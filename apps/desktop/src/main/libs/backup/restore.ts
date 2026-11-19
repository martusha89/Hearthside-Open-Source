import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore, objectHash, type Snapshot } from "./store";
import { canonicalSnapshotIdentitySteps } from "./object-ids";
import { validateNativeArchive, type NativeArchive, type NativeFile } from "./native-state";
import { validateAgentFile } from "./cloud-agent-file";
import { writeDurable } from "./durable-io";
import { drain, drainAsync } from "./breathe";
import { CloudConversionBlocked, convertCloudSteps, convertCloudToStagingAsync, type CloudAgentRecord, type CloudConversationCapture, type CloudConversionReport } from "./cloud-native";
import type { SharedRepositoryRestore, SharedRepositoryMapping } from "./restore-cloud";



export const RECOVERY_CAPSULE_ROOT = "recovery-capsule";
export const RECOVERY_CAPSULE_LIMITS = Object.freeze({ entries: 100_000, manifestBytes: 32 * 1024 * 1024, objectBytes: 256 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
/** Structural limits on what a restore will read, one piece at a time. There is no total. */
export const RESTORE_LIMITS = Object.freeze({ entries: 100_000, manifestBytes: 32 * 1024 * 1024, objectBytes: 256 * 1024 * 1024 });
export type GitAncestry = "restored" | "unavailable" | "inert";

/** Validate inventory before any reads/allocations. Source paths are labels, never extraction paths. */
function capsuleInventory(snapshot: Snapshot): Map<string, number> {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.id !== "string" || typeof snapshot.agentId !== "string" || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.omissions) || snapshot.omissions.some((item) => typeof item !== "string")) throw new Error("Invalid recovery capsule manifest");
  if (snapshot.entries.length > RECOVERY_CAPSULE_LIMITS.entries) throw new Error("Recovery capsule entry limit exceeded");
  const hashes = new Map<string, number>();
  const paths = new Set<string>();
  let total = 0;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || paths.has(entry.path) || typeof entry.kind !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid recovery capsule entry");
    paths.add(entry.path);
    if (entry.size > RECOVERY_CAPSULE_LIMITS.objectBytes) throw new Error("Recovery capsule object size limit exceeded");
    if (hashes.has(entry.hash)) { if (hashes.get(entry.hash) !== entry.size) throw new Error("Conflicting recovery capsule object sizes"); }
    else { hashes.set(entry.hash, entry.size); total += entry.size; }
    if (total > RECOVERY_CAPSULE_LIMITS.totalBytes) throw new Error("Recovery capsule total size limit exceeded");
  }
  return hashes;
}

/** The same structural checks for a restore, without a total: pieces are read one at a time. */
function restoreInventory(snapshot: Snapshot): void {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.id !== "string" || typeof snapshot.agentId !== "string" || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.omissions) || snapshot.omissions.some((item) => typeof item !== "string")) throw new Error("Invalid snapshot manifest");
  if (snapshot.entries.length > RESTORE_LIMITS.entries) throw new Error("Snapshot entry limit exceeded");
  const hashes = new Map<string, number>();
  const paths = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || paths.has(entry.path) || typeof entry.kind !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid snapshot entry");
    paths.add(entry.path);
    if (entry.size > RESTORE_LIMITS.objectBytes) throw new Error("Snapshot object size limit exceeded");
    if (hashes.has(entry.hash) && hashes.get(entry.hash) !== entry.size) throw new Error("Conflicting snapshot object sizes");
    hashes.set(entry.hash, entry.size);
  }
}

/** No filesystem/network access. The caller supplies a bounded, trusted regular-file reader.
 * Returned objects are inert data; never execute source paths or apply archived capabilities.
 */
export async function readRecoveryCapsule(read: (relativePath: string) => Buffer | Promise<Buffer>, expected: { snapshotIdentity: string; sourceAgentId: string }): Promise<{ snapshot: Snapshot; objects: Map<string, Buffer> }> {
  if (!/^[a-f0-9]{64}$/.test(expected.snapshotIdentity)) throw new Error("Invalid expected capsule identity");
  const manifest = await read(`${RECOVERY_CAPSULE_ROOT}/snapshot.json`);
  if (!Buffer.isBuffer(manifest) || manifest.length > RECOVERY_CAPSULE_LIMITS.manifestBytes) throw new Error("Recovery capsule manifest size limit exceeded");
  if (objectHash(manifest) !== expected.snapshotIdentity) throw new Error("Recovery capsule manifest identity mismatch");
  const snapshot = JSON.parse(manifest.toString("utf8")) as Snapshot;
  const inventory = capsuleInventory(snapshot);
  if (snapshot.agentId !== expected.sourceAgentId) throw new Error("Recovery capsule source identity mismatch");
  const objects = new Map<string, Buffer>();
  for (const [hash, size] of inventory) {
    const bytes = await read(`${RECOVERY_CAPSULE_ROOT}/objects/${hash}.bin`);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size || objectHash(bytes) !== hash) throw new Error(`Recovery capsule object integrity failure: ${hash}`);
    objects.set(hash, bytes);
  }
  return { snapshot, objects };
}

/**
 * "translated-native": a Cloud backup converted into native local conversations
 * (cloud-native.ts). The source window is carried as live context, but it is a derived
 * local representation with Cloud provenance, never the source's exact context.
 */
export type ContextCoverage = "archive-only" | "cloud-main-only" | "native-all-conversations" | "translated-native";
export type RestoreMapping = { kind: "agent" | "conversation" | "message" | "repository"; originalId: string; destinationId: string; originalName?: string; destinationName?: string; permissions?: "read" | "read_write" };

