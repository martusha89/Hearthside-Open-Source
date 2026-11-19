import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { syncRecoveryDirectory } from "./durable-io";
import {
  BackupError,
  BackupStore,
  KEY_SIZE,
  SEAL_OVERHEAD,
  STORE_MARKER,
  deriveKeyFromRecoveryCode,
  hashBytes,
  keyCheck,
  newRecoveryCode,
  sealBytes,
  unsealBytes,
  validateSnapshotEntries,
  type SnapshotEntry,
  type SnapshotHeader,
  type Verification,
} from "./store";
import { canonicalSnapshotView, convertAttachmentInventoryReferences, convertConversationObjectReferences } from "./object-ids";




export const CONTAINER_VERSION = 1;
/** Portable format 1 always uses public SHA-256 IDs, independent of native stores. */
export const PORTABLE_STORE_VERSION = 1;
const MAGIC = Buffer.from("HSCONT\0", "latin1");
const KDF_SCRYPT_V1 = 1;
const SALT_BYTES = 16;
const CHECK_CHARS = 16;
const LENGTH_BYTES = 4;

export const CONTAINER_LIMITS = {
  /** One sealed region (the largest single picture or transcript chunk). */
  maxRegionBytes: 256 * 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
  maxManifestBytes: 64 * 1024 * 1024,
  maxObjects: 200_000,
  maxFileBytes: 16 * 1024 * 1024 * 1024,
};

/**
 * What a sealed header may say. Everything here is checked on the way in, by
 * the computer receiving the file: the words in a header are shown in lists and
 * handed over IPC, so a hostile file must not be able to put an object, a
 * megabyte of text, or a number that isn't a number into any of them.
 */
const HEADER_LIMITS = {
  text: 1024,
  omissions: 1000,
  countKeys: 256,
};

export type ContainerHeader = {
  container: number;
  storeVersion: number;
  storeId: string;
  createdAt: string;
  snapshot: SnapshotHeader;
  objectCount: number;
  plainBytes: number;
};
/**
 * The entries of the snapshot, and every piece it needs, in the order the
 * pieces follow. "Needs" is more than the entries name: a chat chunk refers to
 * the pictures it carries, which are pieces in their own right and are not
 * entries (this is the same reachability the folder's own prune walks).
 */
export type ContainerManifest = { entries: SnapshotEntry[]; objects: string[] };

const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const HASH = /^[0-9a-f]{64}$/;

/** The readable preamble: every sealed region is tied to these exact bytes. */
function buildPreamble(parts: { salt: Buffer; check: string; wrapped: Buffer }): Buffer {
  if (parts.salt.length !== SALT_BYTES || parts.check.length !== CHECK_CHARS) throw new BackupError("The container's key material is the wrong size.");
  return Buffer.concat([
    MAGIC,
    u16(CONTAINER_VERSION),
    u16(PORTABLE_STORE_VERSION),
    Buffer.from([KDF_SCRYPT_V1, parts.salt.length]),
    parts.salt,
    Buffer.from([parts.check.length]),
    Buffer.from(parts.check, "latin1"),
    u16(parts.wrapped.length),
    parts.wrapped,
  ]);
}

/** What a region's tag authenticates: the whole preamble, the region's name, its declared length. */
const aadFor = (preamble: Buffer, tag: string, sealedLength: number) => Buffer.concat([preamble, Buffer.from(`\n${tag}\n`, "utf8"), u32(sealedLength)]);

// --- Writing -------------------------------------------------------------------



function insideBackupStore(directory: string): boolean {
  let at = existsSync(directory) ? realpathSync(directory) : resolve(directory);
  for (;;) {
    if (existsSync(join(at, STORE_MARKER))) return true;
    const up = dirname(at);
    if (up === at || at === parse(at).root) return false;
    at = up;
  }
}

/** The folder a portable file or an unpacked folder goes in has to be there already. */
function requireParent(path: string, what: string): string {
  const parent = dirname(path);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new BackupError(`There's no folder at the place you chose for ${what}. Choose a folder that already exists.`);
  if (insideBackupStore(parent)) throw new BackupError("That's inside a backup folder. Put it somewhere else, so it can't be mistaken for part of the backup.");
  return parent;
}

