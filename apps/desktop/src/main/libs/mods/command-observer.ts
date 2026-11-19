import type { ApprovalDecision, ApprovalRequest } from "@hearthside/ipc-contract";
import { type CommandScope, CommandUncertain } from "./command-run";
import { announcesPrompt, commandInputLine } from "./command-lifecycle";

/**
 * Running a mod command, and watching what it sets off, on **one** socket.
 *
 * A mod command can return a `prompt`, which submits a user message and leaves
 * a turn running in the listener. That turn is not one of Hearthside's SDK
 * sessions, so nothing in the normal chat path knows about it. Three things
 * therefore have to be observed here, and all of them come back on the same
 * connection the command was sent on:
 *
 *   - `slash_command_end` — the command's own outcome (mod commands get no
 *     `execute_command_response` at all; see docs/MODS.md);
 *   - `control_request` with `subtype: "can_use_tool"` — a tool in that turn
 *     is waiting for the person. Without routing these, a prompt command that
 *     touches a tool would simply hang until the follow limit with nothing the
 *     person could do. They are answered with `input` /
 *     `approval_response` on the same client, which is the same wire path the
 *     agent SDK uses;
 *   - `update_loop_status`, `update_queue` and `turn_finished` — whether a
 *     turn started and whether it really ended. `WAITING_ON_APPROVAL` is
 *     neither idle nor a failure.
 *
 * Everything is subscribed **before** the command is sent, so a fast command
 * cannot finish before anyone is listening, and everything is matched on the
 * exact scope: a frame without a scope, or with another chat's, is ignored
 * rather than guessed at.
 *
 * The client is captured once. Answers are never sent on a replacement
 * connection: if this run's connection went away, the answer is refused and
 * the person is told, instead of a decision landing in another runtime.
 */

/** The part of the app-server client this needs, so it can be faked in tests. */
export type ObserverClient = {
  nextRequestId(prefix?: string): string;
  onMessage(handler: (message: unknown) => void): () => void;
  onDisconnect(handler: (event: unknown) => void): () => void;
  sendRaw(command: Record<string, unknown> & { type: string }): void;
};

export type CommandRunHandle = {
  /** Answer an approval this run raised. Throws if it is not one of its own. */
  answer: (requestId: string, decision: ApprovalDecision) => void;
  /** Approvals still waiting. */
  pending: () => ApprovalRequest[];
};

export type ObserverHooks = {
  /** Called before the command is sent, so the handle can be registered. */
  onStart: (handle: CommandRunHandle) => void;
  onApprovalRequested: (request: ApprovalRequest) => void;
  onApprovalResolved: (requestId: string) => void;
  onActivity: (activity: string | null) => void;
  /** Called once, whatever the outcome, so the handle can be unregistered. */
  onFinished: () => void;
};

export type RunModCommandParams = {
  scope: CommandScope;
  commandId: string;
  args: string;
  /** Management operations do not emit slash lifecycle frames. */
  recompile?: boolean;
  /** Called immediately before dispatch; retains the exact correlation id for late replies. */
  onDispatch?: (requestId: string) => void;
  /** Built-ins doctor/init run their turn before returning the command outcome. */
  startsTurn?: boolean;
  /** Aborted when this run's connection or account goes away. */
  signal: AbortSignal;
  /** A last check that the chat is idle, in case no push frame said so. */
  confirmIdle: () => Promise<boolean>;
  commandTimeoutMs?: number;
  turnStartWindowMs?: number;
  turnFollowMs?: number;
  /** How often the idle backstop runs while following a turn. */
  pollMs?: number;
};

