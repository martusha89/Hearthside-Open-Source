import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { Followup, FollowupCaptureStatus, FollowupCreate, FollowupPolicy, FollowupScope, FollowupView } from "@hearthside/ipc-contract";
import { parseRequestArgs } from "@hearthside/ipc-contract";
import { getConnectionConfig, getSettings, localFollowupIdentity } from "../settings";
import { resolveRuntimeHome } from "../../runtime/paths";
import { IntentionsStore } from "./store";
import { isIntentionsStorageError, reportIntentionsStorageError } from "./storage-errors";
import { IntentionsController, type IntentionsCapture, type IntentionsHooks, type IntentionMessage } from "./controller";
import { timeContext } from "./time";
import { automaticNote } from "./notes";
import { ClassifierUnavailable, classifyMessage, type ClassifierBudget, type ClassifierTransport } from "./classifier";

export type IntentionsRuntime = Omit<IntentionsHooks, "assertScope" | "capture"> & {
  /**
   * Checks the companion owns the conversation AND reads the real channel
   * bindings and routes, refusing anything that is not demonstrably private.
   * Its refusal text is what the panel shows as the audience reason.
   */
  validateConversation(agentId: string, conversationId: string): Promise<void>;
  /** Absent when this connection cannot run a separate classification at all. */
  capture?: ClassifierTransport;
};
let runtime: IntentionsRuntime | null = null;
let database: IntentionsStore | null = null;
let controller: IntentionsController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus = "Beta · Runs only while the desktop app is open. Nothing is noticed or sent while Hearthside is closed, including for Cloud companions. Only this desktop's own private chats are read; Telegram and Discord are never observed.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function intentionsStore(): IntentionsStore {
  return database ??= new IntentionsStore(join(app.getPath("userData"), "intentions", "intentions.sqlite"));
}
export function existingIntentionsStore(): IntentionsStore | null { return database; }
export function intentionsConnectionId(): string {
  const c = getConnectionConfig();
  const home = resolveRuntimeHome().home;
  // Persist an opaque account/endpoint/home identity, never credentials.
  const derive = () => createHash("sha256").update(JSON.stringify([c.backend, c.apiBaseUrl || "https://api.letta.com", c.serverUrl, c.apiKey, c.lettaSignedIn, getSettings().connectionRevision, c.serverToken, home])).digest("hex");
  // This computer's store is the same store whatever Letta Cloud or server
  // details are saved beside it, so its identity is worked out once and kept.
  return c.backend === "local" ? localFollowupIdentity(home, derive) : derive();
}
export function followupScope(agentId: string, conversationId: string): FollowupScope {
  return { connectionId: intentionsConnectionId(), agentId, conversationId, recipientId: "desktop-owner", audience: "private" };
}
export async function assertFollowupScope(scope: FollowupScope): Promise<void> {
  if (!runtime || scope.connectionId !== intentionsConnectionId() || scope.audience !== "private" || scope.recipientId !== "desktop-owner") throw new Error("Intentions destination changed or is unavailable.");
  await runtime.validateConversation(scope.agentId, scope.conversationId);
  if (scope.connectionId !== intentionsConnectionId()) throw new Error("Intentions account changed while checking the destination.");
}
async function resolveScope(agentId: string, conversationId: string): Promise<FollowupScope> {
  const scope = followupScope(agentId, conversationId); await assertFollowupScope(scope); return scope;
}

/**
 * Semantic capture, assembled from three separate things: the connection's
 * transport, the daily reservation ledger in the store, and the model the person
 * chose. When any of them is missing this reports unavailable with a reason,
 * rather than letting the panel imply that noticing works.
 */
