import { createHash, randomUUID } from "node:crypto";
import { breathe, drain, drainAsync } from "./breathe";
import { isOsJunkFile } from "./os-junk";
import { spawn } from "node:child_process";
import { createAppServerClient, type AppServerRawResponse } from "@letta-ai/letta-code/app-server-client";
import { rm } from "node:fs/promises";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/** Version-locked native archive adapter. Never converts projected API messages. */
export const NATIVE_RUNTIME_VERSION = "0.34.36" as const;
/**
 * Archives captured under these runtimes restore into the current one. This is a
 * reviewed list, never a range: 0.34.23 is listed because the local store's on-disk
 * writers (agents/*.json, conversation.json, manifest.json, messages.jsonl,
 * system-prompt.json) are byte-for-byte the same code in 0.34.36; that upgrade only
 * changed read paths (streaming JSONL reads, images omitted from out-of-context
 * history). Capture and the live runtime check still demand NATIVE_RUNTIME_VERSION.
 */
export const RESTORABLE_RUNTIME_VERSIONS = ["0.34.23", NATIVE_RUNTIME_VERSION] as const;
export type RestorableRuntimeVersion = (typeof RESTORABLE_RUNTIME_VERSIONS)[number];
export interface NativeArchive {
  version: 1;
  runtimeVersion: RestorableRuntimeVersion;
  sourceAgentId: string;
  files: NativeFile[];


  visibility?: "source";
}


