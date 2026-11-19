import WebSocket from "ws";
import { applyStep, settleFromSnapshot, markHelpersUnobserved, helperFeedGeneration } from "./helper-feed";

export type RemoteHelperScope = {
  chatId: string;
  agentId: string;
  conversationId: string;
  connectionId: string;
};

/** Ownership evidence for observation is independent of message admission. */
export function helperOwnership(raw: unknown, scope: { agentId: string; conversationId: string }, previousRevision = -1): { owner: string | null; revision: number } | undefined {
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const invalid = { owner: null, revision: previousRevision };
  if (!record(raw) || raw.agent_id !== scope.agentId || !Array.isArray(raw.statuses)) return invalid;
  const matches = raw.statuses.filter(value => record(value) && value.conversation_id === scope.conversationId);
  if (matches.length !== 1) return invalid;
  const status = matches[0] as Record<string, unknown>;
  const revision = status.revision ?? raw.revision ?? previousRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < ((status.revision ?? raw.revision) === undefined ? -1 : 0)) return invalid;
  if (revision < previousRevision) return undefined;
  const activity = status.last_activity_at;
  const harness = status.active_harness;
  if (status.has_conflicting_listeners || typeof activity !== "number" || !Number.isFinite(activity) || activity < 0 || activity > Date.now() + 5_000 || Date.now() - activity > 120_000 || !record(harness) || typeof harness.connection_id !== "string" || !harness.connection_id.trim()) return { owner: null, revision };
  return { owner: harness.connection_id, revision };
}

/** Passive relay subscription, matching SDK 0.8.52 cloud-session URL routing.
 * Never send sync: runtime 0.34.36 can resume recovered approvals even when its
 * recovery flags are false. Relay replay/live frames are the only evidence here;
 * absence of a frame is not an empty snapshot or proof of completion. */
export function observeRemoteHelpers(options: RemoteHelperScope & {
  baseUrl: string;
  token: string;
  current: () => boolean;
  /** Same account/observer identity, independent of ownership and admission revisions. */
  canRetire?: () => boolean;
  closed?: () => void;
}, Socket: typeof WebSocket = WebSocket): () => void {
  let closed = false;
  const generation = helperFeedGeneration();
  const sockets: WebSocket[] = [];
  const seen = new Set<string>();
  const lastSequences = new Map<string, number>();
  let ping: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearTimeout(deadline);
    for (const socket of sockets) {
      // Keep the error handler until close: ws emits an error if closed while connecting.
      socket.close();
    }
    if (generation === helperFeedGeneration() && (options.canRetire ?? options.current)()) markHelpersUnobserved(options.chatId);
    options.closed?.();
  };
  const send = (socket: WebSocket, frame: Record<string, unknown>) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(frame)); } catch { close(); }
  };
  const active = () => {
    if (closed) return false;
    if (generation !== helperFeedGeneration() || !options.current()) { close(); return false; }
    return true;
  };
  try {
    for (const channel of ["control", "stream"] as const) {
      const url = new URL(options.baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid helper relay URL");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `/v1/environments/${encodeURIComponent(options.connectionId)}/status/ws`;
      url.search = new URLSearchParams({ agentId: options.agentId, conversationId: options.conversationId, channel }).toString();
      const socket = new Socket(url.toString(), { headers: { Authorization: `Bearer ${options.token}` } });
      sockets.push(socket);
      socket.on("error", close);
      socket.on("close", close);
      socket.on("message", (data) => {
        if (!active()) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        if (!frame || typeof frame !== "object") return;
        if (typeof frame.seq === "number") send(socket, { type: "ack", seq: frame.seq });
        if (closed) return;
        const scope = frame.runtime as Record<string, unknown> | undefined;
        if (scope?.agent_id !== options.agentId || scope?.conversation_id !== options.conversationId) return;
        if (frame.type !== "update_subagent_state" && frame.type !== "stream_delta") return;
        // Control duplicates stream deltas; use only the stream channel for steps.
        if (channel === "control" && frame.type === "stream_delta") return;
        if (frame.type === "update_subagent_state" && (!Array.isArray(frame.subagents) || !frame.subagents.every(entry => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.subagent_id === "string" && entry.subagent_id.trim().length > 0))) return;
        const key = typeof frame.idempotency_key === "string" ? frame.idempotency_key : null;
        if (key && seen.has(key)) return;
        if (typeof frame.event_seq === "number") {
          // Snapshot ordering must not discard earlier steps arriving on stream.
          // Copies of snapshots across channels still share their own watermark.
          if (frame.event_seq <= (lastSequences.get(frame.type as string) ?? -1)) return;
          lastSequences.set(frame.type as string, frame.event_seq);
        }
        if (key) {
          seen.add(key);
          if (seen.size > 1000) seen.delete(seen.values().next().value!);
        }
        if (frame.type === "update_subagent_state" && Array.isArray(frame.subagents)) {
          settleFromSnapshot(options.chatId, frame.subagents);
        } else if (typeof frame.subagent_id === "string" && frame.delta && typeof frame.delta === "object") {
          applyStep(options.chatId, frame.subagent_id, frame.delta as Record<string, unknown>);
        }
      });
    }
    ping = setInterval(() => {
      if (!active()) return;
      for (const socket of sockets) send(socket, { type: "ping" });
    }, 10_000);
    ping.unref?.();
    // Bounded even if a caller stops refreshing the chat or a relay falls silent.
    deadline = setTimeout(close, 60 * 60_000);
    deadline.unref?.();
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