function captureHook(transport: ClassifierTransport): IntentionsCapture {
  const budget: ClassifierBudget = {
    reserve: scope => intentionsStore().reserveClassifierJob(scope),
    // Bookkeeping must never replace the real outcome of a job, so everything
    // after the reservation only logs.
    release: (scope, id) => { try { intentionsStore().releaseClassifierJob(scope, id); } catch (error) { reportIntentionsStorageError(error, "release classifier reservation"); } },
    dispatched: (scope, id, conversationId) => { try { intentionsStore().markClassifierJob(scope, id, conversationId); } catch (error) { reportIntentionsStorageError(error, "record classifier job"); } },
    archived: (scope, id, state) => {
      try { intentionsStore().markClassifierArchived(scope, id, state); } catch (error) { reportIntentionsStorageError(error, "record classifier archive state"); }
      if (state === "failed") lastStatus = "A temporary check conversation could not be archived. It is still in your account's conversation list; the panel shows how many.";
      if (state === "unconfirmed") lastStatus = "A temporary check conversation was asked to be archived but did not confirm, so it may still be in your account's conversation list; the panel shows how many.";
    },
  };
  return {
    available: scope => captureStatus(scope, transport),
    classify: async (scope, request) => {
      const policy = intentionsStore().getPolicy(scope);
      const model = policy.semanticModel ?? "";
      if (!model) throw new ClassifierUnavailable("No model is chosen for short-term memory.");
      return classifyMessage({ scope, request, model, transport, budget });
    },
  };
}

/** What capture can actually do right now, in plain words, for panel and logs. */
function captureStatus(scope: FollowupScope, transport: ClassifierTransport | null | undefined): { available: boolean; reason: string } {
  if (!transport) return { available: false, reason: "This connection cannot run the separate classification that noticing needs. Only the simple time-phrase reader runs." };
  const store = intentionsStore();
  const policy = store.getPolicy(scope);
  if (!policy.enabled) return { available: false, reason: "Short-term conversational memory is off." };
  if (policy.extractAutomatically === false) return { available: false, reason: "Noticing is off for this chat; only follow-ups the companion makes itself are kept." };
  if (scope.audience !== "private") return { available: false, reason: "This conversation is not a private desktop chat." };
  if (!policy.semanticModel) return { available: false, reason: "No model is chosen for noticing, so only the simple time-phrase reader runs." };
  const usage = store.classifierUsage(scope);
  if (usage.usedToday >= usage.limit) return { available: false, reason: `Today's ${usage.limit} checks have been used. Noticing starts again tomorrow; the simple time-phrase reader still runs.` };
  return { available: true, reason: `Noticing is on, using ${policy.semanticModel}. ${usage.usedToday} of ${usage.limit} checks used today.` };
}

function activeController(): IntentionsController {
  if (!runtime) throw new Error("Intentions runtime is not ready.");
  const active = runtime;
  const hooks: IntentionsHooks = {
    readPage: active.readPage,
    isBusy: active.isBusy,
    invoke: active.invoke,
    assertScope: assertFollowupScope,
    ...(active.reconcile ? { reconcile: active.reconcile } : {}),
    ...(active.capture ? { capture: captureHook(active.capture) } : {}),
  };
  return controller ??= new IntentionsController(intentionsStore(), hooks);
}
export function configureIntentions(hooks: IntentionsRuntime): void {
  runtime = hooks; controller = null;
  // Reopen durable policies at startup, even if no chat or settings panel opens.
  try { intentionsStore(); } catch (error) {
    const detail = isIntentionsStorageError(error) ? reportIntentionsStorageError(error, "open database").message : "Intentions storage could not be opened.";
    lastStatus = `${detail} Background follow-ups are paused; other chat features remain available.`;
  }
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void tickIntentions(); }, 60_000);
  timer.unref?.();
}
export function stopIntentions(): void { if (timer) clearInterval(timer); timer = null; }
export async function tickIntentions(): Promise<void> {
  if (!runtime || !database) return;
  try {
    const scopes = database.scopes().filter(scope => scope.connectionId === intentionsConnectionId());
    const result = await activeController().tick(scopes);
    if (result.errors.length) lastStatus = "A background pass could not verify its source or delivery. Uncertain sends are not retried. Inspect dispatch states before continuing.";
  } catch (error) {
    if (isIntentionsStorageError(error)) reportIntentionsStorageError(error, "run background intentions pass");
    lastStatus = "The intentions background pass stopped safely. Open this panel to verify the store and current connection.";
  }
}