export type NativeFile = { path: string; bytes: Buffer; size?: number; sha256?: string };
type RecordValue = Record<string, unknown>;
export interface NativeConversationExpectation {
  id: string;
  inContextMessageIds: string[];
  messageIds: string[];
  compactions: { messageId: string; summary: string }[];
  /** Shape of each written row, by message ID (no text): names a missing row precisely. */
  rows?: Map<string, { role: string; bytes: number; index: number; parentOk: boolean; contentKind: string }>;
}
export interface NativeObservation {
  runtimeVersion: string;
  agentId: string;
  conversations: NativeConversationExpectation[];
}
export interface NativeVerificationInput {
  storageDir: string;
  agentId: string;
  expectedConversations: NativeConversationExpectation[];
}
/** Must start/read/stop an isolated pinned native runtime, never a session/send. */
export type NativeVerifier = (input: NativeVerificationInput) => Promise<NativeObservation>;
interface ConversationData { prefix: string; record: RecordValue; rows: RecordValue[] }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (s: string) => Buffer.from(s).toString("base64url");
const agentPath = (id: string) => `agents/${encode(id)}.json`;
const conversationPrefix = (id: string, agent: string) => `conversations/${encode(id === "default" ? `default:${agent}` : `conversation:${id}`)}`;
const fail = (message: string): never => { throw new Error(`Native recovery: ${message}`); };
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`);
  return value as RecordValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) fail(`invalid ${label}`);
  return value as string;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) fail(`invalid ${label}`);
  return value as string[];
}
function json(bytes: Buffer, label: string): RecordValue {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return record(JSON.parse(text), label);
  } catch { return fail(`invalid JSON/UTF-8: ${label}`); }
}
function version(value: string) { if (value !== NATIVE_RUNTIME_VERSION) fail(`unsupported runtime ${value}`); }
function restorableVersion(value: string) { if (!(RESTORABLE_RUNTIME_VERSIONS as readonly string[]).includes(value)) fail(`unsupported runtime ${value}`); }
function localId(id: string) { if (!/^agent-local-[a-zA-Z0-9-]+$/.test(id)) fail("not a local agent ID"); }
function directory(path: string): void {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe directory ${current}`);
  }
}
function readSafe(path: string): Buffer {
  directory(dirname(path));
  // O_NOFOLLOW alone is not a portable file-link guard (notably on Windows).
  // Inspect the leaf without following it, then compare the opened handle and
  // pathname identities. Keep O_NOFOLLOW as additional protection where supported.
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 128n * 1024n * 1024n) fail(`unsafe or oversized file ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 128n * 1024n * 1024n ||
        !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        before.dev !== stat.dev || before.ino !== stat.ino || after.dev !== stat.dev || after.ino !== stat.ino) {
      fail(`unsafe or oversized file ${path}`);
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
const MAX_NATIVE_FILE = 128 * 1024 * 1024;
const MAX_NATIVE_FILES = 200_001;

/** Read once to record size and hash; every later access re-reads and must match. */
export function diskFile(path: string, absolute: string): NativeFile {
  const first = readSafe(absolute);
  const size = first.length, sha256 = hash(first);
  return {
    path, size, sha256,
    get bytes(): Buffer {
      const now = readSafe(absolute);
      if (now.length !== size || hash(now) !== sha256) fail(`native file changed since it was read: ${path}`);
      return now;
    },
  } as NativeFile;
}
function fileHash(file: NativeFile): string { return file.sha256 ?? hash(file.bytes); }
function fingerprint(files: NativeArchive["files"]): string {
  return hash(JSON.stringify(files.map((f): [string, string] => [f.path, fileHash(f)]).sort((a, b) => a[0].localeCompare(b[0]))));
}
function identityFingerprint(storageDir: string, files: NativeArchive["files"]): string {
  const paths = new Set([resolve(storageDir), ...files.flatMap((file) => [join(storageDir, file.path), dirname(join(storageDir, file.path))])]);
  return hash(JSON.stringify([...paths].sort().map((path) => { const stat = lstatSync(path); return [path, stat.dev, stat.ino, stat.mode, stat.nlink]; })));
}
function readOwned(storageDir: string, agentId: string): NativeArchive["files"] {
  return drain(readOwnedSteps(storageDir, agentId));
}
/** Hearthside: the same, one file per step, so a big companion doesn't freeze the window. */
function readOwnedAsync(storageDir: string, agentId: string): Promise<NativeArchive["files"]> {
  return drainAsync(readOwnedSteps(storageDir, agentId));
}
function* readOwnedSteps(storageDir: string, agentId: string): Generator<void, NativeArchive["files"], undefined> {
  directory(storageDir);
  // Disk-backed: each file is hashed as it is read and released; nothing is held.
  const files: NativeFile[] = [diskFile(agentPath(agentId), join(storageDir, agentPath(agentId)))];
  const root = join(storageDir, "conversations");
  if (!existsSync(root)) return files;
  directory(root);
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // A .DS_Store or desktop.ini left by the operating system is no conversation. One of
    // those used to stop the capture, and the restore check, of every companion on this
    // computer. A plain file by one of those names is stepped over (never removed);
    // anything else that isn't a conversation folder still stops here.
    if (entry.isFile() && isOsJunkFile(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unsafe conversation directory entry");
    const dir = join(root, entry.name);
    const conv = json(readSafe(join(dir, "conversation.json")), "conversation");
    if (conv.agent_id !== agentId) continue;
    const prefix = conversationPrefix(string(conv.id, "conversation ID"), agentId);
    if (prefix !== `conversations/${entry.name}`) fail("conversation path does not match identity");
    for (const name of readdirSync(dir).sort()) {
      if (!["conversation.json", "manifest.json", "messages.jsonl", "system-prompt.json"].includes(name)) fail(`unknown native file ${name}`);
      if (files.length >= MAX_NATIVE_FILES) fail("native archive capture limit exceeded");
      yield;
      files.push(diskFile(`${prefix}/${name}`, join(dir, name)));
    }
  }
  return files;
}

type ArchiveIndex = { files: Map<string, NativeFile>; agent: RecordValue; prefixes: string[] };
/** Paths, sizes and the agent record; reads no transcript. */
function indexArchive(archive: NativeArchive): ArchiveIndex {
  if (archive.version !== 1) fail("unsupported archive version");
  restorableVersion(archive.runtimeVersion); localId(archive.sourceAgentId);
  if (!Array.isArray(archive.files) || archive.files.length > MAX_NATIVE_FILES) fail("invalid file inventory");
  const files = new Map<string, NativeFile>();
  let inMemory = 0;
  for (const file of archive.files) {
    if (!file || typeof file.path !== "string" || !/^(agents\/[A-Za-z0-9_-]+\.json|conversations\/[A-Za-z0-9_-]+\/(conversation\.json|manifest\.json|messages\.jsonl|system-prompt\.json))$/.test(file.path)) fail("unsafe archive path or bytes");
    if (files.has(file.path)) fail("duplicate archive path");
    // A disk-backed file states its size; an in-memory one is measured, and only those
    // count towards the in-memory total (they are all held at once).
    let size: number;
    if (typeof file.size === "number") size = file.size;
    else {
      if (!Buffer.isBuffer(file.bytes)) fail("unsafe archive path or bytes");
      size = file.bytes.length; inMemory += size;
    }
    if (inMemory > 256 * 1024 * 1024 || size > MAX_NATIVE_FILE) fail("archive size limit exceeded");
    files.set(file.path, file);
  }
  const agentFile = files.get(agentPath(archive.sourceAgentId));
  if (!agentFile) fail("missing agent record");
  const agent = json(agentFile!.bytes, "agent record");
  if (agent.id !== archive.sourceAgentId) fail("agent identity mismatch");
  for (const key of Object.keys(agent)) if (!["id", "name", "description", "system", "tags", "model", "model_settings", "hidden", "compaction_settings"].includes(key)) fail(`unsupported agent field ${key}`);
  string(agent.name, "agent name"); string(agent.model, "model");
  if (typeof agent.system !== "string") fail("invalid system prompt");
  strings(agent.tags, "agent tags"); record(agent.model_settings, "model settings");
  for (const path of files.keys()) if (path.startsWith("agents/") && path !== agentPath(archive.sourceAgentId)) fail("foreign agent record");
  const prefixes = [...new Set([...files.keys()].filter((p) => p.startsWith("conversations/")).map((p) => p.slice(0, p.lastIndexOf("/"))))];
  return { files, agent, prefixes };
}

/** One conversation, read and validated; only its own files are in memory. */
function readConversation(archive: NativeArchive, files: Map<string, NativeFile>, prefix: string, ids: Set<string>): ConversationData {
    const get = (name: string): Buffer => { const file = files.get(`${prefix}/${name}`); if (!file) fail(`missing ${name}`); return file!.bytes; };
    const conv = json(get("conversation.json"), "conversation");
    for (const key of Object.keys(conv)) if (!["id", "agent_id", "archived", "archived_at", "context_window_limit", "created_at", "created_by_id", "description", "in_context_message_ids", "last_message_at", "last_updated_by_id", "model", "model_settings", "summary", "updated_at", "hidden", "tags", "system", "parent_agent_id", "is_subagent", "name", "agent_free"].includes(key)) fail(`unsupported conversation field ${key}`);
    const id = string(conv.id, "conversation ID");
    if (conv.agent_id !== archive.sourceAgentId || conv.agent_free === true || conv.parent_agent_id != null) fail("foreign/agent-free conversation ownership");
    if (prefix !== conversationPrefix(id, archive.sourceAgentId) || ids.has(id)) fail("conversation identity/path collision");
    ids.add(id);
    const active = strings(conv.in_context_message_ids, "active message IDs");
    if (new Set(active).size !== active.length) fail("duplicate active message IDs");
    const manifest = json(get("manifest.json"), "manifest");
    if (manifest.schema_version !== 2 || manifest.message_format !== "pi-session-entry-jsonl" || manifest.provider_stack !== "pi-ai") fail("unsupported native transcript format");
    const bytes = files.get(`${prefix}/messages.jsonl`)?.bytes;
    const rows: RecordValue[] = [];
    if (bytes?.length) {
      const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) { if (!line.trim()) fail("blank transcript line"); rows.push(json(Buffer.from(line), "transcript line")); }
      const header = rows[0]!;
      if (header.type !== "session" || header.version !== 3 || header.id !== id || typeof header.cwd !== "string") fail("invalid transcript session header");
      string(header.timestamp, "session timestamp");
    }
    const entries = new Set<string>(); const messages = new Set<string>();
    for (const row of rows.slice(1)) {
      if (row.type !== "message" && row.type !== "compaction") fail("unknown transcript entry");
      const entryId = string(row.id, "entry ID");
      if (entries.has(entryId)) fail("duplicate entry ID");
      if (row.parentId !== null && (typeof row.parentId !== "string" || !entries.has(row.parentId))) fail("dangling entry parent");
      if (row.parentId === null && entries.size > 0) fail("disconnected transcript ancestry");
      string(row.timestamp, "entry timestamp");
      if (row.type === "compaction") {
        if (typeof row.summary !== "string" || typeof row.tokensBefore !== "number" || !Number.isFinite(row.tokensBefore) || row.tokensBefore < 0) fail("malformed compaction");
        if (row.firstKeptEntryId !== null && (typeof row.firstKeptEntryId !== "string" || !entries.has(row.firstKeptEntryId))) fail("dangling compaction entry reference");
      }
      const rowKeys = row.type === "message" ? ["type", "id", "parentId", "timestamp", "message"] : ["type", "id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore", "message", "details"];
      if (Object.keys(row).some((key) => !rowKeys.includes(key))) fail("unsupported transcript entry field");
      const message = record(row.message, "native message");
      const messageKeys = ["id", "role", "content", "timestamp", "metadata", ...(message.role === "user" ? ["otid"] : message.role === "assistant" ? ["api", "provider", "model", "usage", "stopReason", "errorMessage"] : ["toolCallId", "toolName", "isError", "details"])];
      if (Object.keys(message).some((key) => !messageKeys.includes(key))) fail("unsupported native message field");
      const messageId = string(message.id, "message ID");
      if (!["user", "assistant", "toolResult"].includes(String(message.role))) fail("unknown native message role");
      if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) fail("invalid message timestamp");
      if (typeof message.content !== "string" && !Array.isArray(message.content)) fail("invalid native message content");
      if (message.role !== "user" && !Array.isArray(message.content)) fail("invalid assistant/tool content");
      if (Array.isArray(message.content)) for (const value of message.content) {
        const part = record(value, "content part");
        const permitted = message.role === "assistant" ? ["text", "thinking", "toolCall"] : ["text", "image"];
        if (!permitted.includes(String(part.type))) fail("unsupported native content part");
        if (part.type === "text" && typeof part.text !== "string") fail("malformed text content");
        if (part.type === "thinking" && typeof part.thinking !== "string") fail("malformed thinking content");
        if (part.type === "image") { string(part.data, "image data"); string(part.mimeType, "image MIME type"); }
        if (part.type === "toolCall") { string(part.id, "tool call ID"); string(part.name, "tool call name"); record(part.arguments, "tool arguments"); }
      }
      if (message.role === "assistant") { string(message.api, "assistant api"); string(message.provider, "assistant provider"); string(message.model, "assistant model"); record(message.usage, "assistant usage"); }
      if (message.role === "toolResult") { string(message.toolCallId, "tool call ID"); string(message.toolName, "tool name"); if (typeof message.isError !== "boolean") fail("invalid tool result"); }
      if (message.metadata !== undefined) {
        const metadata = record(message.metadata, "message metadata");
        if (Object.keys(metadata).some((key) => !["created_at", "updated_at", "agent_id", "conversation_id", "provider", "compaction"].includes(key))) fail("unsupported native metadata field");
        if (metadata.agent_id !== undefined && metadata.agent_id !== archive.sourceAgentId) fail("foreign message agent reference");
        if (metadata.conversation_id !== undefined && metadata.conversation_id !== id) fail("foreign message conversation reference");
        if (metadata.compaction !== undefined) {
          const compaction = record(metadata.compaction, "compaction metadata");
          if (typeof compaction.summary !== "string") fail("invalid compaction metadata");
          if (row.type === "compaction" && compaction.summary !== row.summary) fail("compaction summary mismatch");
        } else if (row.type === "compaction") fail("missing compaction metadata");
      } else if (row.type === "compaction") fail("missing compaction metadata");
      entries.add(entryId); messages.add(messageId);
    }
    if (active.some((id) => !messages.has(id))) fail("dangling active message IDs");
    const prompt = files.get(`${prefix}/system-prompt.json`)?.bytes;
    if (prompt) {
      const p = json(prompt, "compiled system prompt");
      if (typeof p.content !== "string" || typeof p.coreMemory !== "string" || typeof p.rawSystemHash !== "string") fail("invalid compiled system prompt");
      string(p.compiledAt, "compiled prompt timestamp");
    }
    return { prefix, record: conv, rows };
}

/** Every conversation, one at a time: nothing from a previous one is retained by this. */
function* conversationsOf(archive: NativeArchive, index = indexArchive(archive)): Generator<ConversationData> {
  const ids = new Set<string>();
  for (const prefix of index.prefixes) yield readConversation(archive, index.files, prefix, ids);
}

function inspect(archive: NativeArchive): { agent: RecordValue; conversations: ConversationData[] } {
  const index = indexArchive(archive);
  return { agent: index.agent, conversations: [...conversationsOf(archive, index)] };
}
export function validateNativeArchive(archive: NativeArchive): NativeConversationExpectation[] {
  return drain(validateSteps(archive));
}
/** Hearthside: the same, one conversation per step. */
export function validateNativeArchiveAsync(archive: NativeArchive): Promise<NativeConversationExpectation[]> {
  return drainAsync(validateSteps(archive));
}
export function* validateSteps(archive: NativeArchive): Generator<void, NativeConversationExpectation[], undefined> {
  const expectations: NativeConversationExpectation[] = [];
  for (const { record: conv, rows } of conversationsOf(archive)) {
    yield;
    expectations.push((() => {
    const latest = new Map<string, RecordValue>();
    const shapes = new Map<string, { role: string; bytes: number; index: number; parentOk: boolean; contentKind: string }>();
    const entryIdsSeen = new Set<string>([rows[0]?.id as string]);
    for (const [index, row] of rows.slice(1).entries()) {
      const message = row.message as RecordValue; latest.set(message.id as string, message);
      const content = message.content;
      const contentKind = row.type === "compaction" ? "compaction" : typeof content === "string" ? (content.trim() ? "text" : "empty-text") : Array.isArray(content) ? `parts:${content.map((part) => (part as RecordValue)?.type ?? "?").join("+") || "none"}` : typeof content;
      shapes.set(message.id as string, { role: String(message.role ?? row.type), bytes: Buffer.byteLength(JSON.stringify(row)), index: index + 1, parentOk: row.parentId === null || entryIdsSeen.has(row.parentId as string), contentKind });
      entryIdsSeen.add(row.id as string);
    }
    const active = [...conv.in_context_message_ids as string[]];
    // Native public reads expose the active logical window, not superseded JSONL
    // entries. Historical bytes and every compaction entry are hash-verified too.
    const messageIds = active.length ? active : [...latest.keys()];
    return {
      id: conv.id as string, inContextMessageIds: active, messageIds, rows: shapes,
      compactions: messageIds.flatMap((id) => {
        const metadata = latest.get(id)?.metadata as RecordValue | undefined;
        const compaction = metadata?.compaction as RecordValue | undefined;
        return compaction ? [{ messageId: id, summary: compaction.summary as string }] : [];
      }),
    };
  })());
  }
  return expectations;
}
export async function captureNativeState(options: {
  storageDir: string; agentId: string; runtimeVersion: string; assertQuiescent: () => Promise<void> | void;
}): Promise<NativeArchive> {
  version(options.runtimeVersion); localId(options.agentId);
  await options.assertQuiescent();
  const files = await readOwnedAsync(options.storageDir, options.agentId);
  const archive: NativeArchive = { version: 1, runtimeVersion: NATIVE_RUNTIME_VERSION, sourceAgentId: options.agentId, files };
  await validateNativeArchiveAsync(archive);
  await options.assertQuiescent();
  if (fingerprint(files) !== fingerprint(await readOwnedAsync(options.storageDir, options.agentId))) fail("source changed during capture");
  return archive;
}

export interface NativeRestorePlan {
  readonly destinationAgentId: string;
  readonly storageDir: string;
  readonly archive: NativeArchive;
  readonly expectedConversations: NativeConversationExpectation[];
  readonly conversationIds: Readonly<Record<string, string>>;
}
interface PlanPrivate { before: NativeArchive["files"]; beforeFingerprint: string; beforeIdentity: string; archiveFingerprint: string; used: boolean; assertOwnedFreshAgent: () => Promise<void> | void; assertQuiescent: () => Promise<void> | void }
const plans = new WeakMap<NativeRestorePlan, PlanPrivate>();
/**
 * Hearthside diagnostics (the one-chat replay only): keep the staged copy a failed runtime
 * read-back ran against, and hand the structured comparison (IDs and shapes, no text) to a
 * sink. Off in normal use: the staged copy is temporary and removed.
 */
export interface NativeMismatchDetail { conversationId: string; expectedMessageIds: string[]; runtimeMessageIds: string[]; expectedActive: string[]; runtimeActive: string[]; rows: Array<{ id: string; role: string; bytes: number; index: number; parentOk: boolean; contentKind: string }> }
let diagnostics: { retainFailedStaging: boolean; onMismatch?: (detail: NativeMismatchDetail) => void } = { retainFailedStaging: false };
export function configureNativeDiagnostics(options: typeof diagnostics): void { diagnostics = options; }
export async function createNativeRestorePlan(options: {
  archive: NativeArchive; destinationAgentId: string; storageDir: string;
  assertOwnedFreshAgent: () => Promise<void> | void;
  assertQuiescent: () => Promise<void> | void;
  /**
   * Hearthside: write the remapped archive here, one conversation at a time, instead of
   * holding it in memory. The caller owns (and removes) this directory.
   */
  stagingDir?: string;
}): Promise<NativeRestorePlan> {
  const source = indexArchive(options.archive); localId(options.destinationAgentId);
  if (options.destinationAgentId === options.archive.sourceAgentId) fail("destination must be fresh");
  await options.assertOwnedFreshAgent(); await options.assertQuiescent();
  const before = readOwned(options.storageDir, options.destinationAgentId);
  const existing: NativeArchive = { version: 1, runtimeVersion: NATIVE_RUNTIME_VERSION, sourceAgentId: options.destinationAgentId, files: before };
  if (validateNativeArchive(existing).some((c) => c.messageIds.length > 0 || c.inContextMessageIds.length > 0)) fail("destination is not an empty fresh agent");
  const conversationIds: Record<string, string> = Object.create(null);
  const files: NativeArchive["files"] = [];
  const serialize = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  // Create the app-owned staging directory first, then canonicalize it (macOS exposes
  // tmpdir() through the /var -> /private/var link). Canonicalizing a path that does
  // not exist yet throws ENOENT, which broke every large (disk-staged) restore.
  if (options.stagingDir) mkdirSync(options.stagingDir, { recursive: true, mode: 0o700 });
  const staging = options.stagingDir ? realpathSync(options.stagingDir) : undefined;
  if (staging) directory(staging);
  const out = (path: string, bytes: Buffer): NativeFile => {
    if (!staging) return { path, bytes };
    writeExclusive(staging, { path, bytes });

    const file = diskFile(path, join(staging, path));
    if (file.sha256 !== hash(bytes)) fail(`native file changed since it was written: ${path}`);
    return file;
  };
  const freshAgent = inspect(existing).agent;
  // Retain the freshly allocated recovery identity/labels, not live source tags
  // that external automation may use to discover agents.
  files.push(out(agentPath(options.destinationAgentId), serialize({
    ...source.agent, id: options.destinationAgentId,
    name: freshAgent.name, tags: freshAgent.tags, hidden: freshAgent.hidden ?? false,
  })));
  for (const conversation of conversationsOf(options.archive, source)) {
    await breathe();
    const oldId = conversation.record.id as string;
    const id = conversationIds[oldId] = oldId === "default" ? "default" : `local-conv-${randomUUID()}`;
    const prefix = conversationPrefix(id, options.destinationAgentId);
    const messageIds = new Map<string, string>(); const entryIds = new Map<string, string>();
    for (const row of conversation.rows.slice(1)) {
      const old = (row.message as RecordValue).id as string;
      if (!messageIds.has(old)) messageIds.set(old, `ui-msg-${randomUUID()}`);
      entryIds.set(row.id as string, randomUUID().replaceAll("-", "").slice(0, 16));
    }

    const hidden = conversation.record.hidden === true;
    const conv = { ...conversation.record, id, agent_id: options.destinationAgentId, in_context_message_ids: (conversation.record.in_context_message_ids as string[]).map((old) => messageIds.get(old)!), hidden };
    files.push(out(`${prefix}/conversation.json`, serialize(conv)));
    for (const name of ["manifest.json", "system-prompt.json"]) {
      const file = source.files.get(`${conversation.prefix}/${name}`);
      if (file) files.push(out(`${prefix}/${name}`, Buffer.from(file.bytes)));
    }
    const rows = conversation.rows.map((row, index) => {
      if (index === 0) return { ...row, id };
      const message = row.message as RecordValue;
      const metadata = message.metadata as RecordValue | undefined;
      return {
        ...row, id: entryIds.get(row.id as string), parentId: row.parentId === null ? null : entryIds.get(row.parentId as string),
        ...(row.type === "compaction" ? { firstKeptEntryId: row.firstKeptEntryId === null ? null : entryIds.get(row.firstKeptEntryId as string) } : {}),
        message: { ...message, id: messageIds.get(message.id as string), ...(metadata ? { metadata: { ...metadata, ...(metadata.agent_id !== undefined ? { agent_id: options.destinationAgentId } : {}), ...(metadata.conversation_id !== undefined ? { conversation_id: id } : {}) } } : {}) },
      };
    });
    if (source.files.has(`${conversation.prefix}/messages.jsonl`)) files.push(out(`${prefix}/messages.jsonl`, Buffer.from(rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "")));
  }
  const archive: NativeArchive = { version: 1, runtimeVersion: NATIVE_RUNTIME_VERSION, sourceAgentId: options.destinationAgentId, files, ...(options.archive.visibility === "source" ? { visibility: "source" as const } : {}) };
  const plan: NativeRestorePlan = { destinationAgentId: options.destinationAgentId, storageDir: resolve(options.storageDir), archive, expectedConversations: await validateNativeArchiveAsync(archive), conversationIds };
  plans.set(plan, { before, beforeFingerprint: fingerprint(before), beforeIdentity: identityFingerprint(options.storageDir, before), archiveFingerprint: fingerprint(files), used: false, assertOwnedFreshAgent: options.assertOwnedFreshAgent, assertQuiescent: options.assertQuiescent });
  Object.freeze(archive); Object.freeze(plan);
  return plan;
}


const READBACK_PAGE = 1_000_000;
/** Actual public protocol read-back against an isolated, credential-free local runtime. */
export async function verifyNativeStateWithRuntime(input: NativeVerificationInput, options: { cliPath: string; timeoutMs?: number }): Promise<NativeObservation> {
  const packageInfo = json(readSafe(join(dirname(options.cliPath), "package.json")), "runtime package");
  if (packageInfo.name !== "@letta-ai/letta-code") fail("unexpected runtime package");
  version(string(packageInfo.version, "runtime version"));
  // macOS reports tmpdir() through /var, an OS symlink to /private/var. Use
  // the canonical path for our own trusted temporary root so the recovery
  // guard can keep rejecting every symlink introduced beneath it.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hearthside-native-runtime-")));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(process.execPath, [options.cliPath, "--backend", "local", "server", "--listen", "ws://127.0.0.1:0"], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, LETTA_LOCAL_BACKEND_DIR: resolve(input.storageDir), LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1", ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let client: ReturnType<typeof createAppServerClient> | undefined;
  try {
    const url = await new Promise<string>((done, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Native runtime startup timeout")), timeoutMs);
      const cleanup = () => { clearTimeout(timer); child.stdout.off("data", data); child.stderr.off("data", data); };
      const data = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-65536);
        const match = output.match(/Listening on\s+(ws:\/\/\S+)/);
        if (match) { cleanup(); done(match[1]!); }
      };
      child.stdout.on("data", data); child.stderr.on("data", data);
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", () => { cleanup(); reject(new Error("Native runtime exited before readiness")); });
    });
    client = createAppServerClient({ url, requestTimeoutMs: timeoutMs }); await client.connect();
    let sequence = 0;
    const request = async (type: string, body: RecordValue): Promise<RecordValue> => {
      const response = await client!.requestRaw<AppServerRawResponse>({ type, request_id: `native-verify-${++sequence}`, ...body }, { timeoutMs, predicate: (value): value is AppServerRawResponse => !!value && typeof value === "object" && (value as RecordValue).type === `${type}_response` });
      if (response.success !== true) fail(`native ${type} failed: ${String(response.error)}`);
      return response;
    };
    const agent = record((await request("agent_retrieve", { agent_id: input.agentId })).agent, "native agent");
    if (agent.id !== input.agentId) fail("native agent identity mismatch");
    const listed: RecordValue[] = []; let after: string | undefined;
    for (;;) {
      const result = await request("conversation_list", { query: { agent_id: input.agentId, include_hidden: true, archive_status: "all", limit: 100, ...(after ? { after } : {}) } });
      if (!Array.isArray(result.conversations)) fail("invalid native conversation page");
      const page = (result.conversations as unknown[]).map((v) => record(v, "native conversation")); listed.push(...page);
      if (page.length < 100) break;
      const next = string(page.at(-1)!.id, "conversation cursor"); if (next === after || listed.slice(0, -page.length).some((v) => v.id === next)) fail("native conversation pagination stalled"); after = next;
    }
    if (input.expectedConversations.some((c) => c.id === "default")) listed.push({ id: "default", agent_id: input.agentId, in_context_message_ids: agent.in_context_message_ids ?? agent.message_ids });
    const conversations: NativeConversationExpectation[] = [];
    for (const conv of listed) {
      const id = string(conv.id, "native conversation ID");
      if (conv.agent_id !== input.agentId) fail("native runtime returned foreign conversation");
      const expected = input.expectedConversations.find((c) => c.id === id);
      if (!expected) fail("native runtime returned unexpected conversation");
      // Hearthside: everything in one request (READBACK_PAGE); cursors only after a full page.
      const messages: RecordValue[] = []; let before: string | undefined; const seen = new Set<string>();
      for (let pages = 0; pages < 1_000; pages++) {
        const page = await request("conversation_messages_list", { conversation_id: id, query: { agent_id: input.agentId, order: "desc", limit: READBACK_PAGE, ...(before ? { before } : {}) } });
        if (!Array.isArray(page.messages)) fail("invalid native messages page");
        const items = (page.messages as unknown[]).map((v) => record(v, "native projected message"));
        const fresh = items.filter((item) => !seen.has(string(item.id, "native message ID")));
        for (const item of fresh) seen.add(item.id as string);
        messages.push(...fresh);
        if (!fresh.length || (items.length < READBACK_PAGE && page.has_more !== true)) break;
        const next = string(page.next_before, "message cursor"); if (next === before) break; before = next;
      }
      // The projection may split an assistant message into multiple variants.
      const resolveId = (id: string) => expected!.messageIds.find((known) => id === known || id.startsWith(`${known}:`)) ?? id;
      conversations.push({ id, inContextMessageIds: strings(conv.in_context_message_ids, "native active IDs"), messageIds: [...new Set(messages.map((m) => resolveId(string(m.id, "native message ID"))))], compactions: messages.filter((m) => m.message_type === "summary_message").map((m) => ({ messageId: resolveId(string(m.id, "summary ID")), summary: typeof m.summary === "string" ? m.summary : fail("invalid native summary") })) });
    }
    return { runtimeVersion: NATIVE_RUNTIME_VERSION, agentId: input.agentId, conversations };
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000); timer.unref();
    await exited; clearTimeout(timer); await rm(home, { recursive: true, force: true });
  }
}





async function compareObservation(expected: NativeVerificationInput, actual: NativeObservation): Promise<void> {
  version(actual.runtimeVersion);
  if (actual.agentId !== expected.agentId) fail("native verifier returned wrong agent");
  const canonical = (c: NativeConversationExpectation) => JSON.stringify({ id: c.id, inContextMessageIds: c.inContextMessageIds, messageIds: [...new Set(c.messageIds)].sort(), compactions: c.compactions.map((v) => [v.messageId, v.summary]).sort() });
  const byId = (conversations: NativeConversationExpectation[]) => [...conversations].sort((a, b) => a.id.localeCompare(b.id));
  const wanted = byId(expected.expectedConversations), seen = byId(actual.conversations);
  const few = (ids: string[]) => ids.slice(0, 20).join(", ") + (ids.length > 20 ? `, … (${ids.length})` : "");
  const diff = (label: string, a: string[], b: string[]) => {
    const A = new Set(a), Bs = new Set(b);
    const onlyA = a.filter((id) => !Bs.has(id)), onlyB = b.filter((id) => !A.has(id));
    return onlyA.length || onlyB.length ? `${label}: archive ${a.length}, runtime ${b.length}${onlyA.length ? `; only in archive: ${few(onlyA)}` : ""}${onlyB.length ? `; only in runtime: ${few(onlyB)}` : ""}` : null;
  };
  if (wanted.length !== seen.length) {
    const w = new Set(wanted.map((c) => c.id)), s = new Set(seen.map((c) => c.id));
    fail(`native runtime read-back differs from archive: ${wanted.length} conversations written, ${seen.length} listed${[...w].some((id) => !s.has(id)) ? `; not listed: ${few([...w].filter((id) => !s.has(id)))}` : ""}${[...s].some((id) => !w.has(id)) ? `; unexpected: ${few([...s].filter((id) => !w.has(id)))}` : ""}`);
  }
  for (let index = 0; index < wanted.length; index++) {
    await breathe();
    const a = wanted[index]!, b = seen[index]!;
    if (canonical(a) === canonical(b)) continue;
    // Each missing row's shape (role, size, position, parent link, content kind), never its text.
    const shape = (id: string) => { const row = a.rows?.get(id); return row ? `${id} (${row.role}, ${row.contentKind}, ${row.bytes} B, row ${row.index}${row.parentOk ? "" : ", parent link broken"})` : `${id} (no row written)`; };
    const missingRows = [...new Set(a.messageIds)].filter((id) => !new Set(b.messageIds).has(id));
    try { diagnostics.onMismatch?.({ conversationId: a.id, expectedMessageIds: [...new Set(a.messageIds)], runtimeMessageIds: [...new Set(b.messageIds)], expectedActive: a.inContextMessageIds, runtimeActive: b.inContextMessageIds, rows: [...(a.rows ?? [])].map(([id, row]) => ({ id, ...row })) }); } catch { /* diagnostics only */ }
    const parts = [
      a.id !== b.id ? `conversation order: archive ${a.id}, runtime ${b.id}` : null,
      diff("messages", [...new Set(a.messageIds)], [...new Set(b.messageIds)]),
      missingRows.length ? `missing rows: ${missingRows.slice(0, 20).map(shape).join("; ")}${missingRows.length > 20 ? ` … (${missingRows.length})` : ""}` : null,
      JSON.stringify(a.inContextMessageIds) !== JSON.stringify(b.inContextMessageIds) ? `active context: archive ${a.inContextMessageIds.length} [${few(a.inContextMessageIds)}], runtime ${b.inContextMessageIds.length} [${few(b.inContextMessageIds)}]` : null,
      diff("compaction summaries (by message)", a.compactions.map((v) => v.messageId), b.compactions.map((v) => v.messageId)),
      (() => {
        // Same summaries by message, compared in one order (lengths only; never the text).
        const byMessage = new Map(b.compactions.map((v) => [v.messageId, v.summary]));
        const changed = a.compactions.filter((v) => byMessage.has(v.messageId) && byMessage.get(v.messageId) !== v.summary);
        return changed.length ? `compaction summary text differs for ${few(changed.map((v) => `${v.messageId} (archive ${v.summary.length} chars, runtime ${byMessage.get(v.messageId)!.length})`))}` : null;
      })(),
    ].filter(Boolean);
    fail(`native runtime read-back differs from archive in conversation ${a.id}: ${parts.join(" | ") || "same IDs, different order"}`);
  }
}
function writeExclusive(root: string, file: NativeArchive["files"][number]) {
  const path = join(root, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); directory(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, file.bytes); } finally { closeSync(fd); }
}
/**
 * The lifecycle callback must hold an exclusive owned-runtime stop lease through
 * publish, reloadAndVerify and any thrown error. Failed publication remains inactive.
 * No cross-process atomic snapshot is claimed; content and ownership are rechecked.
 */
export async function finalizeNativeRestore(plan: NativeRestorePlan, options: {
  verifyNative: NativeVerifier;
  withStoppedRuntime: (publish: () => Promise<void>) => Promise<void>;
  reloadAndVerify: NativeVerifier;
}): Promise<void> {
  const state = plans.get(plan);
  if (!state || state.used) fail("unknown or consumed restore plan");
  state!.used = true;
  if (state!.archiveFingerprint !== fingerprint(plan.archive.files)) fail("restore plan was modified");
  const expected = await validateNativeArchiveAsync(plan.archive);
  const staging = realpathSync(mkdtempSync(join(tmpdir(), "hearthside-native-")));
  let keepStaging = false;
  try {
    for (const file of plan.archive.files) { await breathe(); writeExclusive(staging, file); }
    const input = { storageDir: staging, agentId: plan.destinationAgentId, expectedConversations: expected };
    try { await compareObservation(input, await options.verifyNative(input)); }
    catch (error) {
      if (!diagnostics.retainFailedStaging) throw error;
      keepStaging = true;
      throw new Error(`${error instanceof Error ? error.message : String(error)} [staged copy kept at ${staging}]`);
    }
    if (fingerprint(await readOwnedAsync(staging, plan.destinationAgentId)) !== state!.archiveFingerprint) fail("native validation mutated staged archive");
    let published = false;
    await options.withStoppedRuntime(async () => {
      if (published) fail("publication callback invoked twice");
      await state!.assertOwnedFreshAgent(); await state!.assertQuiescent();
      if (state!.archiveFingerprint !== fingerprint(plan.archive.files)) fail("restore plan was modified during validation");
      if (fingerprint(await readOwnedAsync(plan.storageDir, plan.destinationAgentId)) !== state!.beforeFingerprint || identityFingerprint(plan.storageDir, state!.before) !== state!.beforeIdentity) fail("destination changed before publication");
      // Disk-backed plans: their recorded hashes say nothing about the bytes now on disk,
      // so read each against its baseline before anything is moved or installed.
      for (const file of plan.archive.files) if (file.sha256 !== undefined) { await breathe(); void file.bytes; }
      directory(plan.storageDir);
      // A stop lease is mandatory: the file group is not a database transaction.
      // All target paths are preflighted before the first write. Originals remain
      // in a private rollback directory until successful native reload/read-back.
      const rollback = mkdtempSync(join(plan.storageDir, ".native-rollback-"));
      const installed: string[] = []; const moved: { from: string; to: string }[] = [];
      try {
        const oldPaths = new Set(state!.before.map((f) => f.path));
        for (const file of plan.archive.files) {
          await breathe();
          const path = join(plan.storageDir, file.path);
          if (existsSync(path) && !oldPaths.has(file.path)) fail("destination path collision");
          // Reject symlinked ancestors even for a new filename.
          let parent = dirname(path); while (!existsSync(parent)) parent = dirname(parent); directory(parent);
        }
        for (const file of state!.before) {
          const from = join(plan.storageDir, file.path); const to = join(rollback, file.path);
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); renameSync(from, to); moved.push({ from, to });
        }
        for (const path of new Set(state!.before.filter((f) => f.path.startsWith("conversations/")).map((f) => dirname(join(plan.storageDir, f.path))))) {
          if (readdirSync(path).length === 0) rmdirSync(path);
        }
        for (const file of plan.archive.files) { await breathe(); writeExclusive(plan.storageDir, file); installed.push(join(plan.storageDir, file.path)); }
        published = true;
        const verification = { storageDir: plan.storageDir, agentId: plan.destinationAgentId, expectedConversations: expected };
        await compareObservation(verification, await options.reloadAndVerify(verification));
        if (fingerprint(await readOwnedAsync(plan.storageDir, plan.destinationAgentId)) !== state!.archiveFingerprint) fail("destination mutated during read-back");
        await rm(rollback, { recursive: true, force: true });
      } catch (error) {
        // Do not undo after runtime reload: it may have acquired readers/writers.
        // Retain the rollback artifact and require the owner to stop/reconcile.
        if (!published) {
          for (const path of installed.reverse()) rmSync(path, { force: true });
          for (const move of moved.reverse()) { mkdirSync(dirname(move.from), { recursive: true, mode: 0o700 }); renameSync(move.to, move.from); }
          rmSync(rollback, { recursive: true, force: true });
        }
        throw new Error(`Native recovery publication failed; destination must remain inactive${published ? `; original records retained at ${rollback}` : ""}. ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (!published) fail("runtime owner did not publish restore");
  } finally { if (!keepStaging) await rm(staging, { recursive: true, force: true }); }
}
