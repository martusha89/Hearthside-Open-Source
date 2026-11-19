/**
 * Hearthside: a chat on Letta Cloud can be in use somewhere else at the same
 * time (a Telegram or Discord bot on another computer shares the main chat).
 * These are the pure rules; runtime.ts asks Letta and waits.
 */

/** How long a chat counts as busy elsewhere after its last sign of activity (a run stuck for days must not block it). */
export const BUSY_FRESH_MS = 2 * 60_000;
export const BUSY_CHECK_MS = 4_000;
export const BUSY_ELSEWHERE_ACTIVITY = "Busy in this chat somewhere else (for example a Telegram or Discord bot on another computer). Your message goes as soon as that finishes.";

/** Letta Cloud's view of one chat: is something else working in it right now? */
export function busyFromStatus(status: { state?: unknown; active_run_ids?: unknown; last_activity_at?: unknown } | undefined, now = Date.now()): boolean {
  if (!status) return false;
  const runs = Array.isArray(status.active_run_ids) ? status.active_run_ids.length : 0;
  const working = runs > 0 || (typeof status.state === "string" && status.state !== "IDLE");
  const last = typeof status.last_activity_at === "number" ? status.last_activity_at : 0;
  return working && now - last < BUSY_FRESH_MS;
}

/**
 * Hearthside: errors that mean another app worked in this chat at the same time,
 * said plainly. The other app carries on; the open chat shows what it does.
 */
/** Whether an error means Letta handed the reply elsewhere mid-turn. */
export function isHandoffError(error: string): boolean {
  return /Invalid tool call IDs|conflicting listener/i.test(error);
}

export function explainTurnError(error: string): string {
  if (/Invalid tool call IDs|conflicting listener/i.test(error)) {
    return "Letta stopped taking this reply's results: the chat moved on without it. It may have carried on somewhere else your companion runs (for example Letta's Cloud sandbox). The chat now shows what Letta holds; send your message again if nothing more appears.";
  }
  return error;
}

