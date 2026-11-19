import type { ConversationExecutionState, ConversationMovePhase, ConversationMoveState } from "@hearthside/ipc-contract";
import { getSettings, loadConversationMoves, saveConversationMoves, type StoredMoveRecord } from "./settings";

/** Ownership evidence goes stale; the execution store uses the same window. */
const OBSERVATION_FRESH_MS = 30_000;

/** A move is still happening, so nothing about its destination is settled yet. */
export function moveInFlight(phase: ConversationMovePhase): boolean {
  return phase === "requested" || phase === "unconfirmed" || phase === "waiting-source" || phase === "starting";
}

/** The move is over, one way or another, and needs no further status reads. */
export function moveSettled(phase: ConversationMovePhase): boolean {
  return phase === "attached" || phase === "unobserved" || phase === "failed";
}

/**
 * Where a move leaves the conversation when there is no fresh observation.
 *
 * `requested` is deliberately `unknown`, not `source`: once the request is on
 * the wire Letta may have admitted and even finished the move before the reply
 * comes back, so the app cannot assert the conversation is still here.
 * `starting` is `unknown` for the mirror-image reason — the source has let go
 * and the destination has not taken over.
 */
function assumedLocation(phase: ConversationMovePhase): ConversationMoveState["location"] {
  switch (phase) {
    case "requested": return "unknown";
    case "unconfirmed": return "unknown";
    case "waiting-source": return "source";
    case "starting": return "unknown";
    case "connecting": return "destination";
    case "attached": return "destination";
    case "unobserved": return "destination";
    case "failed": return "source";
  }
}

/**
 * Where the conversation is running.
 *
 * A fresh observation of the live connection beats every assumption: that is
 * the only thing that can tell "moved" from "told to move". The phase is the
 * fallback, used when nothing has been observed recently enough to trust.
 */
export function moveLocation(
  record: Pick<StoredMoveRecord, "phase" | "targetConnectionId" | "sourceConnectionId">,
  observed: ConversationExecutionState["observed"],
  now = Date.now(),
): ConversationMoveState["location"] {
  if (observed?.connectionId && now - observed.observedAt <= OBSERVATION_FRESH_MS) {
    if (observed.connectionId === record.targetConnectionId) return "destination";
    if (record.sourceConnectionId && observed.connectionId === record.sourceConnectionId) return "source";
  }
  return assumedLocation(record.phase);
}

/** What the main process can actually reach right now. Never inferred from a phase. */
export type ControlReach = {
  /** A live session for the conversation's source is held here. */
  sourceAttached: boolean;
  /** A live attached session for the move's destination is held here. */
  destinationAttached: boolean;
};

/**
 * Whether Stop can be honoured, and if not, why.
 *
 * While a move **this app issued** is in flight Stop is reported unavailable
 * even when the source session is still held. Aborting the source would be
 * acknowledged, but the source may go on to hand the conversation over at its
 * next boundary and the destination would continue the work — so an abort there
 * cannot promise that the work stopped. Saying "unavailable, because it is
 * moving" is the only honest answer until the move lands.
 *
 * A move the **agent** asked for itself is the opposite case. Nobody promised
 * the person anything about it, the source is still the only thing holding the
 * accepted work, and aborting it is how that work drains to its handoff
 * boundary. Reporting Stop unavailable there would withhold the one control
 * that still does something.
 */
export function moveControls(
  phase: ConversationMovePhase,
  reach: ControlReach,
  placeName: string,
  initiatedBy: "hearthside" | "agent" = "hearthside",
): NonNullable<ConversationExecutionState["controls"]> {
  if (moveInFlight(phase) && initiatedBy === "agent") {
    return reach.sourceAttached
      ? { stop: "available" }
      : { stop: "at-destination", reason: `This conversation is moving to ${placeName} on the agent's own request. Stop it there, or in Letta.` };
  }
  if (moveInFlight(phase)) {
    return { stop: "unavailable", reason: `This conversation is moving to ${placeName}. Stop can't be relied on until it lands.` };
  }
  if (phase === "connecting") {
    return { stop: "unavailable", reason: `Connecting to ${placeName} to take over approvals and Stop.` };
  }
  if (phase === "failed") {
    // The move failed, so the conversation never left — but "still on the
    // source" does not mean this app is attached to that source. It may be
    // another computer's listener, or a session that has since dropped.
    return reach.sourceAttached
      ? { stop: "available" }
      : { stop: "at-destination", reason: "The move failed and the conversation stayed where it was. Stop it from there, or in Letta." };
  }
  // attached / unobserved: the conversation is at the destination.
  return reach.destinationAttached
    ? { stop: "available" }
    : { stop: "at-destination", reason: `This conversation is running on ${placeName}. Stop it there, or in Letta.` };
}

