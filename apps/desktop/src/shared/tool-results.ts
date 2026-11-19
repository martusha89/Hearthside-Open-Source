import type { ChatRow } from "@hearthside/ipc-contract";

/** A call-only snapshot is not evidence that an observed outcome disappeared.
 * Keep the executed arguments and result together for the exact same call.
 * When the incoming row has a result, its normal authoritative precedence stays.
 */
export function preserveToolResult(incoming: ChatRow, current: ChatRow | undefined): ChatRow {
  if (
    incoming.kind === "tool_call" && current?.kind === "tool_call" &&
    incoming.toolCallId && incoming.toolCallId === current.toolCallId &&
    incoming.toolName === current.toolName && !incoming.result && current.result
  ) return current;
  return incoming;
}
