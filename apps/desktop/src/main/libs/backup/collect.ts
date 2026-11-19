import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AttachmentCollector, type AttachmentResolver } from "./attachments";
import { BackupError, BackupStore, type SnapshotEntry, type SnapshotHeader } from "./store";
import { BackupSourceError, backupSourceFailure } from "./diagnostics";

/**
 * Hearthside backups: gathering one companion into the store. Everything
 * comes through `BackupSources`, so the gathering itself knows nothing about
 * the runtime and can be tested with made-up data.
 *
 * Conversations are re-read in full, oldest first, so edits and deletions are
 * reflected in each new snapshot. Content-addressed storage deduplicates
 * unchanged chunks without trusting a stale transcript. Pictures inside
 * messages (base64) are taken out and stored once by their decoded bytes;
 * left out when the person says so, each one recorded as "not included".
 */

export const CHUNK = 500;
const PAGE = 100;
const MAX_PAGES_PER_CONVERSATION = 2_000;
const IMAGE_MIN_CHARS = 1_024;

export type SourceConversation = { id: string; title: string; archived: boolean; main?: boolean; createdAt?: string | null; updatedAt?: string | null; context?: unknown };
export type MessagePage = { messages: unknown[]; hasMore?: boolean; identity?: "source-id-components-v1" };
export type BackupSources = {
  agent: Record<string, unknown> & { id: string; name: string };
  listConversations(): Promise<SourceConversation[]>;
  /** Messages in the given order; `after`/`before` are message ids. */
  listMessages(conversationId: string, options: { after?: string; before?: string; limit: number; order: "asc" | "desc" }): Promise<MessagePage>;
  /** The memory folder (a git repository) when it is on this computer. */
  memoryDir: string | null;
  /** The memory's git history as a bundle, when there is one. */
  gitBundle(): Promise<Buffer | null>;
  schedules(): Promise<unknown[]>;
  /** Hearthside's own state for this companion: picture, theme, chat modes, favourites. */
  hearthside(): Promise<Record<string, unknown>>;
  /**
   * The rest of the companion's world, by name: schedule run ledgers, channel
   * routes and allowlists, per-chat settings, skills, connectors and tools
   * (known credential fields excluded; content can still contain secrets).
   * Each key is one list; a key whose reader
   * failed is reported as an omission rather than silently empty.
   */
  extras?(): Promise<Record<string, { items: unknown[]; error?: string; limitation?: string }>>;


  repositories?(): Promise<Array<{ name: string; id?: string; isPrimary?: boolean; permissions?: unknown; revision?: string | null; gitBundle?: Buffer | null; files: Array<{ path: string; content: string; bytes?: Buffer }>; error?: string }>>;
  /** Versioned native state / agent-file artifacts; errors are explicit omissions. */
  artifacts?(): Promise<Array<{ path: string; kind: string; bytes?: Buffer; error?: string }>>;
  /** An authoritative source-wide revision token, if available. Null means unknown. */
  checkpoint?(): Promise<unknown>;
  attachmentResolver?: AttachmentResolver;
  /** Admission/connection check only; this is not a source-wide atomic checkpoint. */
  validateBeforeCommit?(): Promise<void> | void;
};

export type CollectOptions = {
  /** Hearthside: waits between page-read retries (tests shorten them). */
  pageRetryDelaysMs?: number[];
  includePictures: boolean;
  app: string;
  /** Hearthside: the snapshot to build on (the last that checked out); null starts fresh; omitted: the newest. */
  baselineId?: string | null;


  mode?: "full" | "incremental";
  onProgress?: (done: number, total: number, what: string) => void;
};

type ConversationRecord = {
  id: string;
  title: string;
  archived: boolean;
  main: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  context?: unknown;
  count: number;
  lastMessageId: string | null;
  chunks: Array<{ path: string; count: number }>;
};

