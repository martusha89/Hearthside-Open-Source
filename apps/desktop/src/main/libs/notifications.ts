import { Notification } from "electron";
import type { AppEvent } from "@hearthside/ipc-contract";

/**
 * Hearthside: desktop notifications when the window isn't in front: a reply
 * arrived, or the agent is waiting for an approval or an answer. Clicking one
 * brings the window back on that chat.
 */

type Context = {
  enabled: () => boolean;
  /** True while the person is looking at the app. */
  focused: () => boolean;
  /** The agent's name for a conversation, if known. */
  agentName: (conversationId: string) => string | null;
  /** The text of the latest reply in a conversation, if any. */
  lastReply: (conversationId: string) => string | null;
  /** The agent's picture as a file, when one is set ("make it yours"). */
  icon?: (conversationId: string) => string | null;
  open: (conversationId: string) => void;
};

let context: Context | null = null;
/** Keep shown notifications referenced, or their click handlers can be lost. */
const shown = new Set<Notification>();

export function initNotifications(next: Context): void {
  context = next;
}

function plain(text: string): string {
  return text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

function show(conversationId: string, title: string, body: string): void {
  if (!context || !Notification.isSupported()) return;
  const icon = context.icon?.(conversationId) ?? undefined;
  const notification = new Notification({ title, body: body.length > 140 ? `${body.slice(0, 140)}…` : body, silent: false, ...(icon ? { icon } : {}) });
  shown.add(notification);
  notification.on("click", () => {
    context?.open(conversationId);
    shown.delete(notification);
  });
  notification.on("close", () => shown.delete(notification));
  notification.show();
}

export function notifyFor(event: AppEvent): void {
  if (!context || !context.enabled() || context.focused()) return;
  if (event.type === "turn.finished" && !event.error) {
    const name = context.agentName(event.conversationId) ?? "Your agent";
    const reply = context.lastReply(event.conversationId);
    show(event.conversationId, `${name} replied`, reply ? plain(reply) : "Open Hearthside to read it.");
  } else if (event.type === "approval.requested") {
    const name = context.agentName(event.conversationId) ?? "Your agent";
    const question = event.request.toolName === "AskUserQuestion";
    show(event.conversationId, question ? `${name} has a question for you` : `${name} needs your approval`, "Open Hearthside to answer.");
  }
}
