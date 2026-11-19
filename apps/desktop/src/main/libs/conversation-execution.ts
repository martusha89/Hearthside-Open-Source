import type { ConversationExecutionState, ConversationExecutionTarget } from "@hearthside/ipc-contract";
import { getSettings, loadConversationExecution, saveConversationExecution } from "./settings";

let scope: string | undefined;
let states = new Map<string, ConversationExecutionState>();
let revision = 0;
const remoteRevisions = new Map<string, number>();
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function synchronize(): void {
  const next = getSettings().connectionRevision ?? "initial";
  if (scope === next) return;
  const rawSaved: unknown = loadConversationExecution(next);
  const saved = Object.fromEntries(Object.entries(record(rawSaved) ? rawSaved : {}).filter(([id, raw]) => {
    if (!id || !record(raw) || !record(raw.selected) || !["follow-owner", "default", "desktop", "desktop-listener", "cloud", "computer"].includes(String(raw.selected.kind))) return false;
    if (raw.selected.kind === "computer" && (!text(raw.selected.deviceId) || !text(raw.selected.name))) return false;
    if (raw.pendingDelivery !== undefined && (!record(raw.pendingDelivery) ||
        !text(raw.pendingDelivery.agentId) || !text(raw.pendingDelivery.conversationId) || !text(raw.pendingDelivery.clientMessageId) ||
        (raw.pendingDelivery.superRunId !== undefined && !text(raw.pendingDelivery.superRunId)) ||
        (raw.pendingDelivery.workflowId !== undefined && !text(raw.pendingDelivery.workflowId)))) return false;
    if (raw.provenance !== undefined && raw.provenance !== "desktop" && raw.provenance !== "owner" && raw.provenance !== "selected") return false;
    if (raw.selectedConnectionId !== undefined && !text(raw.selectedConnectionId)) return false;
    if (raw.moveFrom !== undefined && (!record(raw.moveFrom) || (raw.moveFrom.connectionId !== null && !text(raw.moveFrom.connectionId)))) return false;
    if (raw.desktopConnectionId !== undefined && !text(raw.desktopConnectionId)) return false;
    if (!["unknown", "confirmed", "blocked"].includes(String(raw.status)) || !Number.isSafeInteger(raw.revision)) return false;
    if (raw.observed !== null && (!record(raw.observed) || !["desktop", "cloud", "computer"].includes(String(raw.observed.kind)) || typeof raw.observed.observedAt !== "number" || !Number.isFinite(raw.observed.observedAt))) return false;
    return true;
  })) as Record<string, ConversationExecutionState>;
  for (const state of Object.values(saved)) {
    if (Number.isSafeInteger(state.revision)) revision = Math.max(revision, state.revision);
  }
  states = new Map(Object.entries(saved).map(([id, state]) => [id, {
    ...state, conversationId: id, status: state.status === "blocked" ? "blocked" : "unknown", revision: ++revision,
    detail: state.status === "blocked" ? state.detail : undefined,
  }]));
  scope = next;
  remoteRevisions.clear();
}

export function getExecutionState(chatId: string): ConversationExecutionState {
  synchronize();
  let state = states.get(chatId);
  if (!state) {
    state = { conversationId: chatId, selected: { kind: "default" }, observed: null, status: "unknown", revision: ++revision };
    states.set(chatId, state);
  }
  const result = structuredClone(state);
  if (result.status === "confirmed" && (!result.observed || Date.now() - result.observed.observedAt > 30_000)) {
    result.status = "unknown";
    result.detail = "Last known location; fresh ownership evidence is required.";
  }
  return result;
}

function update(chatId: string, patch: Partial<ConversationExecutionState>): ConversationExecutionState {
  const before = getExecutionState(chatId);
  const state = { ...before, ...patch, revision: ++revision };
  const nextStates = new Map(states);
  nextStates.set(chatId, state);
  const durable = (entry: ConversationExecutionState) => JSON.stringify({ selected: entry.selected, provenance: entry.provenance, moveFrom: entry.moveFrom, desktopConnectionId: entry.desktopConnectionId, selectedConnectionId: entry.selectedConnectionId, status: entry.status, detail: entry.detail, pendingDelivery: entry.pendingDelivery, observed: entry.observed ? { ...entry.observed, observedAt: 0 } : null });
  // Publishing an unsaved completion would make the next retry look like a
  // no-op, leaving its accepted-job marker on disk forever.
  if (durable(before) !== durable(state)) saveConversationExecution(scope!, Object.fromEntries(nextStates));
  states = nextStates;
  return structuredClone(state);
}

export function recordDesktopExecution(chatId: string, connectionId?: string): ConversationExecutionState {
  return update(chatId, { provenance: "desktop", moveFrom: undefined, observed: null, status: "unknown", detail: undefined, ...(connectionId ? { desktopConnectionId: connectionId } : {}) });
}

export function followExecutionOwner(chatId: string): ConversationExecutionState {
  return selectExecution(chatId, { kind: "follow-owner" });
}