type Collected = { entries: SnapshotEntry[]; counts: Record<string, number>; omissions: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function messageId(message: unknown): string | null {
  const id = record(message)?.id;
  return typeof id === "string" ? id : null;
}

const BASE64 = /^[A-Za-z0-9+/\s]+=*$/;

/**
 * Take base64 pictures out of a message. Returns the message with each picture
 * replaced by a small reference, and the pictures' bytes.
 */
export function liftImages(value: unknown, includePictures: boolean, out: Array<{ hash?: string; bytes: Buffer }>, store: BackupStore | null, omitted: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => liftImages(item, includePictures, out, store, omitted));
  const object = record(value);
  if (!object) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(object)) {
    const text = typeof inner === "string" ? inner : null;
    const mime = object.media_type ?? object.mediaType ?? object.mime_type ?? object.mimeType;
    const looksLikeImage = text !== null && (key === "data" || key === "base64") && text.length >= IMAGE_MIN_CHARS && BASE64.test(text) && typeof mime === "string" && mime.startsWith("image/");
    if (looksLikeImage) {
      const bytes = Buffer.from(text.replace(/\s/g, ""), "base64");
      if (includePictures && store) {
        const { hash } = store.putObject(bytes);
        out.push({ hash, bytes });
        copy[`${key}_hearthside_object`] = hash;
      } else {
        omitted.count += 1;
        copy[`${key}_hearthside_omitted`] = true;
      }
      copy[`${key}_bytes`] = bytes.length;
      continue;
    }
    copy[key] = liftImages(inner, includePictures, out, store, omitted);
  }
  return copy;
}

const WALK_MAX_DEPTH = 12;
const WALK_MAX_FILES = 20_000;



export function walkFiles(dir: string, skip: Set<string>): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > WALK_MAX_DEPTH) {
      skipped.push(`${relative(dir, current) || "."} (too deep)`);
      return;
    }
    for (const name of readdirSync(current)) {
      if (skip.has(name)) continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        skipped.push(`${relative(dir, path)} (a link)`);
      } else if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile()) {
        if (files.length >= WALK_MAX_FILES) {
          skipped.push(`${relative(dir, path)} (over ${WALK_MAX_FILES} files)`);
          continue;
        }
        files.push(path);
      }
    }
  };
  visit(dir, 0);
  return { files: files.sort(), skipped };
}

/**
 * A memory or repository file the backup refuses, said in words the person can act on.
 * The refusal itself is unchanged; it used to be a bare internal error, which the
 * backup then replaced with "source or verification operation failed", so every
 * backup of that companion failed with nothing to say a file's name was the cause.
 */
function unusableName(what: string, name: string, error: unknown): BackupError {
  const shown = JSON.stringify(name.slice(0, 200));
  if (error instanceof Error && /namespace collision/.test(error.message)) {
    return new BackupError(`${what} ${shown} has the same name as another one apart from capitals, and a backup can't hold both. Rename one of them, then back up again.`);
  }
  return new BackupError(`${what} ${shown} has a name a backup can't hold. Names can't contain : ? * " < > | or \\, end in a dot or a space, or be a reserved Windows name such as CON or AUX. Rename it, then back up again.`);
}

// Logical paths must remain distinct on Windows too. Never silently sanitize.
function safePath(path: string): string {
  if (!path || path.includes("\\") || path.startsWith("/") || /[<>"|?*]/.test(path) || [...path].some((char) => char.charCodeAt(0) < 32)) throw new Error(`Unsafe backup path: ${path}`);
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || part.includes(":") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error(`Unsafe backup path: ${path}`);
  }
  return path;
}

/** The note on a backup that holds none of the companion's memory files, from anywhere. */
export const NO_MEMORY_NOTE = "This backup holds no memory files: none could be read from a memory folder on this computer, and none were downloaded from Letta Cloud. Chats and settings were saved.";

const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 1));
const jsonlBytes = (lines: unknown[]) => Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : ""));

/** Gather the companion and write one snapshot. */


