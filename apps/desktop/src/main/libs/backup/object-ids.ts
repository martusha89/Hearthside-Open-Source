import { BackupError, BackupStore, hashBytes, validateSnapshotEntries, type Snapshot, type SnapshotEntry } from "./store";
import { drain } from "./breathe";

const HASH = /^[0-9a-f]{64}$/;
const MAX_MESSAGES_PER_CHUNK = 1_000_000;
const MAX_ATTACHMENT_RECORDS = 100_000;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Rewrite only Hearthside's reserved structured reference fields. Arbitrary
 * strings are data, even when they happen to contain an object ID or the field
 * name. Unchanged input is returned byte-for-byte so legacy SHA stores retain
 * their exact portable representation.
 */
export function convertConversationObjectReferences(bytes: Buffer, resolve: (id: string) => string): Buffer {
  const text = bytes.toString("utf8");
  if (!text.trim()) return bytes;
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasFinalNewline) lines.pop();
  if (lines.length > MAX_MESSAGES_PER_CHUNK) throw new BackupError("A conversation piece contains too many messages.");
  let changed = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!record(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key.endsWith("_hearthside_object")) {
        if (typeof inner !== "string" || !HASH.test(inner)) throw new BackupError("A conversation has an invalid picture reference.");
        const replacement = resolve(inner);
        if (!HASH.test(replacement)) throw new BackupError("A conversation refers to an unknown backup picture.");
        if (replacement !== inner) { value[key] = replacement; changed = true; }
      } else visit(inner);
    }
  };
  const messages = lines.map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new BackupError("A conversation contains malformed JSON."); }
    if (!record(value) || typeof value.id !== "string" || !value.id.trim()) throw new BackupError("A conversation message has no valid id.");
    visit(value);
    return value;
  });
  return changed ? Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n") + (hasFinalNewline ? "\n" : "")) : bytes;
}

/** Version-1 capture inventory has one explicitly object-bearing field. */
export function convertAttachmentInventoryReferences(bytes: Buffer, resolve: (id: string, declaredSize: number) => string): Buffer {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new BackupError("An attachment inventory contains malformed JSON."); }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENT_RECORDS) throw new BackupError("An attachment inventory has an unsupported shape.");
  let changed = false;
  for (const item of value.attachments) {
    if (!record(item) || !["captured", "omitted", "unresolved-external"].includes(String(item.status))) throw new BackupError("An attachment inventory has an invalid record.");
    if (item.status !== "captured") continue;
    if (typeof item.hash !== "string" || !HASH.test(item.hash) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) throw new BackupError("A captured attachment has an invalid hash or size.");
    const replacement = resolve(item.hash, item.size);
    if (!HASH.test(replacement)) throw new BackupError("An attachment inventory refers to an unknown backup object.");
    if (replacement !== item.hash) { item.hash = replacement; changed = true; }
  }
  return changed ? Buffer.from(JSON.stringify(value)) : bytes;
}

type CanonicalSource = { nativeHash: string; references?: Map<string, string>; structuredKind?: "conversation" | "attachment-inventory" };

export type CanonicalSnapshotView = {
  snapshot: Snapshot;
  objects: string[];
  readObject(hash: string): Buffer;
};

/**
 * Present any native store as the public portable SHA-256 namespace. The view
 * stores only IDs; bytes are read and converted again on demand by the streaming
 * writer. Referenced pictures are registered before their parent transcript.
 */
