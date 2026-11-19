import type { ChatRow, ChatToolRow } from "../types";
import { channelName } from "./tools";

/** A tool outcome, not a read/delivery receipt. Never infer one from assistant prose. */
export function channelOutcome(row: ChatToolRow, pending: boolean): string {
  if (row.result?.isError === true) return "Channel attempt failed";
  if (row.result?.isError === false) return "Accepted by channel";
  return pending && row.status !== "complete" ? "Sending…" : "Delivery unconfirmed";
}

/** Requested identifiers are arguments, never evidence that a destination received anything. */
export function channelTarget(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const problems: string[] = [];
  const raw = input.channel;
  if (typeof raw === "string" && raw.trim()) {
    parts.push(`Platform: ${channelName(raw)}`, `Channel: ${raw}`);
  } else {
    problems.push(raw === undefined || raw === "" ? "missing channel" : "invalid channel");
  }
  for (const [key, label] of [["account_id", "Account"], ["accountId", "Account (accountId)"], ["chat_id", "Chat"], ["target", "Target"], ["thread_id", "Thread"], ["threadId", "Thread (threadId)"]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value))) {
      parts.push(`${label}: ${value}`);
    } else {
      problems.push(`invalid ${key}`);
    }
  }
  const action = input.action;
  // Supported actions depend on the registered channel adapter, not this UI.
  if (action !== undefined && typeof action !== "string") {
    problems.push("invalid action");
  }
  return [problems.length ? `Destination unconfirmed · ${problems.join(", ")}` : "Requested destination", ...parts].join(" · ");
}

export function channelOperation(input: Record<string, unknown>): string {
  const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  if (action === "react") return input.remove === true ? "Reaction removal attempt" : "Reaction attempt";
  if (action === "upload-file" || action === "upload_file") return "File upload attempt";
  return ["", "send", "reply", "message"].includes(action) ? "Message attempt" : "Channel attempt";
}

export function isChannelAttempt(row: ChatToolRow): boolean {
  return row.toolName === "MessageChannel" || row.toolName === "message_channel";
}

/** Reconciliation may revoke live membership, but must never grant it. */
export function pendingChannelCallIds(rows: readonly ChatRow[], observed: ReadonlySet<string>): string[] {
  return rows.flatMap((row) => row.kind === "tool_call" && isChannelAttempt(row) &&
    observed.has(row.toolCallId) && !row.result && row.status !== "complete" ? [row.toolCallId] : []);
}
