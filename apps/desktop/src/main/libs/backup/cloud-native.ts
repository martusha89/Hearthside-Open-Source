import { createHash } from "node:crypto";
import { drain, drainAsync } from "./breathe";
import { closeSync, constants, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_RUNTIME_VERSION, diskFile, validateNativeArchive, validateSteps, type NativeArchive, type NativeFile } from "./native-state";




export const CONVERTER_VERSION = "cloud-native-1";



export const HISTORY_VOLUME_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, messages: 400 });

/** How Hearthside recognises and orders history volumes (tags the runtime lists back). */
export const HISTORY_TAG = "hearthside-history";
export function historyTags(input: { sourceConversationId: string; main: boolean; part: number; firstAt: string | null; lastAt: string | null; incomplete?: boolean }): string[] {
  return [
    HISTORY_TAG,
    `${HISTORY_TAG}-of:${input.main ? "main" : input.sourceConversationId}`,
    `${HISTORY_TAG}-part:${input.part}`,
    `${HISTORY_TAG}-span:${input.firstAt ?? ""}/${input.lastAt ?? ""}`,
    ...(input.incomplete ? ["hearthside-history-incomplete"] : []),
  ];
}

export interface CloudAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly system?: unknown;
  readonly description?: unknown;
  readonly model?: unknown;
  readonly model_settings?: unknown;
  readonly compaction_settings?: unknown;
}

export interface CloudConversationCapture {
  readonly id: string;
  readonly main?: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly archived?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly context?: { readonly in_context_message_ids?: unknown } | null;
  /** Projected messages, oldest first. Read once, in order; never held whole. */
  readonly messages: Iterable<Record<string, unknown>>;
  readonly truncated?: boolean;
}

export interface ConvertCloudOptions {
  readonly agent: CloudAgentRecord;
  readonly localAgentId: string;
  readonly conversations: Iterable<CloudConversationCapture>;
  readonly sessionCwd: string;
  readonly limits?: { bytes: number; messages: number };


  readonly pictures?: "block" | "placeholder";
  /**
   * A call in older messages with no result anywhere in its chat: "block" (strict), or
   * "annotate": carried in place with a clearly synthetic recovery annotation, outcome
   * unknown. Also a chosen degraded restore, never the default. Calls in the active
   * window with no result always block.
   */
  readonly unansweredCalls?: "block" | "annotate";


  readonly windowCalls?: "block" | "close";
  /**
   * Chats the person chose to keep as read-only, incomplete history only (their active
   * window names messages the backup doesn't contain): no live conversation is made.
   */
  readonly excludeChats?: readonly string[];


  readonly fallbacks?: boolean;
}

export const WINDOW_CALL_CLOSURE = "Recovery closure: this tool call was still awaiting a result when the backup was made. Its execution outcome is unknown. This is a synthetic recovery record, not a tool response; the restored copy must not run this call again.";

export const PICTURE_PLACEHOLDER = "[Picture not carried into this chat]";

export type VolumeRole = "live" | "history";
export interface ConvertedVolume {
  readonly sourceConversationId: string;
  readonly sourceTitle: string;
  /** Archive conversation ID ("default" for the main live volume). */
  readonly archiveConversationId: string;
  readonly role: VolumeRole;
  /** 1-based order among this conversation's history volumes; 0 for live. */
  readonly part: number;
  readonly messages: number;
  readonly bytes: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly label: string;
}

export type MessagePlacement = { sourceConversationId: string; sourceMessageId: string; archiveMessageId: string; archiveConversationId: string; role: string };

/** Detailed unconverted entries kept for the preview; totals are always complete. */
const UNCONVERTED_DETAIL = 500;
export interface CloudConversionLoss {
  readonly converter: string;
  readonly runtimeVersion: string;
  readonly synthesized: string[];
  /** The first UNCONVERTED_DETAIL items, for the preview's details. */
  readonly unconverted: Array<{ conversationId: string; sourceMessageId: string | null; messageType: string; reason: string }>;
  readonly unconvertedTotal: number;
  readonly unconvertedByReason: Record<string, number>;
  readonly unconvertedByConversation: Record<string, number>;
  /** Picture parts seen in user messages: how many, how many in active windows, in how many chats, and whether the backup holds them. */
  readonly pictures: { policy: "block" | "placeholder"; parts: number; inWindow: number; chats: number; windowChats: number; captured: number; omitted: number; unknown: number; placeholders: number };
  /** Tool results moved to directly after their call, ahead of messages that came between (the local runtime needs that). */
  readonly adjacentResults: Array<{ conversationId: string; resultId: string; callId: string; inWindow: boolean }>;
  readonly adjacentResultsTotal: number;
  /** Tool results Cloud listed before their call (same timestamp), placed after it; those in a window changed its order. */
  readonly reorderedResults: Array<{ conversationId: string; resultId: string; callId: string; inWindow: boolean }>;
  readonly reorderedResultsTotal: number;
  readonly reorderedWindows: number;
  /** Calls in older messages with no result anywhere in their chat (annotated or blocked by policy). */
  readonly unansweredCalls: Array<{ conversationId: string; sourceMessageId: string; toolCallId: string }>;
  readonly unansweredCallsTotal: number;
  readonly unansweredCallsPolicy: "block" | "annotate";
  /** Window calls abandoned with a synthetic closure (policy "close"). */
  readonly closedWindowCalls: Array<{ conversationId: string; sourceMessageId: string; toolCallId: string }>;
  readonly closedWindowCallsTotal: number;
  readonly windowCallsPolicy: "block" | "close";
  /** Window calls still waiting under strict policy, by chat (what "close" would abandon). */
  readonly pendingWindowCalls: Array<{ conversationId: string; title: string; toolCallIds: string[] }>;
  /** Chats whose active window names messages the backup doesn't contain, with those IDs. */
  readonly incompleteWindows: Array<{ conversationId: string; title: string; missing: string[] }>;
  /** Chats kept as read-only incomplete history only, by the person's choice. */
  readonly excludedChats: Array<{ conversationId: string; title: string; missing: string[]; messages: number }>;
  /** True when the one-pass fallbacks decided an exclusion themselves. */
  excludedChatsAuto: boolean;
  /** Whether this conversion ran with every allowed fallback proposed itself. */
  readonly fallbacks: boolean;
  /** Refused tool calls carried as error results: denied, not run (first UNCONVERTED_DETAIL). */
  readonly translatedRefusals: Array<{ conversationId: string; sourceMessageId: string; toolCallId: string; reason: string | null; foldedInto?: string }>;
  readonly translatedRefusalsTotal: number;
  readonly notes: string[];
}

export interface CloudConversionClaims {
  readonly activeContext: "source-window-carried" | "source-window-carried-qualified";
  /** Why the window claim is qualified: "without-pictures", "results-reordered". */
  readonly qualifications: string[];
  readonly transcript: "complete" | "partial";
  readonly systemPrompt: "recompiled-locally";
  readonly perMessageProvider: "unrecorded";
  readonly exactContinuity: false;
}



export type ConversionDiagnostic = { chatId: string; reason: string; messageType: string | null; sourceId: string | null; callId: string | null; inWindow: boolean; before: Array<{ type: string | null; id: string | null; call: string | null }> };
const DIAGNOSTIC_DETAIL = 400;

export interface CloudConversionReport {
  readonly volumes: ConvertedVolume[];
  readonly loss: CloudConversionLoss;
  readonly diagnostics: ConversionDiagnostic[];
  readonly claims: CloudConversionClaims;
  readonly counts: { conversations: number; messages: number; historyVolumes: number; bytes: number };
}

export interface CloudConversion extends CloudConversionReport {
  readonly archive: NativeArchive;
  /** Source message ID -> where it lives now (archive IDs; the restore remaps them again). */
  readonly messages: MessagePlacement[];
}