export type RestoreProvenance = { storeId: string; sourceAgentId: string; snapshotId: string; snapshotIdentity: string };
export type ArchiveImport = {
  originalId: string;
  metadata: Record<string, unknown>;
  /** Original message IDs and ordering remain intact. These are DATA, never messages to send. */
  messages: unknown[];
  attachments: Array<{ hash: string; bytes: Buffer }>;
  provenance: RestoreProvenance;
};
/**
 * A trusted destination adapter, not an arbitrary backend client. It must create a NEW,
 * inactive agent with no tools, routes, schedules, listeners or executable imports.
 * Never infer or replay messages. Only explicit validated native/Agent File hooks may
 * rehydrate context within their advertised scope. Creation must not reuse IDs.
 * File writes must be exclusive regular-file creation, mode 0600, beneath that new
 * agent's memory root; reject symlink ancestors and never overwrite existing user files.
 * Only unchanged bootstrap scaffold files created by this exact recovery operation may
 * be replaced, after checking their recorded initial hashes immediately before writing.
 * Archive import stores inert data, including IDs/context/provenance, not live chats.
 * A throwing create must attach destinationAgentId to its error if allocation occurred.
 */
export type RestoreConfiguration = { name: string; description?: string; systemPrompt?: string; model?: string };
export type RestoreDestination = {
  capabilities?: { gitHistory?: "ancestry" | "inert"; nativeState?: boolean; agentFile?: boolean };
  createInactiveAgent(input: RestoreConfiguration & { provenance: RestoreProvenance; agentFile?: Buffer }): Promise<{ id: string; mappings?: RestoreMapping[] }>;
  importNativeState?(destinationAgentId: string, archive: NativeArchive): Promise<{ mappings: RestoreMapping[] }>;
  restoreSharedRepository?(destinationAgentId: string, input: SharedRepositoryRestore): Promise<SharedRepositoryMapping>;
  /** Remove temporary staging only; never delete source or destination resources. */
  abortRecovery?(destinationAgentId: string): Promise<void>;
  writeMemoryFile(destinationAgentId: string, path: string, bytes: Buffer): Promise<void>;
  /** Kept for adapters' own tests; new restores no longer copy chat archives into memory. */
  importConversationArchive(destinationAgentId: string, archive: ArchiveImport): Promise<{ id: string }>;
  /** Import history without executing hooks, filters or unsafe historical files. */
  importGitHistory?(destinationAgentId: string, bytes: Buffer): Promise<void>;
  /** Commit/publish and verify staged recovery data before reporting success. */
  finalizeRecovery?(destinationAgentId: string): Promise<void>;
  /**
   * Hearthside: an app-owned directory for this recovery's working files and records
   * (conversion staging, message placements), outside the companion's memory and Git.
   * Created by the adapter on the destination's own disk. Absent: a temporary directory.
   */
  recoveryDataDirectory?(destinationAgentId: string): string;
  /** Free bytes where the copy will be written, or null when that can't be told. */
  freeBytes?(): number | null;
  /** The working directory recorded in converted chats' session headers. */
  sessionCwd?: string;
};
export type RestorePart = { path: string; kind: string };
export type UnrestoredPart = { path: string; reason: string };
/** What converting a Cloud backup into local chats will carry, computed from this backup. */
export type ConversionOptions = { pictures?: "block" | "placeholder"; unansweredCalls?: "block" | "annotate"; windowCalls?: "block" | "close"; excludeChats?: string[]; fallbacks?: boolean };
export type ConversionSummary = {
  /** Problem shapes (types and IDs only), for a diagnostic file; never shown as text. */
  diagnostics?: unknown[];
  pictures: { policy: "block" | "placeholder"; parts: number; inWindow: number; chats: number; windowChats: number; captured: number; omitted: number; unknown: number; placeholders: number };
  unansweredCalls: number;
  unansweredCallsPolicy: "block" | "annotate";
  closedWindowCalls: number;
  windowCallsPolicy: "block" | "close";
  /** This preview proposed every allowed fallback itself; what it used is in the fields below. */
  fallbacks: boolean;
  /** Window calls still waiting under strict policy (what "abandon" would close). */
  pendingWindowCalls: Array<{ chatId: string; title: string; calls: number }>;
  incompleteWindows: Array<{ chatId: string; title: string; missing: number }>;
  excludedChats: Array<{ chatId: string; title: string; missing: number; messages: number }>;
  activeContext: "source-window-carried" | "source-window-carried-qualified";
  qualifications: string[];
  reorderedResults: number;
  reorderedWindows: number;
  chats: number; messages: number; historyParts: number; bytes: number;
  transcript: "complete" | "partial";
  unconvertedTotal: number;
  unconvertedByReason: Array<{ reason: string; count: number }>;
  unconvertedByChat: Array<{ chat: string; count: number }>;
  examples: Array<{ chat: string; messageType: string; reason: string }>;
  synthesized: string[];
  notes: string[];
  blocked: string[];
};
export type RestorePlan = RestoreProvenance & {
  token: string;
  contextCoverage: ContextCoverage;
  /** In preview, conditional on successful finalization; in results, confirmed evidence only. */
  gitAncestry: GitAncestry;
  supportedParts: RestorePart[];
  unrestoredParts: UnrestoredPart[];
  omissions: string[];
  warnings: string[];
  blockers: string[];
  guarantees: string[];
  /** Present when this restore converts Cloud chats into local ones. */
  conversion?: ConversionSummary;
};


export type RestoreStep = "check" | "memory" | "carry" | "save" | "verify";
export type RestoreProgress = (step: RestoreStep, done?: number, total?: number, what?: string) => void;

export type RestoreResult = {
  ok: boolean;
  destinationAgentId?: string;
  /** The protection keeping this snapshot out of cleanup while the copy depends on it. */
  pinId?: string;
  /** Creating the copy was attempted but its outcome isn't known: a copy may exist. */
  allocationUnknown?: true;
  sourceUntouched: true;
  activeContextRehydrated: boolean;
  contextCoverage: ContextCoverage;
  /** In preview, conditional on successful finalization; in results, confirmed evidence only. */
  gitAncestry: GitAncestry;
  restoredParts: RestorePart[];
  unrestoredParts: UnrestoredPart[];
  mappings: RestoreMapping[];
  error?: string;
};