/**
 * Write one chosen snapshot to one file. The file is built under a temporary
 * name and moved into place only when it is whole; an existing file is never
 * replaced, and a backup folder is never written into.
 */
export function exportSnapshotContainer(options: { store: BackupStore; agentId: string; snapshotId: string; outPath: string }): {
  path: string;
  recoveryCode: string;
  objects: number;
  plainBytes: number;
  fileBytes: number;
  /** Something to tell the person about a file that was nevertheless finished. */
  warning: string | null;
} {
  const view = canonicalSnapshotView(options.store, options.store.readSnapshot(options.agentId, options.snapshotId));
  const snapshot = view.snapshot;
  validateSnapshotEntries(snapshot.entries);
  const hashes = view.objects;
  if (hashes.length > CONTAINER_LIMITS.maxObjects) throw new BackupError("That backup holds more pieces than one portable file carries.");

  const { entries, authenticatedHeader: _authenticated, ...header } = snapshot;
  const written = writeContainer({
    outPath: options.outPath,
    header: {
      container: CONTAINER_VERSION,
      storeVersion: PORTABLE_STORE_VERSION,
      storeId: options.store.storeId,
      createdAt: new Date().toISOString(),
      snapshot: header,
      objectCount: hashes.length,
      // What a full restore would reassemble, i.e. the snapshot's own total; the
      // pictures the chats refer to are carried as well but are not entries.
      plainBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    },
    manifest: { entries, objects: hashes },
    // One piece at a time: the whole backup is never held in memory at once.
    objects: (function* () { for (const hash of hashes) yield view.readObject(hash); })(),
  });
  return { ...written, objects: hashes.length, plainBytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
}

/**
 * Write one container: the single writer, used by the export above and by the
 * tests that need a container somebody else could have written (their own key,
 * a piece list that lies). It mints the file's own key and its own recovery
 * code, writes beside the target, and moves it into place only when whole.
 */
export function writeContainer(options: { outPath: string; header: ContainerHeader; manifest: ContainerManifest; objects: Iterable<Buffer>; trailing?: Buffer }): {
  path: string;
  recoveryCode: string;
  fileBytes: number;
  /** Set when the file is finished and in place but something else needs saying. */
  warning: string | null;
} {
  const outPath = resolve(options.outPath);
  const parent = requireParent(outPath, "the portable file");
  if (existsSync(outPath)) throw new BackupError("There's already a file with that name. Choose another name: this never writes over a file you already have.");

  // The file's own key, wrapped by its own code. The folder's key stays in the folder.
  const key = randomBytes(KEY_SIZE);
  const recoveryCode = newRecoveryCode();
  const salt = randomBytes(SALT_BYTES);
  const preamble = buildPreamble({ salt, check: keyCheck(key), wrapped: sealBytes(deriveKeyFromRecoveryCode(recoveryCode, salt), key) });

  const temp = `${outPath}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
  const fd = openSync(temp, "wx");
  let fileBytes = 0;
  try {
    const put = (bytes: Buffer) => { writeSync(fd, bytes, 0, bytes.length); fileBytes += bytes.length; };
    put(preamble);
    // Each region is bounded by the limit ITS READER will apply, not by the
    // largest limit in the format: writing a file that only this computer can
    // open would move the failure to the computer the file was carried to.
    const region = (tag: string, plain: Buffer, max: number, tooBig: string) => {
      const sealedLength = plain.length + SEAL_OVERHEAD;
      if (sealedLength > max) throw new BackupError(tooBig);
      const sealed = sealBytes(key, plain, aadFor(preamble, tag, sealedLength));
      if (sealed.length !== sealedLength) throw new BackupError("The container could not be sealed.");
      put(u32(sealedLength));
      put(sealed);
    };
    region("header", Buffer.from(JSON.stringify(options.header)), CONTAINER_LIMITS.maxHeaderBytes, "That backup's details are too long to carry in one portable file.");
    region("manifest", Buffer.from(JSON.stringify(options.manifest)), CONTAINER_LIMITS.maxManifestBytes, "That backup names more pieces, in longer names, than one portable file can list.");
    let index = 0;
    for (const plain of options.objects) region(`object:${index++}`, plain, CONTAINER_LIMITS.maxRegionBytes, "A piece of that backup is too big for one portable file.");
    if (options.trailing) put(options.trailing);
    // On disk before it has a name anybody would trust: this file is by design
    // the only copy of a snapshot that leaves this computer, so losing power
    // between the write and the rename must not leave a whole-looking file
    // with a hole in it (durable-io.ts, as cutover and receipts do).
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* nothing left to remove */ }
    throw error;
  }
  let leftover: string | null = null;
  try {
    ({ leftover } = publishExclusive(temp, outPath));
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing left to remove */ }
    throw error;
  }
  // Past this line the file is published and this call cannot fail: the code
  // below is durability and tidying, and the caller must get the recovery code
  // either way, because nothing else can open the file that now exists.
  try { syncRecoveryDirectory(parent); } catch { /* best effort, as everywhere else */ }
  return {
    path: outPath,
    recoveryCode,
    fileBytes,
    // Named, not silent, and without the temporary file's own name: the person
    // is told there is something to delete beside their file, not given a path
    // to act on blindly.
    warning: leftover === null ? null : "The file is finished and in place. A temporary copy made while writing it could not be removed; it sits beside the file, ends in \".part\", and is safe to delete.",
  };
}

/** Link failed for a reason that means "this filesystem has no hard links". */
const NO_HARD_LINKS = ["EPERM", "EACCES", "ENOSYS", "EXDEV", "EMLINK", "EOPNOTSUPP", "ENOTSUP", "EINVAL"];

/**
 * Give the finished file its name, without ever taking a name that is already
 * taken. `rename` would happily write over a file that appeared since the
 * check, so it is not used: a hard link fails if the name exists, and the link
 * and the check are the same step.
 *
 * There is deliberately no fallback. The obvious one — claim the name with an
 * exclusive create, then rename onto it — is not the same promise: between the
 * claim and the rename the name exists as an empty file, so a power cut leaves
 * a zero-byte "backup", and a second writer that creates the name in that gap
 * has its file replaced by the rename. A removable drive with no hard links
 * (exFAT) therefore gets a refusal, not a weaker publication wearing the same
 * words: export somewhere that supports links and copy the file across, which
 * is a plain file copy and carries everything the file holds.
 *
 * Returns what still needs tidying rather than throwing for it: once the link
 * exists, the finished file is published under its own name and the caller owns
 * a recovery code that is the only way to open it. Failing the whole export
 * because a leftover temporary copy could not be removed would throw that code
 * away while the file it opens sits on disk.
 */
function publishExclusive(temp: string, outPath: string): { leftover: string | null } {
  try {
    linkSync(temp, outPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new BackupError("There's already a file with that name. Choose another name: this never writes over a file you already have.");
    if (NO_HARD_LINKS.includes(code ?? "")) {
      throw new BackupError("This place can't finish a portable file safely: it doesn't support the one step that puts a whole file in place without ever writing over another. Save it on your computer's own disk instead — the file can be copied anywhere afterwards.");
    }
    throw error;
  }
  // Published. Everything from here is tidying.
  try {
    unlinkSync(temp);
    return { leftover: null };
  } catch {
    return { leftover: temp };
  }
}

// --- Reading -------------------------------------------------------------------

/** A file read a piece at a time, never all at once, and never past its end. */
class ContainerFile {
  private position = 0;
  constructor(private readonly fd: number, readonly size: number) {}
  take(length: number, what: string): Buffer {
    if (length < 0 || this.position + length > this.size) throw new BackupError(`This portable file stops in the middle of its ${what}: it is incomplete.`);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(this.fd, bytes, read, length - read, this.position + read);
      if (got <= 0) throw new BackupError(`This portable file stops in the middle of its ${what}: it is incomplete.`);
      read += got;
    }
    this.position += length;
    return bytes;
  }
  byte(what: string): number { return this.take(1, what)[0]!; }
  get offset(): number { return this.position; }
  readAt(position: number, length: number, what: string): Buffer {
    if (position < 0 || length < 0 || position + length > this.size) throw new BackupError(`This portable file stops in the middle of its ${what}: it is incomplete.`);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(this.fd, bytes, read, length - read, position + read);
      if (got <= 0) throw new BackupError(`This portable file stops in the middle of its ${what}: it is incomplete.`);
      read += got;
    }
    return bytes;
  }
  get atEnd(): boolean { return this.position === this.size; }
}

type OpenedContainer = { key: Buffer; preamble: Buffer; file: ContainerFile; header: ContainerHeader; manifest: ContainerManifest };

function openContainer(fd: number, recoveryCode: string): OpenedContainer {
  const size = fstatSync(fd).size;
  if (size > CONTAINER_LIMITS.maxFileBytes) throw new BackupError("That file is far too big to be a portable backup.");
  const file = new ContainerFile(fd, size);

  const magic = file.take(MAGIC.length, "name");
  if (!magic.equals(MAGIC)) throw new BackupError("That isn't a Hearthside portable backup.");
  const containerVersion = file.take(2, "version").readUInt16BE();
  const storeVersion = file.take(2, "version").readUInt16BE();
  if (containerVersion !== CONTAINER_VERSION) throw new BackupError(`That portable backup was written by a different version of Hearthside (format ${containerVersion}; this one reads ${CONTAINER_VERSION}). Update Hearthside and try again; it has not been changed.`);
  if (storeVersion !== PORTABLE_STORE_VERSION) throw new BackupError(`That portable backup holds a backup of a different version (${storeVersion}; this one reads ${PORTABLE_STORE_VERSION}). It has not been changed.`);
  const kdf = file.byte("key settings");
  if (kdf !== KDF_SCRYPT_V1) throw new BackupError("That portable backup locks its key in a way this version doesn't know.");
  const saltLength = file.byte("key settings");
  if (saltLength !== SALT_BYTES) throw new BackupError("That portable backup's key settings are the wrong size.");
  const salt = file.take(saltLength, "key settings");
  const checkLength = file.byte("key settings");
  if (checkLength !== CHECK_CHARS) throw new BackupError("That portable backup's key settings are the wrong size.");
  const check = file.take(checkLength, "key settings");
  const wrappedLength = file.take(2, "key settings").readUInt16BE();
  if (wrappedLength < KEY_SIZE + SEAL_OVERHEAD || wrappedLength > 256) throw new BackupError("That portable backup's wrapped key is the wrong size.");
  const wrapped = file.take(wrappedLength, "key settings");
  const preamble = buildPreamble({ salt, check: check.toString("latin1"), wrapped });

  let key: Buffer;
  try {
    key = unsealBytes(deriveKeyFromRecoveryCode(recoveryCode, salt), wrapped);
  } catch {
    throw new BackupError("That recovery code doesn't open this file. Check it letter by letter (0 and O, 1 and I aren't used).");
  }
  const expected = Buffer.from(keyCheck(key), "latin1");
  if (key.length !== KEY_SIZE || expected.length !== check.length || !timingSafeEqual(expected, check)) throw new BackupError("That recovery code doesn't open this file.");

  const region = (tag: string, what: string, max: number): Buffer => {
    const declared = file.take(LENGTH_BYTES, what).readUInt32BE();
    if (declared < SEAL_OVERHEAD || declared > max) throw new BackupError(`This portable file states a size for its ${what} that this version will not read.`);
    const sealed = file.take(declared, what);
    return unsealBytes(key, sealed, aadFor(preamble, tag, declared));
  };

  const header = JSON.parse(region("header", "details", CONTAINER_LIMITS.maxHeaderBytes).toString("utf8")) as unknown;
  const manifest = JSON.parse(region("manifest", "piece list", CONTAINER_LIMITS.maxManifestBytes).toString("utf8")) as unknown;
  if (!isRecord(header) || !isRecord(manifest)) throw new BackupError("This portable file's details could not be read.");
  validateSnapshotEntries(manifest.entries);
  const objects = manifest.objects;
  if (!Array.isArray(objects) || objects.length > CONTAINER_LIMITS.maxObjects) throw new BackupError("This portable file's piece list is not one this version will read.");
  const named = new Set<string>();
  for (const hash of objects) {
    if (typeof hash !== "string" || !HASH.test(hash)) throw new BackupError("This portable file names a piece in a way that isn't allowed.");
    if (named.has(hash)) throw new BackupError("This portable file names the same piece twice.");
    named.add(hash);
  }
  for (const entry of manifest.entries as SnapshotEntry[]) {
    if (!named.has(entry.hash)) throw new BackupError("This portable file is missing a piece one of its parts needs.");
  }
  const checked = validateContainerHeader(header, manifest.entries as SnapshotEntry[], objects.length);

  return { key, preamble, file, header: checked, manifest: manifest as unknown as ContainerManifest };
}

/**
 * Everything the sealed header says, checked before any of it is written down
 * or handed to anything else. The seal proves the file wasn't altered on the
 * way; it does not prove the computer that wrote it was friendly, and these
 * words end up in lists of companions and in messages people read. So: known
 * types, bounded lengths, and the numbers have to agree with the pieces.
 */
function validateContainerHeader(header: Record<string, unknown>, entries: SnapshotEntry[], objects: number): ContainerHeader {
  const bad = (): never => { throw new BackupError("This portable file's details aren't ones this version will accept."); };
  const text = (value: unknown): string => (typeof value === "string" && value.length > 0 && value.length <= HEADER_LIMITS.text ? value : bad());
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad());

  if (header.container !== CONTAINER_VERSION || header.storeVersion !== PORTABLE_STORE_VERSION) throw new BackupError("This portable file's sealed details disagree with its version.");
  const snapshot = header.snapshot;
  if (!isRecord(snapshot) || typeof snapshot.agentId !== "string" || typeof snapshot.at !== "string" || typeof snapshot.id !== "string") throw new BackupError("This portable file doesn't say which backup it holds.");
  const counts: unknown = snapshot.counts;
  if (!isRecord(counts) || Object.keys(counts).length > HEADER_LIMITS.countKeys) bad();
  for (const [name, value] of Object.entries(counts as Record<string, unknown>)) { text(name); count(value); }
  const omissions: unknown = snapshot.omissions;
  if (!Array.isArray(omissions) || omissions.length > HEADER_LIMITS.omissions) bad();
  for (const omission of omissions as unknown[]) if (typeof omission !== "string" || omission.length > HEADER_LIMITS.text) bad();

  const checked: ContainerHeader = {
    container: CONTAINER_VERSION,
    storeVersion: PORTABLE_STORE_VERSION,
    storeId: text(header.storeId),
    createdAt: text(header.createdAt),
    objectCount: count(header.objectCount),
    plainBytes: count(header.plainBytes),
    snapshot: {
      id: text(snapshot.id),
      agentId: text(snapshot.agentId),
      agentName: text(snapshot.agentName),
      at: text(snapshot.at),
      app: text(snapshot.app),
      counts: snapshot.counts as Record<string, number>,
      omissions: snapshot.omissions as string[],
      objects: count(snapshot.objects),
      bytes: count(snapshot.bytes),
    },
  };
  // The numbers are claims about the rest of the file, so they are checked
  // against it rather than believed.
  if (checked.objectCount !== objects) throw new BackupError("This portable file's details disagree with its piece list.");
  if (checked.plainBytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) throw new BackupError("This portable file's details disagree with the sizes of its parts.");
  if (checked.snapshot.bytes !== checked.plainBytes) throw new BackupError("This portable file's details disagree with the sizes of its parts.");
  if (checked.snapshot.objects !== new Set(entries.map((entry) => entry.hash)).size) throw new BackupError("This portable file's details disagree with its piece list.");
  return checked;
}

/**
 * What one portable file says it holds, without unpacking it: the recovery code
 * has to be right, because everything worth reading is inside the encryption.
 */
export function readContainerHeader(path: string, recoveryCode: string): ContainerHeader {
  const fd = openSync(path, "r");
  try {
    return openContainer(fd, recoveryCode).header;
  } finally {
    closeSync(fd);
  }
}

/**
 * Unpack one portable file into a NEW backup folder of its own.
 *
 * The target folder must NOT exist: this code makes it, which is how it knows
 * it is not adding to, merging with, or writing over a folder somebody is
 * using. (It is also the only publication Windows allows: `MoveFileExW`
 * refuses a folder that is already there, even an empty one, and deleting a
 * folder a person chose is not this code's business.) The folder it goes in
 * does have to exist. The new folder gets its own key and its own recovery
 * code (returned here, shown once by whatever calls this), so the portable
 * file's code is not quietly turned into a folder's code.
 *
 * Nothing is started: this writes a folder, and does not create, enable or
 * touch a companion anywhere.
 */
export function importContainer(options: { path: string; targetRoot: string; recoveryCode: string }): {
  root: string;
  store: BackupStore;
  key: Buffer;
  recoveryCode: string;
  storeId: string;
  snapshot: SnapshotHeader;
  objects: number;
  verification: Verification;
} {
  const targetRoot = resolve(options.targetRoot);
  requireParent(targetRoot, "the unpacked folder");
  if (existsSync(targetRoot)) throw new BackupError("There's already something with that name. Choose a name that isn't in use: this makes the folder itself, and never writes into one that's already there.");

  const fd = openSync(options.path, "r");
  let temp: string | null = null;
  let claimed: string | null = null;
  try {
    const { key, preamble, file, header, manifest } = openContainer(fd, options.recoveryCode);

    // Everything below writes, so it all happens beside the target and is moved
    // into place at the end, or thrown away.
    temp = `${targetRoot}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
    const created = BackupStore.create(temp);
    const parentKinds = new Map<string, Set<string>>();
    for (const entry of manifest.entries) if (entry.kind === "conversation" || entry.kind === "attachment-inventory") {
      const kinds = parentKinds.get(entry.hash) ?? new Set<string>(); kinds.add(entry.kind); parentKinds.set(entry.hash, kinds);
    }
    const rawIds = new Map<string, { hash: string; size: number; canonicalSize: number }>();
    const transformedIds = new Map<string, { hash: string; size: number; canonicalSize: number }>();
    const deferredParents: Array<{ index: number; hash: string; kind: string; declared: number; sealedAt: number }> = [];
    for (const [index, hash] of manifest.objects.entries()) {
      const declared = file.take(LENGTH_BYTES, "pieces").readUInt32BE();
      if (declared < SEAL_OVERHEAD || declared > CONTAINER_LIMITS.maxRegionBytes) throw new BackupError("A piece of this portable file claims a size this version won't read.");
      const sealedAt = file.offset;
      const sealed = file.take(declared, "pieces");
      const plain = unsealBytes(key, sealed, aadFor(preamble, `object:${index}`, declared));
      // The piece has to be the piece the list names, by its own hash; the
      // declared sizes of the entries are checked again by verify() below.
      if (hashBytes(plain) !== hash) throw new BackupError("A piece of this portable file isn't the piece its list names. Nothing was kept.");
      const native = created.store.putObject(plain);
      rawIds.set(hash, { hash: native.hash, size: plain.length, canonicalSize: plain.length });
      for (const kind of parentKinds.get(hash) ?? []) deferredParents.push({ index, hash, kind, declared, sealedAt });
    }
    if (!file.atEnd) throw new BackupError("This portable file has something extra after its last piece. Nothing was kept.");

    // Format 1 writers were allowed to put parents before pictures. Re-read only
    // bounded structured-parent regions after every raw object has been mapped.
    for (const deferred of deferredParents) {
      const sealed = file.readAt(deferred.sealedAt, deferred.declared, "conversation piece");
      const plain = unsealBytes(key, sealed, aadFor(preamble, `object:${deferred.index}`, deferred.declared));
      if (hashBytes(plain) !== deferred.hash) throw new BackupError("A piece of this portable file changed while it was being imported.");
      const nativeBytes = deferred.kind === "attachment-inventory"
        ? convertAttachmentInventoryReferences(plain, (canonical, declaredSize) => {
            const raw = rawIds.get(canonical);
            if (!raw || raw.canonicalSize !== declaredSize) throw new BackupError("A captured attachment's declared size differs from its bytes.");
            return raw.hash;
          })
        : convertConversationObjectReferences(plain, (canonical) => rawIds.get(canonical)?.hash ?? "");
      const native = created.store.putObject(nativeBytes);
      transformedIds.set(`${deferred.hash}\0${deferred.kind}`, { hash: native.hash, size: nativeBytes.length, canonicalSize: plain.length });
    }

    const nativeEntries = manifest.entries.map((entry) => {
      const native = transformedIds.get(`${entry.hash}\0${entry.kind}`) ?? rawIds.get(entry.hash);
      if (!native) throw new BackupError("A portable backup entry refers to an unknown piece.");
      if (entry.size !== native.canonicalSize) throw new BackupError("A portable backup entry's declared size differs from its bytes.");
      let path = entry.path;
      if (entry.kind === "attachment") {
        if (/^attachments\/[a-f0-9]{64}$/.test(entry.path)) {
          if (entry.path !== `attachments/${entry.hash}`) throw new BackupError("A generated attachment entry has an inconsistent path.");
          path = `attachments/${native.hash}`;
        }
      }
      return { ...entry, path, hash: native.hash, size: native.size };
    });
    const { id: _id, objects: _objects, bytes: _bytes, ...rest } = header.snapshot;
    const written = created.store.writeSnapshot(rest, nativeEntries);
    if (written.id !== header.snapshot.id) throw new BackupError("This portable file's backup could not be written under the name it came with.");
    const verification = created.store.verify(written.agentId, written.id);
    if (!verification.ok) throw new BackupError("The unpacked backup didn't check out, so it was thrown away rather than kept.");

    // Claim the name by making the folder: that fails if anything is there, so
    // a folder that appeared since the check (or a second import racing this
    // one) is refused rather than written into. The finished store is then
    // moved in piece by piece, which is a rename into an empty folder, the one
    // publication both POSIX and Windows do.
    try {
      mkdirSync(targetRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BackupError("There's already something with that name. Choose a name that isn't in use: this makes the folder itself, and never writes into one that's already there.");
      throw error;
    }
    claimed = targetRoot;
    // The marker is what makes a folder a backup folder, so it goes in last and
    // on its own: if the power goes out part way through this move, what is left
    // is a folder with pieces in it and no marker, which `BackupStore.open`
    // refuses, rather than a folder that opens as a store and is missing half a
    // companion. Everything else is moved first, then the directories are
    // flushed where this platform lets us, then the marker.
    const children = readdirSync(temp);
    for (const child of children) {
      if (child === STORE_MARKER) continue;
      renameSync(join(temp, child), join(targetRoot, child));
    }
    syncRecoveryDirectory(targetRoot);
    if (children.includes(STORE_MARKER)) {
      renameSync(join(temp, STORE_MARKER), join(targetRoot, STORE_MARKER));
      syncRecoveryDirectory(targetRoot);
    }
    syncRecoveryDirectory(dirname(targetRoot));
    claimed = null;
    return {
      root: targetRoot,
      store: BackupStore.open(targetRoot, created.key),
      key: created.key,
      recoveryCode: created.recoveryCode,
      storeId: created.store.storeId,
      snapshot: written,
      objects: manifest.objects.length,
      verification,
    };
  } finally {
    closeSync(fd);
    // A failed import leaves nothing behind: not a half-store, and not the
    // folder this code made. Only a folder THIS call created is removed, and
    // only while it holds nothing but what this call put in it; a folder
    // somebody else chose or made is never deleted here.
    if (claimed) rmSync(claimed, { recursive: true, force: true });
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
