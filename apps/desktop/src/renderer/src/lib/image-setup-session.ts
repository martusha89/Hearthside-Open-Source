import type { AppEvent, ImageSetupMode, ImageSetupState, ImageSetupStep } from "../types";

/**
 * Hearthside: the window's half of an image setup — which session is mine,
 * what is it doing, and what happens when the person changes their mind part
 * way through.
 *
 * It lives apart from the card because the awkward parts are all about timing,
 * and timing is worth testing:
 *
 *  - Asking the main process to start returns a session id, but the session is
 *    already running by then. Its first updates — or a failure that happens at
 *    once — can arrive BEFORE the id does. Those are held and replayed, rather
 *    than dropped against a session id that is still null, which would leave a
 *    card spinning over a job that had already finished.
 *  - Cancelling, or closing the panel, while that request is still in flight
 *    leaves a job running in the main process that nothing is watching. The
 *    reply is therefore never adopted after a cancel: the returned id is
 *    cancelled instead, so a download or a sign-in can't carry on unseen.
 *
 * Each attempt carries a generation. A reply from an older one can only end
 * what it started; it can never take over the card.
 */

export type SetupPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; sessionId: string; state: ImageSetupState | null }
  | { kind: "failed"; error: string };

type SetupEvent = Extract<AppEvent, { type: "imagesetup.update" } | { type: "imagesetup.finished" }>;

export type SetupSessionDeps = {
  start: (step: ImageSetupStep, mode?: ImageSetupMode) => Promise<{ sessionId: string }>;
  cancel: (sessionId: string) => Promise<unknown> | void;
  /** Called whenever the card should show something different. */
  onPhase: (phase: SetupPhase) => void;
  /** Called when a setup ends, so the cards can read the status again. */
  onSettled: () => void;
};

/** Enough to cover the updates one setup can emit before its id arrives. */
const MAX_EARLY_EVENTS = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSetupSession(deps: SetupSessionDeps) {
  let sessionId: string | null = null;
  let starting = false;
  let generation = 0;
  let disposed = false;
  /** Events that arrived before this attempt learned its session id. */
  let early: SetupEvent[] = [];

  const apply = (event: SetupEvent) => {
    if (event.type === "imagesetup.update") {
      deps.onPhase({ kind: "running", sessionId: event.sessionId, state: event.state });
      return;
    }
    sessionId = null;
    deps.onPhase(event.ok ? { kind: "idle" } : { kind: "failed", error: event.error ?? "That didn't finish. Try again." });
    deps.onSettled();
  };

  /** Hand every app event here; anything that isn't ours is ignored. */
  const handleEvent = (event: AppEvent) => {
    if (disposed) return;
    if (event.type !== "imagesetup.update" && event.type !== "imagesetup.finished") return;
    if (sessionId === null) {
      // No id yet. If one is on its way, keep this for when it arrives;
      // otherwise it belongs to nobody here.
      if (starting && early.length < MAX_EARLY_EVENTS) early.push(event);
      return;
    }
    if (event.sessionId !== sessionId) return;
    apply(event);
  };

  const start = async (step: ImageSetupStep, mode?: ImageSetupMode) => {
    // A second click joins the one already running rather than racing it.
    if (disposed || starting || sessionId !== null) return;
    starting = true;
    const mine = ++generation;
    early = [];
    deps.onPhase({ kind: "starting" });

    let ack: { sessionId: string };
    try {
      ack = await deps.start(step, mode);
    } catch (error) {
      starting = false;
      if (disposed || generation !== mine) return;
      deps.onPhase({ kind: "failed", error: errorMessage(error) });
      deps.onSettled();
      return;
    }

    starting = false;
    const buffered = early;
    early = [];
    if (disposed || generation !== mine) {
      // Cancelled or closed while this was in flight. The job is real and
      // running, so end it; never adopt it, which would leave a download or a
      // sign-in going with nothing on screen to stop it.
      void Promise.resolve(deps.cancel(ack.sessionId)).catch(() => undefined);
      return;
    }

    sessionId = ack.sessionId;
    deps.onPhase({ kind: "running", sessionId, state: null });
    // Anything that happened before the id arrived, in the order it happened.
    for (const event of buffered) {
      if (event.sessionId !== sessionId) continue;
      apply(event);
      if (sessionId === null) break; // It had already finished.
    }
  };

  const cancel = () => {
    if (disposed) return;
    // Invalidates any start still in flight, so its reply cancels instead of adopting.
    generation++;
    starting = false;
    early = [];
    const current = sessionId;
    sessionId = null;
    deps.onPhase({ kind: "idle" });
    if (current) void Promise.resolve(deps.cancel(current)).catch(() => undefined);
    deps.onSettled();
  };

  /** The panel is going away: stop what this app started and go quiet. */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    starting = false;
    early = [];
    const current = sessionId;
    sessionId = null;
    if (current) void Promise.resolve(deps.cancel(current)).catch(() => undefined);
  };

  return { start, cancel, dispose, handleEvent };
}
