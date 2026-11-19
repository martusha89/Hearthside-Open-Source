import type { SendMessage } from "@letta-ai/letta-agent-sdk";

export type CloudConversationTransport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;
type Access = { token: string | (() => string); baseUrl: string };
type Scope = { agentId: string; conversationId: string; clientMessageId: string };
type RequestOptions = { access?: Access; signal?: AbortSignal };
export type CloudConversationReceipt = Scope & { superRunId: string; workflowId: string };
export type DeliveryDiagnostic = { stage: "super-run" | "child-run" | "reply"; reason: "unavailable" | "invalid-evidence" | "not-terminal" | "approval-required" };
class DeliveryObservationError extends Error {
  constructor(readonly diagnostic: DeliveryDiagnostic) { super(`Delivery observation ${diagnostic.stage}: ${diagnostic.reason}`); }
}
export type CloudConversationDelivery = {
  diagnostic?: DeliveryDiagnostic;
  state: "pending" | "completed" | "failed" | "unknown";
  error?: string;
  runIds?: string[];
  text?: string | null;
};

export class CloudConversationAcceptanceUnknownError extends Error {
  readonly clientMessageId: string;
  constructor(clientMessageId: string, cause: unknown) {
    super("Cloud acceptance is unknown; inspect this delivery before resending.", { cause });
    this.name = "CloudConversationAcceptanceUnknownError";
    this.clientMessageId = clientMessageId;
  }
}
/**
 * The input plainly did not go: it was refused before any request was made, or
 * Letta answered with a refusal of the request itself (bad request, not signed
 * in, not allowed, not found, too large). Nothing is running anywhere, so it
 * must not be held as "maybe accepted" — that hold has no way to end.
 *
 * Deliberately narrow. A timeout, a dropped connection, a server error, a
 * conflict or a malformed answer can all follow a successful admission and stay
 * unknown.
 */