/** The renderer-facing view of a stored move. The idempotency key never leaves here. */
export function moveState(record: StoredMoveRecord, observed: ConversationExecutionState["observed"], revision: number, now = Date.now()): ConversationMoveState {
  return {
    conversationId: record.conversationId,
    moveId: record.teleportId,
    place: { id: record.placeId, name: record.placeName },
    phase: record.phase,
    location: moveLocation(record, observed, now),
    ...(record.error ? { error: record.error } : {}),
    revision,
  };
}

// ---------------------------------------------------------------------------
// Durable store. Account-scoped like the execution store, and entirely separate
// from it: a held pendingDelivery must survive every move outcome untouched.
// ---------------------------------------------------------------------------

let scope: string | undefined;
let records = new Map<string, StoredMoveRecord>();
let revision = 0;

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record_ = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const PHASES: ConversationMovePhase[] = ["requested", "unconfirmed", "waiting-source", "starting", "connecting", "attached", "unobserved", "failed"];

/** Strict reload: a record missing its key or target could never be reconciled. */
function valid(raw: unknown): raw is StoredMoveRecord {
  if (!record_(raw)) return false;
  if (!text(raw.conversationId) || !text(raw.agentId) || !text(raw.scopedConversationId)) return false;
  if (raw.initiatedBy !== "hearthside" && raw.initiatedBy !== "agent") return false;
  // A Hearthside move without its key could never be reconciled safely; an
  // agent's move has no key to hold, only a teleport id to watch.
  if (raw.initiatedBy === "hearthside" ? !text(raw.idempotencyKey) : typeof raw.idempotencyKey !== "string") return false;
  if (raw.initiatedBy === "agent" && !text(raw.teleportId)) return false;
  if (!text(raw.targetConnectionId) || !text(raw.targetDeviceId)) return false;
  if (!text(raw.placeId) || !text(raw.placeName)) return false;
  if (raw.sourceConnectionId !== null && !text(raw.sourceConnectionId)) return false;
  if (raw.teleportId !== null && !text(raw.teleportId)) return false;
  if (!PHASES.includes(raw.phase as ConversationMovePhase)) return false;
  if (!["source", "destination", "unknown"].includes(String(raw.location))) return false;
  if (raw.error !== undefined && !text(raw.error)) return false;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return false;
  // A phase that only exists while the app is running cannot be trusted after a
  // restart: nothing was attached, and "connecting" was never finished.
  return true;
}

/**
 * Set when the durable store could not be read.
 *
 * Reads degrade to "no moves known" so a storage problem cannot break Stop or
 * the execution panel. Starting a move is the opposite: without knowing what is
 * already in flight, and without being able to save a key, a request could
 * duplicate a move, so `beginMove` refuses outright.
 */
let loadFailed = false;

function synchronize(): void {
  const next = getSettings().connectionRevision ?? "initial";
  if (scope === next) return;
  let stored: Record<string, StoredMoveRecord>;
  try {
    stored = loadConversationMoves(next);
    loadFailed = false;
  } catch {
    stored = {};
    loadFailed = true;
  }
  const saved = Object.entries(stored).filter(([id, raw]) => id && valid(raw));
  records = new Map(saved.map(([id, raw]) => [id, reopen(raw)]));
  scope = next;
}

/**
 * How a stored move reads after a restart.
 *
 * Nothing is attached any more, so `attached` and `connecting` cannot be
 * claimed. Both become `unobserved`: the conversation did move, and until the
 * app attaches again the controls genuinely live at the destination. This never
 * downgrades to `failed`, which would wrongly say the conversation is here.
 */
function reopen(stored: StoredMoveRecord): StoredMoveRecord {
  if (stored.phase === "attached" || stored.phase === "connecting") {
    return { ...stored, phase: "unobserved", location: "destination" };
  }
  return { ...stored };
}

function persist(): void {
  saveConversationMoves(scope!, Object.fromEntries(records));
}

/**
 * Advancing a move is best-effort on disk: a lost phase update is survivable
 * because the status can be read again. A lost idempotency key never is, so
 * `beginMove` lets its own save failure propagate instead of using this.
 */
