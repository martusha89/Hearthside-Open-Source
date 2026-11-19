import type { ChatState } from "../store";

/** Explain the actual gate, without asking for consent already given by Send. */
export function queueStatusLabel(chat: ChatState, connected: boolean): string {
  if (chat.queue.some((item) => item.deliveryUnconfirmed)) return "Delivery unconfirmed — queued messages are held.";
  if (!connected) return "Offline — queued messages are held.";
  if (chat.stopRequested) return "Waiting for Stop to finish.";
  if (chat.queuePaused) {
    switch (chat.queuePauseReason) {
      case "stopped": return "Queue paused after Stop.";
      case "offline": return "Held after disconnection. Resume when ready.";
      case "detached": return "Held after losing track of the turn.";
      case "device-change": return "Held after changing execution device.";
      case "error": return "Queue held after an error or unfinished command.";
      case "failed-send": return "Not submitted. Ready to retry.";
      // Specific on purpose: this message was never sent, and the one thing it
      // needs is a destination. "Ready to retry" would send them round the loop
      // that held it in the first place.
      case "destination-required": return "Not submitted: this chat needs a destination. Choose where it runs.";
      case "delivery": return "Queue held after a delivery check.";
      default: return "Queue paused. Resume when ready.";
    }
  }
  if (chat.execution?.pendingDelivery) return "Waiting for delivery confirmation.";
  if (chat.executionSaving) return "Waiting for the destination change.";
  if (chat.execution?.requiresDestination) return "Choose where to run before this can send.";
  if (chat.execution?.status === "blocked") return "Waiting for execution to become available.";
  return "Sends when the agent finishes";
}
