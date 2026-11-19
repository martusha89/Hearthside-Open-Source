import type WebSocket from "ws";

/**
 * The observer-only socket a teleport destination is attached through.
 *
 * Hearthside attaches to a conversation that has moved somewhere else. It is
 * *not* that runtime's owner: the person's permission mode, working directory,
 * execution settings and skill sources belong to the destination, and an attach
 * that re-asserts this app's own preferences there is a silent configuration
 * change on someone else's computer.
 *
 * The public Agent SDK gives no call-site way to ask for that. Its cloud
 * `runtime_start` always carries a permission mode (an omitted `permissionMode`
 * normalises to `"standard"`, so the frame demotes an `acceptEdits` or
 * `unrestricted` destination and the listener persists the demotion), it never
 * sends `preserve_skill_sources` — so omitting `skillSources` makes the
 * listener *clear* them rather than leave them alone — and after the runtime is
 * initialised it sends `sync` with `recover_approvals: true`, which the
 * listener answers by replaying state and, when stale auto-decisions exist,
 * starting a recovered-approval continuation. That sync is sent again on every
 * idle reconnect, and `CloudStatusTransport` sends a third one by itself
 * whenever it notices a gap in the event sequence.
 *
 * So the correction cannot live at a call site; it has to live underneath all
 * three. The SDK's documented `WebSocket` client option is the seam: the
 * constructor it is given is the raw socket every outbound frame is written to.
 * This module narrows that one socket, and nothing else — no dependency edit,
 * no second transport, no protocol of our own.
 *
 * What it does to the frames it is given:
 *
 * - `runtime_start`: drops the destination's own settings (`mode`, `cwd`,
 *   `execution_settings`, `workspace_sandbox`, `skill_sources`,
 *   `bundled_skills`) so the listener preserves each of them, and sets
 *   `preserve_skill_sources: true` so the omission of `skill_sources` means
 *   "leave them" rather than "clear them". Forces `recover_approvals: false`.
 * - `sync`: forces `recover_approvals: false`.
 * - `change_device_state` and `runtime_external_tools_update`: refused. These
 *   are how an owner changes the runtime, and an observer has no business
 *   sending them. Refusing here means the attach code cannot regress into
 *   clobbering even by accident.
 * - everything else: passed through untouched, byte for byte.
 *
 * Anything it cannot vet — a frame that is not JSON, a `runtime_start` or
 * `sync` carrying a key this module has never heard of — is **refused**: the
 * frame is not written, the fault is recorded and the socket is closed, so the
 * SDK's `ready()` rejects and the caller records a move it could not observe.
 * Failing that way leaves the destination exactly as it was. Sending an
 * unreviewed frame would not.
 */

/** Keys an observer's `runtime_start` may carry as-is. */
const RUNTIME_START_KEEP = new Set([
  "type", "request_id", "agent_id", "conversation_id", "client_info",
  "force_device_status", "wait_for_replay",
]);

/**
 * Keys dropped so the destination keeps its own.
 *
 * Every one of these is documented as preserved when omitted — except
 * `skill_sources`, which is preserved only when `preserve_skill_sources` is
 * sent with it. That pairing is the whole reason this adapter exists.
 */
const RUNTIME_START_DROP = new Set([
  "mode", "cwd", "execution_settings", "workspace_sandbox", "skill_sources", "bundled_skills",
]);

/** Keys this adapter decides, whatever the SDK asked for. */
const RUNTIME_START_FORCED: Record<string, unknown> = {
  recover_approvals: false,
  preserve_skill_sources: true,
};

/** Keys an observer's `sync` may carry as-is. */
const SYNC_KEEP = new Set(["type", "runtime", "request_id", "force_device_status"]);

const SYNC_FORCED: Record<string, unknown> = { recover_approvals: false };

/** Frames that exist to change a runtime's configuration. Never an observer's. */
const OWNER_ONLY_FRAMES = new Set(["change_device_state", "runtime_external_tools_update"]);

export type ObserverDecision =
  | { action: "pass" }
  | { action: "rewrite"; frame: string }
  | { action: "refuse"; reason: string };

function narrow(
  frame: Record<string, unknown>,
  keep: Set<string>,
  drop: Set<string>,
  forced: Record<string, unknown>,
): ObserverDecision {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (key in forced || drop.has(key)) continue;
    if (!keep.has(key)) {
      // Not "probably harmless". An unreviewed key on an owner-shaped frame is
      // exactly how a future SDK version would start writing to the
      // destination again, so it stops the attach instead.
      return { action: "refuse", reason: `${String(frame.type)} carries an unreviewed field "${key}"` };
    }
    next[key] = value;
  }
  return { action: "rewrite", frame: JSON.stringify({ ...next, ...forced }) };
}

/**
 * Decide what an observer may write for one outbound frame.
 *
 * Exported separately from the socket so the frame contract can be asserted
 * directly, against the shapes the real SDK builds.
 */
export function reviewObserverFrame(data: string): ObserverDecision {
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return { action: "refuse", reason: "an outbound frame was not JSON, so it could not be reviewed" };
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { action: "refuse", reason: "an outbound frame was not a protocol command, so it could not be reviewed" };
  }
  const record = frame as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return { action: "refuse", reason: "an outbound frame had no command type, so it could not be reviewed" };
  if (OWNER_ONLY_FRAMES.has(type)) {
    return { action: "refuse", reason: `an observer must not send "${type}" to a destination it does not own` };
  }
  if (type === "runtime_start") return narrow(record, RUNTIME_START_KEEP, RUNTIME_START_DROP, RUNTIME_START_FORCED);
  if (type === "sync") return narrow(record, SYNC_KEEP, new Set(), SYNC_FORCED);
  return { action: "pass" };
}

export type ObserverSocketFault = {
  /** Shown to the person as the reason a move could not be observed. */
  reason: string;
};

// A rest-parameter constructor, because this is extended as a mixin: TypeScript
// only allows `extends` over a type-parameter base whose constructor it can
// forward wholesale, and it insists on `any[]` specifically for that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SocketConstructor = new (...args: any[]) => WebSocket;

/**
 * Wrap a socket constructor so every frame written through it is an observer's.
 *
 * Layered over whatever socket the app already uses rather than replacing it,
 * so an attach keeps the inbound filtering and header handling of an ordinary
 * session.
 *
 * `onFault` is called at most once per socket, before it is closed.
 */
export function observerOnlySocket<Base extends SocketConstructor>(
  base: Base,
  onFault: (fault: ObserverSocketFault) => void,
): Base {
  return class ObserverOnlySocket extends base {
    private faulted = false;

    private fail(reason: string): Error {
      const error = new Error(reason);
      if (!this.faulted) {
        this.faulted = true;
        onFault({ reason });
        // Closing matters as much as not sending: the SDK swallows throws from
        // its own keepalive and gap-recovery writes, and a socket whose frames
        // cannot be vetted must not stay usable.
        try { this.close(); } catch { /* already closing */ }
      }
      return error;
    }

    override send(data: unknown, ...rest: unknown[]): void {
      if (typeof data !== "string") {
        throw this.fail("an outbound frame was not text, so it could not be reviewed");
      }
      const decision = reviewObserverFrame(data);
      if (decision.action === "refuse") throw this.fail(decision.reason);
      const payload = decision.action === "rewrite" ? decision.frame : data;
      (super.send as (value: unknown, ...args: unknown[]) => void)(payload, ...rest);
    }
  } as unknown as Base;
}