export type ModCommandResult = {
  output: string;
  success: boolean;
  startedTurn: boolean;
  turnFinished: boolean;
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/** How long to give a reply the command submitted to actually appear. */
export const DEFAULT_TURN_START_WINDOW_MS = 12_000;
/** How long to follow that reply before saying plainly that it stopped. */
export const DEFAULT_TURN_FOLLOW_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 4_000;

type LoopState = { idle: boolean; awaitingApproval: boolean };

type Frame = {
  type?: unknown;
  request_id?: unknown;
  success?: unknown;
  output?: unknown;
  error?: unknown;
  runtime?: { agent_id?: unknown; conversation_id?: unknown };
  agent_id?: unknown;
  conversation_id?: unknown;
  loop_status?: { status?: unknown; active_run_ids?: unknown; executing_tool_call_ids?: unknown };
  queue?: unknown;
  request?: {
    subtype?: unknown;
    tool_name?: unknown;
    input?: unknown;
    tool_call_id?: unknown;
    permission_suggestions?: unknown;
  };
  delta?: {
    message_type?: unknown;
    command_id?: unknown;
    input?: unknown;
    output?: unknown;
    success?: unknown;
  };
};

/**
 * Whether a frame is about this chat.
 *
 * `control_request` is declared with the scope either in `runtime` or, for
 * older senders, as top-level `agent_id` / `conversation_id`
 * (protocol_v2.d.ts:111). Both are accepted; a frame carrying neither is
 * **not** — treating an unscoped approval as ours would show another chat's
 * tool call, or answer one.
 */
function inScope(frame: Frame, scope: CommandScope): boolean {
  const agentId = frame.runtime?.agent_id ?? frame.agent_id;
  const conversationId = frame.runtime?.conversation_id ?? frame.conversation_id;
  if (typeof agentId !== "string" || typeof conversationId !== "string") return false;
  return agentId === scope.agent_id && conversationId === scope.conversation_id;
}

function readLoopState(frame: Frame): LoopState | null {
  const loop = frame.loop_status;
  if (!loop || typeof loop.status !== "string") return null;
  const runs = Array.isArray(loop.active_run_ids) ? loop.active_run_ids.length : 0;
  const tools = Array.isArray(loop.executing_tool_call_ids) ? loop.executing_tool_call_ids.length : 0;
  return {
    // WAITING_ON_APPROVAL is a turn waiting for the person: busy, not idle.
    idle: loop.status === "WAITING_ON_INPUT" && runs === 0 && tools === 0,
    awaitingApproval: loop.status === "WAITING_ON_APPROVAL",
  };
}

function readApproval(frame: Frame): ApprovalRequest | null {
  const request = frame.request;
  if (!request || request.subtype !== "can_use_tool") return null;
  if (typeof frame.request_id !== "string" || !frame.request_id) return null;
  if (typeof request.tool_name !== "string") return null;
  const suggestions = Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions.flatMap((item) => {
        const entry = item as { id?: unknown; text?: unknown } | null;
        return entry && typeof entry.id === "string" && typeof entry.text === "string"
          ? [{ id: entry.id, text: entry.text }]
          : [];
      })
    : [];
  return {
    requestId: frame.request_id,
    toolCallId: typeof request.tool_call_id === "string" ? request.tool_call_id : null,
    toolName: request.tool_name,
    input: (request.input ?? {}) as Record<string, unknown>,
    suggestions,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runModCommand(
  client: ObserverClient,
  params: RunModCommandParams,
  hooks: ObserverHooks,
): Promise<ModCommandResult> {
  const { scope, commandId, signal } = params;
  const args = params.args.trim();
  const input = commandInputLine(commandId, args);
  const requestType = params.recompile ? "conversation_recompile" : "execute_command";
  const requestId = client.nextRequestId(requestType);
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;

  let loop: LoopState | null = null as LoopState | null;
  let queueEmpty: boolean | null = null as boolean | null;
  let sawTurnFinished = false;
  let sawTurnStarted = false;
  let dropped = false;
  const approvals = new Map<string, ApprovalRequest>();
  /**
   * Approvals this run has already answered. The runtime replays pending
   * approvals on a sync, and a replay that arrives after the answer went out
   * must not put the same tool call in front of the person a second time. It is
   * bounded, like the agent SDK's own decision cache, so a long reply with many
   * approvals cannot grow it without limit.
   */
  const answered = new Set<string>();
  const ANSWERED_KEPT = 64;
  let settleCommand: ((value: { output: string; success: boolean; announcedPrompt: boolean }) => void) | null = null;
  let failCommand: ((error: Error) => void) | null = null;

  const commandOutcome = new Promise<{ output: string; success: boolean; announcedPrompt: boolean }>((resolve, reject) => {
    settleCommand = resolve;
    failCommand = reject;
  });

  /** Answers go out on the client this run started on, and no other. */
  const answer = (id: string, decision: ApprovalDecision) => {
    const request = approvals.get(id);
    if (!request) throw new Error("That approval isn't one this command is waiting on.");
    if (dropped || signal.aborted) {
      throw new Error("The connection to the runtime went away, so that answer wasn't sent. Reopen the chat to see where the reply got to.");
    }
    // The request stays pending until the socket has actually taken the answer.
    // Forgetting it first would leave the tool call on screen with no way to
    // answer it again: `respondApproval` routes by what is still pending.
    client.sendRaw({
      type: "input",
      request_id: client.nextRequestId("input"),
      runtime: { agent_id: scope.agent_id, conversation_id: scope.conversation_id },
      payload: {
        kind: "approval_response",
        request_id: id,
        decision: decision.behavior === "allow"
          ? {
              behavior: "allow",
              updated_input: decision.updatedInput ?? null,
              selected_permission_suggestion_ids: decision.suggestionIds ?? [],
            }
          : { behavior: "deny", message: decision.message || "Denied by the user." },
      },
    });
    approvals.delete(id);
    answered.add(id);
    if (answered.size > ANSWERED_KEPT) {
      const oldest = answered.values().next();
      if (!oldest.done) answered.delete(oldest.value);
    }
    hooks.onApprovalResolved(id);
  };

  const stopListening = client.onMessage((message) => {
    const frame = message as Frame | null;
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === `${requestType}_response` && frame.request_id === requestId) {
      settleCommand?.({
        // The compiled prompt is private context, not command feedback.
        output: params.recompile
          ? (frame.success === false ? (typeof frame.error === "string" ? frame.error : "Prompt recompilation failed.") : "Recompiled the current conversation's system prompt. This evicts the prompt cache and may increase costs.")
          : (typeof frame.output === "string" ? frame.output.trim() : ""),
        success: frame.success !== false,
        announcedPrompt: false,
      });
      return;
    }
    if (!inScope(frame, scope)) return;

    switch (frame.type) {
      case "control_request": {
        const request = readApproval(frame);
        // One entry per request id, and never one this run has already
        // answered: the runtime replays pending approvals on a sync, and the
        // same tool call must not be put in front of the person twice.
        if (!request || approvals.has(request.requestId) || answered.has(request.requestId)) return;
        approvals.set(request.requestId, request);
        hooks.onApprovalRequested(request);
        return;
      }
      case "update_loop_status": {
        const next = readLoopState(frame);
        if (next) {
          loop = next;
          if (!next.idle) sawTurnStarted = true;
        }
        return;
      }
      case "update_queue": {
        if (Array.isArray(frame.queue)) queueEmpty = frame.queue.length === 0;
        return;
      }
      case "turn_finished": {
        sawTurnFinished = true;
        return;
      }
      case "stream_delta": {
        const delta = frame.delta;
        if (params.recompile || !delta || delta.message_type !== "slash_command_end" || delta.command_id !== commandId) return;
        // No request id on this frame; scope and the echoed command line are
        // the whole of the available identity.
        if (delta.input !== input) return;
        const output = typeof delta.output === "string" ? delta.output.trim() : "";
        settleCommand?.({
          output,
          success: delta.success !== false,
          announcedPrompt: delta.success !== false && announcesPrompt(commandId, output),
        });
        return;
      }
      default:
        return;
    }
  });
  const stopWatching = client.onDisconnect(() => {
    dropped = true;
    failCommand?.(new CommandUncertain("disconnect", `The connection to the runtime went away while /${commandId} was running. It may still have run.`));
  });
  const onAbort = () => {
    dropped = true;
    failCommand?.(new CommandUncertain("disconnect", `Hearthside reconnected while /${commandId} was running. It may still have run.`));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const abandonApprovals = () => {
    for (const id of [...approvals.keys()]) {
      approvals.delete(id);
      hooks.onApprovalResolved(id);
    }
  };
  const close = () => {
    signal.removeEventListener("abort", onAbort);
    stopListening();
    stopWatching();
    abandonApprovals();
    hooks.onFinished();
  };

  hooks.onStart({ answer, pending: () => [...approvals.values()] });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (signal.aborted) throw new Error("The connection changed before the command was sent.");
    params.onDispatch?.(requestId);
    client.sendRaw(params.recompile ? {
      type: "conversation_recompile",
      request_id: requestId,
      conversation_id: scope.conversation_id,
      body: { agent_id: scope.agent_id },
    } : {
      type: "execute_command",
      request_id: requestId,
      command_id: commandId,
      runtime: { agent_id: scope.agent_id, conversation_id: scope.conversation_id },
      ...(args ? { args } : {}),
    });

    const outcome = await Promise.race([
      commandOutcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CommandUncertain("timeout", `/${commandId} didn't finish in time. It may still be running in the runtime.`)),
          params.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!outcome.success) {
      return { output: outcome.output, success: false, startedTurn: false, turnFinished: true };
    }

    // Did a reply start? The push frames usually say so; a last idle check
    // covers a runtime that sent none, and never stands in for one.
    const observedStart = () => sawTurnStarted || sawTurnFinished;
    if (params.startsTurn && approvals.size === 0) {
      const idle = await params.confirmIdle();
      if (signal.aborted || dropped) {
        throw new CommandUncertain("disconnect", `Hearthside reconnected while /${commandId} was running.`);
      }
      if (idle) return { output: outcome.output, success: true, startedTurn: true, turnFinished: true };
    }
    let started = params.startsTurn === true || observedStart();
    if (!started) started = !(await params.confirmIdle());
    if (!started && outcome.announcedPrompt) {
      const until = Date.now() + (params.turnStartWindowMs ?? DEFAULT_TURN_START_WINDOW_MS);
      while (!started && Date.now() < until && !signal.aborted) {
        await sleep(pollMs, signal);
        if (signal.aborted) break;
        started = observedStart() || !(await params.confirmIdle());
      }
    }
    if (signal.aborted) {
      throw new CommandUncertain("disconnect", `Hearthside reconnected while /${commandId} was running.`);
    }
    if (!started) return { output: outcome.output, success: true, startedTurn: false, turnFinished: true };

    hooks.onActivity(`Working on /${commandId}`);
    const until = Date.now() + (params.turnFollowMs ?? DEFAULT_TURN_FOLLOW_MS);
    while (Date.now() < until) {
      await sleep(pollMs, signal);
      // The command itself did finish — its end frame arrived — so this is not
      // an uncertain command. What is unknown is the reply, and a reply that
      // can no longer be watched is never claimed as finished. Stop straight
      // away rather than polling a connection that has gone, and let `close`
      // take any unanswered approval off screen.
      if (signal.aborted || dropped) {
        return { output: outcome.output, success: true, startedTurn: true, turnFinished: false };
      }
      // A turn waiting for the person is not finished, however quiet it looks.
      if (approvals.size > 0 || loop?.awaitingApproval) {
        hooks.onActivity("Waiting for your approval");
        continue;
      }
      const settled = (loop?.idle === true && queueEmpty !== false) || (sawTurnFinished && loop?.idle !== false);
      if (settled && (await params.confirmIdle())) {
        return { output: outcome.output, success: true, startedTurn: true, turnFinished: true };
      }
      hooks.onActivity(`Working on /${commandId}`);
    }
    return { output: outcome.output, success: true, startedTurn: true, turnFinished: false };
  } finally {
    if (timer) clearTimeout(timer);
    close();
  }
}