export class CloudConversionBlocked extends Error {
  constructor(readonly reasons: string[], readonly report?: CloudConversionReport) {
    super(`These chats can't be restored as openable conversations yet: ${reasons.slice(0, 20).join("; ")}${reasons.length > 20 ? `; and ${reasons.length - 20} more` : ""}`);
    this.name = "CloudConversionBlocked";
  }
}

/** Where converted output goes. */
export interface ConversionSink {
  file(path: string, bytes: Buffer): void;
  message(placement: MessagePlacement): void;
}

const UNRECORDED = "unrecorded-by-cloud-capture";
const encode = (value: string) => Buffer.from(value).toString("base64url");
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const refuse = (message: string): never => { throw new Error(`Cloud conversion: ${message}`); };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");

type Entry =
  | { kind: "message"; sourceId: string; archiveId: string; at: number; iso: string; role: "user"; content: string }
  | { kind: "message"; sourceId: string; archiveId: string; at: number; iso: string; role: "assistant"; parts: Array<Record<string, unknown>> }
  | { kind: "message"; sourceId: string; archiveId: string; at: number; iso: string; role: "toolResult"; toolCallId: string; toolName: string; isError: boolean; content: string }
  | { kind: "compaction"; sourceId: string; archiveId: string; at: number; iso: string; summary: string; tokensBefore: number; stats: Record<string, unknown> | null };

function when(message: Record<string, unknown>): { at: number; iso: string } | null {
  const iso = text(message.date) ?? text(message.created_at);
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? { at, iso } : null;
}

function nativeRow(entry: Entry, model: string, id: string, parentId: string | null): Record<string, unknown> {
  const base = { id, parentId, timestamp: entry.iso };
  if (entry.kind === "compaction") {
    return { type: "compaction", ...base, summary: entry.summary, firstKeptEntryId: null, tokensBefore: entry.tokensBefore, message: {
      id: entry.archiveId, role: "user", content: entry.summary, timestamp: entry.at,
      metadata: { compaction: { summary: entry.summary, ...(entry.stats ? { stats: entry.stats } : {}) } },
    } };
  }
  const message = entry.role === "user"
    ? { id: entry.archiveId, role: "user", content: entry.content, timestamp: entry.at }
    : entry.role === "assistant"
      ? { id: entry.archiveId, role: "assistant", content: entry.parts, timestamp: entry.at, api: UNRECORDED, provider: UNRECORDED, model, usage: {} }
      : { id: entry.archiveId, role: "toolResult", content: [{ type: "text", text: entry.content }], timestamp: entry.at, toolCallId: entry.toolCallId, toolName: entry.toolName, isError: entry.isError };
  return { type: "message", ...base, message };
}

/** How many rows the runtime projects for one native entry (what the chat view pages by). */
function components(entry: Entry): number {
  return entry.kind === "message" && entry.role === "assistant" ? Math.max(1, entry.parts.length) : 1;
}

function callsOf(entry: Entry): string[] {
  return entry.kind === "message" && entry.role === "assistant" ? entry.parts.filter((part) => part.type === "toolCall").map((part) => part.id as string) : [];
}

/** The streaming engine: everything else is a sink around it. Throws CloudConversionBlocked at the end if anything was blocked. */
export function convertCloudStream(options: ConvertCloudOptions, sink: ConversionSink): CloudConversionReport {
  return drain(convertCloudSteps(options, sink));
}


