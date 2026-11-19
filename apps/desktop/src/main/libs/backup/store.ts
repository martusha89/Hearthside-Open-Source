import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { syncRecoveryDirectory, writeDurable } from "./durable-io";
import { drain, drainAsync } from "./breathe";
import { isOsJunkFile } from "./os-junk";




export const STORE_VERSION = 2;
export const LEGACY_STORE_VERSION = 1;
/**
 * The one file that makes a folder a backup folder: `open` refuses a folder
 * without it, so anything assembling a store elsewhere and moving it in puts
 * this in last.
 */
export const STORE_MARKER = "hearthside-backup.json";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A piece's name: a version-specific 256-bit digest in lowercase hex. */
const HASH = /^[0-9a-f]{64}$/;
/** A snapshot's name: its time, e.g. 2026-10-15T08-00-00-000. */
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/;
const PIN_ID = /^[0-9a-f-]{36}$/;

/**
 * Hearthside: a snapshot a recovery depends on. Restores no longer copy what they
 * don't apply into the companion; it stays here, so cleanup must not retire it.
 */
export type SnapshotPin = { id: string; agentId: string; snapshotId: string; at: string; reason: string; destinationAgentId?: string };

export type SnapshotEntry = { path: string; hash: string; size: number; kind: string };
export type SnapshotHeader = {
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  counts: Record<string, number>;
  /** Pieces this snapshot names and their plaintext bytes in all (what a full restore would reassemble). */
  objects: number;
  bytes: number;
  /** What was deliberately not included (pictures left out, a part that failed), in plain words. */
  omissions: string[];
  app: string;
};
export type Snapshot = SnapshotHeader & { entries: SnapshotEntry[]; authenticatedHeader?: boolean };
export type Verification = { ok: boolean; checked: number; missing: string[]; corrupt: string[]; semanticErrors: string[]; warnings: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Logical archive names, NOT extraction destinations. Main-chat namespaces are
 * allowed only in the conversation-id component; recovery must map these names. */
function validEntryPath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.includes("\\") || [...path].some((character) => character.charCodeAt(0) < 32)) return false;
  const parts = path.split("/");
  return parts.every((part, index) => part !== "" && part !== "." && part !== ".." &&
    (!part.includes(":") || (parts[0] === "conversations" && index === 1 && /^main:[A-Za-z0-9_-]+$/.test(part))));
}

function validateEntries(entries: unknown): asserts entries is SnapshotEntry[] {
  if (!Array.isArray(entries)) throw new BackupError("This backup has no valid entry list.");
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !validEntryPath(entry.path) || paths.has(entry.path)) throw new BackupError("This backup has an unsafe or duplicate entry path.");
    if (typeof entry.hash !== "string" || !HASH.test(entry.hash) || !isCount(entry.size) || typeof entry.kind !== "string" || !entry.kind) throw new BackupError("This backup has an invalid piece description.");
    paths.add(entry.path);
  }
}

function chunkMessages(bytes: Buffer): Record<string, unknown>[] {
  const lines = bytes.toString("utf8").trim();
  if (!lines) return [];
  return lines.split("\n").map((line) => {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message) || typeof message.id !== "string" || !message.id.trim()) throw new BackupError("A conversation message has no valid id.");
    return message;
  });
}

function pictureReferences(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) { for (const item of value) pictureReferences(item, refs); return; }
  if (!isRecord(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith("_hearthside_object")) {
      if (typeof inner !== "string" || !HASH.test(inner)) throw new BackupError("A conversation has an invalid picture reference.");
      refs.push(inner);
    } else pictureReferences(inner, refs);
  }
}

export class BackupError extends Error {}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * AES-256-GCM, 12-byte nonce + ciphertext + 16-byte tag.
 *
 * `aad` is additional data that is authenticated but not encrypted: it is not
 * part of the output, and opening fails unless exactly the same bytes are
 * supplied again. Passing none is what the store itself does, and is
 * byte-compatible with every file written before this parameter existed. The
 * portable container (container.ts) uses it to bind each sealed region to the
 * readable preamble, so a changed version or salt cannot be opened at all.
 */
function seal(key: Buffer, plain: Buffer, aad?: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function unseal(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new BackupError("The backup piece is too short to be real.");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupError("The backup piece couldn't be decrypted: wrong key, or the file is damaged.");
  }
}

/**
 * The store's own primitives, for the portable container in container.ts: one
 * encryption, one key derivation and one entry validator in this codebase, not
 * two. Nothing here is new cryptography.
 */
export { seal as sealBytes, unseal as unsealBytes, validateEntries as validateSnapshotEntries };
export const KEY_SIZE = KEY_BYTES;
export const SEAL_OVERHEAD = NONCE_BYTES + TAG_BYTES;
export const hashBytes = sha256;
/** Legacy/portable wrapped-key check; native v2 uses its own purpose-separated check. */
export const keyCheck = (key: Buffer): string => sha256(key).slice(0, 16);
export const deriveKeyFromRecoveryCode = (code: string, salt: Buffer): Buffer => keyFromRecoveryCode(code, salt);