type Lazy = () => Buffer;
type Prepared = {
  plan: RestorePlan;
  config: RestoreConfiguration;
  nativeArchive?: NativeArchive;
  /** Cloud chats to convert, read from the snapshot one message at a time. */
  conversion?: { agent: CloudAgentRecord; chats: number; conversations: () => Iterable<CloudConversationCapture> };
  agentFile?: Buffer;
  shared: SharedRepositoryRestore[];
  files: Array<{ part: RestorePart; path: string; read: Lazy }>;
  histories: Array<{ part: RestorePart; read: Lazy }>;
};
const pending = new Map<string, { store: BackupStore; adapter: RestoreDestination; source: string; snapshot: string; identity: string; expires: number; options: ConversionOptions }>();
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const KEPT_IN_BACKUP = "Kept in your backup, which stays protected from cleanup while this recovery depends on it. It is not copied into the companion.";

/** Portable extraction paths: reject rather than normalize ambiguous names. */
export function isSafeRestorePath(path: string): boolean {
  return path.length > 0 && !/[\\:]/.test(path) && ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function inertFile(path: string): boolean {
  return !path.split("/").some((part) => [".git", ".hg", ".svn", ".letta", "scripts", "recovery-archives", RECOVERY_CAPSULE_ROOT].includes(part.toLowerCase()));
}
/** A Cloud snapshot's chats as converter input: chunk by chunk, line by line. */
function* snapshotConversations(records: Array<Record<string, unknown>>, read: (path: string) => Buffer): Generator<CloudConversationCapture> {
  for (const meta of records) {
    const id = meta.id as string;
    const chunks = (meta.chunks as Array<{ path: string }>).map((chunk) => chunk.path);
    yield {
      id, main: meta.main === true || id.startsWith("main:"),
      ...(typeof meta.title === "string" ? { title: meta.title } : {}),
      ...(typeof meta.archived === "boolean" ? { archived: meta.archived } : {}),
      ...(typeof meta.createdAt === "string" ? { createdAt: meta.createdAt } : {}),
      ...(typeof meta.updatedAt === "string" ? { updatedAt: meta.updatedAt } : {}),
      context: object(meta.context) as CloudConversationCapture["context"],
      // Re-iterable: the converter reads each chat twice (IDs first, then the messages).
      messages: { *[Symbol.iterator]() {
        for (const path of chunks) {
          for (const line of read(path).toString("utf8").split("\n")) if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
        }
      } },
    };
  }
}



export function groupReasons(reasons: string[], limit = 8): string[] {
  const groups = new Map<string, { text: string; count: number }>();
  for (const reason of reasons) {
    const key = reason.replace(/\bmessage [^\s,)]+/g, "message \u2026").replace(/\(([^()]*)\)$/, "(\u2026)");
    const group = groups.get(key);
    if (group) group.count++; else groups.set(key, { text: reason, count: 1 });
  }
  const lines = [...groups.entries()].map(([key, { text, count }]) => count === 1 ? text
    : key.includes("message \u2026") ? key.replace("message \u2026", `${count.toLocaleString()} messages`).replace(/ \(\u2026\)$/, "")
    : `${key.replace(/ \(\u2026\)$/, "")} (${count.toLocaleString()} times)`);
  return lines.length > limit ? [...lines.slice(0, limit), `\u2026 and ${(lines.length - limit).toLocaleString()} more like these.`] : lines;
}

function summarize(report: CloudConversionReport, blocked: string[]): ConversionSummary {
  const top = (record: Record<string, number>, key: "reason" | "chat") => Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([name, count]) => ({ [key]: name, count }) as never);
  return {
    chats: report.counts.conversations, messages: report.counts.messages, historyParts: report.counts.historyVolumes, bytes: report.counts.bytes,
    transcript: report.claims.transcript,
    unconvertedTotal: report.loss.unconvertedTotal,
    unconvertedByReason: top(report.loss.unconvertedByReason, "reason"),
    unconvertedByChat: top(report.loss.unconvertedByConversation, "chat"),
    examples: report.loss.unconverted.slice(0, 50).map((item) => ({ chat: item.conversationId, messageType: item.messageType, reason: item.reason })),
    synthesized: report.loss.synthesized, notes: report.loss.notes, blocked, diagnostics: report.diagnostics,
    pictures: report.loss.pictures, unansweredCalls: report.loss.unansweredCallsTotal, unansweredCallsPolicy: report.loss.unansweredCallsPolicy, activeContext: report.claims.activeContext,
    closedWindowCalls: report.loss.closedWindowCallsTotal, windowCallsPolicy: report.loss.windowCallsPolicy, fallbacks: report.loss.fallbacks,
    pendingWindowCalls: report.loss.pendingWindowCalls.map((item) => ({ chatId: item.conversationId, title: item.title, calls: item.toolCallIds.length })),
    incompleteWindows: report.loss.incompleteWindows.map((item) => ({ chatId: item.conversationId, title: item.title, missing: item.missing.length })),
    excludedChats: report.loss.excludedChats.map((item) => ({ chatId: item.conversationId, title: item.title, missing: item.missing.length, messages: item.messages })), qualifications: report.claims.qualifications, reorderedResults: report.loss.reorderedResultsTotal, reorderedWindows: report.loss.reorderedWindows,
  };
}

function prepare(store: BackupStore, source: string, id: string, adapter: RestoreDestination, stage: "preview" | "execute", progress?: RestoreProgress, options: ConversionOptions = {}): Prepared {
  return drain(prepareSteps(store, source, id, adapter, stage, progress, options));
}