export function recordSelectedExecution(chatId: string, connectionId?: string): ConversationExecutionState {
  return update(chatId, { selected: conversationTarget(chatId), provenance: "selected", selectedConnectionId: connectionId, desktopConnectionId: undefined, moveFrom: undefined });
}

export function acknowledgeExecutionMove(chatId: string, connectionId: string | null): ConversationExecutionState {
  return update(chatId, { moveFrom: { connectionId } });
}

export function completeExecutionDelivery(chatId: string): ConversationExecutionState {
  return update(chatId, { pendingDelivery: undefined, status: "unknown", detail: undefined });
}

export function selectExecution(chatId: string, target: ConversationExecutionTarget): ConversationExecutionState {
  if (getExecutionState(chatId).pendingDelivery) return getExecutionState(chatId);
  if (!record(target) || !["follow-owner", "default", "desktop", "desktop-listener", "cloud", "computer"].includes(target.kind) ||
      (target.kind === "computer" && (!text(target.deviceId) || !text(target.name)))) {
    return blockExecution(chatId, "Invalid execution target.");
  }
  return update(chatId, { selected: structuredClone(target), provenance: target.kind === "follow-owner" ? "owner" : undefined, selectedConnectionId: undefined, desktopConnectionId: undefined, moveFrom: undefined, status: "unknown", detail: undefined, pendingDelivery: undefined });
}

export function markExecutionUnknown(chatId: string, detail: string): ConversationExecutionState {
  if (getExecutionState(chatId).status === "blocked") return getExecutionState(chatId);
  return update(chatId, { status: "unknown", detail });
}

export function blockExecution(chatId: string, detail: string, pendingDelivery?: ConversationExecutionState["pendingDelivery"]): ConversationExecutionState {
  return update(chatId, { status: "blocked", detail, ...(pendingDelivery ? { pendingDelivery } : {}) });
}

/** Resolve only intent; this is never evidence that a listener is running. */
export function conversationTarget(chatId: string): ConversationExecutionTarget {
  const selected = getExecutionState(chatId).selected;
  if (selected.kind !== "default") return selected;
  const settings = getSettings();
  return settings.backend === "cloud" && settings.executionComputer
    ? { kind: "computer", deviceId: settings.executionComputer.deviceId, name: settings.executionComputer.name }
    : { kind: "desktop" };
}

/** Capture getExecutionState().revision before awaiting a request and pass it as
 * expectedRevision: a response to an old selection/account must not confirm it.
 * A server-provided revision is additionally checked independently per chat. */
export function observeExecution(chatId: string, raw: unknown, normalizedConversationId: string, expectedRevision?: number): ConversationExecutionState {
  const current = getExecutionState(chatId);
  // Ownership can recover, but ambiguous delivery is a separate admission guard.
  // Observations must never clear acceptance-unknown or accepted input IDs.
  if (current.pendingDelivery) return current;
  if (expectedRevision !== undefined && expectedRevision !== current.revision) return current;
  if (!record(raw) || !Array.isArray(raw.statuses)) return blockExecution(chatId, "Malformed runtime status.");
  const matches = raw.statuses.filter((status) => record(status) && status.conversation_id === normalizedConversationId);
  const unknown = (detail: string) => update(chatId, { status: "unknown", detail });
  if (matches.length !== 1) return unknown("No unambiguous status for this conversation.");
  const status = matches[0] as Record<string, unknown>;
  const receivedRevision = status.revision ?? raw.revision;
  if (receivedRevision !== undefined) {
    if (typeof receivedRevision !== "number" || !Number.isSafeInteger(receivedRevision) || receivedRevision < 0) return blockExecution(chatId, "Malformed runtime revision.");
    if (receivedRevision < (remoteRevisions.get(chatId) ?? -1)) return current;
    remoteRevisions.set(chatId, receivedRevision);
  }
  if (status.has_conflicting_listeners) return unknown("Conflicting listeners.");
  if (status.state === "IDLE" && Array.isArray(status.active_run_ids) && status.active_run_ids.length === 0 && status.active_harness == null) return unknown("Conversation is idle; no active harness.");
  const lastActivity = status.last_activity_at;
  if (typeof lastActivity !== "number" || !Number.isFinite(lastActivity) || lastActivity < 0 || lastActivity > Date.now() + 5_000 || Date.now() - lastActivity > 120_000) {
    return unknown("Runtime ownership evidence is stale or has no valid activity timestamp.");
  }
  const harness = status.active_harness;
  if (harness == null) return unknown("No active harness.");
  if (!record(harness)) return blockExecution(chatId, "Malformed active harness.");
  if (!text(harness.connection_id)) return unknown("No listener connection identity.");
  const observed: NonNullable<ConversationExecutionState["observed"]> = {
    kind: harness.managed_sandbox === true || harness.type === "managed_sandbox" || harness.kind === "managed_sandbox" ? "cloud" : "computer",
    connectionId: harness.connection_id,
    ...(text(harness.device_id) ? { deviceId: harness.device_id } : {}),
    ...(text(harness.connection_name) ? { name: harness.connection_name } : text(harness.name) ? { name: harness.name } : {}),
    observedAt: Date.now(),
  };
  return update(chatId, { observed, status: "confirmed", detail: undefined });
}