/** Write a file so that a crash leaves either the old file or the new one, never half of one. */
function writeAtomic(path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

/** A recovery code the person writes down: 6 groups of 5 letters and digits (no 0/O/1/I), about 150 bits. */
export function newRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let group = "";
    for (const byte of randomBytes(5)) group += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    groups.push(group);
  }
  return groups.join("-");
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "").replace(/(.{5})(?=.)/g, "$1-");
}

function keyFromRecoveryCode(code: string, salt: Buffer): Buffer {
  return scryptSync(normaliseRecoveryCode(code), salt, KEY_BYTES, SCRYPT);
}

type Meta = { version: number; storeId: string; createdAt: string; authentication?: string };
type Wrapped = { kdf: "scrypt"; salt: string; wrapped: string; check: string };

const STORE_ID = /^[0-9a-f]{16}$/;
const AUTH = /^[0-9a-f]{64}$/;
const HKDF_SALT_PREFIX = "hearthside/native-store/v2/";
const OBJECT_ID_PURPOSE = "object-id";
const MARKER_AUTH_PURPOSE = "marker-auth";

/** RFC 5869 HKDF-SHA256, with the store identity in the salt and a distinct purpose in info. */
function storePurposeKey(key: Buffer, storeId: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.from(`${HKDF_SALT_PREFIX}${storeId}`, "utf8"), Buffer.from(purpose, "utf8"), KEY_BYTES));
}

function markerPayload(meta: Meta): Buffer {
  return Buffer.from(JSON.stringify({ version: meta.version, storeId: meta.storeId, createdAt: meta.createdAt }), "utf8");
}

function markerAuthentication(key: Buffer, meta: Meta): string {
  return createHmac("sha256", storePurposeKey(key, meta.storeId, MARKER_AUTH_PURPOSE)).update(markerPayload(meta)).digest("hex");
}

function wrappedKeyCheck(key: Buffer, meta: Meta): string {
  return meta.version === LEGACY_STORE_VERSION
    ? sha256(key).slice(0, 16)
    : createHmac("sha256", storePurposeKey(key, meta.storeId, "wrapped-key-check")).update(markerPayload(meta)).digest("hex").slice(0, 16);
}

function authenticateMeta(meta: Meta, key: Buffer): void {
  if (meta.version !== STORE_VERSION || !STORE_ID.test(meta.storeId) || typeof meta.createdAt !== "string" || !AUTH.test(meta.authentication ?? "")) {
    throw new BackupError("This backup folder's identity is invalid or unauthenticated.");
  }
  const actual = Buffer.from(meta.authentication!, "hex");
  const expected = Buffer.from(markerAuthentication(key, meta), "hex");
  if (!timingSafeEqual(actual, expected)) throw new BackupError("This backup folder's identity does not match its key; it may have been changed.");
}

export class BackupStore {
  private constructor(
    readonly root: string,
    readonly storeId: string,
    private readonly key: Buffer,
    readonly version: number,
  ) {}



