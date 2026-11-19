import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type { ChatHelper, ChatHelperStep } from "@hearthside/ipc-contract";




const MAX_HELPERS_PER_CHAT = 40;
const MAX_STEPS = 150;

type Store = Record<string, ChatHelper[]>;

let file: string | null = null;
let store: Store = {};
let feedGeneration = 0;
/** Changes whenever a different persisted feed is loaded, even for the same chat IDs. */
export function helperFeedGeneration(): number { return feedGeneration; }
let listener: ((chatId: string, helpers: ChatHelper[]) => void) | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export function initHelperFeed(path: string, onChange: (chatId: string, helpers: ChatHelper[]) => void): void {
  feedGeneration++;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  file = path;
  listener = onChange;
  try {
    const saved: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    store = saved && typeof saved === "object" && !Array.isArray(saved)
      ? Object.fromEntries(Object.entries(saved).filter(([, helpers]) => Array.isArray(helpers)).map(([chatId, helpers]) => [chatId,
          (helpers as unknown[]).filter((helper): helper is ChatHelper => Boolean(helper && typeof helper === "object" && !Array.isArray(helper)
            && typeof (helper as ChatHelper).id === "string" && typeof (helper as ChatHelper).status === "string"
            && Array.isArray((helper as ChatHelper).steps))),
        ]))
      : {};
  } catch {
    store = {};
  }
  // Persisted history is not a live subscription. A crashed/disconnected
  // runtime may never have delivered its terminal snapshot before shutdown.
  // Keep completed results, but require fresh evidence for working spinners.
  for (const chatId of Object.keys(store)) markHelpersUnobserved(chatId);
}

