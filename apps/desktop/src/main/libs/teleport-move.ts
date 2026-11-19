import { randomUUID } from "node:crypto";
import type { ConversationMoveState, ExecutionPlace } from "@hearthside/ipc-contract";
import type { NativeTeleportReceipt } from "./native-teleport";
import {
  phaseForStatus, readNativeTeleportStatus, requestNativeTeleport,
  type TeleportScope, type TeleportTransport,
} from "./teleport-control";
import {
  advanceMove, beginMove, getMoveRecord, moveInFlight, moveRevision, moveSettled, moveState,
} from "./teleport-moves";
import {
  CLOUD_PLACE_ID, THIS_PC_PLACE_ID, channelBoundRefusal, executionPlaces,
  type PlacesInput,
} from "./teleport-places";

/** A place, resolved to the thing a teleport request can actually address. */
export type ResolvedPlace = {
  connectionId: string;
  name: string;
  /** Needed to validate the move's own status receipts, which name the device. */
  deviceId: string;
};

/**
 * Everything the move needs from the rest of the app, injected so this module
 * can be exercised without Electron, Letta credentials or a live computer.
 */
export type MoveEnvironment = {
  transport: () => Promise<TeleportTransport>;
  /** Scope and identity of the conversation, or null when it has none yet. */
  scopeFor: (conversationId: string) => { agentId: string; scopedConversationId: string } | null;
  places: (conversationId: string) => Promise<PlacesInput>;
  /**
   * The destination for a place, resolved fresh at request time.
   *
   * Takes the conversation because resolving is not always a lookup: picking
   * Letta Cloud provisions that conversation's own sandbox, and the thing that
   * does it has to know which conversation it is for.
   */
  resolvePlace: (placeId: string, conversationId: string) => Promise<ResolvedPlace>;
  observed: (conversationId: string) => { connectionId?: string; observedAt: number } | null;
  publish: (state: ConversationMoveState) => void;
  newKey?: () => string;
};

export async function listPlaces(env: MoveEnvironment, conversationId: string): Promise<ExecutionPlace[]> {
  return executionPlaces(await env.places(conversationId));
}

/** Derive the channel refusal from the conversation's own routes. */
export function refusalFromRoutes(
  routes: Array<{ conversationId: string; enabled: boolean; channelId: string }>,
  scopedConversationId: string,
  conversationId: string,
): string | null {
  return channelBoundRefusal(routes, scopedConversationId, conversationId);
}

/**
 * Ask Letta to move a conversation now.
 *
 * The returned state is the move's *acceptance*, not its completion. Watching
 * it to completion is `followMove`, which the caller drives.
 */
export async function startMove(env: MoveEnvironment, conversationId: string, placeId: string): Promise<ConversationMoveState> {
  const identity = env.scopeFor(conversationId);
  if (!identity) throw new Error("This conversation has no identity in Letta yet, so there is nothing to move.");

  // Re-check the refusals against fresh state rather than trusting whatever the
  // picker was showing when the person clicked.
  const offered = await listPlaces(env, conversationId);
  const place = offered.find((candidate) => candidate.id === placeId);
  if (!place) throw new Error("That place is no longer available. Refresh and choose again.");
  if (place.moveBlocked) throw new Error(place.moveBlocked);
  // Running in this app and continuing where it runs are not relocations, and a
  // teleport is the one thing a channel-bound conversation must never be given.
  // They are refused here as well as handled earlier, so no future caller can
  // route one of them into a move by passing its id to this function.
  if (place.kind === "app" || place.kind === "follow") throw new Error("That place isn't somewhere a conversation is moved to; nothing was moved.");

  const target = await env.resolvePlace(placeId, conversationId);
  const scope: TeleportScope = { agentId: identity.agentId, conversationId: identity.scopedConversationId };

  // The key is written before the request goes out, so a request whose outcome
  // is never learned can still only be reconciled, never duplicated.
  const { record } = beginMove({
    conversationId,
    agentId: identity.agentId,
    scopedConversationId: identity.scopedConversationId,
    placeId,
    placeName: target.name,
    targetConnectionId: target.connectionId,
    targetDeviceId: target.deviceId,
    newKey: env.newKey ?? randomUUID,
  });
  publish(env, conversationId);

  const outcome = await requestNativeTeleport(
    await env.transport(), scope, record.targetConnectionId, record.idempotencyKey,
  );

  if (outcome.outcome === "refused") {
    // A stated refusal is proof nothing started, so the move is closed out and
    // the conversation is known to be where it was.
    const failed = advanceMove(conversationId, { phase: "failed", error: outcome.reason });
    if (failed) publish(env, conversationId);
    throw new Error(outcome.reason);
  }
  if (outcome.outcome === "unknown") {
    // Not a failure. Letta may have admitted the move, so the app must not say
    // the conversation stayed here.
    const unconfirmed = advanceMove(conversationId, { phase: "unconfirmed", error: outcome.reason });
    if (unconfirmed) publish(env, conversationId);
    return current(env, conversationId)!;
  }

  const accepted = advanceMove(conversationId, {
    phase: phaseForStatus(outcome.receipt.status),
    teleportId: outcome.receipt.id,
    sourceConnectionId: outcome.receipt.sourceConnectionId,
    ...(outcome.receipt.error ? { error: outcome.receipt.error } : {}),
  });
  if (accepted) publish(env, conversationId);
  return current(env, conversationId)!;
}