/** The capture block shown in the panel, including anything left unarchived. */
function captureView(scope: FollowupScope, refusal: string | null): FollowupCaptureStatus {
  const store = intentionsStore();
  const policy = store.getPolicy(scope);
  const usage = store.classifierUsage(scope);
  const readiness = refusal ? { available: false, reason: refusal } : captureStatus(scope, runtime?.capture);
  const note = controller?.captureStatus();
  return {
    available: readiness.available,
    reason: readiness.available && note ? `${readiness.reason} Last time: ${note}` : readiness.reason,
    model: policy.semanticModel ?? null,
    usedToday: usage.usedToday,
    limit: usage.limit,
    archiveFailures: usage.archiveFailures,
  };
}

export async function getFollowups(agentId: string, conversationId: string): Promise<FollowupView> {
  const scope = followupScope(agentId, conversationId), store = intentionsStore();
  // A conversation that cannot be shown to be private still gets a panel: it
  // says why, rather than failing with nothing the person can act on. Items
  // already held locally stay visible; nothing new is read or written.
  let refusal: string | null = null;
  try { await assertFollowupScope(scope); } catch (error) { refusal = errorText(error); }
  if (!refusal) store.expire(scope);
  return {
    scope,
    policy: store.getPolicy(scope),
    items: store.list(scope),
    status: lastStatus,
    audienceReason: refusal ?? "This conversation is private to this desktop app.",
    capture: captureView(scope, refusal),
  };
}
export async function saveFollowupPolicy(agentId: string, conversationId: string, policy: FollowupPolicy): Promise<FollowupView> {
  const scope = await resolveScope(agentId, conversationId);
  intentionsStore().setPolicy(scope, policy);
  return getFollowups(agentId, conversationId);
}
export async function createFollowup(agentId: string, conversationId: string, input: FollowupCreate): Promise<Followup> {
  const scope = await resolveScope(agentId, conversationId);
  return intentionsStore().create(scope, { ...input, sourceMessageId: `manual:${randomUUID()}`, sourceAt: new Date().toISOString() }, "user_created", "user");
}
export async function updateFollowup(agentId: string, conversationId: string, id: string, revision: number, patch: Partial<FollowupCreate>): Promise<Followup> {
  const scope = await resolveScope(agentId, conversationId);
  return intentionsStore().update(scope, id, revision, patch);
}
export async function changeFollowup(agentId: string, conversationId: string, id: string, revision: number, action: "adopt" | "defer" | "resolve" | "cancel", notBefore?: string): Promise<Followup> {
  const scope = await resolveScope(agentId, conversationId);
  return intentionsStore().transition(scope, id, revision, action, "user", notBefore);
}
export async function scanFollowups(agentId: string, conversationId: string) {
  return activeController().scan(await resolveScope(agentId, conversationId));
}

/** Mark only actual desktop-originated inputs before sending, so a crash after
 * acknowledgement can be recovered without classifying another channel's users. */
export function rememberFollowupInput(agentId: string, conversationId: string, otid: string, at: string): FollowupScope | null {
  if (!runtime) return null;
  const scope = followupScope(agentId, conversationId), store = intentionsStore();
  const policy = store.getPolicy(scope);
  if (!policy.enabled || policy.extractAutomatically === false) return null;
  store.rememberInput(scope, otid, at); return scope;
}
export async function observeFollowupInput(scope: FollowupScope, message: IntentionMessage): Promise<void> {
  try { await activeController().observe(scope, message); }
  catch (error) {
    if (isIntentionsStorageError(error)) reportIntentionsStorageError(error, "observe intentions input");
    lastStatus = "An input could not be classified immediately; reconciliation can retry confirmed desktop inputs.";
  }
}

export const FOLLOWUP_TOOL_NAMES = ["list_relevant_followups", "create_followup", "adopt_followup", "defer_followup", "resolve_followup", "cancel_followup"] as const;

/**
 * This turn's follow-up tools.
 *
 * `preparedAt` is when the person submitted, and the automatic note labels it as
 * a snapshot rather than the current time; the tool itself returns a fresh
 * clock. The note is built only after the conversation has been shown to be
 * private on this very turn, because a tool definition is matched by agent and
 * conversation and not by connection: while it is registered, another session on
 * the same conversation could read its description.
 */