export function convertCloudStreamAsync(options: ConvertCloudOptions, sink: ConversionSink): Promise<CloudConversionReport> {
  return drainAsync(convertCloudSteps(options, sink));
}
/** The conversion, one message per step. */
export function* convertCloudSteps(options: ConvertCloudOptions, sink: ConversionSink): Generator<void, CloudConversionReport, undefined> {
  if (!/^agent-local-[a-zA-Z0-9-]+$/.test(options.localAgentId)) refuse("destination needs a minted local agent ID");
  if (options.localAgentId === options.agent.id) refuse("the minted local ID must differ from the Cloud agent ID");
  if (!text(options.sessionCwd)) refuse("a session working directory must be chosen");
  const limits = options.limits ?? HISTORY_VOLUME_LIMITS;
  if (!(limits.bytes > 0) || !(limits.messages > 0)) refuse("invalid volume limits");
  const model = text(options.agent.model) ?? refuse("the captured agent record has no model handle; nothing may be invented in its place");
  const agentName = text(options.agent.name) ?? refuse("the captured agent record has no name");

  const loss = {
    converter: CONVERTER_VERSION, runtimeVersion: NATIVE_RUNTIME_VERSION,
    synthesized: [
      `The local agent ID ${options.localAgentId} is new; the Cloud agent ID ${options.agent.id} is kept as provenance only.`,
      "Transcript entry IDs and their parent chain are generated in capture order; the Cloud projection has no entry graph.",
      "Agent tags are emptied; source automation tags are not carried into a recovery identity.",
      `Per-message assistant api/provider are written as "${UNRECORDED}" and token usage as an empty record.`,
      "Messages outside each chat's active window are stored in separate read-only history conversations, generated by this converter.",
    ],
    unconverted: [] as CloudConversionLoss["unconverted"],
    unconvertedTotal: 0,
    unconvertedByReason: {} as Record<string, number>,
    unconvertedByConversation: {} as Record<string, number>,
    translatedRefusals: [] as CloudConversionLoss["translatedRefusals"],
    translatedRefusalsTotal: 0,
    pictures: { policy: options.pictures ?? (options.fallbacks ? "placeholder" : "block"), parts: 0, inWindow: 0, chats: 0, windowChats: 0, captured: 0, omitted: 0, unknown: 0, placeholders: 0 },
    adjacentResults: [] as CloudConversionLoss["adjacentResults"],
    adjacentResultsTotal: 0,
    reorderedResults: [] as CloudConversionLoss["reorderedResults"],
    reorderedResultsTotal: 0,
    reorderedWindows: 0,
    unansweredCalls: [] as CloudConversionLoss["unansweredCalls"],
    unansweredCallsTotal: 0,
    unansweredCallsPolicy: options.unansweredCalls ?? (options.fallbacks ? "annotate" : "block"),
    closedWindowCalls: [] as CloudConversionLoss["closedWindowCalls"],
    closedWindowCallsTotal: 0,
    windowCallsPolicy: options.windowCalls ?? (options.fallbacks ? "close" : "block"),
    pendingWindowCalls: [] as CloudConversionLoss["pendingWindowCalls"],
    incompleteWindows: [] as CloudConversionLoss["incompleteWindows"],
    excludedChats: [] as CloudConversionLoss["excludedChats"],
    excludedChatsAuto: false,
    fallbacks: options.fallbacks === true,
    notes: [
      "No compiled system prompt is carried; the local runtime rebuilds it from the carried instructions and memory files, so it is not byte-identical to Cloud's.",
      "Compaction boundaries (firstKeptEntryId) are written as null: the Cloud projection carries none.",
      "Per-message token usage and the serving provider are not recorded by the Cloud projection.",
    ],
  };
  const blocked: string[] = [];
  const diagnostics: ConversionDiagnostic[] = [];
  // Set per conversation: the title, the window, and the last few messages seen.
  let diagnose: (reason: string, message: Record<string, unknown> | null, callId?: string | null) => void = () => undefined;
  const block = (reason: string, message: Record<string, unknown> | null = null, callId: string | null = null) => { if (!blocked.includes(reason)) blocked.push(reason); diagnose(reason, message, callId); };
  const volumes: ConvertedVolume[] = [];
  const counts = { conversations: 0, messages: 0, historyVolumes: 0, bytes: 0 };
  let complete = true;

  const serialize = (value: unknown) => Buffer.from(JSON.stringify(value));
  sink.file(`agents/${encode(options.localAgentId)}.json`, serialize({
    id: options.localAgentId, name: agentName, model, hidden: false, tags: [],
    system: typeof options.agent.system === "string" ? options.agent.system : "",
    model_settings: options.agent.model_settings && typeof options.agent.model_settings === "object" && !Array.isArray(options.agent.model_settings) ? options.agent.model_settings : {},
    ...(text(options.agent.description) ? { description: options.agent.description } : {}),
    ...(options.agent.compaction_settings && typeof options.agent.compaction_settings === "object" ? { compaction_settings: options.agent.compaction_settings } : {}),
  }));
  if (typeof options.agent.system !== "string") loss.notes.push("The captured agent record carries no system prompt; the local agent gets an empty one.");

  const ids = new Set<string>();

  let foldedApprovals = 0, systemPrompts = 0, repeatedResults = 0;
  const pictureChats = new Set<string>(), pictureWindowChats = new Set<string>();
  for (const conversation of options.conversations) {
    yield;

    const resolvedCalls = new Set<string>();

    const ambiguousCalls = new Set<string>();
    let firstPassCount = 0, secondPassCount = 0;
    for (const message of conversation.messages) {
      yield;
      firstPassCount++;
      const type = text(message.message_type);
      if (type === "tool_return_message") { const call = text(message.tool_call_id); if (call) (validReturn(message) ? resolvedCalls : ambiguousCalls).add(call); }
      else if (type === "approval_response_message" && Array.isArray(message.approvals)) for (const approval of message.approvals as Array<Record<string, unknown>>) { const call = text(approval?.tool_call_id); const kind = classifyApproval(approval); if (!call) continue; if (kind === "result" || kind === "refusal") resolvedCalls.add(call); else if (kind === "unsupported") ambiguousCalls.add(call); }
    }
    counts.conversations++;
    const messagesBefore = counts.messages;
    const liveId = conversation.main === true ? "default" : conversation.id;
    if (!text(liveId)) refuse("conversation has no ID");
    if (conversation.main !== true && liveId === "default") refuse("a named conversation may not claim the main conversation identity");
    if (ids.has(liveId)) refuse(`duplicate conversation identity ${liveId}`);
    ids.add(liveId);
    const title = conversation.main === true ? "Main chat" : text(conversation.title) ?? text(conversation.summary) ?? "Untitled chat";
    if (conversation.truncated === true) { complete = false; block(`${title}: the backup doesn't reach the start of this chat's history`); }

    // Rule 6, known before a single message is read.
    const sourceActive = conversation.context?.in_context_message_ids;
    const capturedWindow = Array.isArray(sourceActive) && sourceActive.every((id) => typeof id === "string") ? sourceActive as string[] : null;
    // An excluded chat (the person's choice) keeps no live conversation: everything it has
    // goes to read-only history marked incomplete, and its window is not claimed.
    let excluded = (options.excludeChats ?? []).includes(conversation.id);
    if (excluded && conversation.main === true) block(`${title}: the main chat can't be kept as history only`);
    const windowIds = excluded ? [] : capturedWindow;
    if (!capturedWindow && !excluded) block(`${title}: the backup recorded no active context for this chat`);
    const windowSet = new Set(windowIds ?? []);
    const windowDerived = new Map<string, string[]>();

    const derivedCount = new Map<string, number>();
    // A tool return carries only its call ID; the name comes from the call, read earlier.
    const toolNames = new Map<string, string>();

    const systemPromptIds = new Set<string>();
    const droppedIds = new Set<string>();
    // Approval answers waiting for their call's result: the tool return that normally
    // follows, else the answer itself (a refusal, or a result Cloud didn't repeat).
    type Answer = { sourceId: string; at: number; iso: string; kind: "result" | "refusal" | "granted"; content: string; isError: boolean; reason: string | null; message?: Record<string, unknown> };
    const answers = new Map<string, Answer>();
    // Each call's one result, and which source message carries it; and whether it was an error.
    const resultOf = new Map<string, string>();
    const resultIsError = new Map<string, boolean>();

    const DENIAL_RESULT = "Error: request to call tool denied";
    const resultIsDenial = new Map<string, boolean>();
    // What each placed result said, so a later row that repeats it exactly can be
    // recognised as the same event (Cloud lists an approval answer's result and the
    // tool_return_message for it as two rows, sometimes with a message between).
    const resultText = new Map<string, { content: string; isError: boolean }>();
    const noteRefusal = (sourceId: string, callId: string, reason: string | null, foldedInto?: string) => {
      loss.translatedRefusalsTotal++;
      if (loss.translatedRefusals.length < UNCONVERTED_DETAIL) loss.translatedRefusals.push({ conversationId: conversation.id, sourceMessageId: sourceId, toolCallId: callId, reason, ...(foldedInto ? { foldedInto } : {}) });
    };

    type EarlyReturn = { message: Record<string, unknown>; sourceId: string; at: number; iso: string; isError: boolean; content: string; age: number };

    const reorderedInWindow = new Map<string, string[]>();
    const earlyReturns = new Map<string, EarlyReturn>();
    const EARLY_RETURN_PATIENCE = 12;
    const expireEarlyReturns = (all = false) => {
      for (const [callId, early] of earlyReturns) {
        if (!all && ++early.age <= EARLY_RETURN_PATIENCE) continue;
        earlyReturns.delete(callId);
        drop(early.message, "tool return has no matching tool call in this chat");
      }
    };
    // An approval answer's calls' results, by source ID: in the active window it stands
    // for those results, so they must be there too.
    const aliases = new Map<string, Set<string>>();
    const alias = (approvalId: string, resultId: string) => { if (approvalId !== resultId) aliases.set(approvalId, (aliases.get(approvalId) ?? new Set()).add(resultId)); };
    const claim = (sourceId: string, suffix: string) => {
      const n = derivedCount.get(sourceId) ?? 0;
      derivedCount.set(sourceId, n + 1);
      const archiveId = n ? `${sourceId}--${suffix}${n}` : sourceId;
      if (windowSet.has(sourceId)) windowDerived.set(sourceId, [...(windowDerived.get(sourceId) ?? []), archiveId]);
      return archiveId;
    };
    const recent: ConversionDiagnostic["before"] = [];
    diagnose = (reason, message, callId) => {
      const sourceId = text(message?.id);

      const blocking = (!!sourceId && windowSet.has(sourceId)) || !reason.startsWith("user content") && !reason.startsWith("tool return has no matching") ? true : false;
      const used = diagnostics.length;
      if (used >= DIAGNOSTIC_DETAIL) return;
      if (!blocking && used >= DIAGNOSTIC_DETAIL / 2) return;
      // The reason without the chat's title (titles are private text); IDs only.
      const code = reason.startsWith(`${title}: `) ? reason.slice(title.length + 2) : reason;
      diagnostics.push({ chatId: conversation.id, reason: code, messageType: text(message?.message_type), sourceId, callId: callId ?? callOf(message), inWindow: !!sourceId && windowSet.has(sourceId), before: recent.slice(0, -1) });
    };
    const drop = (message: Record<string, unknown>, reason: string) => {
      const sourceId = text(message.id);
      diagnose(reason, message);

      if (sourceId && windowSet.has(sourceId)) block(`${title}: part of message ${sourceId} in the active context couldn't be converted`);
      complete = false;
      loss.unconvertedTotal++;
      loss.unconvertedByReason[reason] = (loss.unconvertedByReason[reason] ?? 0) + 1;
      loss.unconvertedByConversation[conversation.id] = (loss.unconvertedByConversation[conversation.id] ?? 0) + 1;
      if (loss.unconverted.length < UNCONVERTED_DETAIL) loss.unconverted.push({ conversationId: conversation.id, sourceMessageId: sourceId, messageType: text(message.message_type) ?? "(absent)", reason });
      if (sourceId) droppedIds.add(sourceId);
    };

    // Where each volume's files and message placements go.
    const liveIndex = volumes.length;
    const writeVolume = (archiveId: string, role: VolumeRole, part: number, entries: Entry[], active: string[], incomplete = false) => {
      const prefix = `conversations/${encode(archiveId === "default" ? `default:${options.localAgentId}` : `conversation:${archiveId}`)}`;
      const firstAt = entries[0]?.iso ?? null, lastAt = entries.at(-1)?.iso ?? null;
      const header = { type: "session", version: 3, id: archiveId, timestamp: firstAt ?? text(conversation.createdAt) ?? new Date(0).toISOString(), cwd: options.sessionCwd };
      const rows: string[] = [JSON.stringify(header)];
      entries.forEach((entry, index) => rows.push(JSON.stringify(nativeRow(entry, model, `entry-${index + 1}`, index === 0 ? null : `entry-${index}`))));
      const body = Buffer.from(`${rows.join("\n")}\n`);
      const label = role === "live" ? title : `History${incomplete ? " (incomplete)" : ""} · ${title} · ${day(firstAt)} to ${day(lastAt)}`;
      sink.file(`${prefix}/conversation.json`, serialize({
        id: archiveId, agent_id: options.localAgentId, in_context_message_ids: active, hidden: false,
        ...(role === "history"
          ? { archived: true, summary: label, tags: historyTags({ sourceConversationId: conversation.id, main: conversation.main === true, part, firstAt, lastAt, incomplete }) }
          : {
            ...(typeof conversation.archived === "boolean" ? { archived: conversation.archived } : {}),
            // A real captured fact, and the only thing local conversation search reads.
            ...(text(conversation.summary) ? { summary: conversation.summary } : text(conversation.title) ? { summary: conversation.title } : {}),
          }),
        ...(text(conversation.createdAt) ? { created_at: conversation.createdAt } : {}),
        ...(text(conversation.updatedAt) ? { updated_at: conversation.updatedAt } : {}),
      }));
      sink.file(`${prefix}/manifest.json`, serialize({ schema_version: 2, message_format: "pi-session-entry-jsonl", provider_stack: "pi-ai" }));
      sink.file(`${prefix}/messages.jsonl`, body);
      const volume: ConvertedVolume = { sourceConversationId: conversation.id, sourceTitle: title, archiveConversationId: archiveId, role, part, messages: entries.length, bytes: body.length, firstAt, lastAt, label };
      // The live volume is listed first for its conversation, though written last.
      if (role === "live") volumes.splice(liveIndex, 0, volume); else volumes.push(volume);
      counts.bytes += body.length; counts.messages += entries.length;
      if (role === "history") counts.historyVolumes++;
      for (const entry of entries) sink.message({ sourceConversationId: conversation.id, sourceMessageId: entry.sourceId, archiveMessageId: entry.archiveId, archiveConversationId: archiveId, role: entry.kind === "compaction" ? "summary" : entry.role });
    };

    // --- History packing: whole call/result groups under hard caps -------------------
    const header = Buffer.byteLength(JSON.stringify({ type: "session", version: 3, id: "history-000000000000000000000000", timestamp: new Date(0).toISOString(), cwd: options.sessionCwd })) + 1;
    const caps = { bytes: limits.bytes - header, messages: limits.messages };
    const size = (entry: Entry) => Buffer.byteLength(JSON.stringify(nativeRow(entry, model, "entry-0000000", "entry-0000000"))) + 1;
    const live: Entry[] = [];
    const callSide = new Map<string, "live" | "history">();
    let group: Entry[] = [], groupCalls = new Set<string>();

    let awaiting = new Set<string>();
    let absorbedInGroup = 0;
    const GROUP_PATIENCE = 12;

    const lateCalls = new Map<string, number>();
    const pendingLate = new Set<string>();
    let volume: Entry[] = [], volumeBytes = 0, volumeCount = 0, part = 0;
    const flushVolume = () => {
      if (!volume.length) return;
      part++;
      const archiveId = `history-${createHash("sha256").update(`${conversation.id}\u0000${part - 1}`).digest("hex").slice(0, 24)}`;
      if (ids.has(archiveId)) refuse("history volume identity collision");
      ids.add(archiveId);
      writeVolume(archiveId, "history", part, volume, [], excluded);
      volume = []; volumeBytes = 0; volumeCount = 0;
    };
    const closeGroup = () => {
      if (!group.length) return;
      if (awaiting.size) settleAwaiting("when its group closed");
      const groupBytes = group.reduce((sum, entry) => sum + size(entry), 0);
      const groupCount = group.reduce((sum, entry) => sum + components(entry), 0);
      if (groupBytes > caps.bytes || groupCount > caps.messages) block(`${title}: message ${group[0]!.sourceId} (with its tool results) is too big for one history part`);
      else {
        if (volume.length && (volumeBytes + groupBytes > caps.bytes || volumeCount + groupCount > caps.messages)) flushVolume();
        volume.push(...group); volumeBytes += groupBytes; volumeCount += groupCount;
        // The calls settled from this group now live in this part (its serial = parts written so far).
        for (const entry of group) for (const callId of callsOf(entry)) if (pendingLate.has(callId)) { pendingLate.delete(callId); lateCalls.set(callId, part); }
      }
      // A settled call whose group was refused has no part to join.
      pendingLate.clear();
      group = []; groupCalls = new Set();
    };

    const insertAfterCall = (list: Entry[], callId: string, entry: Entry): "placed" | "moved" | "no-call" => {
      const at = list.findIndex((item) => callsOf(item).includes(callId));
      if (at < 0) return "no-call";
      let end = at + 1;
      for (;;) { const next = list[end]; if (!next || next.kind !== "message" || next.role !== "toolResult") break; end++; }
      const moved = end < list.length;
      list.splice(end, 0, entry);
      return moved ? "moved" : "placed";
    };
    // Results moved ahead of messages that came between them and their call (disclosed).
    const noteMoved = (entry: Entry, callId: string, outcome: "placed" | "moved" | "no-call") => {
      if (outcome !== "moved") return;
      loss.adjacentResultsTotal++;
      if (loss.adjacentResults.length < UNCONVERTED_DETAIL) loss.adjacentResults.push({ conversationId: conversation.id, resultId: entry.sourceId, callId, inWindow: windowSet.has(entry.sourceId) });
    };
    const settleAwaiting = (when: string) => {
      for (const callId of awaiting) {
        if (resolvedCalls.has(callId)) { pendingLate.add(callId); continue; }
        if (ambiguousCalls.has(callId)) { block(`${title}: a tool call has a result this converter can't read (${callId})`, current, callId); continue; }
        const call = group.find((entry) => callsOf(entry).includes(callId));
        if (!call) continue;
        loss.unansweredCallsTotal++;
        if (loss.unansweredCalls.length < UNCONVERTED_DETAIL) loss.unansweredCalls.push({ conversationId: conversation.id, sourceMessageId: call.sourceId, toolCallId: callId });
        if (loss.unansweredCallsPolicy !== "annotate") { block(`${title}: a tool call in older messages has no result anywhere in the chat (${callId})`, current, callId); continue; }
        insertAfterCall(group, callId, { kind: "message", sourceId: call.sourceId, archiveId: claim(call.sourceId, "annotation"), at: call.at, iso: call.iso, role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "tool", isError: false, content: "Recovery annotation: no result was found for this call in the captured conversation. Execution outcome is unknown. This is a synthetic recovery record, not a tool response." });
      }
      awaiting.clear(); absorbedInGroup = 0;
    };
    // Calls inside the active window waiting for a result in the window: always block.
    const liveAwaiting = new Set<string>();
    const placedSourceIds = new Set<string>();
    const place = (entry: Entry) => {
      placedSourceIds.add(entry.sourceId);
      if (windowSet.has(entry.sourceId)) {
        for (const call of callsOf(entry)) { callSide.set(call, "live"); liveAwaiting.add(call); }
        if (entry.kind === "message" && entry.role === "toolResult") {
          liveAwaiting.delete(entry.toolCallId);
          if (callSide.get(entry.toolCallId) !== "live") block(`${title}: the active context starts partway through a tool call (${entry.toolCallId})`, current, entry.toolCallId);
          const outcome = insertAfterCall(live, entry.toolCallId, entry);
          if (outcome === "no-call") live.push(entry);
          else if (outcome === "moved") {
            noteMoved(entry, entry.toolCallId, outcome);
            const at = live.findIndex((item) => callsOf(item).includes(entry.toolCallId));
            const block: string[] = [];
            for (let i = at + 1; i < live.length; i++) { const next = live[i]!; if (next.kind !== "message" || next.role !== "toolResult") break; block.push(next.sourceId); }
            reorderedInWindow.set(live[at]!.sourceId, block);
          }
          return;
        }
        live.push(entry);
        return;
      }
      if (entry.kind === "message" && entry.role === "toolResult") {
        if (groupCalls.has(entry.toolCallId)) { noteMoved(entry, entry.toolCallId, insertAfterCall(group, entry.toolCallId, entry)); awaiting.delete(entry.toolCallId); return; }
        const latePart = lateCalls.get(entry.toolCallId);
        if (latePart !== undefined) {
          lateCalls.delete(entry.toolCallId);
          // Preceding work closes first (it may write the part); then the result joins only
          // if its call's part is still open and it fits without writing that part.
          closeGroup();
          const fitsPart = volumeBytes + size(entry) <= caps.bytes && volumeCount + components(entry) <= caps.messages;
          const outcome = latePart === part && fitsPart ? insertAfterCall(volume, entry.toolCallId, entry) : "no-call";
          if (outcome !== "no-call") { noteMoved(entry, entry.toolCallId, outcome); volumeBytes += size(entry); volumeCount += components(entry); return; }
          block(`${title}: a tool result came too late to share a history part with its call (${entry.toolCallId})`, current, entry.toolCallId);
          return;
        }
        block(callSide.get(entry.toolCallId) === "live"
          ? `${title}: a tool result outside the active context belongs to a call inside it (${entry.toolCallId})`
          : `${title}: a tool result in its history has no call before it (${entry.toolCallId})`, current, entry.toolCallId);
        return;
      }
      const calls = callsOf(entry);

      const fits = () => group.reduce((sum, item) => sum + size(item), 0) + size(entry) <= caps.bytes && group.reduce((sum, item) => sum + components(item), 0) + components(entry) <= caps.messages;
      if (!calls.length && awaiting.size) {
        if (absorbedInGroup < GROUP_PATIENCE && fits()) { group.push(entry); absorbedInGroup++; return; }
        if (absorbedInGroup < GROUP_PATIENCE) block(`${title}: message ${group[0]!.sourceId} (with its tool calls and results) is too big for one history part`, current);
        // Past the bound nothing more is retained for the group; it is settled and closed.
        settleAwaiting(absorbedInGroup < GROUP_PATIENCE ? "when its group grew too big" : `after ${GROUP_PATIENCE} further messages`);
      }

      if (calls.length && awaiting.size && absorbedInGroup < GROUP_PATIENCE) {

        if (!fits()) { block(`${title}: message ${group[0]!.sourceId} (with its tool calls and results) is too big for one history part`, current); settleAwaiting("when its group grew too big"); closeGroup(); }
        else {
          group.push(entry); absorbedInGroup++;
          for (const call of calls) { callSide.set(call, "history"); groupCalls.add(call); awaiting.add(call); }
          return;
        }
      }
      closeGroup();
      awaiting = new Set(calls); absorbedInGroup = 0;
      group = [entry];
      for (const call of calls) callSide.set(call, "history");
      if (calls.length) groupCalls = new Set(calls); else closeGroup();
    };

    // --- Reading messages, one at a time -----------------------------------------------
    let pending: Extract<Entry, { role: "assistant" }> | null = null;
    const placeResult = (sourceId: string, callId: string, at: number, iso: string, isError: boolean, content: string) => {
      place({ kind: "message", sourceId, archiveId: claim(sourceId, "toolresult"), at, iso, role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId)!, isError, content });
      resultOf.set(callId, sourceId); resultIsError.set(callId, isError); resultIsDenial.set(callId, isError && content.startsWith(DENIAL_RESULT)); resultText.set(callId, { content, isError });
      const answered = answers.get(callId);
      if (!answered) return;
      // A pending refusal is kept as provenance (its reason too) when the recorded result
      // is Letta's denial; a refusal followed by any other result is a contradiction.
      if (answered.kind === "refusal" && !resultIsDenial.get(callId)) { drop(answered.message ?? { id: answered.sourceId, message_type: "approval_response_message" }, "approval answer refuses a tool call that already has a result"); answers.delete(callId); return; }
      if (answered.kind === "refusal") noteRefusal(answered.sourceId, callId, answered.reason, sourceId);
      alias(answered.sourceId, sourceId); answers.delete(callId);
    };
    const finishPending = () => {
      if (!pending) return;
      const placed = pending; pending = null;
      place(placed);
      // A result that arrived before this call goes straight after it.
      for (const callId of callsOf(placed)) {
        const early = earlyReturns.get(callId);
        if (!early) continue;
        earlyReturns.delete(callId);
        // Only the established inversion is repaired: the same timestamp as its call.
        if (early.at !== placed.at) { drop(early.message, "tool return listed before its call, at a different time"); continue; }
        placeResult(early.sourceId, callId, early.at, early.iso, early.isError, early.content);
        const inWindow = windowSet.has(early.sourceId) && windowSet.has(placed.sourceId);
        loss.reorderedResultsTotal++;
        if (loss.reorderedResults.length < UNCONVERTED_DETAIL) loss.reorderedResults.push({ conversationId: conversation.id, resultId: early.sourceId, callId, inWindow });
        if (inWindow) reorderedInWindow.set(placed.sourceId, [...(reorderedInWindow.get(placed.sourceId) ?? []), early.sourceId]);
      }
    };
    // An approval answer with no tool result after it is the result: a refusal (the tool
    // never ran) or Cloud not repeating it. Placed before the next turn, inside its group.
    const flushAnswers = () => {
      for (const [callId, answer] of answers) {

        if (answer.kind === "granted") { drop({ id: answer.sourceId, message_type: "approval_response_message" }, "approved tool call has no recorded result"); continue; }
        place({ kind: "message", sourceId: answer.sourceId, archiveId: claim(answer.sourceId, "toolresult"), at: answer.at, iso: answer.iso, role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId)!, isError: answer.isError, content: answer.content });
        resultOf.set(callId, answer.sourceId); resultIsError.set(callId, answer.isError); resultText.set(callId, { content: answer.content, isError: answer.isError });
        if (answer.kind === "refusal") noteRefusal(answer.sourceId, callId, answer.reason);
      }
      answers.clear();
    };
    let current: Record<string, unknown> | null = null;
    for (const message of conversation.messages) {
      yield;
      secondPassCount++;
      current = message;
      expireEarlyReturns();
      const type = text(message.message_type), sourceId = text(message.id);
      recent.push({ type, id: sourceId, call: callOf(message) });
      if (recent.length > 8) recent.shift();
      if (!type || !sourceId) { drop(message, "projected message has no ID or type"); continue; }
      const stamp = when(message);
      if (!stamp) { drop(message, "projected message carries no parseable timestamp"); continue; }
      if (type === "system_message") {
        // A saved copy of the compiled system prompt. The local runtime builds its own.
        if (!text(typeof message.content === "string" ? message.content : null)) { drop(message, "system message carries no prompt text"); continue; }
        systemPromptIds.add(sourceId); systemPrompts++;
        continue;
      }
      if (type === "approval_response_message") {
        // The decision on a tool call. Its result is the tool result that follows; a
        // refusal (no tool ran) or an unrepeated result becomes that result itself.
        finishPending();
        const approvals = Array.isArray(message.approvals) ? message.approvals as Array<Record<string, unknown>> : [];
        if (!approvals.length) { drop(message, "approval answer names no tool call"); continue; }
        foldedApprovals++;
        for (const approval of approvals) {
          const callId = text(approval.tool_call_id);
          if (!callId) { drop(message, "approval answer names no tool call"); continue; }
          if (!toolNames.has(callId)) { drop(message, "approval answer for a tool call this chat doesn't contain"); continue; }
          // Classified first, so nothing unrecognised or contradictory hides behind a result.
          const reason = text(approval.reason);
          const kind = classifyApproval(approval);
          const answer: Answer | null =
            kind === "refusal" ? { sourceId, at: stamp.at, iso: stamp.iso, kind: "refusal", content: `Not approved${reason ? `: ${reason}` : "."}`, isError: true, reason, message }
            : kind === "granted" ? { sourceId, at: stamp.at, iso: stamp.iso, kind: "granted", content: "", isError: false, reason: null }
            : kind === "result" ? { sourceId, at: stamp.at, iso: stamp.iso, kind: "result", content: approval.tool_return as string, isError: approval.status === "error", reason: null }
            : null;
          if (!answer) { drop(message, "approval answer entry isn't one this converter recognises"); continue; }
          // Answered after its result: an approval or a matching result stands for it; a
          // refusal of a call that has a result contradicts it and is reported, not reconciled.
          const existing = resultOf.get(callId);
          if (existing) {
            // A refusal after Letta's denial result is the same event, kept as provenance
            // with its reason; after any other result it contradicts it and is reported.
            if (answer.kind === "refusal" && !resultIsDenial.get(callId)) { drop(message, "approval answer refuses a tool call that already has a result"); continue; }
            if (answer.kind === "refusal") noteRefusal(sourceId, callId, reason, existing);
            alias(sourceId, existing);
            continue;
          }
          if (answers.has(callId)) { drop(message, "a second approval answer for the same tool call"); continue; }
          answers.set(callId, answer);
        }
        continue;
      }
      if (type !== "tool_return_message") flushAnswers();
      if (type === "user_message") {
        let content: string | null = null;
        if (typeof message.content === "string") content = message.content;
        else if (Array.isArray(message.content)) {
          // Text parts, and positively identified picture parts; anything else is a loss.
          const pieces: string[] = [];
          let pictures = 0, captured = 0, omitted = 0, unknown = 0, supported = true;
          for (const value of message.content) {
            const item = value as Record<string, unknown> | null;
            if (item && item.type === "text" && typeof item.text === "string") pieces.push(item.text);
            else if (item && item.type === "image") { pictures++; const status = pictureStatus(item); if (status === "captured") captured++; else if (status === "omitted") omitted++; else unknown++; pieces.push(PICTURE_PLACEHOLDER); }
            else supported = false;
          }
          if (pictures) {
            loss.pictures.parts += pictures; loss.pictures.captured += captured; loss.pictures.omitted += omitted; loss.pictures.unknown += unknown;
            pictureChats.add(conversation.id);
            if (windowSet.has(sourceId)) { loss.pictures.inWindow += pictures; pictureWindowChats.add(conversation.id); }
          }
          if (supported && (!pictures || loss.pictures.policy === "placeholder")) { content = pieces.join("\n"); if (pictures) loss.pictures.placeholders += pictures; }
        }
        if (content === null) { drop(message, "user content is not plain text (pictures and files are not carried into native chats)"); continue; }
        finishPending();
        place({ kind: "message", sourceId, archiveId: claim(sourceId, "user"), at: stamp.at, iso: stamp.iso, role: "user", content });
        continue;
      }
      if (type === "reasoning_message" || type === "assistant_message" || type === "tool_call_message" || type === "approval_request_message") {
        const parts: Array<Record<string, unknown>> = [];
        if (type === "reasoning_message") {
          const reasoning = text(message.reasoning);
          if (!reasoning) { drop(message, "reasoning carries no visible text"); continue; }
          parts.push({ type: "thinking", thinking: reasoning });
        } else if (type === "assistant_message") {
          if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
          else if (Array.isArray(message.content)) {
            for (const value of message.content) {
              const item = value as Record<string, unknown> | null;
              if (item && item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
              else drop(message, `assistant content part ${String(item?.type)} has no native representation`);
            }
          } else drop(message, "assistant content is neither text nor a part list");
          if (!parts.length) continue;
        } else {
          // A tool call; one that needed approval is recorded as an approval request.
          const calls = Array.isArray(message.tool_calls) && message.tool_calls.length ? message.tool_calls as Array<Record<string, unknown>> : [message.tool_call as Record<string, unknown> | undefined];
          for (const call of calls) {
            const name = text(call?.name), callId = text(call?.tool_call_id);
            if (!name || !callId) { drop(message, "tool call has no name or call ID"); continue; }
            let args: unknown;
            try { args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : call?.arguments; } catch { args = undefined; }
            if (!args || typeof args !== "object" || Array.isArray(args)) { drop(message, "tool call arguments are not a JSON object"); continue; }
            parts.push({ type: "toolCall", id: callId, name, arguments: args });
            toolNames.set(callId, name);
          }
          if (!parts.length) continue;
        }
        // Rule 3: components sharing one source ID become one assistant message.
        if (pending && pending.sourceId === sourceId) { pending.parts.push(...parts); continue; }
        finishPending();
        pending = { kind: "message", sourceId, archiveId: claim(sourceId, "assistant"), at: stamp.at, iso: stamp.iso, role: "assistant", parts };
        continue;
      }
      if (type === "tool_return_message") {
        finishPending();
        const callId = text(message.tool_call_id);
        if (!callId) { drop(message, "tool return has no matching tool call in this chat"); continue; }
        const status = text(message.status);
        if (status !== "success" && status !== "error") { drop(message, "tool return has no recorded success/error status"); continue; }
        const content = typeof message.tool_return === "string" ? message.tool_return : null;
        if (content === null) { drop(message, "tool return payload is not plain text"); continue; }
        if (!toolNames.has(callId)) {
          // Its call hasn't been seen yet: wait for it (Cloud's ordering), else it's a loss.
          if (earlyReturns.has(callId) || earlyReturns.size >= 64) { drop(message, "tool return has no matching tool call in this chat"); continue; }
          earlyReturns.set(callId, { message, sourceId, at: stamp.at, iso: stamp.iso, isError: status === "error", content, age: 0 });
          continue;
        }
        // One outcome per call. A later row that repeats the placed result exactly (same
        // text, same status) is the same event and stands for it; anything else after the
        // approval answer already stood in is an ordering this converter refuses.
        if (resultOf.has(callId)) {
          const placed = resultText.get(callId);
          if (placed && placed.content === content && placed.isError === (status === "error")) { alias(sourceId, resultOf.get(callId)!); repeatedResults++; continue; }
          block(`${title}: a tool result came after its approval answer had already been used as the result (${callId})`, current, callId); drop(message, "tool result after its approval answer stood in for it"); continue;
        }
        placeResult(sourceId, callId, stamp.at, stamp.iso, status === "error", content);
        continue;
      }
      if (type === "summary_message") {
        const summary = text(message.summary) ?? (typeof message.content === "string" ? text(message.content) : null);
        if (!summary) { drop(message, "summary carries no text"); continue; }
        finishPending();
        const stats = message.compaction_stats && typeof message.compaction_stats === "object" && !Array.isArray(message.compaction_stats) ? message.compaction_stats as Record<string, unknown> : null;
        const counted = stats && typeof stats.context_tokens_before === "number" && Number.isFinite(stats.context_tokens_before) && stats.context_tokens_before >= 0 ? stats.context_tokens_before : null;
        place({ kind: "compaction", sourceId, archiveId: claim(sourceId, "summary"), at: stamp.at, iso: stamp.iso, summary, tokensBefore: counted ?? 0, stats });
        continue;
      }
      drop(message, `projected message type ${type} has no native representation`);
    }
    // A one-shot stream would have been emptied by the first pass: refuse, never convert nothing.
    if (secondPassCount !== firstPassCount) refuse(`conversation ${conversation.id} could not be read twice (${firstPassCount} then ${secondPassCount} messages)`);
    finishPending();
    expireEarlyReturns(true);
    flushAnswers();
    if (awaiting.size) settleAwaiting("at the end of the chat");
    closeGroup();
    // A call whose result was recorded but never joined is an ordering this converter refuses.
    for (const callId of [...lateCalls.keys(), ...pendingLate]) block(`${title}: a tool call is still waiting for its result at the end of the chat (${callId})`, null, callId);
    flushVolume();

    const active: string[] = [];
    // The captured order, except a result the window lists before its call: it moves to
    // just after the call (both are in the window), and the chat is counted as normalized.
    let orderedWindow = windowIds ?? [];
    if (reorderedInWindow.size) {
      let ids = [...orderedWindow];
      let moved = false;
      for (const [callMessageId, resultIds] of reorderedInWindow) {
        const c = ids.indexOf(callMessageId);
        if (c < 0) continue;

        const present = [...new Set(resultIds)].filter((id) => ids.includes(id));
        if (present.every((id, i) => ids[c + 1 + i] === id)) continue;
        ids = ids.filter((id) => !present.includes(id));
        ids.splice(ids.indexOf(callMessageId) + 1, 0, ...present);
        moved = true;
      }
      if (moved) { loss.reorderedWindows++; orderedWindow = ids; }
    }

    const closures = new Map<number, string[]>();
    for (const callId of liveAwaiting) {
      if (ambiguousCalls.has(callId)) { block(`${title}: a tool call in the active context has a result this converter can't read (${callId})`, null, callId); continue; }
      if (!resolvedCalls.has(callId)) { const entry = loss.pendingWindowCalls.find((item) => item.conversationId === conversation.id) ?? loss.pendingWindowCalls[loss.pendingWindowCalls.push({ conversationId: conversation.id, title, toolCallIds: [] }) - 1]!; entry.toolCallIds.push(callId); }
      if (resolvedCalls.has(callId) || loss.windowCallsPolicy !== "close") { block(`${title}: a tool call in the active context has no result (${callId})`, null, callId); continue; }
      const at = live.findIndex((entry) => callsOf(entry).includes(callId));
      if (at < 0) { block(`${title}: a tool call in the active context has no result (${callId})`, null, callId); continue; }
      closures.set(at, [...(closures.get(at) ?? []), callId]);
    }
    for (const [at, callIds] of [...closures.entries()].sort((a, b) => b[0] - a[0])) {
      const call = live[at]!;
      const ordered = callsOf(call).filter((callId) => callIds.includes(callId));
      const entries: Entry[] = ordered.map((callId) => ({ kind: "message", sourceId: call.sourceId, archiveId: claim(call.sourceId, "closure"), at: call.at, iso: call.iso, role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "tool", isError: false, content: WINDOW_CALL_CLOSURE }));
      live.splice(at + 1, 0, ...entries);
      for (const callId of ordered) {
        loss.closedWindowCallsTotal++;
        if (loss.closedWindowCalls.length < UNCONVERTED_DETAIL) loss.closedWindowCalls.push({ conversationId: conversation.id, sourceMessageId: call.sourceId, toolCallId: callId });
      }
    }
    const missing: string[] = [];
    // With fallbacks on, a named chat whose window names messages the backup doesn't have
    // is kept as read-only history instead of blocking: its live entries go to history
    // in order, through the same grouping, and its window is not claimed.
    if (options.fallbacks && !excluded && conversation.main !== true && orderedWindow.some((id) => !windowDerived.has(id) && !systemPromptIds.has(id) && !aliases.has(id) && !droppedIds.has(id))) {
      excluded = true;
      const wanted = orderedWindow;
      windowSet.clear();
      const carried = live.splice(0, live.length).filter((entry) => !(entry.kind === "message" && entry.role === "toolResult" && entry.content === WINDOW_CALL_CLOSURE));
      for (const entry of carried) place(entry);
      finishPending(); closeGroup(); flushVolume();
      loss.incompleteWindows.push({ conversationId: conversation.id, title, missing: wanted.filter((id) => !placedSourceIds.has(id) && !systemPromptIds.has(id) && !aliases.has(id) && !droppedIds.has(id)) });
      orderedWindow = [];
    }
    for (const id of orderedWindow) {
      const derived = windowDerived.get(id);
      // An approval answer in the window stands for its calls' results: they must be there.
      const results = aliases.get(id);
      if (results && [...results].some((result) => !windowSet.has(result))) block(`${title}: an approval answer in the active context belongs to a tool result outside it (${id})`);
      if (derived) active.push(...derived);
      else if (systemPromptIds.has(id) || results || droppedIds.has(id)) continue; // carried elsewhere, disclosed, or already reported
      else { missing.push(id); block(`${title}: its active context names message ${id}, which the backup doesn't contain`); }
    }
    if (missing.length) loss.incompleteWindows.push({ conversationId: conversation.id, title, missing });
    if (excluded) {
      // Kept as read-only incomplete history only: what the window would have needed is recorded.
      const wanted = capturedWindow ?? [];
      loss.excludedChatsAuto = loss.excludedChatsAuto || !(options.excludeChats ?? []).includes(conversation.id);
      const absent = wanted.filter((id) => !placedSourceIds.has(id) && !systemPromptIds.has(id) && !aliases.has(id) && !droppedIds.has(id));
      loss.excludedChats.push({ conversationId: conversation.id, title, missing: absent, messages: counts.messages - messagesBefore });
      if (live.length) refuse("an excluded chat produced live entries");
    } else {

      const rowIds = new Set(live.map((entry) => entry.archiveId)), activeIds = new Set(active);
      const rowsNotActive = [...rowIds].filter((id) => !activeIds.has(id)), activeWithoutRow = [...activeIds].filter((id) => !rowIds.has(id));
      if (rowsNotActive.length || activeWithoutRow.length) refuse(`${title}: its active window and its rows disagree (${rowsNotActive.length} row(s) outside the active list: ${rowsNotActive.slice(0, 5).join(", ")}; ${activeWithoutRow.length} active ID(s) without a row: ${activeWithoutRow.slice(0, 5).join(", ")})`);
      writeVolume(liveId, "live", 0, live, active);
    }
    const liveComponents = live.reduce((sum, entry) => sum + components(entry), 0);
    if (liveComponents > limits.messages) loss.notes.push(`${title}: its active context has ${liveComponents} parts, more than one page of the chat view; it is carried whole, not trimmed.`);
  }

  loss.pictures.chats = pictureChats.size; loss.pictures.windowChats = pictureWindowChats.size;
  if (loss.pictures.placeholders) {
    const why = [loss.pictures.omitted ? `${loss.pictures.omitted} weren't in this backup (pictures were switched off)` : "", loss.pictures.captured ? `${loss.pictures.captured} are in the backup but can't go into a local chat` : "", loss.pictures.unknown ? `${loss.pictures.unknown} have no record of whether they were kept` : ""].filter(Boolean).join("; ");
    loss.synthesized.push(`Restored without pictures: ${loss.pictures.placeholders} picture(s) in ${loss.pictures.chats} chat(s) are shown as "${PICTURE_PLACEHOLDER}" (${loss.pictures.inWindow} in the active windows of ${loss.pictures.windowChats} chat(s)). ${why}.`);
  }
  if (repeatedResults) loss.notes.push(`${repeatedResults} tool result(s) were recorded twice by Cloud (in the approval answer and again as a result row, identical); each is carried once.`);
  if (loss.adjacentResultsTotal) loss.synthesized.push(`Tool results are placed beside their calls so local chats can read them; this changes the position of ${loss.adjacentResultsTotal} result(s) relative to messages that came between.`);
  if (loss.reorderedResultsTotal) loss.synthesized.push(`${loss.reorderedResultsTotal} tool result(s) that Cloud listed before their call (same timestamp) are placed after it; ${loss.reorderedWindows} active window(s) had their order normalized for this.`);
  if (loss.unansweredCallsTotal && loss.unansweredCallsPolicy === "annotate") loss.synthesized.push(`${loss.unansweredCallsTotal} tool call(s) in older messages had no result anywhere in their chat; each carries a synthetic recovery annotation saying so. The outcome is unknown, not failed.`);
  if (foldedApprovals) loss.notes.push(`${foldedApprovals} approval answers were folded into the tool results they answered.`);
  if (loss.translatedRefusalsTotal) loss.synthesized.push(`${loss.translatedRefusalsTotal} refused tool calls are carried as error results reading "Not approved" and the recorded reason: the call was denied and never ran; it didn't fail.`);
  if (systemPrompts) loss.notes.push(`${systemPrompts} saved copies of the system prompt aren't carried; the local runtime builds its own from the instructions and memory.`);
  if (loss.unconvertedTotal) loss.notes.push(`${loss.unconvertedTotal} message(s) couldn't be turned into chat messages; their original form stays in the backup.`);
  const qualifications = [...(loss.pictures.placeholders && loss.pictures.inWindow ? ["without-pictures"] : []), ...(loss.reorderedWindows ? ["results-reordered"] : []), ...(loss.closedWindowCallsTotal ? ["window-calls-closed"] : []), ...(loss.excludedChats.length ? ["chats-excluded"] : [])];
  if (loss.closedWindowCallsTotal) loss.synthesized.push(`${loss.closedWindowCallsTotal} tool call(s) still waiting for a result in a chat's active window were abandoned by choice: each keeps its call and gets a synthetic closure saying the outcome is unknown and the call must not be run again.`);
  if (loss.excludedChats.length) loss.synthesized.push(`${loss.excludedChats.length} chat(s) are kept as read-only incomplete history only, by choice: their active window named messages the backup doesn't contain, so they have no live conversation.`);
  const report: CloudConversionReport = {
    volumes, loss, counts, diagnostics,
    claims: { activeContext: qualifications.length ? "source-window-carried-qualified" : "source-window-carried", qualifications, transcript: complete ? "complete" : "partial", systemPrompt: "recompiled-locally", perMessageProvider: "unrecorded", exactContinuity: false },
  };
  if (blocked.length) throw new CloudConversionBlocked(blocked, report);
  return report;
}