function scheduleSave(): void {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(store));
    } catch (error) {
      console.warn(`[helpers] couldn't save the helper list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 1_000);
  saveTimer.unref?.();
}

/**
 * Drop what is kept about a chat's helpers. Nothing ever did: the list outlived
 * archived chats and deleted companions, and because This computer hands out
 * chat ids again once their owner is gone, a brand-new chat could open with a
 * deleted companion's helpers, prompts and steps, under "Previous".
 */
export function forgetHelpers(chatId: string): void {
  if (!Object.hasOwn(store, chatId)) return;
  delete store[chatId];
  changed(chatId);
}

/** Hearthside's id for the chat a frame belongs to: the default conversation is the agent's main chat. */
export function chatIdFor(scope: { agent_id?: unknown; conversation_id?: unknown } | null | undefined): string | null {
  const agentId = typeof scope?.agent_id === "string" ? scope.agent_id : null;
  const conversationId = typeof scope?.conversation_id === "string" ? scope.conversation_id : null;
  if (!conversationId) return null;
  if (conversationId === "default") return agentId ? `main:${agentId}` : null;
  return conversationId;
}

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function changed(chatId: string): void {
  scheduleSave();
  listener?.(chatId, store[chatId] ?? []);
}

const STILL_RUNNING = new Set(["running", "pending", "queued", "started"]);

/** Whether any helper of a chat is still shown as working. */
export function hasRunningHelpers(chatId: string): boolean {
  return (store[chatId] ?? []).some((helper) => STILL_RUNNING.has(helper.status));
}

/** When a helper of this chat that is still working last did something, or null when none is working. */
export function lastHelperActivity(chatId: string): number | null {
  const times = (store[chatId] ?? []).filter((helper) => STILL_RUNNING.has(helper.status)).map((helper) => helper.updatedAt ?? 0);
  return times.length > 0 ? Math.max(...times) : null;
}

/** A disconnected remote observer cannot honestly label a helper completed or
 * keep a permanent "working" spinner. A later live snapshot can update it. */
export function markHelpersUnobserved(chatId: string): void {
  let touched = false;
  for (const helper of store[chatId] ?? []) {
    if (!STILL_RUNNING.has(helper.status)) continue;
    helper.status = "unobserved";
    helper.error = "Live status is no longer connected. This helper may still be running on the selected computer.";
    helper.updatedAt = Date.now();
    touched = true;
  }
  if (touched) changed(chatId);
}



export function settleFromSnapshot(chatId: string, entries: unknown[]): void {
  // An incomplete/malformed list is not authoritative evidence of absence.
  if (!entries.every(entry => entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).subagent_id === "string" && ((entry as Record<string, unknown>).subagent_id as string).trim().length > 0)) return;
  applySnapshot(chatId, entries);
  const listed = new Set(entries.map((entry) => entry && typeof entry === "object" ? str((entry as Record<string, unknown>).subagent_id) : null).filter(Boolean));
  let touched = false;
  for (const helper of store[chatId] ?? []) {
    if (STILL_RUNNING.has(helper.status) && !listed.has(helper.id)) {
      helper.status = "ended";
      helper.updatedAt = Date.now();
      touched = true;
    }
  }
  if (touched) changed(chatId);
}

/** A runtime snapshot of a chat's helpers: merge it into what we keep (finished ones stay as "Previous"). */
export function applySnapshot(chatId: string, entries: unknown[]): void {
  const list = store[chatId] ?? [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = str(entry.subagent_id);
    if (!id) continue;
    const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls.length : num(entry.tool_calls) ?? null;
    const existing = list.find((helper) => helper.id === id);
    const next: ChatHelper = {
      id,
      type: str(entry.subagent_type) ?? existing?.type ?? "helper",
      description: str(entry.description) ?? existing?.description ?? "",
      prompt: str(entry.prompt) ?? existing?.prompt ?? "",
      status: str(entry.status) ?? existing?.status ?? "running",
      model: str(entry.model) ?? existing?.model ?? null,
      background: entry.is_background === true,
      startedAt: num(entry.start_time) ?? existing?.startedAt ?? Date.now(),
      durationMs: num(entry.duration_ms) ?? existing?.durationMs ?? null,
      toolCalls: toolCalls ?? existing?.toolCalls ?? 0,
      totalTokens: num(entry.total_tokens) ?? existing?.totalTokens ?? null,
      error: str(entry.error) ?? (existing?.status === "unobserved" || entry.error === null ? null : existing?.error) ?? null,
      conversationId: str(entry.conversation_id) ?? existing?.conversationId ?? null,
      steps: existing?.steps ?? [],
      updatedAt: Date.now(),
    };
    if (existing) Object.assign(existing, next);
    else list.unshift(next);
  }
  store[chatId] = list.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_HELPERS_PER_CHAT);
  changed(chatId);
}

/** One step a helper took (a tool call, a thought, a reply), from a tagged stream frame. */
export function applyStep(chatId: string, subagentId: string, delta: Record<string, unknown>): void {
  const type = str(delta.message_type);
  if (!type || type === "ping" || type === "usage_statistics" || type === "stop_reason") return;
  const list = (store[chatId] ??= []);
  let helper = list.find((item) => item.id === subagentId);
  if (!helper) {
    helper = { id: subagentId, type: "helper", description: "", prompt: "", status: "running", model: null, background: false, startedAt: Date.now(), durationMs: null, toolCalls: 0, totalTokens: null, error: null, conversationId: null, steps: [], updatedAt: Date.now() };
    list.unshift(helper);
  }
  let step: ChatHelperStep | null = null;
  if (type === "tool_call_message" || type === "approval_request_message") {
    const call = (delta.tool_call ?? (Array.isArray(delta.tool_calls) ? delta.tool_calls[0] : null)) as Record<string, unknown> | null;
    const name = str(call?.name);
    const id = str(call?.tool_call_id) ?? str(call?.id);
    if (!name) return;
    // Streamed calls arrive in pieces; the first piece names the tool, later ones add arguments.
    const known = id ? helper.steps.find((item) => item.kind === "tool" && item.id === id) : undefined;
    const args = str(call?.arguments) ?? "";
    if (known) {
      known.detail = `${known.detail}${args}`.slice(0, 600);
      helper.updatedAt = Date.now();
      changed(chatId);
      return;
    }
    step = { kind: "tool", id: id ?? `${Date.now()}`, name, detail: args.slice(0, 600), at: Date.now() };
  } else if (type === "tool_return_message") {
    const status = str(delta.status);
    const id = str(delta.tool_call_id);
    const known = id ? helper.steps.find((item) => item.kind === "tool" && item.id === id) : undefined;
    if (known) {
      known.failed = status === "error";
      helper.updatedAt = Date.now();
      changed(chatId);
    }
    return;
  } else if (type === "assistant_message" || type === "reasoning_message") {
    const text = typeof delta.content === "string" ? delta.content : str(delta.reasoning) ?? "";
    const last = helper.steps[helper.steps.length - 1];
    const kind = type === "assistant_message" ? "text" : "thought";
    if (last && last.kind === kind) {
      last.detail = `${last.detail}${text}`.slice(-1_200);
      helper.updatedAt = Date.now();
      changed(chatId);
      return;
    }
    step = { kind, id: str(delta.id) ?? `${Date.now()}`, name: "", detail: text.slice(-1_200), at: Date.now() };
  } else {
    return;
  }
  helper.steps.push(step);
  if (helper.steps.length > MAX_STEPS) helper.steps.splice(0, helper.steps.length - MAX_STEPS);
  helper.updatedAt = Date.now();
  changed(chatId);
}

export function helpersFor(chatId: string): ChatHelper[] {
  return store[chatId] ?? [];
}

/**
 * Read one incoming frame. Returns the frame to pass on to the SDK: unchanged,
 * or, for a helper's step, renamed so the SDK ignores it.
 */
export function filterFrame(text: string): string {
  if (!text.includes("subagent")) return text;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
  const chatId = chatIdFor(frame.runtime as Record<string, unknown> | undefined);
  if (frame.type === "update_subagent_state") {
    if (chatId && Array.isArray(frame.subagents)) applySnapshot(chatId, frame.subagents);
    return text;
  }
  if (frame.type === "stream_delta" && typeof frame.subagent_id === "string") {
    if (chatId && frame.delta && typeof frame.delta === "object") applyStep(chatId, frame.subagent_id, frame.delta as Record<string, unknown>);
    return JSON.stringify({ ...frame, type: "hearthside_subagent_delta" });
  }
  return text;
}

type Listener = (...args: unknown[]) => void;

/**
 * The WebSocket the SDK is given: every incoming message goes through
 * filterFrame first. (The app-server client listens with addEventListener.)
 */
export class HelperAwareWebSocket extends WebSocket {
  private readonly helperListeners = new Map<Listener, Listener>();

  override removeEventListener(type: string, listener: Listener): void {
    const wrapped = type === "message" ? this.helperListeners.get(listener) : undefined;
    (super.removeEventListener as (t: string, l: Listener) => void)(type, wrapped ?? listener);
    if (wrapped) this.helperListeners.delete(listener);
  }

  override addEventListener(type: string, listener: Listener, options?: unknown): void {
    if (type !== "message") return (super.addEventListener as (t: string, l: Listener, o?: unknown) => void)(type, listener, options);
    if (this.helperListeners.has(listener)) return;
    const wrapped = (event: { data: unknown }) => {
      const data = typeof event.data === "string" ? event.data : Buffer.isBuffer(event.data) ? event.data.toString("utf8") : null;
      if (data === null) return listener(event);
      const next = filterFrame(data);
      listener(next === data ? event : { ...event, data: next, type: "message", target: this });
    };
    this.helperListeners.set(listener, wrapped as Listener);
    (super.addEventListener as (t: string, l: Listener, o?: unknown) => void)(type, wrapped as Listener, options);
  }
}

export function helperFeedPath(userData: string): string {
  return join(userData, "helpers.json");
}