/** Hearthside: preparing, one piece or message per step, so it can run without freezing the window. */
function* prepareSteps(store: BackupStore, source: string, id: string, adapter: RestoreDestination, stage: "preview" | "execute", progress?: RestoreProgress, options: ConversionOptions = {}): Generator<void, Prepared, undefined> {
  const snapshot = store.readSnapshot(source, id);
  // Structural limits are checked before the canonical view reads any object.
  // This provisional value is replaced inside the guarded validation block.
  const origin: RestoreProvenance = { storeId: store.storeId, sourceAgentId: snapshot.agentId, snapshotId: snapshot.id, snapshotIdentity: objectHash(Buffer.from(JSON.stringify(snapshot))) };
  const plan: RestorePlan = { ...origin, token: "", contextCoverage: "archive-only", gitAncestry: "unavailable", supportedParts: [], unrestoredParts: [], omissions: [...snapshot.omissions], warnings: [], blockers: [], guarantees: [
    "New inactive recovery copy only; the source is never modified.",
    "Conversations are archived data, not active context; no continuation-state rehydration is guaranteed.",
    "Tools, routes, schedules, listeners and executable imports remain off. No inference or message replay.",
    "Failed destinations are retained and known allocated IDs are reported; there is no automatic deletion or claimed rollback. If the creation response fails, allocation may be unknown: inspect local agents before retrying. There is no automatic retry.",
  ] };
  const result: Prepared = { plan, config: { name: `${snapshot.agentName} (recovery copy)` }, files: [], histories: [], shared: [] };
  if (snapshot.agentId !== source || snapshot.id !== id) plan.blockers.push("The snapshot does not match the requested source and snapshot identity.");
  const manifestBytes = Buffer.from(JSON.stringify(snapshot));
  try {
    if (manifestBytes.length > RESTORE_LIMITS.manifestBytes) throw new Error("Snapshot manifest size limit exceeded");
    restoreInventory(snapshot);
    const snapshotIdentity = yield* canonicalSnapshotIdentitySteps(store, snapshot);
    plan.snapshotIdentity = snapshotIdentity;
    origin.snapshotIdentity = snapshotIdentity;
  } catch (error) { plan.blockers.push(errorText(error)); return result; }
  plan.guarantees.push("The backup this copy comes from is protected from automatic cleanup while any recovery depends on it. Pieces that aren't applied stay there, inert; nothing is copied into the companion's memory just to keep it.");
  // Every piece is decrypted and hash-checked here (holding message IDs only), and again
  // when it is actually read: the bytes consumed are the bytes verified.
  const verification = yield* store.verifySteps(source, id, progress && ((done, total) => progress("check", done, total)));
  const details = verification as typeof verification & { semanticErrors?: string[]; warnings?: string[] };
  plan.warnings.push(...(details.warnings ?? []));
  if (!verification.ok) plan.blockers.push(`Integrity check failed: ${[...verification.missing, ...verification.corrupt, ...(details.semanticErrors ?? [])].join(", ")}`);
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const read = (path: string): Buffer => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Backup piece missing: ${path}`);
    const data = store.getObject(entry.hash);
    if (data.length !== entry.size) throw new Error(`Object size mismatch: ${path}`);
    return data;
  };
  for (const entry of snapshot.entries) {
    // Conversation IDs (e.g. main:agent-id) are logical archive keys, not extraction paths.
    const logicalPath = entry.kind === "conversation" || entry.kind === "conversation-record" ? entry.path.replace(/^(conversations\/)[^/]+(?=\/)/, (segment) => segment.replaceAll(":", "_")) : entry.path;
    if (!isSafeRestorePath(logicalPath)) plan.blockers.push(`Unsafe backup path: ${entry.path}`);
  }
  if (!verification.ok || plan.blockers.length) return result;
  const json = (path: string): unknown => JSON.parse(read(path).toString("utf8"));
  const handled = new Set<string>();
  const skip = (path: string, reason: string) => { handled.add(path); plan.unrestoredParts.push({ path, reason }); };
  const support = (part: RestorePart) => { if (!handled.has(part.path)) plan.supportedParts.push(part); handled.add(part.path); };
  const targets = new Set<string>();
  const file = (path: string, target: string) => {
    const entry = entries.get(path)!;
    if (!isSafeRestorePath(target)) { plan.blockers.push(`Unsafe destination path: ${target}`); return; }
    if (!inertFile(target)) { skip(path, "Repository control files, hooks, scripts and reserved recovery paths are not restored."); return; }
    const key = target.toLowerCase();
    if (targets.has(key) || [...targets].some((other) => other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) {
      plan.blockers.push(`Conflicting memory destination: ${target}`); return;
    }
    targets.add(key);
    const part = { path, kind: entry.kind };
    result.files.push({ part, path: target, read: () => read(path) }); support(part);
  };
  if (entries.has("native-state/manifest.json")) {
    try {
      const manifest = object(json("native-state/manifest.json"));
      if (!manifest || manifest.version !== 1 || manifest.sourceAgentId !== source || !Array.isArray(manifest.files)) throw new Error("Invalid native state manifest");
      const seen = new Set<string>();
      const files = manifest.files.map((value): NativeFile => {
        const item = object(value);
        if (!item || typeof item.path !== "string" || !isSafeRestorePath(item.path) || typeof item.artifactPath !== "string" || item.artifactPath !== `native-state/files/${Buffer.from(item.path).toString("base64url")}` || entries.get(item.artifactPath)?.kind !== "native-state-file" || seen.has(item.path.toLowerCase())) throw new Error("Invalid native state file reference");
        seen.add(item.path.toLowerCase());
        const artifact = item.artifactPath, entry = entries.get(artifact)!;
        // Read from the backup when used, verified by its hash then: never held.
        return { path: item.path, size: entry.size, sha256: entry.hash, get bytes() { return read(artifact); } } as NativeFile;
      });
      const archive = { version: 1, runtimeVersion: manifest.runtimeVersion, sourceAgentId: source, files, ...(manifest.visibility === "source" ? { visibility: "source" } : {}) } as NativeArchive;
      if (manifest.visibility !== undefined && manifest.visibility !== "source") throw new Error("Unsupported native visibility policy");
      validateNativeArchive(archive);
      if (adapter.capabilities?.nativeState && adapter.importNativeState && adapter.finalizeRecovery) {
        result.nativeArchive = archive; plan.contextCoverage = "native-all-conversations";
        support({ path: "native-state/manifest.json", kind: "native-state" });
        for (const value of manifest.files) support({ path: (value as { artifactPath: string }).artifactPath, kind: "native-state-file" });
      }
    } catch (error) { plan.blockers.push(`Native state: ${errorText(error)}`); }
  }
  if (entries.has("agent-files/main.af")) {
    try {
      if (entries.get("agent-files/main.af")?.kind !== "agent-file") throw new Error("Invalid main agent-file kind");
      const data = read("agent-files/main.af");
      if (validateAgentFile(data).agents[0]!.id !== source) throw new Error("Main agent-file source identity mismatch");
      const manifest = object(json("agent-files/main.provenance.json"));
      if (!manifest || manifest.sourceAgentId !== source || manifest.conversationId !== null || manifest.sha256 !== objectHash(data)) throw new Error("Invalid main agent-file provenance");
      if (!result.nativeArchive && adapter.capabilities?.agentFile && adapter.finalizeRecovery) {
        result.agentFile = data; plan.contextCoverage = "cloud-main-only";
        support({ path: "agent-files/main.af", kind: "agent-file" });
        support({ path: "agent-files/main.provenance.json", kind: "agent-file-provenance" });
      }
    } catch (error) { plan.blockers.push(`Agent file: ${errorText(error)}`); }
  }
  // Additional AF exports remain inert archives: importing them would duplicate agents.
  for (const entry of snapshot.entries) if (entry.kind === "agent-file" && !handled.has(entry.path)) {
    try { validateAgentFile(read(entry.path)); file(entry.path, `agent-file-archives/${entry.path}`); }
    catch (error) { plan.blockers.push(`Agent file: ${errorText(error)}`); }
  }
  for (const entry of snapshot.entries) if (entry.kind === "agent-file-provenance" && !handled.has(entry.path)) file(entry.path, `agent-file-archives/${entry.path}`);
  let agentRecord: Record<string, unknown> | null = null;
  if (entries.has("agent.json")) {
    try {
      const agent = object(json("agent.json"));
      if (!agent) throw new Error("Invalid agent metadata");
      agentRecord = agent;
      // Prompt text is inert in the inactive destination. Never apply provider config,
      // tool/permission fields or credential-bearing endpoint URLs as model handles.
      handled.add("agent.json");
      support({ path: "agent.json#name", kind: "safe-configuration" });
      if (typeof agent.description === "string") { result.config.description = agent.description; support({ path: "agent.json#description", kind: "safe-configuration" }); }
      if (typeof agent.system === "string") { result.config.systemPrompt = agent.system; support({ path: "agent.json#system", kind: "safe-configuration" }); }
      if (typeof agent.model === "string" && agent.model) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(agent.model) || agent.model.includes("://")) throw new Error("Model handle is unsafe; provider URLs and credentials are not restored.");
        result.config.model = agent.model; support({ path: "agent.json#model", kind: "safe-configuration" });
      }
      plan.unrestoredParts.push({ path: "agent.json#other-fields", reason: "Only name, description, system prompt and model handle are applied when present. Context-window limits, provider credentials, reasoning/compaction settings, permissions and capabilities are not restored." });
    } catch (error) { plan.blockers.push(errorText(error)); }
  }
  for (const entry of snapshot.entries) {
    if (entry.kind === "memory" && entry.path.startsWith("memory/")) file(entry.path, entry.path.slice(7));
    if (entry.kind === "memory-history") {
      if (adapter.importGitHistory) { const part = { path: entry.path, kind: entry.kind }; const path = entry.path; result.histories.push({ part, read: () => read(path) }); support(part); }
      else skip(entry.path, "This destination does not support inert Git history import; only available current files can be recovered.");
    }
  }
  // A primary relationship must be explicit; legacy repository names are not enough.
  if (entries.has("repositories.json")) {
    try {
      const manifest = json("repositories.json");
      const repositories = Array.isArray(manifest) ? manifest : object(manifest)?.repositories;
      if (!Array.isArray(repositories)) throw new Error("Invalid repository manifest");
      const primary = repositories.map(object).filter((repo) => repo?.isPrimary === true);
      if (primary.length > 1) throw new Error("Multiple primary repositories cannot be restored safely");
      for (const repo of primary) {
        const prefix = typeof repo?.root === "string" ? repo.root : typeof repo?.prefix === "string" ? repo.prefix : typeof repo?.folder === "string" ? `repositories/${repo.folder}/` : null;
        if (!prefix || !prefix.startsWith("repositories/") || !isSafeRestorePath(prefix.replace(/\/$/, ""))) throw new Error("Primary repository has no safe file prefix");
        const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
        if (Array.isArray(repo?.files)) for (const path of repo.files) if (typeof path !== "string" || !path.startsWith(normalized) || entries.get(path)?.kind !== "repository") throw new Error("Primary repository references an unavailable file");
        for (const entry of snapshot.entries) if (entry.kind === "repository" && entry.path.startsWith(normalized)) file(entry.path, entry.path.slice(normalized.length));
        if (typeof repo?.bundlePath === "string") {
          const bundle = entries.get(repo.bundlePath);
          if (!bundle || bundle.kind !== "repository-history") throw new Error("Primary repository history is unavailable");
          if (adapter.importGitHistory) { const part = { path: bundle.path, kind: bundle.kind }; const path = bundle.path; result.histories.push({ part, read: () => read(path) }); support(part); }
          else skip(bundle.path, "This destination does not support inert Git history import; only the primary current tree is recovered.");
        }
      }
      const ids = new Set<string>();
      const prefixes = new Set<string>();
      for (const value of repositories) {
        const repo = object(value);
        if (!repo) throw new Error("Invalid repository record");
        if (repo.isPrimary !== true && (typeof repo.id !== "string" || !repo.id)) throw new Error("Invalid repository ID");
        if (typeof repo.id === "string") { if (ids.has(repo.id)) throw new Error("Duplicate repository ID"); ids.add(repo.id); }
        const prefix = typeof repo.root === "string" ? repo.root : typeof repo.prefix === "string" ? repo.prefix : typeof repo.folder === "string" ? `repositories/${repo.folder}/` : null;
        if (!prefix || !prefix.startsWith("repositories/") || !isSafeRestorePath(prefix.replace(/\/$/, ""))) throw new Error("Repository has no safe file prefix");
        const normalized = `${prefix.replace(/\/$/, "")}/`;
        if ([...prefixes].some((other) => normalized.toLowerCase().startsWith(other) || other.startsWith(normalized.toLowerCase()))) throw new Error("Overlapping repository prefixes");
        prefixes.add(normalized.toLowerCase());
        if (repo.isPrimary === true) continue;
        if (repo.isPrimary !== false) throw new Error("Repository relationship must be explicit");
        if (typeof repo.name !== "string" || !repo.name || (repo.permissions !== "read" && repo.permissions !== "read_write")) throw new Error("Shared repository requires name and permissions");
        if (!Array.isArray(repo.files)) throw new Error("Shared repository requires explicit files");
        const files: SharedRepositoryRestore["files"] = [];
        const paths = new Set<string>();
        for (const path of repo.files) {
          if (typeof path !== "string" || !path.startsWith(normalized) || entries.get(path)?.kind !== "repository") throw new Error("Shared repository references unavailable file");
          const target = path.slice(normalized.length);
          if (!isSafeRestorePath(target)) throw new Error("Unsafe shared repository path");
          if (!inertFile(target)) { skip(path, "Repository control files, scripts and reserved paths are not applied; they stay in your backup."); continue; }
          if (!isSafeRestorePath(target) || paths.has(target.toLowerCase()) || [...paths].some((other) => other.startsWith(`${target.toLowerCase()}/`) || target.toLowerCase().startsWith(`${other}/`))) throw new Error("Unsafe or conflicting shared repository path");
          paths.add(target.toLowerCase()); files.push({ path: target, bytes: read(path) });
        }
        let gitBundle: Buffer | undefined;
        if (repo.bundlePath != null) {
          if (typeof repo.bundlePath !== "string" || !isSafeRestorePath(repo.bundlePath) || entries.get(repo.bundlePath)?.kind !== "repository-history") throw new Error("Shared repository history unavailable");
          gitBundle = read(repo.bundlePath);
        }
        if (adapter.restoreSharedRepository && adapter.finalizeRecovery) {
          result.shared.push({ originalId: repo.id as string, name: repo.name, permissions: repo.permissions, files, gitBundle });
          for (const path of repo.files as string[]) support({ path, kind: "shared-repository-file" });
          if (typeof repo.bundlePath === "string") support({ path: repo.bundlePath, kind: "shared-repository-history" });
        }
      }
      if (result.shared.length) support({ path: "repositories.json", kind: "repository-mappings" });
      else skip("repositories.json", "Repository identity, revisions and permissions are provenance only; current primary files are restored where identified.");
    } catch (error) { plan.blockers.push(errorText(error)); }
  }

  // --- Chats -----------------------------------------------------------------------------
  const records: Array<Record<string, unknown>> = [];
  for (const entry of snapshot.entries.filter((item) => item.kind === "conversation-record")) {
    try {
      const meta = object(json(entry.path));
      if (!meta || typeof meta.id !== "string" || !Array.isArray(meta.chunks)) throw new Error("Invalid conversation metadata");
      for (const value of meta.chunks) {
        const chunk = object(value);
        if (!chunk || typeof chunk.path !== "string" || entries.get(chunk.path)?.kind !== "conversation" || !chunk.path.startsWith(`conversations/${meta.id}/`)) throw new Error("Invalid conversation chunk reference");
      }
      records.push(meta);
    } catch (error) { plan.blockers.push(`${entry.path}: ${errorText(error)}`); }
  }
  // A Cloud backup into a local destination that can take native state: convert the chats
  // into openable local conversations (cloud-native.ts) instead of archiving them.
  const convertible = !result.nativeArchive && records.length > 0 && !/^agent-local-/.test(source)
    && adapter.capabilities?.nativeState === true && Boolean(adapter.importNativeState && adapter.finalizeRecovery);
  if (convertible) {
    if (!agentRecord) plan.blockers.push("Converting chats needs the companion's own record (agent.json), which this backup doesn't have.");
    else {
      const agent = { ...agentRecord, id: source, name: typeof agentRecord.name === "string" && agentRecord.name ? agentRecord.name : snapshot.agentName } as CloudAgentRecord;
      result.conversion = { agent, chats: records.length, conversations: () => snapshotConversations(records, read) };
      if (stage === "preview") {
        // A dry run over this backup: what the preview promises is what this backup yields.
        const counting = { file: () => undefined, message: () => undefined };
        let report: CloudConversionReport | undefined;
        let blocked: string[] = [];
        try { report = yield* convertCloudSteps({ agent, localAgentId: "agent-local-preview", conversations: result.conversion.conversations(), sessionCwd: adapter.sessionCwd ?? homedir(), ...options }, counting); }
        catch (error) {
          if (error instanceof CloudConversionBlocked) { blocked = error.reasons; report = error.report; }
          else plan.blockers.push(`Converting chats: ${errorText(error)}`);
        }
        if (report) plan.conversion = summarize(report, groupReasons(blocked));
        if (report && report.loss.pictures.placeholders) plan.omissions.push(`Restored without pictures: ${report.loss.pictures.placeholders} picture(s) shown as placeholders, ${report.loss.pictures.inWindow} of them in active windows.`);
        if (report && report.loss.closedWindowCallsTotal) plan.omissions.push(`Pending calls abandoned by choice: ${report.loss.closedWindowCallsTotal} tool call(s) in active windows carry a synthetic closure (outcome unknown; must not be run again).`);
        if (report && report.loss.excludedChats.length) plan.omissions.push(`Chats kept as read-only incomplete history by choice: ${report.loss.excludedChats.map((item) => item.conversationId).join(", ")} (their active window named messages the backup doesn't contain).`);
        if (report && report.loss.unansweredCallsPolicy === "annotate" && report.loss.unansweredCallsTotal) plan.omissions.push(`Restored with gaps marked: ${report.loss.unansweredCallsTotal} tool call(s) in older messages carry a synthetic recovery annotation (no result recorded; outcome unknown).`);
        for (const reason of groupReasons(blocked)) plan.blockers.push(reason);
      }
      plan.contextCoverage = "translated-native";
      for (const meta of records) {
        support({ path: `conversations/${meta.id}/meta.json`, kind: "converted-conversation" });
        for (const chunk of meta.chunks as Array<{ path: string }>) support({ path: chunk.path, kind: "converted-conversation-data" });
      }
    }
  } else {
    for (const meta of records) {
      skip(`conversations/${meta.id}/meta.json`, KEPT_IN_BACKUP);
      for (const chunk of meta.chunks as Array<{ path: string }>) handled.add(chunk.path);
    }
  }
  for (const entry of snapshot.entries) if (!handled.has(entry.path)) skip(entry.path, KEPT_IN_BACKUP);
  const hasBundle = snapshot.entries.some((entry) => entry.kind === "memory-history" || entry.kind === "repository-history");
  plan.gitAncestry = result.histories.length > 0 && adapter.capabilities?.gitHistory === "ancestry" && adapter.finalizeRecovery ? "restored" : hasBundle ? "inert" : "unavailable";
  if (hasBundle && plan.gitAncestry !== "restored") {
    const reason = "Git bundles stay in your backup as inert data; Git ancestry is not installed into the destination memory repository.";
    plan.warnings.push(reason);
    plan.unrestoredParts.push({ path: "git-ancestry", reason });
  }
  if (plan.contextCoverage === "translated-native") {
    plan.guarantees[1] = "Each chat continues from the window your companion had in mind, carried into a local conversation; older messages are kept as read-only history. This is a translation of the Cloud chats, not their exact Cloud context.";
  } else if (plan.contextCoverage !== "native-all-conversations") {
    plan.unrestoredParts.push({ path: "active-context", reason: plan.contextCoverage === "cloud-main-only" ? "Only the Cloud main Agent File context is validated; other conversations and complete historical context are not rehydrated." : "Active context, compaction state and live conversation IDs are not rehydrated. Chats stay in your backup." });
  }
  if (plan.contextCoverage !== "archive-only" && plan.contextCoverage !== "translated-native") plan.guarantees[1] = `Context recovery scope: ${plan.contextCoverage}; success requires destination finalization and verification.`;
  // Hearthside: room for the working copies (converted chats, the remapped plan) and the
  // published copy, checked before anything is written, at preview and again at restore.
  const free = adapter.freeBytes?.() ?? null;
  if (free !== null) {
    const supported = new Set(plan.supportedParts.map((part) => part.path));
    const needed = DISK_HEADROOM + DISK_COPIES * snapshot.entries.reduce((sum, entry) => sum + (supported.has(entry.path) ? entry.size : 0), 0);
    if (free < needed) plan.blockers.push(`There isn't enough free space on this computer for this restore: it needs about ${size(needed)} and ${size(free)} is free. Free up some space and preview again. Nothing was written.`);
  }
  return result;
}

