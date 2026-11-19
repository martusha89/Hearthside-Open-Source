import type { BackupCaptureDiagnostic, BackupCaptureDiagnosticLimits, BackupChatDiagnostic } from "@hearthside/ipc-contract";
import type { MessagePage, SourceConversation } from "./collect";
import { BackupSourceError } from "./diagnostics";

/**
 * Hearthside: "what does this connection actually report?", answered by
 * reading, counting, and nothing else.
 *
 * Phase 3 of docs/PORTABLE-CONTINUITY.md left one question that no synthetic
 * fixture can settle: whether the Cloud message list really returns
 * `summary_message` rows with `compaction_stats` for a real account, and
 * whether a conversation really reports `in_context_message_ids`. That needs an
 * account, so it needs the person who owns one to press a button.
 *
 * The rules this module exists to keep:
 *  - It reads through the SAME readers a backup uses (`backupMainConversation`,
 *    `backupConversationPage`, `backupConversationRecord`, `backupMessages`), so
 *    what it reports is what a capture would see, including every SDK
 *    normalisation. It never builds its own client — and it never calls the
 *    whole-history reader `backupConversations`, whose walk is bounded by what a
 *    backup needs (500 pages and one record read per chat), not by what this
 *    check is allowed to spend.
 *  - It only ever counts. Every value in a report is a number, a boolean, or a
 *    word from a list written here. Nothing from a payload is ever copied into
 *    the report: no message text, no prompts, no tool arguments, no token
 *    counts, no URLs, no identifiers, not even a chat title. Chats are
 *    numbered.
 *  - It is bounded in chats, listing pages, message pages, messages, received
 *    bytes and time — every one of those counted from the first read, the chat
 *    listing included — and it can be cancelled.
 *  - Every read is given a deadline and raced against one. Where the transport
 *    takes a signal the deadline really aborts it; where it does not, this check
 *    stops waiting and says so, and `abandonedReads` counts it. Waiting is
 *    bounded either way; stopping the request is not always possible, and this
 *    module never claims otherwise.
 *  - A bounded scan that saw nothing says "not observed within the range
 *    scanned". It never says "absent".
 *  - Failures are sanitised: a refusal is reported as a refusal, with no
 *    payload and no endpoint.
 *  - It writes nothing, sends nothing, schedules nothing, and asks no model
 *    anything.
 */

export const CAPTURE_DIAGNOSTIC_VERSION = 1;

/** The shape the renderer sees lives in the contract; this is its only writer. */
export type CaptureDiagnosticLimits = BackupCaptureDiagnosticLimits;
export type ChatDiagnostic = BackupChatDiagnostic;
export type CaptureDiagnosticReport = BackupCaptureDiagnostic;

export const CAPTURE_DIAGNOSTIC_LIMITS: CaptureDiagnosticLimits = {
  chats: 12,
  pagesPerChat: 3,
  messagesPerChat: 300,
  jsonBytes: 4_000_000,
  milliseconds: 20_000,
  listPages: 2,
  readMilliseconds: 10_000,
};

const PAGE = 100;

/** Counts what arrived, in bytes, not in UTF-16 units. Works in main and in a browser fixture. */
const encoder = new TextEncoder();
const byteLength = (value: unknown): number => {
  const text = JSON.stringify(value);
  return typeof text === "string" ? encoder.encode(text).length : 0;
};

/**
 * The message types the pinned SDK declares
 * (@letta-ai/letta-client resources/agents/messages.d.ts:1342). A type outside
 * this list is counted as `other`, never named, so a server string can never
 * reach the report.
 */
const MESSAGE_TYPES = [
  "system_message",
  "user_message",
  "assistant_message",
  "reasoning_message",
  "hidden_reasoning_message",
  "tool_call_message",
  "tool_return_message",
  "approval_request_message",
  "approval_response_message",
  "summary_message",
  "event_message",
] as const;

/** Roles a local runtime transcript row carries instead of a message type. */
const ROLES = ["user", "assistant", "system", "tool", "approval"] as const;

/**
 * CompactionStats as the pinned SDK declares it (messages.d.ts:1557). Presence
 * is counted per field; a field outside the list is counted but never named.
 */
const COMPACTION_STAT_FIELDS = [
  "context_window",
  "messages_count_before",
  "messages_count_after",
  "trigger",
  "context_tokens_before",
  "context_tokens_after",
] as const;