function persistQuietly(): void {
  try { persist(); } catch (error) {
    console.warn(`[teleport] a move update could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getMoveRecord(conversationId: string): StoredMoveRecord | null {
  synchronize();
  const stored = records.get(conversationId);
  return stored ? structuredClone(stored) : null;
}

export function moveRevision(): number {
  return revision;
}

/**
 * Every move this account knows about, as it reads now.
 *
 * This is how a restart finds the work it left behind: a move that was in
 * flight when the app closed is still in flight in Letta, and one that was
 * being watched reads back as `unobserved` (see `reopen`) and can be attached
 * to again. Returned as copies, in insertion order.
 */
export function listMoveRecords(): StoredMoveRecord[] {
  synchronize();
  return [...records.values()].map((record) => structuredClone(record));
}

/**
 * Begin a move, writing the idempotency key before any request is made.
 *
 * An existing unresolved move for the same place is **reused**, key and all, so
 * a retry can only reconcile that move. A move to a different place while one
 * is unresolved is refused rather than queued: Letta allows one in flight, and
 * guessing which one the person meant is not the app's call.
 */
export function beginMove(input: {
  conversationId: string; agentId: string; scopedConversationId: string;
  placeId: string; placeName: string; targetConnectionId: string; targetDeviceId: string;
  newKey: () => string;
}): { record: StoredMoveRecord; reused: boolean } {
  synchronize();
  if (loadFailed) {
    throw new Error("Hearthside couldn't read its record of moves, so it won't start one: a move it can't remember could be started twice.");
  }
  const existing = records.get(input.conversationId);
  if (existing && !moveSettled(existing.phase)) {
    if (existing.placeId !== input.placeId) {
      throw new Error(`This conversation is already moving to ${existing.placeName}. Wait for that to finish before moving it somewhere else.`);
    }
    revision += 1;
    return { record: structuredClone(existing), reused: true };
  }
  const stored: StoredMoveRecord = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    scopedConversationId: input.scopedConversationId,
    initiatedBy: "hearthside",
    idempotencyKey: input.newKey(),
    targetConnectionId: input.targetConnectionId,
    targetDeviceId: input.targetDeviceId,
    sourceConnectionId: null,
    placeId: input.placeId,
    placeName: input.placeName,
    teleportId: null,
    phase: "requested",
    location: "unknown",
    startedAt: Date.now(),
  };
  records = new Map(records).set(input.conversationId, stored);
  revision += 1;
  persist();
  return { record: structuredClone(stored), reused: false };
}

/**
 * Record a move the agent asked for itself, from an authoritative receipt.
 *
 * Hearthside did not issue this one, so there is no key to retry with — the
 * record exists so the app can say where the conversation went instead of only
 * that it lost control of it. A move this app started is never overwritten by
 * one of these: its key must survive.
 */
export function recordObservedMove(input: {
  conversationId: string; agentId: string; scopedConversationId: string;
  receipt: { id: string; targetConnectionId: string; sourceConnectionId: string; targetDeviceId: string; targetConnectionName: string; status: "waiting_for_source" | "starting_destination" | "completed" | "failed"; error: string | null };
}): StoredMoveRecord | null {
  synchronize();
  const existing = records.get(input.conversationId);
  if (existing && existing.initiatedBy === "hearthside" && !moveSettled(existing.phase)) return structuredClone(existing);
  const phase: ConversationMovePhase = input.receipt.status === "completed"
    // Completed natively, with nothing of ours attached to it.
    ? "unobserved"
    : input.receipt.status === "failed" ? "failed"
      : input.receipt.status === "starting_destination" ? "starting" : "waiting-source";
  const stored: StoredMoveRecord = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    scopedConversationId: input.scopedConversationId,
    initiatedBy: "agent",
    idempotencyKey: "",
    targetConnectionId: input.receipt.targetConnectionId,
    targetDeviceId: input.receipt.targetDeviceId,
    sourceConnectionId: input.receipt.sourceConnectionId,
    placeId: `computer:${input.receipt.targetDeviceId}`,
    placeName: input.receipt.targetConnectionName,
    teleportId: input.receipt.id,
    phase,
    location: assumedLocation(phase),
    ...(input.receipt.error ? { error: input.receipt.error } : {}),
    startedAt: existing?.startedAt ?? Date.now(),
  };
  records = new Map(records).set(input.conversationId, stored);
  revision += 1;
  persistQuietly();
  return structuredClone(stored);
}

/** Advance a move. The idempotency key and place are never rewritten. */
export function advanceMove(conversationId: string, patch: {
  phase: ConversationMovePhase;
  teleportId?: string | null;
  sourceConnectionId?: string | null;
  location?: ConversationMoveState["location"];
  error?: string;
}): StoredMoveRecord | null {
  synchronize();
  const existing = records.get(conversationId);
  if (!existing) return null;
  const next: StoredMoveRecord = {
    ...existing,
    phase: patch.phase,
    ...(patch.teleportId !== undefined ? { teleportId: patch.teleportId } : {}),
    ...(patch.sourceConnectionId !== undefined ? { sourceConnectionId: patch.sourceConnectionId } : {}),
    location: patch.location ?? assumedLocation(patch.phase),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  };
  records = new Map(records).set(conversationId, next);
  revision += 1;
  persistQuietly();
  return structuredClone(next);
}

/**
 * Forget a move once it can no longer tell anyone anything useful.
 *
 * An unresolved move is never forgotten: it is the only record that a request
 * went out, and its key is the only way a retry stays a reconciliation.
 */
export function clearMove(conversationId: string): void {
  synchronize();
  const existing = records.get(conversationId);
  if (!existing || !moveSettled(existing.phase)) return;
  const next = new Map(records);
  next.delete(conversationId);
  records = next;
  revision += 1;
  persistQuietly();
}

/** Test seam: drop in-memory state so a fresh account scope is re-read. */
export function resetMovesForTests(): void {
  scope = undefined;
  records = new Map();
  revision = 0;
  loadFailed = false;
}