/** Working copy, remapped plan and published copy, plus a margin for the runtime. */
const DISK_COPIES = 3;
const DISK_HEADROOM = 256 * 1024 * 1024;
const size = (bytes: number) => bytes < 1024 ** 3 ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Decrypt and verify all objects before offering a single-use, fifteen-minute plan. */
export function previewRestore(store: BackupStore, sourceAgentId: string, snapshotId: string, adapter: RestoreDestination, progress?: RestoreProgress, options: ConversionOptions = {}): RestorePlan {
  return offer(store, sourceAgentId, snapshotId, adapter, prepare(store, sourceAgentId, snapshotId, adapter, "preview", progress, options), options);
}

/** The same, in slices: what the app uses, so a big backup doesn't freeze the window. */
export async function previewRestoreAsync(store: BackupStore, sourceAgentId: string, snapshotId: string, adapter: RestoreDestination, progress?: RestoreProgress, options: ConversionOptions = {}): Promise<RestorePlan> {
  return offer(store, sourceAgentId, snapshotId, adapter, await drainAsync(prepareSteps(store, sourceAgentId, snapshotId, adapter, "preview", progress, options)), options);
}

function offer(store: BackupStore, sourceAgentId: string, snapshotId: string, adapter: RestoreDestination, prepared: Prepared, options: ConversionOptions): RestorePlan {
  for (const [token, saved] of pending) if (saved.expires < Date.now()) pending.delete(token);
  const token = randomBytes(24).toString("hex");
  prepared.plan.token = token;
  pending.set(token, { store, adapter, source: sourceAgentId, snapshot: snapshotId, identity: prepared.plan.snapshotIdentity, expires: Date.now() + 15 * 60_000, options });
  return prepared.plan;
}