/** Conversation-context fields a capture records (runtime.ts `backupConversations`). */
const CONTEXT_FIELDS = ["in_context_message_ids", "compaction_settings", "model_settings", "context_window_limit"] as const;

/** The only two provenance words `backupConversations` ever writes. */
const CONTEXT_SOURCES = ["agent.message_ids", "conversation.retrieve"] as const;

/**
 * One read's deadline, offered to the transport in both forms it may accept. A
 * transport that accepts neither is still only waited on for `timeoutMs`.
 */
export type DiagnosticRead = { signal: AbortSignal; timeoutMs: number };

export type CaptureDiagnosticSources = {
  /** The main chat's record, and the authoritative check that this agent is reachable. */
  readMainChat(read: DiagnosticRead): Promise<SourceConversation>;
  /** One page of the chat listing, newest first, at most `limit` rows. */
  listChatPage(options: { archived: boolean; after?: string; limit: number }, read: DiagnosticRead): Promise<unknown[]>;
  /** One chat's record, for its active-context window. */
  readChat(conversationId: string, read: DiagnosticRead): Promise<SourceConversation>;
  listMessages(conversationId: string, options: { after?: string; before?: string; limit: number; order: "asc" | "desc" }, read: DiagnosticRead): Promise<MessagePage>;
  /**
   * Throws if the account or connection is no longer the one the scan started
   * against. Called before and after every read, exactly as a capture does, so
   * a scan can never mix two principals.
   */
  checkScope(): void;
  backend: CaptureDiagnosticReport["backend"];
  now?(): number;
  cancelled?(): boolean;
};

/** Why the check stopped waiting. Not a failure of the connection. */
type StopReason = "cancelled" | "time" | "read-time" | "bytes";
class DiagnosticStopped extends Error {
  constructor(readonly reason: StopReason) { super(reason); }
}
const stopWords: Record<Exclude<StopReason, "cancelled">, string> = {
  time: "the time this check is allowed to take ran out",
  "read-time": "a read did not answer within the time allowed for one read",
  bytes: "the amount this check is allowed to read ran out",
};

const record = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 0]));
const bump = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const row = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** The account or connection changed mid-scan: the whole check stops. */
export class DiagnosticScopeChanged extends Error {}

/**
 * Sanitised, payload-free words for a failed read. Only this build's own
 * sentences, the closed failure code and the clamped HTTP status (which
 * `BackupSourceError` already restricts to 400-599) are ever shown.
 */
function failureWords(error: unknown): string {
  if (error instanceof BackupSourceError) {
    const what = error.status === 403 ? "refused the read (not permitted)"
      : error.status === 404 ? "reported nothing at that place (not found)"
      : error.status === 401 ? "rejected the sign-in"
      : error.status !== undefined ? `answered with status ${error.status}`
      : error.code === "request_timeout" ? "did not answer in time"
      : error.code === "connection_failed" ? "could not be reached"
      : error.code.startsWith("cursor_") ? "returned messages this check could not follow"
      : error.code === "page_limit" ? "holds more pages than this check reads"
      : error.code === "capture_limit" ? "holds more than one backup is allowed to copy"
      : "did not complete the read";
    return `The connection ${what}. Nothing can be concluded about what it holds. No request details are included.`;
  }
  return "The read did not complete. Nothing can be concluded about what the connection holds. No request details are included.";
}

/**
 * Count one bounded, newest-first walk of each chat. Pages are requested with
 * the same reader a capture uses; the walk stops the moment a cursor fails to
 * move, so a wrong guess about paging ends the scan honestly instead of
 * looping or claiming absence.
 */
/**
 * Count one bounded, newest-first walk of each chat, inside one budget that
 * covers the chat listing, each chat's record and every message page. Pages are
 * requested with the same readers a capture uses; a walk stops the moment a
 * cursor fails to move, so a wrong guess about paging ends the scan honestly
 * instead of looping or claiming absence.
 */
