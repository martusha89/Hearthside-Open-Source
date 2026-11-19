import type { ConversationExecutionState } from "@hearthside/ipc-contract";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const SOURCE_STATES = new Set(["IDLE", "RUNNING", "BUSY", "WAITING", "ERROR"]);
const DETAILS = new Map([
  ["Conversation is idle; no active harness.", "idle-unowned"],
  ["No active harness.", "unowned"],
  ["Conflicting listeners.", "conflicting"],
  ["Runtime ownership evidence is stale or has no valid activity timestamp.", "stale"],
  ["Execution observation is temporarily unavailable. Refresh to verify the location.", "unavailable"],
]);

/** Display-only, bounded evidence. Never log IDs, URLs, payloads or arbitrary error/detail strings. */
export function createExecutionObservationDiagnostics(
  write: (line: string) => void,
  clock: () => number = Date.now,
): (raw: unknown, scope: { agentId: string; conversationId: string; connectionRevision?: string }, state: ConversationExecutionState, accepted: boolean) => void {
  const scopes = new Map<string, { label: number; signature: string }>();
  let nextLabel = 0;
  let windowStart = 0;
  let emitted = 0;
  let suppressed = 0;
  return (raw, scope, state, accepted) => {
    try {
      const now = clock();
      if (now < windowStart || now - windowStart >= 60_000) { windowStart = now; emitted = 0; }
      // Keys stay process-local, are never emitted, and are bounded to 64 scopes.
      const key = JSON.stringify([scope.connectionRevision ?? null, scope.agentId, scope.conversationId]);
      let entry = scopes.get(key);
      if (!entry) {
        if (scopes.size >= 64) scopes.delete(scopes.keys().next().value!);
        entry = { label: ++nextLabel, signature: "" };
        scopes.set(key, entry);
      }
      const matches = record(raw) && raw.agent_id === scope.agentId && Array.isArray(raw.statuses)
        ? raw.statuses.filter((item) => record(item) && item.conversation_id === scope.conversationId)
        : [];
      const status = matches.length === 1 ? matches[0] as Record<string, unknown> : undefined;
      const runs = status?.active_run_ids;
      const harness = status?.active_harness;
      const activity = status?.last_activity_at;
      const snapshot = record(raw) ? raw.snapshot_at : undefined;
      const age = (value: unknown, limit: number) => typeof value !== "number" || !Number.isFinite(value) || value < 0
        ? "missing-or-invalid" : value > now + 5_000 ? "future" : now - value > limit ? "stale" : "fresh";
      const fields = {
        scope: entry.label,
        accepted,
        response: raw === undefined ? "unavailable" : "received",
        matchingStatuses: Math.min(matches.length, 2),
        sourceState: typeof status?.state === "string" && SOURCE_STATES.has(status.state) ? status.state : "other-or-missing",
        runList: Array.isArray(runs) ? "array" : runs === undefined ? "missing" : "malformed",
        runCount: Array.isArray(runs) ? Math.min(runs.length, 1000) : null,
        harness: harness == null ? "absent" : record(harness) ? "object" : "malformed",
        activityAge: age(activity, 120_000),
        snapshotAge: age(snapshot, 30_000),
        conflicting: status?.has_conflicting_listeners === true,
        outcome: state.status === "confirmed" ? "confirmed" : state.status === "blocked" ? "blocked" : "unknown",
        reason: DETAILS.get(state.detail ?? "") ?? "other-or-none",
        selected: ["default", "desktop", "desktop-listener", "cloud", "computer", "follow-owner"].includes(state.selected.kind) ? state.selected.kind : "other",
        provenance: ["desktop", "owner", "selected"].includes(state.provenance ?? "") ? state.provenance : "none",
        requiresDestination: state.requiresDestination === true,
        pendingDelivery: Boolean(state.pendingDelivery),
        canMoveExecution: state.canMoveExecution === true,
        canFollowCurrentOwner: state.canFollowCurrentOwner === true,
      };
      const signature = JSON.stringify(fields);
      if (entry.signature === signature) return;
      if (emitted >= 12) { suppressed = Math.min(suppressed + 1, 1000000); return; }
      write(JSON.stringify({ event: "hearthside.execution-observation", ...fields, suppressed }));
      entry.signature = signature;
      emitted++;
      suppressed = 0;
    } catch { /* Observability must never change admission, delivery, or the original error. */ }
  };
}