/** A tool return the converter would carry: a known status and plain-text payload. */
function validReturn(message: Record<string, unknown>): boolean {
  const status = text(message.status);
  return (status === "success" || status === "error") && typeof message.tool_return === "string";
}
/** What one approvals[] entry is evidence of, by the same rules in both passes. */
function classifyApproval(approval: Record<string, unknown> | null | undefined): "refusal" | "granted" | "result" | "unsupported" {
  if (!approval || !text(approval.tool_call_id)) return "unsupported";
  if (approval.type === "approval" && approval.approve === false) return "refusal";
  if (approval.type === "approval" && approval.approve === true) return "granted";
  if (approval.type === "tool" && typeof approval.tool_return === "string" && (approval.status === "success" || approval.status === "error")) return "result";
  return "unsupported";
}
/** Whether the backup holds a picture part: the collector's object reference, its explicit omission flag, or neither. */
function pictureStatus(item: Record<string, unknown>): "captured" | "omitted" | "unknown" {
  const source = item.source && typeof item.source === "object" && !Array.isArray(item.source) ? item.source as Record<string, unknown> : item;
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith("_hearthside_object") && typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return "captured";
  }
  for (const [key, value] of Object.entries(source)) if (key.endsWith("_hearthside_omitted") && value === true) return "omitted";
  return "unknown";
}