const PAGE_RETRIES = 3;
const PAGE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
export async function readPageWithRetry(read: () => Promise<MessagePage>, context: { operation: "messages.list"; page: number }, delays = PAGE_RETRY_DELAYS_MS): Promise<MessagePage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const classified = backupSourceFailure(error, context);
      const transient = classified.code === "request_failed" || classified.code === "request_timeout" || classified.code === "connection_failed";
      const retriable = transient && (classified.status === undefined || classified.status >= 500 || classified.status === 429);
      if (!retriable || attempt >= PAGE_RETRIES) throw error;
      console.warn(`[backup] page ${context.page} read failed (${classified.code}${classified.status ? `, status ${classified.status}` : ""}); trying again in ${Math.round((delays[attempt] ?? 10_000) / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 10_000));
    }
  }
}

export async function collectSnapshot(store: BackupStore, sources: BackupSources, options: CollectOptions): Promise<SnapshotHeader> {
  const before = sources.checkpoint ? await sources.checkpoint() : null;
  const beforeToken = JSON.stringify(before);
  // Baseline is only an optional new-message statistic, never a data source.
  let previous = new Map<string, SnapshotEntry>();
  try { previous = store.latestEntries(sources.agent.id, options.baselineId); } catch { /* Re-read even when an old manifest is damaged. */ }
  const paths = new Set<string>();
  const directories = new Set<string>();
  const blobs = new Map<string, number>();
  const attachmentCollector = new AttachmentCollector(options.includePictures, (bytes) => {
    const { hash } = store.putObject(bytes); blobs.set(hash, bytes.length); return hash;
  }, sources.attachmentResolver);
  const attachments = attachmentCollector.inventory;
  const collected: Collected = { entries: [], counts: { conversations: 0, messages: 0, newMessages: 0, memoryFiles: 0, pictures: 0, schedules: 0 }, omissions: [] };
  const put = (path: string, kind: string, bytes: Buffer) => {
    // Legacy main-chat IDs have a colon; they are logical IDs, not extraction paths.
    safePath(path.replace(/^conversations\/main:/, "conversations/main-"));
    const normalized = path.normalize("NFC").toLowerCase();
    const parts = normalized.split("/");
    const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    if (paths.has(normalized) || directories.has(normalized) || parents.some((parent) => paths.has(parent))) throw new Error(`Backup path namespace collision: ${path}`);
    paths.add(normalized);
    parents.forEach((parent) => directories.add(parent));
    const { hash } = store.putObject(bytes);
    collected.entries.push({ path, hash, size: bytes.length, kind });
    return hash;
  };
  /** A piece carried over unchanged from the baseline: same checks on its name, no new bytes. */
  const carry = (entry: SnapshotEntry) => {
    const normalized = entry.path.normalize("NFC").toLowerCase();
    const parts = normalized.split("/");
    const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    if (paths.has(normalized) || directories.has(normalized) || parents.some((parent) => paths.has(parent))) throw new Error(`Backup path namespace collision: ${entry.path}`);
    paths.add(normalized);
    parents.forEach((parent) => directories.add(parent));
    collected.entries.push({ ...entry });
  };
  const incremental = options.mode === "incremental" && previous.size > 0;
  /**
   * What the baseline recorded for a chat, if it can be built on: an ascending capture whose
   * chunks are all still in the store, with a last message to resume from. Anything short of
   * that means a full read of this one chat, which is always correct, only slower.
   */
  const baselineRecord = (conversationId: string): (ConversationRecord & { ids: string[]; identity?: MessagePage["identity"] }) | null => {
    if (!incremental) return null;
    const metaEntry = previous.get(`conversations/${conversationId}/meta.json`);
    if (!metaEntry) return null;
    try {
      const meta = JSON.parse(store.getObject(metaEntry.hash).toString("utf8")) as ConversationRecord & { capture?: { mode?: string; order?: string; messageIdentity?: string } };
      if (meta.id !== conversationId || !meta.capture || meta.capture.order !== "asc" || !Array.isArray(meta.chunks) || typeof meta.lastMessageId !== "string" || !meta.lastMessageId) return null;
      if (meta.capture.messageIdentity !== undefined && meta.capture.messageIdentity !== "source-id-components-v1") return null;
      const ids: string[] = [];
      for (const chunk of meta.chunks) {
        const entry = previous.get(chunk.path);
        if (!entry || entry.kind !== "conversation" || !store.hasObject(entry.hash)) return null;
        const lines = store.getObject(entry.hash).toString("utf8").split("\n").filter(Boolean);
        if (lines.length !== chunk.count) return null;
        for (const line of lines) { const id = messageId(JSON.parse(line)); if (!id) return null; ids.push(id); }
      }
      if (ids.length !== meta.count || ids[ids.length - 1] !== meta.lastMessageId) return null;
      return { ...meta, ids, identity: meta.capture.messageIdentity as MessagePage["identity"] };
    } catch {
      return null;
    }
  };
  let carriedChats = 0;

  // The companion itself.
  put("agent.json", "agent", jsonBytes(sources.agent));

  // Memory: every file, then the git history as one bundle.
  if (sources.memoryDir) {
    const walked = walkFiles(sources.memoryDir, new Set([".git"]));
    if (walked.skipped.length > 0) collected.omissions.push(`Not followed in the memory folder: ${walked.skipped.slice(0, 5).join(", ")}${walked.skipped.length > 5 ? ` and ${walked.skipped.length - 5} more` : ""}.`);
    for (const file of walked.files) {
      const rel = relative(sources.memoryDir, file);
      // A literal backslash on POSIX is not a separator; reject rather than alias it.
      const logical = process.platform === "win32" ? rel.split("\\").join("/") : rel;
      try {
        safePath(logical);
        put(`memory/${logical}`, "memory", readFileSync(file));
      } catch (error) {
        if (error instanceof Error && /^(Unsafe backup path|Backup path namespace collision)/.test(error.message)) throw unusableName("The memory file", logical, error);
        throw error;
      }
      collected.counts.memoryFiles! += 1;
    }
    const bundle = await sources.gitBundle().catch((error: unknown) => {
      // Classified, not quoted: an omission is stored in the snapshot header and read
      // by the person, so it carries this build's own words, never upstream text.
      collected.omissions.push(`Memory history (git) couldn't be read: ${backupSourceFailure(error, { operation: "git.capture" }).message}`);
      return null;
    });
    if (bundle) put("memory.git.bundle", "memory-history", bundle);
    else collected.omissions.push("Local memory Git history is unavailable; only current files were captured.");
    collected.omissions.push("Local memory working tree and Git bundle were read separately; their consistency is not proven.");
  } else {
    collected.omissions.push("Memory files aren't on this computer; any available Cloud repository current files are listed separately in repositories.json. No local memory tree or Git history was captured.");
  }

  // Conversations, fully re-read and content-addressed.
  const conversations = await sources.listConversations();
  let done = 0;
  for (const conversation of conversations) {
    safePath(conversation.id.replace(/^main:/, "main-"));
    if (conversation.id.includes("/")) throw new Error(`Unsafe conversation identity: ${conversation.id}`);
    options.onProgress?.(done, conversations.length + 2, conversation.title);
    // Never carry old message bytes forward: historical edits/deletions matter.
    const meta: ConversationRecord = { ...conversation, main: conversation.main === true, count: 0, lastMessageId: null, chunks: [] };
    if (conversation.context === undefined) collected.omissions.push(`Active context for ${conversation.id} was not supplied; transcript history is not a continuation checkpoint.`);

    let read = 0;
    let lastId: string | undefined;
    const lines: unknown[] = [];
    let seen = new Set<string>();
    let after: string | undefined;
    let complete = false;
    let identity: MessagePage["identity"];
    // Incremental: the baseline's pieces for this chat come over as they are, and reading
    // resumes after the last message they hold. A chat the baseline can't vouch for is read whole.
    let carried = baselineRecord(conversation.id);
    const carriedFrom = collected.entries.length;
    if (carried) {
      for (const chunk of carried.chunks) { carry(previous.get(chunk.path)!); meta.chunks.push({ path: chunk.path, count: chunk.count }); }
      for (const id of carried.ids) seen.add(id);
      read = carried.ids.length;
      after = carried.lastMessageId ?? undefined;
      lastId = after;
      identity = carried.identity;
      carriedChats += 1;
    }
    /**
     * The message the baseline ended on may no longer exist. Letta then answers the
     * resume request with the chat from its beginning, so the very first page repeats
     * messages already carried over. That used to fail every routine backup until the
     * weekly full one. Nothing new has been written for this chat at that point, so
     * what was carried is put back and this one chat is read whole instead, which is
     * always correct, only slower. A repeat on any later page is still a failure.
     */
    const readWholeInstead = () => {
      for (const entry of collected.entries.splice(carriedFrom)) paths.delete(entry.path.normalize("NFC").toLowerCase());
      meta.chunks = [];
      seen = new Set<string>();
      read = 0;
      after = undefined;
      lastId = undefined;
      identity = undefined;
      carried = null;
      carriedChats -= 1;
      console.warn(`[backup] ${conversation.main || conversation.id.startsWith("main:") ? "main chat" : "a named chat"}: the last backup's final message is gone from Letta; reading this chat in full`);
    };
    const flushChunks = (all: boolean) => {
      while (lines.length >= CHUNK || (all && lines.length > 0)) {
        const slice = lines.splice(0, CHUNK);
        const index = meta.chunks.length + 1;
        const path = `conversations/${conversation.id}/${String(index).padStart(4, "0")}.jsonl`;
        put(path, "conversation", jsonlBytes(slice));
        meta.chunks.push({ path, count: slice.length });
      }
    };
    // One extra empty terminal probe permits an exact-cap history without allowing
    // any additional data page beyond the bound.
    for (let page = 0; page <= MAX_PAGES_PER_CONVERSATION; page++) {
      const context = { operation: "messages.list" as const, chat: conversation.main || conversation.id.startsWith("main:") ? "main" as const : "named" as const, page: page + 1, count: read, limit: PAGE };
      let batch: MessagePage;
      try { batch = await readPageWithRetry(() => sources.listMessages(conversation.id, { ...(after ? { after } : {}), limit: PAGE, order: "asc" }), context, options.pageRetryDelaysMs); }
      catch (error) { throw backupSourceFailure(error, context); }
      if (!batch || !Array.isArray(batch.messages)) throw new BackupSourceError(context, "invalid_response");
      if (batch.identity !== undefined && batch.identity !== "source-id-components-v1") throw new BackupSourceError(context, "invalid_response");
      if (page === 0 && !carried) identity = batch.identity;
      else if (identity !== batch.identity) throw new BackupSourceError(context, "invalid_response");
      const observation = { ...context, returned: batch.messages.length };
      if (page === MAX_PAGES_PER_CONVERSATION && batch.messages.length > 0) throw new BackupSourceError(observation, "page_limit");
      // Whether another page exists is decided from the raw response, before anything is held back.
      const more = batch.hasMore ?? batch.messages.length >= PAGE;

      let rows = batch.messages;
      if (more && identity === "source-id-components-v1" && rows.length === PAGE) {
        const tailId = messageId(rows[rows.length - 1]);
        let cut = rows.length;
        while (cut > 0 && messageId(rows[cut - 1]) === tailId) cut--;
        // A whole page of one ID can't be backed up to a safe cursor: refuse, never skip.
        if (cut === 0) throw new BackupSourceError(observation, "group_split");
        rows = rows.slice(0, cut);
      }
      const pageIds = new Set<string>();
      let previousId: string | undefined;
      let restart = false;
      for (const message of rows) {
        const id = messageId(message);
        if (!id) throw new BackupSourceError(observation, "cursor_missing");
        // Letta can project one source ID into several reasoning/text/tool
        // components, including multiple of the same type. Preserve them all.
        // A source ID from an earlier page is still ambiguous overlap: fail
        // closed rather than deduplicate content or hide a pagination loop.
        if (seen.has(id)) {
          if (carried && page === 0) { restart = true; break; }
          throw new BackupSourceError(observation, "cursor_repeated");
        }
        if (pageIds.has(id) && (identity !== "source-id-components-v1" || id !== previousId)) throw new BackupSourceError(observation, "cursor_repeated");
        pageIds.add(id);
        previousId = id;
      }
      if (restart) {
        readWholeInstead();
        // The next turn of this loop is page 0 again: the chat's first page, from the start.
        page = -1;
        continue;
      }
      for (const id of pageIds) seen.add(id);
      for (const message of rows) {
        lines.push(await attachmentCollector.lift(message, `${conversation.id}/message/${read}`));
        read += 1;
      }
      if (rows.length > 0) lastId = messageId(rows[rows.length - 1]) ?? lastId;
      flushChunks(false);
      if (rows.length > 0) options.onProgress?.(done, conversations.length + 2, `${conversation.title} · ${read.toLocaleString()} messages`);
      if (!more) { complete = true; break; }
      const next = messageId(rows[rows.length - 1]);
      if (!next || next === after) throw new BackupSourceError(observation, "cursor_stalled");
      after = next;
    }
    if (!complete) throw new BackupSourceError({ operation: "messages.list", page: MAX_PAGES_PER_CONVERSATION + 1, count: read }, "page_limit");
    flushChunks(true);
    meta.count = meta.chunks.reduce((sum, chunk) => sum + chunk.count, 0);
    meta.lastMessageId = lastId ?? meta.lastMessageId;
    meta.title = conversation.title;
    meta.archived = conversation.archived;
    put(`conversations/${conversation.id}/meta.json`, "conversation-record", jsonBytes({ ...meta, capture: { mode: carried ? "incremental" : "full-history", order: "asc", ...(carried ? { baseline: options.baselineId ?? null } : {}), ...(identity ? { messageIdentity: identity } : {}) } }));
    collected.counts.conversations! += 1;
    collected.counts.messages! += meta.count;
    const oldIds = new Set<string>();
    try {
      for (const entry of previous.values()) {
        if (entry.kind !== "conversation" || !entry.path.startsWith(`conversations/${conversation.id}/`)) continue;
        for (const line of store.getObject(entry.hash).toString("utf8").split("\n").filter(Boolean)) {
          const id = messageId(JSON.parse(line));
          if (id) oldIds.add(id);
        }
      }
    } catch { oldIds.clear(); } // Damaged baselines never supply current snapshot content.
    // Ids only: the chat itself has already been written out in chunks.
    collected.counts.newMessages! += [...seen].filter((id) => !oldIds.has(id)).length;
    done += 1;
  }
  // Binary attachments share the content-addressed store, including small inline images.
  for (const [hash, size] of blobs) collected.entries.push({ path: `attachments/${hash}`, hash, size, kind: "attachment" });
  collected.counts.pictures = new Set(attachments.filter((item) => item.status === "captured" && item.mediaType?.startsWith("image/")).map((item) => item.hash)).size;
  const omittedPictures = attachments.filter((item) => item.reason === "pictures-disabled").length;
  if (omittedPictures) collected.omissions.push(`${omittedPictures} picture${omittedPictures === 1 ? "" : "s"} left out (pictures are switched off for backups).`);

  // Schedules and Hearthside's own state.
  options.onProgress?.(conversations.length, conversations.length + 2, "schedules");
  const schedules = await sources.schedules().catch((error: unknown) => {
    collected.omissions.push(`Schedules couldn't be read: ${backupSourceFailure(error, { operation: "schedules.list" }).message}`);
    return [] as unknown[];
  });
  put("schedules.json", "schedules", jsonBytes(schedules));
  collected.counts.schedules = schedules.length;
  put("hearthside.json", "hearthside", jsonBytes(await sources.hearthside()));
  if (sources.repositories) {
    // Reader failures are omissions; unsafe namespaces are fatal, not swallowed.
    const repositories = await sources.repositories().catch((error: unknown) => {
      collected.omissions.push(`Attached history (repositories on Letta Cloud) couldn't be read: ${backupSourceFailure(error, { operation: "repositories.list" }).message}`);
      return [];
    });
    const manifest: unknown[] = [];
    const folders = new Set<string>();
    let files = 0;
    for (const repository of repositories) {
      const folder = safePath(repository.id ?? repository.name);
      if (folder.includes("/") || folders.has(folder.normalize("NFC").toLowerCase())) throw new Error(`Repository namespace collision or invalid identity: ${folder}`);
      folders.add(folder.normalize("NFC").toLowerCase());
      const root = `repositories/${folder}`;
      for (const file of repository.files) {
        try {
          put(`${root}/${safePath(file.path)}`, "repository", file.bytes ?? Buffer.from(file.content, "utf8"));
        } catch (error) {
          if (error instanceof Error && /^(Unsafe backup path|Backup path namespace collision)/.test(error.message)) throw unusableName(`In the memory store "${repository.name.slice(0, 80)}", the file`, String(file.path), error);
          throw error;
        }
        files += 1;
      }
      const bundlePath = repository.gitBundle ? `repository-history/${folder}.git.bundle` : null;
      if (bundlePath) put(bundlePath, "repository-history", repository.gitBundle!);
      else collected.omissions.push(`Repository "${repository.name}" Git history is unavailable; only current files were captured.`);
      const { files: sourceFiles, gitBundle: _bundle, ...identity } = repository;
      manifest.push({ ...identity, root, files: sourceFiles.map((file) => `${root}/${file.path}`), bundlePath });
      if (repository.isPrimary === undefined || repository.id === undefined || repository.permissions === undefined || repository.revision == null) collected.omissions.push(`Repository "${repository.name}" identity/primary/permissions/revision metadata is incomplete.`);
      if (repository.error) collected.omissions.push(`Part of repository "${repository.name}" couldn't be read: ${repository.error}`);
    }
    put("repositories.json", "repository-records", jsonBytes({ version: 1, repositories: manifest }));
    collected.counts.repositoryFiles = files;
  } else collected.omissions.push("Attached repository inventory was not supplied.");
  // Said outright: a companion on a self-hosted server has no memory folder here, one
  // whose folder has no history yet isn't read, and neither has anything in Cloud. That backup used to look like any other, with only a note whose
  // explanation said nothing was missing.
  if (!sources.memoryDir && !collected.counts.repositoryFiles) collected.omissions.push(NO_MEMORY_NOTE);
  if (sources.extras) {
    const extras = await sources.extras();
    const kept: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(extras)) {
      if (key === "captureObservations") {
        put("capture-observation.json", "capture-observation", jsonBytes(value.items));
        if (value.error) collected.omissions.push(`Capture observations: ${value.error}`);
        continue;
      }
      kept[key] = value.items;
      collected.counts[key] = value.items.length;
      if (value.error) collected.omissions.push(`${key} couldn't be read: ${value.error}`);
      if (value.limitation) collected.omissions.push(`${key === "configurationCoverage" ? "Configuration coverage" : key}: ${value.limitation}`);
    }
    put("extras.json", "extras", jsonBytes(kept));
  }
  if (sources.artifacts) {
    for (const artifact of await sources.artifacts()) {
      if (artifact.error) collected.omissions.push(`${artifact.path}: ${artifact.error}`);
      else if (artifact.bytes) put(safePath(artifact.path), artifact.kind, artifact.bytes);
      else collected.omissions.push(`${artifact.path}: no artifact data was returned.`);
    }
  }
  if (carriedChats > 0) collected.omissions.push(`Incremental backup: ${carriedChats} chat(s) were carried over from the previous backup and only new messages were read. Messages edited or deleted since then aren't reflected until the next full backup.`);
  put("attachments.json", "attachment-inventory", jsonBytes({ version: 1, attachments }));
  const unresolved = attachments.filter((item) => item.status === "unresolved-external").length;
  if (unresolved) collected.omissions.push(`${unresolved} attachments could not be captured; see attachments.json for bounded, sanitized omission reasons.`);
  const after = sources.checkpoint ? await sources.checkpoint() : null;
  const comparable = before !== null && before !== undefined && after !== null && after !== undefined;
  if (comparable && beforeToken !== JSON.stringify(after)) throw new Error("Source changed during backup; retry capture (previous snapshots are unchanged).");
  const status = comparable ? "revision-checked" : "non-atomic";
  if (!comparable) collected.omissions.push("Capture is non-atomic: no authoritative source-wide checkpoint was available; concurrent changes cannot be ruled out.");
  put("consistency.json", "consistency", jsonBytes({ version: 1, status, before, after }));
  options.onProgress?.(conversations.length + 2, conversations.length + 2, "done");
  await sources.validateBeforeCommit?.();
  return store.writeSnapshot(
    { agentId: sources.agent.id, agentName: sources.agent.name, at: new Date().toISOString(), counts: collected.counts, omissions: collected.omissions, app: options.app },
    collected.entries,
  );
}