export async function runCaptureDiagnostic(sources: CaptureDiagnosticSources, limits: CaptureDiagnosticLimits = CAPTURE_DIAGNOSTIC_LIMITS): Promise<CaptureDiagnosticReport> {
  const now = sources.now ?? (() => Date.now());
  const cancelled = sources.cancelled ?? (() => false);
  const began = now();
  const startedAt = new Date().toISOString();

  let jsonBytesRead = 0;
  let abandonedReads = 0;
  let listPagesRead = 0;
  let wasCancelled = false;
  let bounded = false;
  let listingBounded = false;
  let stopped: Exclude<StopReason, "cancelled"> | null = null;

  /** A principal change is never a per-chat failure: it ends the check. */
  const scope = () => {
    try { sources.checkScope(); } catch {
      throw new DiagnosticScopeChanged("The account or connection changed while the check ran. The check stopped, and nothing from a second account is reported.");
    }
  };

  const noteStop = (reason: StopReason) => {
    if (reason === "cancelled") wasCancelled = true;
    else stopped ??= reason;
    bounded = true;
  };

  /**
   * Resolves when the check must stop waiting on the read in flight: its own
   * share of the time, the whole check's time, or a cancel. Cancellation is a
   * flag another thread of control sets, so it is polled rather than awaited.
   */
  const watchStop = (budget: number) => {
    let settle: (reason: StopReason) => void = () => undefined;
    const promise = new Promise<StopReason>((resolve) => { settle = resolve; });
    const step = Math.max(5, Math.min(50, Math.ceil(budget / 4)));
    let waited = 0;
    const timer = setInterval(() => {
      if (cancelled()) { clearInterval(timer); settle("cancelled"); return; }
      waited += step;
      if (now() - began >= limits.milliseconds) { clearInterval(timer); settle("time"); return; }
      if (waited >= budget) { clearInterval(timer); settle("read-time"); }
    }, step);
    (timer as unknown as { unref?: () => void }).unref?.();
    return { promise, done: () => clearInterval(timer) };
  };

  /**
   * Every read this check makes goes through here, the chat listing included:
   * limits are consulted before the request, the request carries a deadline,
   * and the wait for it is raced against that deadline and against cancel. A
   * read that loses the race is aborted where the transport allows it, counted
   * as abandoned where it does not, and never waited on or read from again.
   */
  const read = async <T>(run: (read: DiagnosticRead) => Promise<T>): Promise<T> => {
    if (cancelled()) throw new DiagnosticStopped("cancelled");
    if (now() - began >= limits.milliseconds) throw new DiagnosticStopped("time");
    if (jsonBytesRead >= limits.jsonBytes) throw new DiagnosticStopped("bytes");
    scope();
    const budget = Math.max(1, Math.min(limits.readMilliseconds, limits.milliseconds - (now() - began)));
    const controller = new AbortController();
    const watch = watchStop(budget);
    // The attempt absorbs its own rejection here, so abandoning it below can
    // never surface later as an unhandled rejection.
    const attempt = run({ signal: controller.signal, timeoutMs: budget }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let answer: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      answer = await Promise.race([attempt, watch.promise.then((reason) => ({ ok: false as const, error: new DiagnosticStopped(reason) }))]);
    } finally {
      watch.done();
    }
    if (!answer.ok && answer.error instanceof DiagnosticStopped) {
      controller.abort();
      abandonedReads += 1;
      throw answer.error;
    }
    if (!answer.ok) throw answer.error;
    scope();
    jsonBytesRead += byteLength(answer.value);
    return answer.value;
  };

  // The main chat first: the agent read that carries its active-context window
  // is also the authoritative check that this companion is on this connection.
  let main: SourceConversation | null = null;
  let mainFailure: string | null = null;
  try {
    main = await read((at) => sources.readMainChat(at));
  } catch (error) {
    if (error instanceof DiagnosticScopeChanged) throw error;
    if (error instanceof DiagnosticStopped) noteStop(error.reason);
    else { mainFailure = failureWords(error); bounded = true; }
  }

  // The listing, page by page, only as far as this check may scan: active chats
  // before archived ones, newest first, and never more rows than there is room
  // to look at. A listing that fills the chat limit says nothing about what lies
  // past it, archived chats included.
  const ids = new Set<string>(main ? [main.id] : []);
  const candidates: Array<{ id: string; archived: boolean }> = [];
  const room = () => limits.chats - (main ? 1 : 0) - candidates.length;
  let listFailure: string | null = null;
  const walk = async (archived: boolean) => {
    let after: string | undefined;
    for (let page = 0; page < limits.listPages; page++) {
      if (room() <= 0) { listingBounded = true; return; }
      const want = Math.min(PAGE, room());
      const rows = await read((at) => sources.listChatPage({ archived, limit: want, ...(after ? { after } : {}) }, at));
      listPagesRead += 1;
      const batch = Array.isArray(rows) ? rows : [];
      let fresh = 0;
      let last: string | undefined;
      for (const entry of batch) {
        const item = row(entry);
        const id = typeof item.id === "string" ? item.id : undefined;
        if (!id) continue;
        last = id;
        if (ids.has(id)) continue;
        ids.add(id);
        fresh += 1;
        if (room() > 0) candidates.push({ id, archived: archived || item.archived === true });
      }
      if (batch.length === 0) return;
      if (fresh === 0 || last === undefined || last === after) { listingBounded = true; return; }
      if (batch.length < want) return;
      after = last;
      if (page + 1 === limits.listPages) listingBounded = true;
    }
  };
  try {
    await walk(false);
    await walk(true);
  } catch (error) {
    if (error instanceof DiagnosticScopeChanged) throw error;
    listingBounded = true;
    if (error instanceof DiagnosticStopped) noteStop(error.reason);
    else { listFailure = failureWords(error); bounded = true; }
  }

  const chatsReported = ids.size;
  const selected = [
    ...(main ? [{ id: main.id, archived: main.archived === true, main: true }] : []),
    ...candidates.map((candidate) => ({ ...candidate, main: false })),
  ].slice(0, limits.chats);

  const chats: ChatDiagnostic[] = [];
  for (const [index, entry] of selected.entries()) {
    const report: ChatDiagnostic = {
      chat: entry.main ? "Main chat" : `Chat ${index + 1}`,
      main: entry.main,
      archived: entry.archived,
      pagesRead: 0,
      messagesRead: 0,
      messagesReceived: 0,
      messageTypes: { ...record(MESSAGE_TYPES), other: 0 },
      roles: { ...record(ROLES), other: 0 },
      summaries: 0,
      summariesWithStats: 0,
      otherRowsWithCompactionStats: 0,
      compactionStatFields: record(COMPACTION_STAT_FIELDS),
      unknownCompactionStatFields: 0,
      contextFields: [],
      contextSource: "not-reported",
      sourceWindowIds: null,
      contextFailure: null,
      scan: "whole-chat",
      stoppedBecause: null,
      failure: null,
    };

    // The chat's own record carries the active-context window. The main chat's
    // came with the agent read above; every other chat needs one read of its
    // own, which is a read like any other: bounded, counted and abandonable.
    let persisted: SourceConversation | null = entry.main ? main : null;
    if (!persisted) {
      try {
        persisted = await read((at) => sources.readChat(entry.id, at));
      } catch (error) {
        if (error instanceof DiagnosticScopeChanged) throw error;
        if (error instanceof DiagnosticStopped) {
          noteStop(error.reason);
          if (error.reason === "cancelled") report.scan = "cancelled";
          else { report.scan = "stopped-at-limit"; report.stoppedBecause = stopWords[error.reason]; }
          chats.push(report);
          break;
        }
        report.contextFailure = failureWords(error);
      }
    }
    if (persisted) {
      report.archived = persisted.archived === true || entry.archived;
      // The recorded context, by field presence only. The window's ids are counted,
      // never read out.
      const context = row(persisted.context);
      report.contextFields = CONTEXT_FIELDS.filter((field) => context[field] !== undefined && context[field] !== null);
      if (Array.isArray(context.in_context_message_ids)) report.sourceWindowIds = context.in_context_message_ids.length;
      if (typeof context.source === "string") report.contextSource = (CONTEXT_SOURCES as readonly string[]).includes(context.source) ? (context.source as (typeof CONTEXT_SOURCES)[number]) : "unrecognised";
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < limits.pagesPerChat; page++) {
        // Never ask for more messages than there is room to count, so a page
        // cannot be expanded past this chat's allowance by asking.
        const left = limits.messagesPerChat - report.messagesRead;
        if (left <= 0) { report.scan = "stopped-at-limit"; report.stoppedBecause = "the number of messages this check is allowed to count ran out"; break; }
        const want = Math.min(PAGE, left);

        const result = await read((at) => sources.listMessages(entry.id, { limit: want, order: "desc", ...(cursor ? { before: cursor } : {}) }, at));
        const messages = Array.isArray(result.messages) ? result.messages : [];
        report.pagesRead += 1;
        // What arrived, whether or not it is counted below: a page can come back
        // longer than it was asked for, and the bytes of it are already spent.
        report.messagesReceived += messages.length;

        let fresh = 0;
        let last: string | undefined;
        for (const message of messages) {
          if (report.messagesRead >= limits.messagesPerChat) break;
          const item = row(message);
          const id = typeof item.id === "string" ? item.id : undefined;
          if (id) last = id;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          fresh += 1;
          report.messagesRead += 1;

          const type = typeof item.message_type === "string" ? item.message_type : null;
          if (type) bump(report.messageTypes, (MESSAGE_TYPES as readonly string[]).includes(type) ? type : "other");
          const role = typeof item.role === "string" ? item.role : null;
          if (role) bump(report.roles, (ROLES as readonly string[]).includes(role) ? role : "other");

          // Two separate questions, kept separate on purpose: is this a row this
          // check recognises as a compaction summary, and does it carry stats?
          // A row of some other kind that carries compaction stats is counted as
          // a stat-bearing row — never relabelled as a summary, and never thrown
          // away, which would turn "this connection does report stats" into a
          // flat "no summary was observed".
          const isSummary = type === "summary_message" || (type === null && item.summary !== undefined && item.compaction_stats !== undefined);
          const stats = typeof item.compaction_stats === "object" && item.compaction_stats !== null ? (item.compaction_stats as Record<string, unknown>) : null;
          if (isSummary) {
            report.summaries += 1;
            if (stats) report.summariesWithStats += 1;
          } else if (stats) {
            report.otherRowsWithCompactionStats += 1;
          }
          if (!stats) continue;
          for (const [field, value] of Object.entries(stats)) {
            if (value === undefined || value === null) continue;
            if ((COMPACTION_STAT_FIELDS as readonly string[]).includes(field)) bump(report.compactionStatFields, field);
            else report.unknownCompactionStatFields += 1;
          }
        }

        if (report.messagesRead >= limits.messagesPerChat) { report.scan = "stopped-at-limit"; report.stoppedBecause = "the number of messages this check is allowed to count ran out"; break; }
        if (messages.length === 0) break;
        if (fresh === 0 || last === undefined || last === cursor) { report.scan = "stopped-at-limit"; report.stoppedBecause = "the connection did not page any further back"; break; }
        if (messages.length < want && result.hasMore !== true) break;
        cursor = last;
        if (page + 1 === limits.pagesPerChat) { report.scan = "stopped-at-limit"; report.stoppedBecause = "the number of pages this check is allowed to read ran out"; }
      }
    } catch (error) {
      if (error instanceof DiagnosticScopeChanged) throw error;
      if (error instanceof DiagnosticStopped) {
        noteStop(error.reason);
        if (error.reason === "cancelled") report.scan = "cancelled";
        else { report.scan = "stopped-at-limit"; report.stoppedBecause = stopWords[error.reason]; }
      } else {
        report.scan = "failed";
        report.failure = failureWords(error);
      }
    }

    if (report.scan !== "whole-chat") bounded = true;
    chats.push(report);
    if (wasCancelled || stopped !== null) break;
  }
  if (chats.length < selected.length) bounded = true;
  // A listing that stopped at a limit is a bounded report, whatever happened
  // inside the chats it did name.
  if (listingBounded) bounded = true;

  const sum = (pick: (chat: ChatDiagnostic) => number) => chats.reduce((total, chat) => total + pick(chat), 0);
  const scanned = chats.filter((chat) => chat.scan !== "failed").length;
  const messagesRead = sum((chat) => chat.messagesRead);
  const messagesReceived = sum((chat) => chat.messagesReceived);
  const summaries = sum((chat) => chat.summaries);
  const summariesWithStats = sum((chat) => chat.summariesWithStats);
  const otherStatRows = sum((chat) => chat.otherRowsWithCompactionStats);
  const withWindow = chats.filter((chat) => chat.sourceWindowIds !== null && chat.sourceWindowIds > 0).length;
  const failed = chats.filter((chat) => chat.scan === "failed").length;

  const findings: string[] = [];
  if (mainFailure) findings.push(`The main chat's record could not be read, so this check could not look at it. ${mainFailure}`);
  if (listFailure) findings.push(`The chat listing did not complete, so this check saw at most ${chatsReported} chat(s). ${listFailure}`);
  const range = `${messagesRead} message(s) across ${scanned} of ${chatsReported} listed chat(s), newest first`;
  if (summaries === 0) findings.push(`No compaction summary row was recognised within the range scanned (${range}). This is not evidence that none exists: the scan is bounded and stops before the oldest messages.`);
  else {
    findings.push(`${summaries} compaction summary row(s) were observed within the range scanned (${range}).`);
    if (summariesWithStats === 0) findings.push("None of them carried compaction stats, so a captured transcript here would record a compaction with no counts.");
    else findings.push(`${summariesWithStats} of them carried compaction stats.`);
  }
  // Stat-bearing rows this check does not call summaries are still reported:
  // "no summary was observed" alone would hide that the connection does send
  // compaction metadata, in a shape this version does not recognise.
  if (otherStatRows > 0) findings.push(`${otherStatRows} row(s) that this check does not recognise as a compaction summary carried compaction stats of their own. They are counted as stat-bearing rows and nothing more: carrying stats does not make a row a summary.`);
  const statRows = summariesWithStats + otherStatRows;
  if (statRows > 0) {
    const present = Object.entries(chats.reduce<Record<string, number>>((totals, chat) => { for (const [field, count] of Object.entries(chat.compactionStatFields)) totals[field] = (totals[field] ?? 0) + count; return totals; }, {})).filter(([, count]) => count > 0).map(([field]) => field);
    // An empty or all-null stats record is a real answer, and it must not read
    // as a sentence that trails off into "the fields present were: ."
    if (present.length > 0) findings.push(`Across those ${statRows} row(s), the stat fields present were: ${present.join(", ")}.`);
    else findings.push(`Across those ${statRows} row(s), no stat field this version knows about carried a value.`);
    const unknown = sum((chat) => chat.unknownCompactionStatFields);
    if (unknown > 0) findings.push(`${unknown} stat field(s) present are not ones this version knows about; they are counted here and not named.`);
  }
  // What this check can say is about itself: a window it did not see is a thing
  // it cannot establish, not a thing that would make a chat unreopenable. A
  // degraded conversion can reopen a chat with no source window at all, so no
  // claim about restoring belongs in a bounded count.
  if (withWindow === 0) findings.push(`No chat reported an active-context window within the range scanned, so this check cannot establish active-context continuity. It says nothing either way about whether a chat could be reopened.`);
  else findings.push(`${withWindow} of ${chats.length} scanned chat(s) reported an active-context window; the window lengths are listed per chat.`);
  const contextMissed = chats.filter((chat) => chat.contextFailure !== null).length;
  if (contextMissed > 0) findings.push(`${contextMissed} chat(s) would not give up their own record, so nothing is claimed about the active context of those chats.`);
  if (failed > 0) findings.push(`${failed} chat(s) could not be read. Nothing is claimed about those chats.`);
  if (listingBounded) findings.push(`The chat listing itself stopped at one of this check's limits: ${chatsReported} chat(s) were named in the ${listPagesRead} listing page(s) read, and how many exist is unknown. The listing is read newest first, active chats before archived ones, so archived chats may not have been reached at all.`);
  if (messagesReceived > messagesRead) findings.push(`${messagesReceived - messagesRead} message(s) arrived beyond what this check counts. They were received and measured, not counted: a page is measured only once it has arrived.`);
  // What this check can promise is that it stopped waiting, and nothing more.
  // Stopping the read itself needs the transport to take a cancel, and most of
  // the reads here go through a client that takes none, so saying "it asked the
  // connection to stop" would be a claim about reads where nothing was asked.
  if (abandonedReads > 0) findings.push(`${abandonedReads} read(s) did not answer within the time allowed, so this check stopped waiting for them and ignored anything they returned afterwards. Stopping the waiting is not the same as stopping the read: where the connection cannot be cancelled, a read may have gone on after this report.`);
  if (wasCancelled) findings.push("The check was stopped on request. Everything above is partial.");
  else if (bounded) findings.push("The check stopped at one of its limits, so everything above describes only the range scanned.");

  return {
    version: CAPTURE_DIAGNOSTIC_VERSION,
    backend: sources.backend,
    startedAt,
    elapsedMs: now() - began,
    limits,
    chatsReported,
    chatsScanned: scanned,
    messagesRead,
    messagesReceived,
    jsonBytesRead,
    summaries,
    summariesWithStats,
    chatsWithSourceWindow: withWindow,
    bounded,
    listingBounded,
    abandonedReads,
    cancelled: wasCancelled,
    chats,
    findings,
  };
}