export class CloudConversationRefusedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CloudConversationRefusedError";
  }
}
class CloudHttpError extends Error {
  constructor(readonly status: number) { super(`Cloud request returned HTTP ${status}`); }
}
const REFUSED_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422]);
export class CloudConversationCorrelationError extends Error {
  constructor(message: string) { super(message); this.name = "CloudConversationCorrelationError"; }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  // Native client IDs include cm-submit-* and arbitrary caller-provided IDs, not just UUIDs.
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function validateScope(scope: Scope) {
  if (!id(scope.agentId) || !/^agent-[a-zA-Z0-9-]+$/.test(scope.agentId)
    || !id(scope.conversationId) || !(scope.conversationId === "default" || /^conv-[a-zA-Z0-9-]+$/.test(scope.conversationId))
    || !id(scope.clientMessageId)) throw new Error("Invalid Cloud delivery identity");
}
function assertScope(raw: Record<string, unknown>, scope: Scope) {
  if ((raw.agent_id !== undefined && raw.agent_id !== scope.agentId)
    || (raw.conversation_id !== undefined && raw.conversation_id !== scope.conversationId)
    || (raw.client_message_id !== undefined && raw.client_message_id !== scope.clientMessageId)) {
    throw new CloudConversationCorrelationError("Cloud delivery identity mismatch");
  }
}
function transportFor(options: RequestOptions, injected?: CloudConversationTransport): CloudConversationTransport {
  if (injected) return injected;
  const access = options.access;
  if (!access) throw new Error("Cloud access is required");
  const base = new URL(access.baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Invalid Cloud API URL");
  return async (method, path, body) => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    const deadline = setTimeout(() => controller.abort(new Error("Cloud request timed out after 15 seconds")), 15_000);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    try {
      controller.signal.throwIfAborted();
      const token = typeof access.token === "function" ? access.token() : access.token;
      const response = await fetch(`${access.baseUrl.replace(/\/$/, "")}${path}`, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new CloudHttpError(response.status);
      // Keep the deadline active through response-body consumption, not just headers.
      return await response.json();
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

/** Validate before recording pending delivery: malformed content was never submitted. */
export function currentDestinationContent(value: SendMessage | undefined) {
  const content = typeof value === "string" ? [{ type: "text" as const, text: value }] : value;
  if (!Array.isArray(content) || content.length === 0 || !content.every((part) => {
    if (!record(part)) return false;
    if (part.type === "text") return typeof part.text === "string";
    return part.type === "image" && record(part.source) && part.source.type === "base64"
      && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.source.media_type as string)
      && typeof part.source.data === "string" && part.source.data.trim().length > 0;
  }) || !content.some((part) => part.type === "image" || part.text.trim().length > 0)) {
    throw new Error("Cloud input must contain supported text or image content; nothing was sent");
  }
  return content;
}

/** Native CLI conversation-enqueue.ts: no computer selector, runtime_start, sync, or retry. */
export async function enqueueCurrentDestination(
  input: RequestOptions & { agentId: string; conversationId: string; text?: string; content?: SendMessage; clientMessageId?: string; otid?: string },
  injected?: CloudConversationTransport,
): Promise<CloudConversationReceipt> {
  const clientMessageId = input.clientMessageId ?? input.otid ?? "";
  const scope = { agentId: input.agentId, conversationId: input.conversationId, clientMessageId };
  let content: ReturnType<typeof currentDestinationContent>;
  let transport: CloudConversationTransport;
  try {
    validateScope(scope);
    if (input.otid !== undefined && input.clientMessageId !== undefined && input.otid !== input.clientMessageId) throw new Error("Conflicting client message IDs");
    if (input.content !== undefined && input.text !== undefined) throw new Error("Supply content or text, not both");
    // SDK 0.8.52 cloud-management.enqueueConversationMessage forwards SendMessage
    // unchanged: text and inline base64 images need no sandbox upload or owner move.
    content = currentDestinationContent(input.content ?? input.text);
    transport = transportFor(input, injected);
  } catch (error) {
    // Everything above runs before a request exists.
    throw new CloudConversationRefusedError(error instanceof Error ? error.message : String(error), error);
  }
  // Native default routing is agent-scoped via agent_id in the POST body, not a newly created conversation.
  const body = {
    agent_id: scope.agentId, client_message_id: clientMessageId,
    messages: [{ role: "user", content, client_message_id: clientMessageId }],
  };
  try {
    const raw = await transport("POST", `/v1/conversations/${encodeURIComponent(scope.conversationId)}/messages/enqueue`, body);
    if (!record(raw) || raw.client_message_id !== clientMessageId || !id(raw.workflow_id) || !id(raw.super_run_id)) throw new Error("Invalid enqueue receipt");
    assertScope(raw, scope);
    return { ...scope, workflowId: raw.workflow_id, superRunId: raw.super_run_id };
  } catch (error) {
    if (error instanceof CloudHttpError && REFUSED_STATUSES.has(error.status)) {
      throw new CloudConversationRefusedError(`Letta refused this message (HTTP ${error.status}). Nothing was sent.`, error);
    }
    // Anything else, a malformed response included, may follow successful admission. Preserve the ID.
    throw new CloudConversationAcceptanceUnknownError(clientMessageId, error);
  }
}

/** Exact Super Run -> child run correlation follows native headless-super-run-wait.ts. */
export async function readCurrentDestinationDelivery(
  input: Scope & { superRunId: string } & RequestOptions,
  injected?: CloudConversationTransport,
): Promise<CloudConversationDelivery> {
  validateScope(input);
  if (!id(input.superRunId)) throw new Error("Invalid Super Run ID");
  const transport = transportFor(input, injected);
  let stage: DeliveryDiagnostic["stage"] = "super-run";
  try {
    const raw = await transport("GET", `/v1/agents/${encodeURIComponent(input.agentId)}/super-runs/${encodeURIComponent(input.superRunId)}`);
    if (!record(raw) || raw.id !== input.superRunId) throw new CloudConversationCorrelationError("Exact Super Run mismatch");
    assertScope(raw, input);
    if (typeof raw.status !== "string" || !raw.status) throw new CloudConversationCorrelationError("Missing Super Run status");
    for (const key of ["completed_at", "cancelled_at", "errored_at"] as const) {
      const value = raw[key];
      if (value !== null && value !== undefined && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
        throw new CloudConversationCorrelationError("Invalid Super Run terminal timestamp");
      }
    }
    if (raw.errored_at || raw.cancelled_at || raw.status === "CAN") {
      return { state: "failed", error: raw.cancelled_at || raw.status === "CAN" ? "Cloud delivery cancelled" : "Cloud delivery failed" };
    }
    if (raw.status !== "COM" && !raw.completed_at) return { state: "pending", diagnostic: { stage: "super-run", reason: "not-terminal" } };
    if (!Array.isArray(raw.run_ids) || !raw.run_ids.length || !raw.run_ids.every(id)) throw new CloudConversationCorrelationError("Completed Super Run has no correlated child runs");
    const runIds = raw.run_ids as string[];
    const runId = runIds[0]!; // Native schema: child runs, newest first; never conversation's newest message.
    stage = "child-run";
    const run = await transport("GET", `/v1/runs/${encodeURIComponent(runId)}`);
    if (!record(run) || run.id !== runId) throw new CloudConversationCorrelationError("Child run mismatch");
    // Verified server shape: default-conversation children may store null while
    // their exact Super Run explicitly names "default". Normalize only this
    // field for scope validation, with positive child-agent evidence.
    const defaultChild = input.conversationId === "default" && raw.conversation_id === "default"
      && run.conversation_id === null && run.agent_id === input.agentId;
    assertScope(defaultChild ? { ...run, conversation_id: "default" } : run, input);
    if (typeof run.status !== "string" || !["created", "running", "completed", "failed", "pending", "cancelled", "expired"].includes(run.status)) {
      throw new CloudConversationCorrelationError("Unknown child run status");
    }
    const runtimeStatus = record(raw.runtime_status) ? raw.runtime_status : null;
    const sources = [raw, run, raw.loop_state, runtimeStatus?.loop_state].filter(record);
    for (const source of sources) {
      const mapping = source.client_message_ids_by_run_id;
      if (mapping !== undefined && (!record(mapping) || !Array.isArray(mapping[runId]) || !(mapping[runId] as unknown[]).every(id) || !(mapping[runId] as unknown[]).includes(input.clientMessageId))) {
        throw new CloudConversationCorrelationError("Child run does not include this input");
      }
    }
    // JobStatus from the native client's generated schema; expired is the terminal timeout state.
    if (run.status === "failed" || run.status === "cancelled" || run.status === "expired") return { state: "failed", runIds, error: `Cloud run ${run.status}` };
    if (run.status !== "completed" || run.stop_reason === "requires_approval") return { state: "pending", runIds, diagnostic: { stage: "child-run", reason: run.stop_reason === "requires_approval" ? "approval-required" : "not-terminal" } };
    // Reply display is optional only after every required completion guard above.
    stage = "reply";
    try {
      const messages = await transport("GET", `/v1/runs/${encodeURIComponent(runId)}/messages?limit=100`);
      if (!Array.isArray(messages)) throw new CloudConversationCorrelationError("Invalid run messages response");
      for (const message of messages) {
        if (!record(message)) throw new CloudConversationCorrelationError("Invalid run message");
        assertScope(message, input);
        if (message.run_id !== undefined && message.run_id !== runId) throw new CloudConversationCorrelationError("Run message mismatch");
        if (typeof message.message_type !== "string" || (message.seq_id !== undefined && (typeof message.seq_id !== "number" || !Number.isFinite(message.seq_id)))) throw new CloudConversationCorrelationError("Invalid run message shape");
        if (message.message_type === "assistant_message" && typeof message.content !== "string"
          && !(Array.isArray(message.content) && message.content.every((part) => record(part) && part.type === "text" && typeof part.text === "string"))) {
          throw new CloudConversationCorrelationError("Invalid assistant content");
        }
      }
      const assistant = messages.filter((message) => message.message_type === "assistant_message")
        .sort((a, b) => (typeof b.seq_id === "number" ? b.seq_id : 0) - (typeof a.seq_id === "number" ? a.seq_id : 0))[0];
      const content = assistant?.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((part) => record(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : null;
      return { state: "completed", runIds, text };
    } catch (error) {
      return { state: "completed", runIds, text: null, diagnostic: { stage: "reply", reason: error instanceof CloudConversationCorrelationError ? "invalid-evidence" : "unavailable" } };
    }
  } catch (error) {
    throw new DeliveryObservationError({ stage, reason: error instanceof CloudConversationCorrelationError ? "invalid-evidence" : "unavailable" });
  }
}

/** Read failures cannot prove termination: the caller must retain its held delivery. */
export async function observeEnqueuedTurn(input: Scope & { superRunId: string } & RequestOptions, injected?: CloudConversationTransport): Promise<CloudConversationDelivery> {
  try { return await readCurrentDestinationDelivery(input, injected); }
  catch (error) {
    const diagnostic: DeliveryDiagnostic = error instanceof DeliveryObservationError ? error.diagnostic : { stage: "super-run", reason: "invalid-evidence" };
    return { state: "unknown", diagnostic, error: `Delivery observation ${diagnostic.stage}: ${diagnostic.reason}` };
  }
}