  static create(root: string, persistKey?: (storeId: string, key: Buffer) => void): { store: BackupStore; recoveryCode: string; key: Buffer } {
    if (existsSync(join(root, STORE_MARKER))) throw new BackupError("This folder already holds a Hearthside backup. Open it instead.");
    const recoveryPath = join(root, "keys", "recovery.json");
    // A folder with keys but no marker is a setup that stopped partway (or one another
    // computer is assembling). Overwriting the wrapping would silently retire a recovery
    // code someone may have written down, so refuse instead of deciding for them. The
    // check is cheap and this is a public entry point, even though the app only calls it
    // on a fresh folder.
    if (existsSync(recoveryPath)) {
      throw new BackupError("This folder already holds backup keys from a setup that didn't finish. Hearthside won't replace them, because an existing recovery code would stop working. Open the folder, or choose an empty one.");
    }
    const key = randomBytes(KEY_BYTES);
    const recoveryCode = newRecoveryCode();
    const meta: Meta = { version: STORE_VERSION, storeId: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
    meta.authentication = markerAuthentication(key, meta);
    const salt = randomBytes(16);
    const kek = keyFromRecoveryCode(recoveryCode, salt);
    const wrapped: Wrapped = {
      kdf: "scrypt",
      salt: salt.toString("base64"),
      wrapped: seal(kek, key).toString("base64"),
      check: wrappedKeyCheck(key, meta),
    };
    // Directories this call creates, so rollback removes those and nothing else: the
    // chosen folder itself, and any file that was already in it, are never touched.
    const ourDirectories = ["objects", "keys"].filter((name) => !existsSync(join(root, name)));
    mkdirSync(join(root, "objects"), { recursive: true });
    try {
      writeAtomic(recoveryPath, JSON.stringify(wrapped, null, 2));
      persistKey?.(meta.storeId, key);
    } catch (error) {
      // The wrapping is ours either way (we refused to start if it already existed);
      // `keys/` may not be, so remove the file first and the directory only if we made it.
      rmSync(recoveryPath, { force: true });
      for (const name of ourDirectories) rmSync(join(root, name), { recursive: true, force: true });
      throw error;
    }
    // Publication, last: before this line the folder is not a backup folder.
    writeAtomic(join(root, STORE_MARKER), JSON.stringify(meta, null, 2));
    return { store: new BackupStore(root, meta.storeId, key, meta.version), recoveryCode, key };
  }



  static rewrapRecoveryCode(root: string, key: Buffer): string {
    const meta = readMeta(root);
    const wrapped = readWrapped(root);
    if (wrappedKeyCheck(key, meta) !== wrapped.check) throw new BackupError("That key doesn't belong to this backup folder.");
    if (meta.version === STORE_VERSION) authenticateMeta(meta, key);
    const recoveryCode = newRecoveryCode();
    const salt = randomBytes(16);
    const next: Wrapped = { kdf: "scrypt", salt: salt.toString("base64"), wrapped: seal(keyFromRecoveryCode(recoveryCode, salt), key).toString("base64"), check: wrappedKeyCheck(key, meta) };
    writeAtomic(join(root, "keys", "recovery.json"), JSON.stringify(next, null, 2));
    return recoveryCode;
  }

  /** Open with the data key this computer keeps (see backup-keys.ts). */
  static open(root: string, key: Buffer): BackupStore {
    const meta = readMeta(root);
    const wrapped = readWrapped(root);
    if (wrappedKeyCheck(key, meta) !== wrapped.check) throw new BackupError("That key doesn't belong to this backup folder.");
    if (meta.version === STORE_VERSION) authenticateMeta(meta, key);
    return new BackupStore(root, meta.storeId, key, meta.version);
  }

  /** Open on another computer, with the recovery code. Returns the key so it can be kept from now on. */
  static openWithRecoveryCode(root: string, code: string): { store: BackupStore; key: Buffer } {
    const meta = readMeta(root);
    const wrapped = readWrapped(root);
    const kek = keyFromRecoveryCode(code, Buffer.from(wrapped.salt, "base64"));
    let key: Buffer;
    try {
      key = unseal(kek, Buffer.from(wrapped.wrapped, "base64"));
    } catch {
      throw new BackupError("That recovery code doesn't open this backup. Check it letter by letter (0 and O, 1 and I aren't used).");
    }
    const check = Buffer.from(wrappedKeyCheck(key, meta));
    if (check.length !== wrapped.check.length || !timingSafeEqual(check, Buffer.from(wrapped.check))) throw new BackupError("That recovery code doesn't open this backup.");
    if (meta.version === STORE_VERSION) authenticateMeta(meta, key);
    return { store: new BackupStore(root, meta.storeId, key, meta.version), key };
  }

  private objectPath(hash: string): string {
    return join(this.root, "objects", hash.slice(0, 2), hash);
  }

  objectId(bytes: Buffer): string {
    return this.version === LEGACY_STORE_VERSION
      ? sha256(bytes)
      : createHmac("sha256", storePurposeKey(this.key, this.storeId, OBJECT_ID_PURPOSE)).update(bytes).digest("hex");
  }

  hasObject(hash: string): boolean {
    return existsSync(this.objectPath(hash));
  }



  putObject(bytes: Buffer): { hash: string; written: boolean } {
    const hash = this.objectId(bytes);
    const path = this.objectPath(hash);
    if (existsSync(path)) {
      try {
        if (this.objectId(unseal(this.key, readFileSync(path))) === hash) return { hash, written: false };
      } catch {
        // Damaged or not ours: replaced below.
      }
    }
    writeAtomic(path, seal(this.key, bytes));
    return { hash, written: true };
  }

  getObject(hash: string): Buffer {
    if (!HASH.test(hash)) throw new BackupError("A backup piece has an invalid name.");
    const path = this.objectPath(hash);
    if (!existsSync(path)) throw new BackupError(`A piece of the backup is missing (${hash.slice(0, 12)}…).`);
    const plain = unseal(this.key, readFileSync(path));
    if (this.objectId(plain) !== hash) throw new BackupError(`A piece of the backup is damaged (${hash.slice(0, 12)}…).`);
    return plain;
  }

  private snapshotsDir(agentId: string): string {
    return join(this.root, "companions", safeName(agentId), "snapshots");
  }



  writeSnapshot(header: Omit<SnapshotHeader, "id" | "objects" | "bytes">, entries: SnapshotEntry[]): SnapshotHeader {
    validateEntries(entries);
    const id = header.at.replace(/[:.]/g, "-").replace(/Z$/, "");
    if (!SNAPSHOT_ID.test(id)) throw new BackupError("The backup's time couldn't be used as its name.");
    const full: SnapshotHeader = { ...header, id, objects: new Set(entries.map((entry) => entry.hash)).size, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
    const sealed = seal(this.key, Buffer.from(JSON.stringify({ header: full, entries }))).toString("base64");
    writeAtomic(join(this.snapshotsDir(header.agentId), `${id}.json`), JSON.stringify({ header: full, sealed }, null, 2));
    return full;
  }

  listSnapshots(agentId: string): SnapshotHeader[] {
    return this.listSnapshotsIn(this.snapshotsDir(agentId)).map((item) => item.header);
  }

  /**
   * A snapshot that was written but then didn't pass its own check is kept (most of it
   * is usually readable, and it may be the only copy of something), but it must not
   * pass for a good one: it is marked with a small file beside it. The mark is what
   * lets the list say so, and what stops cleanup from treating it as "the newest
   * backup" and retiring the last one that did check out.
   */
  private failedCheckPath(file: string): string {
    return `${file.slice(0, -".json".length)}.failed-check`;
  }

  markFailedCheck(agentId: string, id: string): void {
    if (!SNAPSHOT_ID.test(id)) throw new BackupError("That isn't a backup name.");
    writeAtomic(this.failedCheckPath(join(this.snapshotsDir(agentId), `${id}.json`)), new Date().toISOString());
  }

  /** Taken off again once the snapshot passes a later check (a synced folder that has caught up, say). */
  clearFailedCheck(agentId: string, id: string): void {
    if (!SNAPSHOT_ID.test(id)) throw new BackupError("That isn't a backup name.");
    rmSync(this.failedCheckPath(join(this.snapshotsDir(agentId), `${id}.json`)), { force: true });
  }

  /** The snapshots of one companion that carry the mark. */
  failedChecks(agentId: string): Set<string> {
    return new Set(this.listSnapshotsIn(this.snapshotsDir(agentId)).filter((item) => existsSync(this.failedCheckPath(item.file))).map((item) => item.header.id));
  }

  /** Every companion with snapshots in this store. */
  listCompanions(): Array<{ agentId: string; agentName: string; snapshots: number; latest: string }> {
    const dir = join(this.root, "companions");
    if (!existsSync(dir)) return [];
    const out: Array<{ agentId: string; agentName: string; snapshots: number; latest: string }> = [];
    for (const folder of readdirSync(dir)) {
      const snapshots = this.listSnapshotsIn(join(dir, folder, "snapshots"));
      const last = snapshots[snapshots.length - 1]?.header;
      if (last) out.push({ agentId: last.agentId, agentName: last.agentName, snapshots: snapshots.length, latest: last.at });
    }
    return out;
  }



  private listSnapshotsIn(dir: string): Array<{ file: string; header: SnapshotHeader }> {
    if (!existsSync(dir)) return [];
    const out: Array<{ file: string; header: SnapshotHeader }> = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || !SNAPSHOT_ID.test(name.slice(0, -5))) continue;
      const file = join(dir, name);
      try {
        if (!lstatSync(file).isFile()) continue;
        const header = (JSON.parse(readFileSync(file, "utf8")) as { header: SnapshotHeader }).header;
        if (header && typeof header.at === "string") out.push({ file, header: { ...header, id: name.slice(0, -5) } });
      } catch {
        // Unreadable: not listed, and never deleted on its say-so.
      }
    }
    return out.sort((a, b) => a.header.at.localeCompare(b.header.at));
  }

