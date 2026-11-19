import type { AppServerClient } from "@letta-ai/letta-code/app-server-client";

type Scope = { agent_id: string; conversation_id: string };

/** Observe a fresh replay without submitting input or requesting turn recovery. */
export async function observeRuntimeIdle(
  client: Pick<AppServerClient, "onMessage" | "sync">,
  runtime: Scope,
): Promise<boolean> {
  let loopIdle = false;
  let queueEmpty = false;
  const unsubscribe = client.onMessage((message) => {
    const frame = message as unknown as {
      type: string;
      runtime?: Scope;
      loop_status?: { status?: string; active_run_ids?: unknown[]; executing_tool_call_ids?: unknown[] };
      queue?: unknown[];
    };
    if (frame.runtime?.agent_id !== runtime.agent_id || frame.runtime.conversation_id !== runtime.conversation_id) return;
    if (frame.type === "update_loop_status") {
      const loop = frame.loop_status;
      loopIdle = loop?.status === "WAITING_ON_INPUT"
        && Array.isArray(loop.active_run_ids) && loop.active_run_ids.length === 0
        && Array.isArray(loop.executing_tool_call_ids) && loop.executing_tool_call_ids.length === 0;
    }
    if (frame.type === "update_queue") queueEmpty = Array.isArray(frame.queue) && frame.queue.length === 0;
  });
  try {
    // sync_response is sent after replay. Missing state or failed sync is never evidence of idle.
    const reply = await client.sync({ runtime, recover_approvals: false, resume_interrupted_turn: false }, { timeoutMs: 5_000 });
    return reply.success === true && loopIdle && queueEmpty;
  } catch {
    return false;
  } finally {
    unsubscribe();
  }
}
