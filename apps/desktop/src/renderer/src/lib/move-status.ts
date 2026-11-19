/**
 * Hearthside: moving a conversation to another computer, in plain words.
 *
 * A move has a lot of states because it can go wrong in a lot of ways, and the
 * difference between them matters: "asked for" is not "arrived", and "it moved
 * but we can't follow it" is not "it failed". So the line says only what is
 * known, and the rest — where it is, what went wrong, what to do — sits folded
 * underneath.
 *
 * Two rules hold everywhere here:
 * - Where the conversation is comes from `location`, never from the phase. A
 *   move that reached its destination and then lost the connection is still at
 *   the destination.
 * - Nothing says "arrived" until Hearthside is attached. Until then it can see
 *   the move happening; it cannot speak for the runtime at the other end.
 */
import type { ConversationMoveState } from "@hearthside/ipc-contract";

export type MoveNotice = {
  /** One short line, safe to show next to the composer. */
  line: string;
  /** The longer story, shown folded away. */
  detail: string;
  tone: "progress" | "warning" | "error";
  /** True once the move is over, one way or another. */
  settled: boolean;
};

/** Where it is running, said only as far as it is actually known. */
function whereItIs(move: ConversationMoveState): string {
  switch (move.location) {
    case "source":
      // Not "on this computer": the source is wherever the conversation already
      // was, which is often another computer and — when Letta refused the move
      // because there was no live environment to hand over — nowhere at all.
      return "It did not move: it stays wherever it already was.";
    case "destination":
      return `It is running on ${move.place.name}.`;
    default:
      return "Which computer is running it has not been confirmed.";
  }
}

/** The move, as one line and a folded explanation. */
export function moveNotice(move: ConversationMoveState | null | undefined): MoveNotice | null {
  if (!move) return null;
  const place = move.place.name;
  const reason = move.error ? ` ${move.error}` : "";
  switch (move.phase) {
    case "requested":
      return { line: `Moving to ${place}…`, detail: `Letta has been asked to move this conversation. Nothing has moved yet. ${whereItIs(move)}`, tone: "progress", settled: false };
    case "waiting-source":
      return { line: `Moving to ${place} — finishing here first`, detail: `This computer is finishing the work it already took on, then hands the conversation over. ${whereItIs(move)}`, tone: "progress", settled: false };
    case "starting":
      return { line: `Moving to ${place} — starting up there`, detail: `${place} is taking the conversation on. ${whereItIs(move)}`, tone: "progress", settled: false };
    case "connecting":
      return { line: `Moving to ${place} — connecting`, detail: `The move itself is done. Hearthside is connecting to ${place} so Stop and approvals work here again; until then they are only available in Letta. ${whereItIs(move)}`, tone: "progress", settled: false };
    case "attached":
      return { line: `Running on ${place}`, detail: `Hearthside is connected to ${place}, so Stop and approvals work here. ${whereItIs(move)} Its model, permissions, tools and files are ${place}'s, not this computer's.`, tone: "progress", settled: true };
    case "unconfirmed":
      // Asking again could start a second move. It is left alone on purpose.
      return { line: `Moving to ${place} — not confirmed`, detail: `Hearthside did not hear back about the move, so it does not know whether it started. It will not ask again, because asking twice could move the conversation twice. ${whereItIs(move)} Check the conversation in Letta.${reason}`, tone: "warning", settled: false };
    case "unobserved":
      // Even "it moved" is only said when `location` says so.
      return {
        line: move.location === "destination" ? `Moved to ${place} — can't follow it` : `Can't follow this conversation`,
        detail: `Hearthside could not connect to ${place}, so Stop and approvals are not available here — use Letta for those. ${whereItIs(move)} Nothing was cancelled, and the work may still be running.${reason}`,
        tone: "warning",
        settled: true,
      };
    default:
      return { line: `Couldn't move to ${place}`, detail: `${whereItIs(move)}${reason} Nothing was resent, and anything you had typed is still here.`, tone: "error", settled: true };
  }
}

/** A move still underway: the conversation is in neither place for certain. */
export function moveInFlight(move: ConversationMoveState | null | undefined): boolean {
  if (!move) return false;
  return move.phase === "requested" || move.phase === "unconfirmed" || move.phase === "waiting-source" || move.phase === "starting" || move.phase === "connecting";
}

/**
 * Asking for the same place again is a reconcile, not a second move: the backend
 * recognises the key it kept and reports on the move that already exists.
 */
export function isRetryOfSamePlace(move: ConversationMoveState | null | undefined, placeId: string): boolean {
  return Boolean(move && move.place.id === placeId && (move.phase === "unconfirmed" || move.phase === "failed" || move.phase === "unobserved"));
}