/**
 * Read a move's status once and record what it says.
 *
 * Returns the move's state, or null when there is nothing to follow. A read
 * that tells us nothing leaves the record exactly as it was — "no answer" is
 * never promoted to "failed".
 */
export async function followMove(env: MoveEnvironment, conversationId: string): Promise<ConversationMoveState | null> {
  const record = getMoveRecord(conversationId);
  if (!record) return null;
  if (moveSettled(record.phase)) return current(env, conversationId);
  if (!record.teleportId) {
    // An unconfirmed request has no teleport id, so there is nothing to read.
    // It stays unconfirmed until the person retries it, which reuses the key.
    return current(env, conversationId);
  }
  const accepted: NativeTeleportReceipt = {
    id: record.teleportId,
    agentId: record.agentId,
    conversationId: record.scopedConversationId,
    sourceConnectionId: record.sourceConnectionId ?? "",
    targetConnectionId: record.targetConnectionId,
    // These travel on the receipt and are pinned by the validator; a record
    // written before they were known cannot be followed.
    targetDeviceId: record.targetDeviceId,
    targetConnectionName: record.placeName,
    // The validator pins identity, not status: the whole point of the read is
    // to learn a status that has moved on from whatever was last recorded.
    status: "waiting_for_source",
    error: record.error ?? null,
  };
  if (!accepted.sourceConnectionId || !accepted.targetDeviceId) return current(env, conversationId);

  const status = await readNativeTeleportStatus(
    await env.transport(),
    { agentId: record.agentId, conversationId: record.scopedConversationId },
    accepted,
  );
  if (!status) return current(env, conversationId);

  const next = advanceMove(conversationId, {
    phase: phaseForStatus(status.status),
    ...(status.error ? { error: status.error } : {}),
  });
  if (next) publish(env, conversationId);
  return current(env, conversationId);
}

/** Mark a completed move the app could not attach to. It moved regardless. */
export function markUnobserved(env: MoveEnvironment, conversationId: string, reason: string): ConversationMoveState | null {
  const next = advanceMove(conversationId, { phase: "unobserved", error: reason });
  if (!next) return null;
  publish(env, conversationId);
  return current(env, conversationId);
}

/** Mark a completed move the app did attach to, so Stop and approvals land there. */
export function markAttached(env: MoveEnvironment, conversationId: string): ConversationMoveState | null {
  const next = advanceMove(conversationId, { phase: "attached" });
  if (!next) return null;
  publish(env, conversationId);
  return current(env, conversationId);
}

/** Whether a move is live enough that Stop must not be promised. */
export function moveHoldsControls(conversationId: string): boolean {
  const record = getMoveRecord(conversationId);
  return record ? moveInFlight(record.phase) || record.phase === "connecting" : false;
}

export function current(env: MoveEnvironment, conversationId: string): ConversationMoveState | null {
  const record = getMoveRecord(conversationId);
  if (!record) return null;
  const seen = env.observed(conversationId);
  return moveState(record, seen ? { kind: "computer", ...seen } : null, moveRevision());
}

function publish(env: MoveEnvironment, conversationId: string): void {
  const state = current(env, conversationId);
  if (state) env.publish(state);
}


export { CLOUD_PLACE_ID, THIS_PC_PLACE_ID };
