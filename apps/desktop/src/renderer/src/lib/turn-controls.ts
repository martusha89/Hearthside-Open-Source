/**
 * Hearthside: whether Stop can actually stop this turn.
 *
 * Stop stays on screen the whole time a reply is coming, because a button that
 * vanishes leaves the person with no idea whether they can interrupt. What
 * changes is whether it works, and that is the runtime's answer, not a guess
 * here: `controls.stop` comes from the backend, which knows which runtime owns
 * the turn and whether this app can reach it.
 *
 * The one thing inferred locally is *un*availability — mid-move, nothing can be
 * stopped from here — because being wrong in that direction only ever withholds
 * a claim, never makes a false one.
 */
import type { ConversationExecutionState, ConversationMoveState } from "@hearthside/ipc-contract";
import { moveInFlight } from "./move-status";

export type StopCapability = NonNullable<ConversationExecutionState["controls"]>["stop"];

export type StopControl = {
  /** `pending`: asked for, not yet finished. `blocked`: visible, won't act. */
  state: "available" | "pending" | "blocked";
  label: string;
  /** Why, in one sentence — shown on hover and said on click when blocked. */
  reason: string | null;
};

export type StopInput = {
  controls?: { stop: StopCapability; reason?: string };
  move?: ConversationMoveState | null;
  /** Older runtimes send no `controls`; these are what they do say. */
  blocked?: boolean;
  pendingDelivery?: boolean;
  followsOwner?: boolean;
  /**
   * Whether this build can move conversations between computers. It decides
   * what silence means: on an old build, no `controls` is just an old runtime
   * and today's behaviour is right. On this one, the turn could be owned by a
   * computer this window has never spoken to, so silence is "unknown".
   */
  nativeMove?: boolean;
};

const AT_DESTINATION = "This turn is running on another computer. Stop it there, or in Letta.";
const MID_MOVE = "This conversation is moving to another computer. Stop can't reach it until the move settles.";
const UNKNOWN = "Hearthside can't reach the runtime working on this chat, so it can't stop it.";
const UNREPORTED = "Hearthside hasn't been told which computer is working on this chat, so it can't promise Stop would reach it. Stop it in Letta.";

export function stopControl(input: StopInput, stopRequested: boolean): StopControl {
  // Asked for and not yet done. A stop is a request to the runtime, so this says
  // it is pending — the turn is over when the runtime says it is, not now.
  if (stopRequested) return { state: "pending", label: "Stopping…", reason: "Stop has been asked for. The turn ends when the runtime confirms it." };
  const capability = input.controls?.stop;
  // A move the companion asked for itself leaves the source as the only thing
  // holding the work, and the app says so by reporting Stop available. Believe
  // it: withholding Stop there took away the one control that still worked.
  if (moveInFlight(input.move) && capability !== "available") return { state: "blocked", label: "Stop", reason: MID_MOVE };
  if (capability === "available") return { state: "available", label: "Stop", reason: null };
  if (capability === "at-destination") return { state: "blocked", label: "Stop", reason: input.controls?.reason ?? AT_DESTINATION };
  if (capability === "unavailable") return { state: "blocked", label: "Stop", reason: input.controls?.reason ?? UNKNOWN };
  // Nothing said about Stop, on a build where the turn may be owned by another
  // computer. The old guess below would answer "available", and after a move
  // this window could not have reached that runtime — pressing Stop would have
  // asked the *source* to stop a turn it no longer owns, and reported success.
  // Not knowing is not permission: say so instead of guessing.
  if (input.nativeMove || input.move) return { state: "blocked", label: "Stop", reason: UNREPORTED };
  // No `controls` field and no native move: an older runtime. Keep today's
  // behaviour rather than inventing a capability, and stay on the withholding
  // side of it.
  if (input.pendingDelivery) return { state: "blocked", label: "Stop", reason: "This message is running at its current destination. Stop it there, or in Letta." };
  if (input.blocked || input.followsOwner) return { state: "blocked", label: "Stop", reason: AT_DESTINATION };
  return { state: "available", label: "Stop", reason: null };
}