  /** Open a snapshot file: the sealed header is authoritative and must match the readable one. */
  private openSnapshotFile(file: string): Snapshot {
    const { header, sealed } = JSON.parse(readFileSync(file, "utf8")) as { header: SnapshotHeader; sealed: string };
    const opened = JSON.parse(unseal(this.key, Buffer.from(sealed, "base64")).toString("utf8")) as { header?: SnapshotHeader; entries: SnapshotEntry[] };

    const trusted = opened.header ?? header;
    if (opened.header && (opened.header.id !== header.id || opened.header.at !== header.at || opened.header.agentId !== header.agentId)) {
      throw new BackupError("This backup's details don't match its sealed copy: it may have been changed. It's left as it is.");
    }
    validateEntries(opened.entries);
    return { ...trusted, entries: opened.entries, authenticatedHeader: opened.header !== undefined };
  }

  readSnapshot(agentId: string, id: string): Snapshot {
    if (!SNAPSHOT_ID.test(id)) throw new BackupError("That isn't a backup name.");
    const path = join(this.snapshotsDir(agentId), `${id}.json`);
    if (!existsSync(path)) throw new BackupError("That backup isn't in this folder any more.");
    return this.openSnapshotFile(path);
  }

  /** The latest snapshot's entries by path, for "only what changed" on the next run. */
  latestEntries(agentId: string, snapshotId?: string | null): Map<string, SnapshotEntry> {
    // Hearthside: a chosen snapshot (the last one that checked out), else the newest; null: none (start fresh).
    if (snapshotId === null) return new Map();
    const id = snapshotId ?? this.listSnapshots(agentId).at(-1)?.id;
    if (!id) return new Map();
    try {
      return new Map(this.readSnapshot(agentId, id).entries.map((entry) => [entry.path, entry]));
    } catch {
      return new Map();
    }
  }