export async function createFollowupTools(agentId: string, conversationId: string, preparedAt = new Date().toISOString()): Promise<AnyAgentTool[]> {
  if (!runtime) return [];
  const scope = followupScope(agentId, conversationId), store = intentionsStore();
  const policy = store.getPolicy(scope);
  if (!policy.enabled) return [];
  // Re-checked every turn, never cached: a bot bound a minute ago changes this.
  try { await assertFollowupScope(scope); } catch { return []; }
  if (store.getPolicy(scope).enabled !== true) return [];
  // Tools are registered before this turn's own input is marked, so this is the
  // previous observed desktop input, not a fabricated global last-contact time.
  const previousInputAt = store.lastInputTimestamp(scope) ?? undefined;
  const clock = timeContext(new Date(), policy.timezone, previousInputAt);
  const note = policy.automaticNotes === false ? "" : automaticNote(store.relevant(scope, 3), {
    preparedAt,
    timezone: policy.timezone,
    audience: scope.audience,
    includeSummaries: policy.enabled && policy.extractAutomatically !== false,
  });
  const tools: AnyAgentTool[] = [{
    name: "list_relevant_followups", label: "Read this chat's open follow-ups",
    description: `Controller-owned short-term follow-ups for this private desktop conversation only. ${clock} Call to obtain a fresh clock and at most 3 relevant items. Candidates are classifier proposals, not your intentions; adopt only if you choose. A past event time is not evidence of attendance. Do not resolve an item merely because you asked or received an unrelated reply.${note ? `\n\n${note}` : ""}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      await assertFollowupScope(scope);
      if (!store.getPolicy(scope).enabled) throw new Error("Intentions disabled.");
      return { content: [{ type: "text", text: JSON.stringify({ source: "Hearthside intentions controller", time: timeContext(new Date(), store.getPolicy(scope).timezone, previousInputAt), clockScope: "Previous marked desktop input in this conversation only; not cross-channel contact.", items: store.relevant(scope, 3) }) }] };
    },
  }];
  tools.push({
    name: "create_followup", label: "Create an agent-owned intention",
    description: "Create your own short-term follow-up for this private chat. This records your choice, not a user promise. Times must include UTC or an explicit offset; leave ambiguous event/follow-up times null. Proactive contact still requires the human's separate policy opt-in.",
    parameters: { type: "object", properties: { summary: { type: "string" }, action: { type: "string" }, eventAt: { type: ["string", "null"] }, notBefore: { type: ["string", "null"] }, expiresAt: { type: "string" } }, required: ["summary", "action", "eventAt", "notBefore", "expiresAt"], additionalProperties: false },
    execute: async (_call, args) => {
      await assertFollowupScope(scope);
      if (!store.getPolicy(scope).enabled) throw new Error("Intentions disabled.");
      const input = { ...args as object, timezone: store.getPolicy(scope).timezone, sourceMessageId: `agent:${randomUUID()}`, sourceAt: new Date().toISOString() };
      const parsed = parseRequestArgs("createFollowup", [agentId, conversationId, input])[2];
      const item = store.create(scope, parsed, "agent_created", "agent");
      return { content: [{ type: "text", text: JSON.stringify(item) }] };
    },
  });
  for (const action of ["adopt", "defer", "resolve", "cancel"] as const) tools.push({
    name: `${action}_followup`, label: `${action} this chat's follow-up`,
    description: `${action} a follow-up using its current id and revision. Adoption is your deliberate choice. Defer requires an explicit ISO timestamp. Resolution requires relevant evidence, never just elapsed time or an unrelated reply.`,
    parameters: { type: "object", properties: { id: { type: "string" }, revision: { type: "integer" }, notBefore: { type: "string" } }, required: ["id", "revision"], additionalProperties: false },
    execute: async (_call, args) => {
      await assertFollowupScope(scope);
      if (!store.getPolicy(scope).enabled) throw new Error("Intentions disabled.");
      const a = args as { id: string; revision: number; notBefore?: string };
      parseRequestArgs("changeFollowup", [agentId, conversationId, a.id, a.revision, action, a.notBefore]);
      const item = store.transition(scope, a.id, a.revision, action, "agent", a.notBefore);
      return { content: [{ type: "text", text: JSON.stringify(item) }] };
    },
  });
  return tools;
}
