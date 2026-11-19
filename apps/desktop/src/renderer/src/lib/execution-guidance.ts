import type { ConversationExecutionState } from "@hearthside/ipc-contract";

/** A blocked next send does not mean the previously submitted input was unsent. */
export function executionHoldNotice(execution: ConversationExecutionState | undefined): string | null {
  if (execution?.status !== "blocked") return null;
  if (execution.pendingDelivery?.superRunId) {
    return "Your message was accepted at its current destination. Hearthside is still confirming completion; a response may appear before that check finishes. Do not resend it. New messages will wait. Use the current destination for approvals or Stop.";
  }
  if (execution.pendingDelivery) {
    return "Delivery of the submitted message is not yet confirmed. Hearthside is checking the existing submission; do not resend it. New messages will wait.";
  }
  return `${execution.detail ?? "Execution ownership is unresolved."} New messages will wait; this window cannot follow, stop, or approve the native turn elsewhere.`;
}

/** Display guidance only. This never authorizes a send, move, or local access. */
export function executionDestinationNotice(execution: ConversationExecutionState | undefined, running: boolean): string | null {
  if (!execution?.requiresDestination) return null;
  if (execution.pendingDelivery) return "A submitted input is still being reconciled. Refresh execution status; do not resend it.";
  if (execution.status === "blocked") return "Execution is on hold. Refresh execution status to check recovery; no destination has been changed.";
  if (running) return "A reply is already in progress. Its execution status is being checked; wait for it to finish before changing destination.";
  if (!execution.canMoveExecution && !execution.canFollowCurrentOwner) {
    return "Execution status needs verification. Refresh execution status in the destination menu to check the available choices; nothing has been moved.";
  }
  return "No established execution destination is known. Choose this chat's next destination before sending; opening it does not start a runtime.";
}
