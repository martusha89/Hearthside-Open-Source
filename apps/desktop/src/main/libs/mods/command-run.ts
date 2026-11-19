/**
 * The gate every mod command goes through.
 *
 * Two problems force this to exist.
 *
 * The runtime's lifecycle end frame carries no request id (docs/MODS.md), so
 * two runs of one command in one chat are indistinguishable. Queueing them
 * would mean the second dispatches against checks made before the first ran —
 * possibly after it started a model turn, or after the execution target or the
 * connection changed. So a second command in the same chat is **refused**, and
 * the whole admission runs inside the slot, immediately before the send.
 *
 * And a command whose outcome is unknown — it timed out, or the connection
 * dropped mid-flight — leaves the chat ambiguous. The listener runs slash
 * commands as detached tasks (letta.js 459075), so an unfinished command does
 * not make the chat busy: the model loop can be idle, with no active runs and
 * an empty queue, while that command is still running and about to emit its
 * end frame. A later command would be satisfied by that straggler.
 *
 * So an ambiguous chat is held, and the hold is **only** released by evidence
 * that the command actually ended:
 *
 *   - its `slash_command_end` is observed (`clearQuarantineOnEnd`), or
 *   - the runtime process Hearthside owns is restarted, which takes the
 *     detached task with it (`clearQuarantineForNewRuntime`).
 *
 * An idle model loop is **not** evidence, and neither is a reconnect: the new
 * connection subscribes to the same chat, so the straggler can still arrive.
 *
 * A hold therefore belongs to **one runtime**, not to a chat id: the same
 * companion can be reached through a Letta server on another machine and
 * through a runtime on this one, and only one of those has the lost command
 * still in it. Every key carries that runtime's identity, so starting a
 * runtime Hearthside owns releases that runtime's holds and leaves another
 * server's alone — its process was never restarted, and switching away from it
 * and back is not evidence about anything.
 */

/** A command whose outcome is unknown: it may still be running in the runtime. */
export class CommandUncertain extends Error {
  readonly kind: "timeout" | "disconnect";
  constructor(kind: "timeout" | "disconnect", message: string) {
    super(message);
    this.name = "CommandUncertain";
    this.kind = kind;
  }
}

export type CommandScope = { agent_id: string; conversation_id: string };

/**
 * One chat on one runtime. The separator is a character no identity, agent id
 * or chat id can contain, so a server URL with a space in it cannot collide
 * with another runtime's chat.
 */
const KEY_PART = "\u0000";

export function commandSlotKey(runtimeIdentity: string, scope: CommandScope): string {
  return [runtimeIdentity, scope.agent_id, scope.conversation_id].join(KEY_PART);
}

const inFlight = new Set<string>();
const quarantined = new Map<string, string>();

/** How many commands are running right now, across every chat and runtime. */
export function commandsInFlight(): number {
  return inFlight.size;
}

export function scopeQuarantine(key: string): string | null {
  return quarantined.get(key) ?? null;
}

export function quarantineScope(key: string, reason: string): void {
  quarantined.set(key, reason);
}

/**
 * The command Hearthside lost track of has now ended: the chat can be used
 * again. This is the only per-chat release, and it needs a real end frame.
 */
export function clearQuarantineOnEnd(key: string): boolean {
  return quarantined.delete(key);
}

/**
 * A fresh runtime process for one runtime identity. Whatever was still running
 * in that process is gone with it, so nothing can arrive late from it any more.
 *
 * Only that runtime's holds go. A command lost on a Letta server Hearthside
 * does not own is still running there; starting a local runtime says nothing
 * about it, and must not quietly make that chat look safe again.
 */
export function clearQuarantineForNewRuntime(runtimeIdentity: string): void {
  const prefix = `${runtimeIdentity}${KEY_PART}`;
  for (const key of [...quarantined.keys()]) {
    if (key.startsWith(prefix)) quarantined.delete(key);
  }
}

/**
 * Let go of any slot held across a reconnect. The quarantine is deliberately
 * **not** cleared here: a reconnect is not a restart, and the straggler can
 * still be delivered to the new connection.
 */
export function releaseCommandSlots(): void {
  inFlight.clear();
}

/** Tests only. */
export function __resetCommandGate(): void {
  inFlight.clear();
  quarantined.clear();
}

export const UNCERTAIN_HOLD_REASON =
  "A command in this chat stopped answering and may still be running in the runtime. Hearthside won't start another in this chat until that one finishes, or until the runtime it was sent to is restarted.";

export type GuardedCommand<T> = {
  /** Everything that has to be true right now. Throws with a readable reason. */
  admit: () => Promise<void>;
  dispatch: () => Promise<T>;
};

export async function runGuardedCommand<T>(key: string, steps: GuardedCommand<T>): Promise<T> {
  if (inFlight.has(key)) {
    throw new Error("A command is already running in this chat. Wait for it to finish.");
  }
  const held = quarantined.get(key);
  if (held) throw new Error(held);
  inFlight.add(key);
  try {
    // Admission happens here, inside the slot and immediately before the send,
    // so nothing can have gone stale in between.
    await steps.admit();
    try {
      return await steps.dispatch();
    } catch (error) {
      if (error instanceof CommandUncertain) quarantined.set(key, UNCERTAIN_HOLD_REASON);
      throw error;
    }
  } finally {
    inFlight.delete(key);
  }
}