/** Chats as they are carried over, reported one by one. */
function* counted(conversations: Iterable<CloudConversationCapture>, total: number, progress?: RestoreProgress): Generator<CloudConversationCapture> {
  let done = 0;
  for (const conversation of conversations) {
    progress?.("carry", ++done, total, conversation.main ? "Main" : conversation.title || "Untitled chat");
    yield conversation;
  }
}

/** No target ID argument exists: every execution allocates a new inactive destination. */
export async function executeRestore(store: BackupStore, token: string, adapter: RestoreDestination, progress?: RestoreProgress): Promise<RestoreResult> {
  const result: RestoreResult = { ok: false, sourceUntouched: true, activeContextRehydrated: false, contextCoverage: "archive-only", gitAncestry: "unavailable", restoredParts: [], unrestoredParts: [], mappings: [] };
  const saved = pending.get(token);
  pending.delete(token);
  let prepared: Prepared | undefined;
  let staging: string | null = null;
  let allocationAttempted = false;
  let noAllocation = false;
  try {
    if (!saved || saved.store !== store || saved.adapter !== adapter || saved.expires < Date.now()) throw new Error("Restore plan expired or does not match this store and destination. Preview again.");
    prepared = await drainAsync(prepareSteps(store, saved.source, saved.snapshot, adapter, "execute", progress, saved.options));
    result.unrestoredParts = [...prepared.plan.unrestoredParts];
    if (prepared.plan.snapshotIdentity !== saved.identity) throw new Error("The snapshot changed after preview. Preview again.");
    if (prepared.plan.blockers.length) throw new Error(prepared.plan.blockers.join("; "));
    const { storeId, sourceAgentId, snapshotId, snapshotIdentity } = prepared.plan;
    const origin = { storeId, sourceAgentId, snapshotId, snapshotIdentity };
    // What isn't applied stays in this snapshot, so it is protected from cleanup
    // before anything is written. It stays protected after a failure that left a copy.
    result.pinId = store.pin(sourceAgentId, snapshotId, "recovery").id;
    allocationAttempted = true;
    const created = await adapter.createInactiveAgent({ ...prepared.config, provenance: origin, ...(prepared.agentFile ? { agentFile: prepared.agentFile } : {}) });
    result.destinationAgentId = created.id;
    if (!created.id || created.id === sourceAgentId) throw new Error("Destination adapter did not allocate a new agent; no content was written.");
    store.updatePin(result.pinId, created.id);
    result.mappings.push({ kind: "agent", originalId: sourceAgentId, destinationId: created.id });
    result.mappings.push(...(created.mappings ?? []));
    // One piece at a time: read from the backup (verified), written, released.
    progress?.("memory");
    for (const file of prepared.files) await adapter.writeMemoryFile(created.id, file.path, file.read());
    if (prepared.nativeArchive) {
      progress?.("save");
      const imported = await adapter.importNativeState!(created.id, prepared.nativeArchive);
      result.mappings.push(...imported.mappings);
    }
    if (prepared.conversion) {
      // Converted on disk, conversation by conversation, then published through the same
      // verified native path as any other native restore.
      const root = adapter.recoveryDataDirectory?.(created.id);
      staging = root ? join(root, `staging-${randomUUID()}`) : mkdtempSync(join(tmpdir(), "hearthside-conversion-"));
      const converted = await convertCloudToStagingAsync({
        agent: prepared.conversion.agent, localAgentId: `agent-local-converted-${randomUUID()}`,
        conversations: counted(prepared.conversion.conversations(), prepared.conversion.chats, progress), sessionCwd: adapter.sessionCwd ?? homedir(),
        stagingDir: join(staging, "native"), placementsFile: join(root ?? staging, "cloud-placements.jsonl"),
        ...saved.options,
      });
      progress?.("save");
      // What the conversion did and didn't carry over stays with the copy, outside its
      // memory, so a translated recovery is still explicable after the preview closes.
      if (root) writeDurable(join(root, "conversion-report.json"), JSON.stringify({ version: 1, converter: "cloud-native", snapshotId, summary: { ...summarize(converted, []), pendingWindowCalls: undefined, incompleteWindows: converted.loss.incompleteWindows.map((item) => ({ chatId: item.conversationId, missing: item.missing })), excludedChats: converted.loss.excludedChats.map((item) => ({ chatId: item.conversationId, missing: item.missing, messages: item.messages })) }, closedWindowCalls: converted.loss.closedWindowCalls, refusals: { total: converted.loss.translatedRefusalsTotal, items: converted.loss.translatedRefusals } }, null, 2));
      const imported = await adapter.importNativeState!(created.id, converted.archive);
      result.mappings.push(...imported.mappings);
    }
    for (const shared of prepared.shared) {
      const mapping = await adapter.restoreSharedRepository!(created.id, shared);
      if (!mapping.destinationId || mapping.destinationId === shared.originalId || mapping.originalId !== shared.originalId || !mapping.destinationName || mapping.permissions !== shared.permissions) throw new Error("Invalid shared repository mapping");
      result.mappings.push({ kind: "repository", ...mapping });
    }
    for (const history of prepared.histories) await adapter.importGitHistory!(created.id, history.read());
    await adapter.finalizeRecovery?.(created.id);
    result.restoredParts = [...prepared.plan.supportedParts];
    result.contextCoverage = prepared.plan.contextCoverage;
    result.gitAncestry = prepared.plan.gitAncestry;
    result.activeContextRehydrated = result.contextCoverage === "native-all-conversations" || result.contextCoverage === "translated-native";
    result.ok = true;
  } catch (error) {
    const allocated = object(error)?.destinationAgentId;
    if (!result.destinationAgentId && typeof allocated === "string") result.destinationAgentId = allocated;
    // Only an adapter's explicit word that nothing was created counts as "no copy".
    noAllocation = !allocationAttempted || (!result.destinationAgentId && object(error)?.allocation === "none");
    if (allocationAttempted && !noAllocation && !result.destinationAgentId) result.allocationUnknown = true;
    result.error = errorText(error);
    if (prepared) for (const part of prepared.plan.supportedParts) result.unrestoredParts.push({ path: part.path, reason: "Publication/verification not confirmed; recovery failed. Allocated destinations and mappings may contain partial data and are retained, not rolled back." });
  } finally {
    // Nothing was allocated, so nothing depends on the snapshot.
    if (!result.ok && result.pinId && noAllocation) { try { store.unpin(result.pinId); delete result.pinId; } catch { /* a leftover pin only keeps a backup longer */ } }
    if (staging) { try { await rm(staging, { recursive: true, force: true }); } catch { /* left for the next run to report */ } }
    if (result.destinationAgentId && result.destinationAgentId !== saved?.source && adapter.abortRecovery) {
      try { await adapter.abortRecovery(result.destinationAgentId); }
      catch (error) { result.error = [result.error, `Temporary staging cleanup failed: ${errorText(error)}`].filter(Boolean).join("; "); }
    }
  }
  return result;
}