/** A message's tool call ID, whichever field carries it (never its text). */
function callOf(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const call = message.tool_call as Record<string, unknown> | undefined;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
  const approvals = Array.isArray(message.approvals) ? message.approvals as Array<Record<string, unknown>> : [];
  return text(message.tool_call_id) ?? text(call?.tool_call_id) ?? text(calls[0]?.tool_call_id) ?? text(approvals[0]?.tool_call_id);
}

/** In memory: for tests and small conversions. */
export function convertCloudConversations(options: ConvertCloudOptions): CloudConversion {
  const files: NativeFile[] = [];
  const messages: MessagePlacement[] = [];
  const report = convertCloudStream(options, { file: (path, bytes) => files.push({ path, bytes }), message: (placement) => messages.push(placement) });
  const archive: NativeArchive = { version: 1, runtimeVersion: NATIVE_RUNTIME_VERSION, sourceAgentId: options.localAgentId, files };
  // Held to the shipped validator, never the other way around.
  validateNativeArchive(archive);
  return { ...report, archive, messages };
}

/**
 * On disk: the native files are written under `stagingDir` as they are produced, and every
 * message placement is appended to `placementsFile` (JSON lines). Memory stays bounded by
 * one conversation's live window plus the history volume being filled.
 */
export function convertCloudToStaging(options: ConvertCloudOptions & { stagingDir: string; placementsFile: string }): CloudConversionReport & { archive: NativeArchive } {
  return drain(stagingSteps(options));
}
/** Hearthside: the same, letting the window breathe between messages. */
export function convertCloudToStagingAsync(options: ConvertCloudOptions & { stagingDir: string; placementsFile: string }): Promise<CloudConversionReport & { archive: NativeArchive }> {
  return drainAsync(stagingSteps(options));
}
function* stagingSteps(options: ConvertCloudOptions & { stagingDir: string; placementsFile: string }): Generator<void, CloudConversionReport & { archive: NativeArchive }, undefined> {
  mkdirSync(options.stagingDir, { recursive: true, mode: 0o700 });
  // Canonicalize only the staging directory Hearthside created. On macOS the
  // temporary root is commonly exposed as /var while its real path is /private/var.
  const stagingDir = realpathSync(options.stagingDir);
  const files: NativeFile[] = [];
  mkdirSync(dirname(options.placementsFile), { recursive: true, mode: 0o700 });
  const placements = openSync(options.placementsFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let buffered: string[] = [];
  const flush = () => { if (buffered.length) { writeSync(placements, `${buffered.join("\n")}\n`); buffered = []; } };
  try {
    const report = yield* convertCloudSteps(options, {
      file: (path, bytes) => {
        const absolute = join(stagingDir, ...path.split("/"));
        mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
        const fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { writeSync(fd, bytes); } finally { closeSync(fd); }
        files.push(diskFile(path, absolute));
      },
      message: (placement) => { buffered.push(JSON.stringify(placement)); if (buffered.length >= 1000) flush(); },
    });
    flush();
    const archive: NativeArchive = { version: 1, runtimeVersion: NATIVE_RUNTIME_VERSION, sourceAgentId: options.localAgentId, files, visibility: "source" };
    yield* validateSteps(archive);
    return { ...report, archive };
  } finally { flush(); closeSync(placements); }
}

/** The derived snapshot's native-state artifacts, exactly as restore.ts reads them. */
export function nativeStateArtifacts(archive: NativeArchive): Array<{ path: string; kind: string; bytes: Buffer }> {
  return [
    { path: "native-state/manifest.json", kind: "native-state", bytes: Buffer.from(JSON.stringify({
      version: 1, runtimeVersion: archive.runtimeVersion, sourceAgentId: archive.sourceAgentId,
      // Converted chats publish visible (history volumes archived), before the receipt.
      visibility: "source",
      files: archive.files.map((file) => ({ path: file.path, artifactPath: `native-state/files/${encode(file.path)}` })),
    })) },
    ...archive.files.map((file) => ({ path: `native-state/files/${encode(file.path)}`, kind: "native-state-file", bytes: file.bytes })),
  ];
}