  referencesOf(entry: SnapshotEntry): string[] {
    if (entry.kind !== "conversation") return [];
    const refs: string[] = [];
    for (const message of chunkMessages(this.getObject(entry.hash))) pictureReferences(message, refs);
    return refs;
  }

  /** Decrypt and re-hash every piece a snapshot names, and every picture its chats refer to. */
  verify(agentId: string, id: string, onProgress?: (checked: number, total: number) => void): Verification {
    return drain(this.verifySteps(agentId, id, onProgress));
  }

  /** The same, letting the window breathe between pieces (a big backup takes a while). */
  verifyAsync(agentId: string, id: string, onProgress?: (checked: number, total: number) => void): Promise<Verification> {
    return drainAsync(this.verifySteps(agentId, id, onProgress));
  }

  /** The check, one piece per step. */
  *verifySteps(agentId: string, id: string, onProgress?: (checked: number, total: number) => void): Generator<void, Verification, undefined> {
    const snapshot = this.readSnapshot(agentId, id);
    const missing: string[] = [];
    const corrupt: string[] = [];
    const semanticErrors: string[] = [];
    const warnings = Array.isArray(snapshot.omissions) ? snapshot.omissions.filter((item): item is string => typeof item === "string") : [];
    if (!snapshot.authenticatedHeader) warnings.push("Legacy snapshot header is not authenticated; its provenance and totals cannot be trusted.");
    const seen = new Set<string>();
    const objects = new Map<string, Buffer>();
    const sizes = new Map<string, number>();
    const check = (hash: string, label: string): Buffer | undefined => {
      if (seen.has(hash)) return;
      seen.add(hash);
      if (!this.hasObject(hash)) {
        missing.push(label);
        return;
      }
      try {
        const bytes = this.getObject(hash);
        sizes.set(hash, bytes.length);
        return bytes;
      } catch {
        corrupt.push(label);
      }
    };
    // Keep IDs rather than whole transcripts or memory/picture bytes in RAM.
    const messages = new Map<string, string[]>();
    const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    let checked = 0;
    for (const entry of snapshot.entries) {
      yield;
      onProgress?.(++checked, snapshot.entries.length);
      let bytes = check(entry.hash, entry.path);
      if (!sizes.has(entry.hash)) continue;
      if (sizes.get(entry.hash) !== entry.size) semanticErrors.push(`${entry.path}: declared size differs from its bytes.`);
      if (entry.kind !== "conversation" && entry.kind !== "conversation-record") continue;
      // A shared object may have been checked through another entry or picture.
      bytes ??= this.getObject(entry.hash);
      if (entry.kind === "conversation-record") objects.set(entry.hash, bytes);
      if (entry.kind === "conversation") {
        try {
          const parsed = chunkMessages(bytes);
          messages.set(entry.path, parsed.map((message) => message.id as string));
          const refs: string[] = [];
          for (const message of parsed) pictureReferences(message, refs);
          for (const ref of refs) check(ref, `${entry.path} → picture ${ref.slice(0, 12)}…`);
        } catch {
          semanticErrors.push(`${entry.path}: malformed conversation messages or picture references.`);
        }
      }
    }
    if (!isRecord(snapshot.counts) || Object.values(snapshot.counts).some((count) => !isCount(count))) semanticErrors.push("Snapshot counts must be non-negative safe integers.");
    if (snapshot.objects !== new Set(snapshot.entries.map((entry) => entry.hash)).size || snapshot.bytes !== snapshot.entries.reduce((sum, entry) => sum + entry.size, 0)) semanticErrors.push("Snapshot object or byte totals do not match its entries.");
    const records = snapshot.entries.filter((entry) => entry.kind === "conversation-record");
    const referenced = new Set<string>();
    const conversationIds = new Set<string>();
    let totalMessages = 0;
    for (const entry of records) {
      yield;
      const bytes = objects.get(entry.hash);
      if (!bytes) continue;
      try {
        const meta: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isRecord(meta) || typeof meta.id !== "string" || !meta.id || entry.path !== `conversations/${meta.id}/meta.json` || conversationIds.has(meta.id) || !isCount(meta.count) || !Array.isArray(meta.chunks)) throw new Error("invalid metadata");
        conversationIds.add(meta.id);
        if (isRecord(meta.capture) && meta.capture.mode === "incremental" && meta.capture.order === "asc") warnings.push(`${entry.path}: incremental capture built on an earlier backup; messages edited or deleted since the last full backup may not be reflected.`);
        else if (!isRecord(meta.capture) || meta.capture.mode !== "full-history" || meta.capture.order !== "asc") warnings.push(`${entry.path}: legacy capture has no full-history freshness provenance; historical edits may not be reflected.`);
        const ids = new Set<string>();
        const componentIdentity = isRecord(meta.capture) && meta.capture.messageIdentity === "source-id-components-v1";
        if (isRecord(meta.capture) && meta.capture.messageIdentity !== undefined && !componentIdentity) throw new Error("unsupported message identity format");
        let count = 0;
        let lastId: string | null = null;
        for (const [index, chunk] of meta.chunks.entries()) {
          if (!isRecord(chunk) || !isCount(chunk.count) || chunk.count === 0 || typeof chunk.path !== "string") throw new Error("invalid chunk description");
          const expected = `conversations/${meta.id}/${String(index + 1).padStart(4, "0")}.jsonl`;
          if (chunk.path !== expected || referenced.has(chunk.path)) throw new Error("duplicate or out-of-order chunk");
          referenced.add(chunk.path);
          const target = entries.get(chunk.path);
          if (!target || target.kind !== "conversation") throw new Error(`missing conversation chunk ${chunk.path}`);
          const lines = messages.get(chunk.path);
          if (!lines) throw new Error(`unreadable conversation chunk ${chunk.path}`);
          if (lines.length !== chunk.count) throw new Error(`chunk count mismatch ${chunk.path}`);
          for (const messageId of lines) {
            // Only explicitly versioned projected captures can contain a
            // contiguous group with one source ID, even across chunk boundaries.
            if (ids.has(messageId) && (!componentIdentity || messageId !== lastId)) throw new Error("duplicate or noncontiguous message identity");
            ids.add(messageId);
            lastId = messageId;
          }
          count += lines.length;
        }
        if (count !== meta.count || meta.lastMessageId !== lastId) throw new Error("message count or lastMessageId mismatch");
        totalMessages += count;
      } catch (error) {
        semanticErrors.push(`${entry.path}: ${error instanceof Error ? error.message : "invalid conversation metadata"}.`);
      }
    }
    if (records.length > 0) {
      for (const entry of snapshot.entries) if (entry.kind === "conversation" && !referenced.has(entry.path)) semanticErrors.push(`${entry.path}: conversation chunk is not referenced by metadata.`);
      if (snapshot.counts?.conversations !== records.length || snapshot.counts?.messages !== totalMessages) semanticErrors.push("Snapshot conversation/message totals do not match its records.");
    } else {
      warnings.push("No conversation metadata is available to establish transcript completeness or freshness.");
    }
    warnings.push("Integrity checks do not prove live-source completeness, durable attachment recovery, or continuation-ready restore.");
    return { ok: missing.length === 0 && corrupt.length === 0 && semanticErrors.length === 0, checked: seen.size, missing, corrupt, semanticErrors, warnings };
  }

  /**
   * Drop snapshots older than `keepDays` (always keeping the newest), then
   * pieces nothing names any more, directly or through a chat's pictures.
   * If any remaining snapshot can't be opened, no piece is deleted: the
   * list of what's still needed would be incomplete.
   */
  /**
   * Protect a snapshot from cleanup. Written (atomically) before a restore writes
   * anything, so a restore never depends on a snapshot that cleanup could retire.
   */
  pin(agentId: string, snapshotId: string, reason: string, destinationAgentId?: string): SnapshotPin {
    return this.withPinLock(() => {
      this.readSnapshot(agentId, snapshotId);
      // A restore asks for this before it creates anything. If the protections already
      // here can't all be read, say so now: found out later, it would be after the new
      // companion exists, leaving an empty copy behind on every attempt.
      this.pins();
      const pin: SnapshotPin = { id: randomUUID(), agentId, snapshotId, at: new Date().toISOString(), reason, ...(destinationAgentId ? { destinationAgentId } : {}) };
      writeDurable(join(this.root, "pins", `${pin.id}.json`), JSON.stringify(pin, null, 2));
      return pin;
    });
  }



  private withPinLock<T>(run: () => T): T {
    const lock = join(this.root, "pins.lock");
    const mine = { host: hostname(), pid: process.pid, token: randomUUID() };
    const take = () => {
      const fd = openSync(lock, "wx", 0o600);
      try { writeSync(fd, JSON.stringify(mine)); fsyncSync(fd); } finally { closeSync(fd); }
    };
    try { take(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BackupError(LOCK_HELD);
      throw error;
    }
    try { return run(); }
    finally {
      // Never remove a lock that isn't ours (one that replaced it, say).
      try { if ((JSON.parse(readFileSync(lock, "utf8")) as { token?: string }).token === mine.token) rmSync(lock, { force: true }); } catch { /* gone or unreadable: not ours to remove */ }
    }
  }

  /** Record which companion a pin is for, once the restore has allocated it. */
  updatePin(id: string, destinationAgentId: string): SnapshotPin {
    if (!PIN_ID.test(id)) throw new BackupError("That isn't a protection name.");
    // Only this pin's own file is read: by now the restore has created its companion,
    // and something unrelated appearing in the folder must not fail it at this point.
    const file = join(this.root, "pins", `${id}.json`);
    if (!existsSync(file)) throw new BackupError("That protection isn't in this backup folder any more.");
    const pin = this.readPin(file, id);
    const next = { ...pin, destinationAgentId };
    writeDurable(join(this.root, "pins", `${id}.json`), JSON.stringify(next, null, 2));
    return next;
  }

  unpin(id: string): void {
    if (!PIN_ID.test(id)) throw new BackupError("That isn't a protection name.");
    rmSync(join(this.root, "pins", `${id}.json`), { force: true });
    if (existsSync(join(this.root, "pins"))) syncRecoveryDirectory(join(this.root, "pins"));
  }

  /** Every pin. Throws if any pin can't be read: cleanup then retires nothing. */
  pins(): SnapshotPin[] {
    const dir = join(this.root, "pins");
    if (!existsSync(dir)) return [];
    const out: SnapshotPin[] = [];
    for (const name of readdirSync(dir)) {
      // What the operating system leaves in a folder someone has opened (.DS_Store,
      // desktop.ini) is stepped over, not removed. Anything else unrecognised still
      // stops here: it could be a protection under a changed name.
      if (name.endsWith(".tmp") || isOsJunkFile(name)) continue;
      if (!name.endsWith(".json") || !PIN_ID.test(name.slice(0, -5))) throw new BackupError(`The backup folder has a file Hearthside doesn't recognise in its "pins" folder (${name.slice(0, 80)}). Move it out of there and try again; nothing was changed.`);
      out.push(this.readPin(join(dir, name), name.slice(0, -5)));
    }
    return out;
  }

  private readPin(file: string, id: string): SnapshotPin {
    let pin: unknown;
    try { pin = JSON.parse(readFileSync(file, "utf8")); } catch { pin = null; }
    if (!isRecord(pin) || pin.id !== id || typeof pin.agentId !== "string" || typeof pin.snapshotId !== "string" || !SNAPSHOT_ID.test(pin.snapshotId)) throw new BackupError("A protection in this backup folder is damaged.");
    return pin as SnapshotPin;
  }

  /**
   * `skipped` says why nothing was retired or removed when cleanup had to hold back
   * (the lock is held, a protection can't be read, a folder can't be listed), so the
   * caller can say so instead of old backups quietly piling up.
   */
  prune(keepDays: number, now = Date.now()): { snapshots: number; objects: number; skipped: string[] } {
    let removedSnapshots = 0;
    const skipped: string[] = [];
    const why = (error: unknown) => (error instanceof BackupError ? error.message : "The backup folder couldn't be read.");
    // Snapshots are retired under the pin lock; if it's held elsewhere, none are this time.
    try { removedSnapshots = this.withPinLock(() => this.retireSnapshots(keepDays, now, (error) => skipped.push(`Old backups were kept: ${why(error)}`))); }
    catch (error) { removedSnapshots = 0; skipped.push(`Old backups were kept: ${why(error)}`); }
    const objects = this.removeUnreferenced(removedSnapshots, (error) => skipped.push(`Unused pieces were kept: ${why(error)}`));
    return { snapshots: removedSnapshots, objects, skipped };
  }

  private retireSnapshots(keepDays: number, now: number, onSkipped?: (error: unknown) => void): number {
    const cutoff = now - keepDays * 86_400_000;
    let removedSnapshots = 0;
    const companions = join(this.root, "companions");
    const folders = existsSync(companions) ? readdirSync(companions) : [];
    // Hearthside: snapshots a recovery depends on are never retired. If the pins can't
    // be read, no snapshot is (fail closed); unreferenced pieces may still go below.
    let pinned: Set<string> | null;
    try { pinned = new Set(this.pins().map((pin) => `${safeName(pin.agentId)}/${pin.snapshotId}`)); } catch (error) { pinned = null; onSkipped?.(error); }
    for (const folder of pinned ? folders : []) {
      const snapshots = this.listSnapshotsIn(join(companions, folder, "snapshots"));
      // The newest is always kept. So is the newest that isn't marked as having failed
      // its check: otherwise one bad backup, being the newest, would be the one kept
      // while the last good ones aged out behind it.
      const newestGood = [...snapshots].reverse().find((item) => !existsSync(this.failedCheckPath(item.file)));
      for (const item of snapshots.slice(0, -1)) {
        const { file, header } = item;
        if (item === newestGood) continue;
        if (!(Date.parse(header.at) < cutoff)) continue;
        if (pinned!.has(`${folder}/${header.id}`)) continue;
        // Only a snapshot that opens and matches its sealed copy is retired.
        try {
          this.openSnapshotFile(file);
        } catch {
          continue;
        }
        rmSync(file, { force: true });
        rmSync(this.failedCheckPath(file), { force: true });
        removedSnapshots += 1;
      }
    }
    return removedSnapshots;
  }

  /** Unfiltered GC inventory. Never follow links, including directory links. */
  private snapshotCandidatesForGC(): string[] {
    const companions = join(this.root, "companions");
    const directory = (path: string): boolean => {
      try {
        if (!lstatSync(path).isDirectory()) throw new BackupError("An unsafe backup directory prevents cleanup.");
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    if (!directory(companions)) return [];
    const files: string[] = [];
    for (const folder of readdirSync(companions)) {
      const companion = join(companions, folder);
      // A .DS_Store or desktop.ini beside the companions' folders holds no snapshots.
      // Only a plain file by one of those names is stepped over; a link still stops cleanup.
      if (isOsJunkFile(folder) && lstatSync(companion).isFile()) continue;
      if (!directory(companion)) throw new BackupError("A backup directory disappeared during cleanup.");
      const snapshots = join(companion, "snapshots");
      if (!directory(snapshots)) continue;
      for (const name of readdirSync(snapshots)) {
        if (!name.endsWith(".json") || !SNAPSHOT_ID.test(name.slice(0, -5))) continue;
        const file = join(snapshots, name);
        if (!lstatSync(file).isFile()) throw new BackupError("An unsafe snapshot prevents cleanup.");
        files.push(file);
      }
    }
    return files;
  }

  /** Pieces no snapshot names any more. Returns 0 without deleting if any snapshot can't be read. */
  private removeUnreferenced(removedSnapshots: number, onSkipped?: (error: unknown) => void): number {
    const referenced = new Set<string>();
    // Display listing deliberately hides broken headers. GC must instead inspect
    // every snapshot-shaped candidate, or a hidden but recoverable manifest could
    // lose its pieces. Enumeration errors and links also make reachability unknown.
    let candidates: string[];
    try { candidates = this.snapshotCandidatesForGC(); } catch (error) { onSkipped?.(error); return 0; }
    for (const file of candidates) {
      let snapshot: Snapshot;
      try {
        snapshot = this.openSnapshotFile(file);
      } catch {
        onSkipped?.(new BackupError("One of the backups in the folder can't be opened, so it isn't known which pieces are still needed."));
        return 0;
      }
      for (const entry of snapshot.entries) {
        referenced.add(entry.hash);
        if (entry.kind === "conversation") {
          try {
            for (const ref of this.referencesOf(entry)) referenced.add(ref);
          } catch {
            onSkipped?.(new BackupError("One of the backups in the folder has a chat that can't be read, so it isn't known which pictures are still needed."));
            return 0;
          }
        }
      }
    }
    let removedObjects = 0;
    const objects = join(this.root, "objects");
    for (const shard of existsSync(objects) ? readdirSync(objects) : []) {
      const shardDir = join(objects, shard);
      if (!lstatSync(shardDir).isDirectory()) continue;
      for (const name of readdirSync(shardDir)) {
        if (!HASH.test(name) || referenced.has(name)) continue;
        const path = join(shardDir, name);
        if (!lstatSync(path).isFile()) continue;
        rmSync(path, { force: true });
        removedObjects += 1;
      }
    }
    void removedSnapshots;
    return removedObjects;
  }

  /** Bytes on disk, for the settings page. */
  sizeOnDisk(): number {
    let total = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else total += stat.size;
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return total;
  }
}

export const LOCK_HELD = "Another Hearthside is tidying or restoring from this backup folder. Try again when it has finished. If no other Hearthside uses this folder, delete the file pins.lock in it.";

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function readMeta(root: string): Meta {
  const path = join(root, STORE_MARKER);
  if (!existsSync(path)) throw new BackupError("That folder doesn't hold a Hearthside backup.");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Meta;
  if (meta.version !== LEGACY_STORE_VERSION && meta.version !== STORE_VERSION) throw new BackupError(`This backup was made by a newer Hearthside (format ${meta.version}). Update Hearthside to open it.`);
  if (!STORE_ID.test(meta.storeId) || typeof meta.createdAt !== "string") throw new BackupError("That backup folder has an invalid identity marker.");
  return meta;
}

function readWrapped(root: string): Wrapped {
  const path = join(root, "keys", "recovery.json");
  if (!existsSync(path)) throw new BackupError("The backup folder is missing its keys/recovery.json; it can't be opened.");
  return JSON.parse(readFileSync(path, "utf8")) as Wrapped;
}

/** Public SHA-256 integrity hash for portable data/provenance, not a native v2 object ID. */
export function objectHash(bytes: Buffer): string {
  return sha256(bytes);
}