export function* canonicalSnapshotViewSteps(store: BackupStore, snapshot: Snapshot): Generator<void, CanonicalSnapshotView, undefined> {
  validateSnapshotEntries(snapshot.entries);
  if (snapshot.objects !== new Set(snapshot.entries.map((entry) => entry.hash)).size || snapshot.bytes !== snapshot.entries.reduce((total, entry) => total + entry.size, 0)) {
    throw new BackupError("Snapshot object or byte totals do not match its entries.");
  }
  const sources = new Map<string, CanonicalSource>();
  const objects: string[] = [];
  const add = (canonical: string, source: CanonicalSource) => {
    if (!sources.has(canonical)) { sources.set(canonical, source); objects.push(canonical); }
  };
  const convertedEntries: SnapshotEntry[] = [];
  for (const entry of snapshot.entries) {
    yield;
    const nativeBytes = store.getObject(entry.hash);
    if (nativeBytes.length !== entry.size) throw new BackupError("A snapshot entry's declared size differs from its bytes.");
    let portableBytes = nativeBytes;
    let references: Map<string, string> | undefined;
    if (entry.kind === "conversation" || entry.kind === "attachment-inventory") {
      references = new Map<string, string>();
      const referenceSizes = new Map<string, number>();
      const resolve = (nativeId: string, declaredSize?: number) => {
        const prior = references!.get(nativeId);
        if (prior) {
          if (declaredSize !== undefined && referenceSizes.get(nativeId) !== declaredSize) throw new BackupError("A captured attachment's declared size differs from its bytes.");
          return prior;
        }
        const picture = store.getObject(nativeId);
        if (declaredSize !== undefined && picture.length !== declaredSize) throw new BackupError("A captured attachment's declared size differs from its bytes.");
        const canonical = hashBytes(picture);
        references!.set(nativeId, canonical);
        referenceSizes.set(nativeId, picture.length);
        add(canonical, { nativeHash: nativeId });
        return canonical;
      };
      portableBytes = entry.kind === "conversation"
        ? convertConversationObjectReferences(nativeBytes, resolve)
        : convertAttachmentInventoryReferences(nativeBytes, resolve);
    }
    const canonical = hashBytes(portableBytes);
    add(canonical, { nativeHash: entry.hash, ...(references ? { references, structuredKind: entry.kind as "conversation" | "attachment-inventory" } : {}) });
    let path = entry.path;
    if (entry.kind === "attachment") {
      if (/^attachments\/[a-f0-9]{64}$/.test(entry.path)) {
        if (entry.path !== `attachments/${entry.hash}`) throw new BackupError("A generated attachment entry has an inconsistent path.");
        path = `attachments/${canonical}`;
      }
    }
    convertedEntries.push({ ...entry, path, hash: canonical, size: portableBytes.length });
  }
  if (store.version === 1) objects.sort();
  const entries = convertedEntries;
  const canonicalSnapshot: Snapshot = {
    ...snapshot,
    entries,
    objects: new Set(entries.map((entry) => entry.hash)).size,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
  return {
    snapshot: canonicalSnapshot,
    objects,
    readObject(hash: string): Buffer {
      const source = sources.get(hash);
      if (!source) throw new BackupError("A portable backup refers to an unknown piece.");
      const native = store.getObject(source.nativeHash);
      const bytes = source.structuredKind === "conversation"
        ? convertConversationObjectReferences(native, (id) => source.references!.get(id) ?? "")
        : source.structuredKind === "attachment-inventory"
          ? convertAttachmentInventoryReferences(native, (id) => source.references!.get(id) ?? "")
          : native;
      if (hashBytes(bytes) !== hash) throw new BackupError("The backup changed while its portable view was being written.");
      return bytes;
    },
  };
}

export function canonicalSnapshotView(store: BackupStore, snapshot: Snapshot): CanonicalSnapshotView {
  return drain(canonicalSnapshotViewSteps(store, snapshot));
}

export function* canonicalSnapshotIdentitySteps(store: BackupStore, snapshot: Snapshot): Generator<void, string, undefined> {
  const view = yield* canonicalSnapshotViewSteps(store, snapshot);
  return hashBytes(Buffer.from(JSON.stringify(view.snapshot)));
}

export function canonicalSnapshotIdentity(store: BackupStore, snapshot: Snapshot): string {
  return drain(canonicalSnapshotIdentitySteps(store, snapshot));
}
