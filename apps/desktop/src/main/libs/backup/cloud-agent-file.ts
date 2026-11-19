import { createHash } from "node:crypto";
import { toFile } from "@letta-ai/letta-client";
import { buildCreatedAgentTags } from "@letta-ai/letta-code/agent-presets";
import type { AgentExportFileParams, AgentImportFileParams } from "@letta-ai/letta-client/resources/agents/agents";
import { CLOUD_EXPORT_DEADLINE_MS, cloudDeadline } from "./cloud-deadline";

/** Public schema evidence: letta-ai/letta, tag 0.16.4,
 * letta/schemas/agent_file.py (AgentFileSchema/AgentSchema/MessageSchema).
 * That export takes 50 historical messages plus context, not all conversations.
 * Current Cloud semantics are unproven: never promote this to full-history coverage.
 */
type RecordValue = Record<string, unknown>;
export interface AgentFileClient {
  agents: {
    /** The client returns parsed JSON when Letta answers application/json, and text otherwise. */
    exportFile(id: string, query: AgentExportFileParams, options?: { maxRetries: number; signal?: AbortSignal }): PromiseLike<string | Record<string, unknown>>;
    importFile(body: AgentImportFileParams, options?: { maxRetries: number }): PromiseLike<{ agent_ids: string[] }>;
  };
}
type AF = RecordValue & { agents: [RecordValue] };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => object(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const secret = /^(api_?key|token|access_token|refresh_token|password|secret|secrets|authorization|custom_headers|headers|env|env_vars_json|tool_exec_environment_variables|credentials)$/i;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key, entry]) => [key, redact(entry)]));
}
export function validateAgentFile(bytes: Buffer | string): AF {
  const file: unknown = JSON.parse(bytes.toString());
  if (!object(file) || !Array.isArray(file.agents) || file.agents.length !== 1 || !object(file.agents[0])) throw new Error("Agent file must contain exactly one agent");
  for (const key of ["groups", "blocks", "files", "sources", "tools", "mcp_servers"]) {
    if (!Array.isArray(file[key])) throw new Error(`Unsupported AgentFile schema: ${key}`);
    const ids = new Set<string>();
    for (const item of file[key] as unknown[]) {
      if (!object(item) || typeof item.id !== "string" || ids.has(item.id)) throw new Error(`Invalid or duplicate ${key} ID`);
      ids.add(item.id);
    }
  }
  const agent = file.agents[0];
  if (typeof agent.id !== "string" || !agent.id || !Array.isArray(agent.messages) || !Array.isArray(agent.in_context_message_ids)) throw new Error("Unsupported AgentFile agent schema");
  const ids = new Set<string>();
  for (const message of agent.messages) {
    if (!object(message) || typeof message.id !== "string" || !message.id || ids.has(message.id) || typeof message.role !== "string" || (message.content != null && !Array.isArray(message.content))) throw new Error("Invalid or duplicate message ID/payload");
    ids.add(message.id);
  }
  const context = new Set<string>();
  for (const id of agent.in_context_message_ids) {
    if (typeof id !== "string" || !ids.has(id) || context.has(id)) throw new Error("Dangling or duplicate context message ID");
    context.add(id);
  }
  for (const message of agent.messages as RecordValue[]) {
    if (message.approval_request_id != null && !ids.has(String(message.approval_request_id))) throw new Error("Dangling approval message reference");
  }
  for (const [reference, collection] of [["block_ids", "blocks"], ["tool_ids", "tools"], ["source_ids", "sources"], ["group_ids", "groups"]] as const) {
    const known = new Set((file[collection] as RecordValue[]).map((item) => item.id));
    const references = agent[reference];
    if (references != null && (!Array.isArray(references) || new Set(references).size !== references.length || references.some((id) => !known.has(id)))) throw new Error(`Dangling or duplicate ${reference} reference`);
  }
  return file as AF;
}

// Allow-list rather than deny-list: newly introduced external capabilities cannot
// silently become executable. Historical messages are inert data, never replayed.
const safeAgentFields = new Set(["id", "name", "description", "system", "agent_type", "messages", "in_context_message_ids", "memory_blocks", "block_ids", "llm_config", "embedding_config", "model", "embedding", "context_window_limit", "embedding_chunk_size", "max_tokens", "max_reasoning_tokens", "enable_reasoner", "message_buffer_autoclear", "response_format", "timezone", "max_files_open", "per_file_view_window_char_limit", "compaction_settings"]);
export function sanitizeAgentFile(bytes: Buffer | string) {
  const original = validateAgentFile(bytes);
  const agent = original.agents[0];
  const quarantined: RecordValue = {};
  for (const [key, value] of Object.entries(agent)) if (!safeAgentFields.has(key)) quarantined[`agent.${key}`] = redact(value);
  for (const [key, value] of Object.entries(original)) if (!["agents", "blocks", "created_at"].includes(key)) quarantined[key] = redact(value);
  const cleanAgent = Object.fromEntries(Object.entries(agent).filter(([key]) => safeAgentFields.has(key)).map(([key, value]) => [key, key === "messages" ? value : redact(value)]));
  Object.assign(cleanAgent, { tools: [], tool_ids: [], tool_rules: [], source_ids: [], files_agents: [], group_ids: [], include_base_tools: false, include_multi_agent_tools: false, include_base_tool_rules: false, include_default_source: false, enable_sleeptime: false, initial_message_sequence: [], tags: [] });
  const sanitized = { agents: [cleanAgent], blocks: redact(original.blocks), groups: [], files: [], sources: [], tools: [], mcp_servers: [], metadata: {} };
  return { bytes: Buffer.from(JSON.stringify(sanitized)), quarantined, original };
}

const captureFailures = {
  "not-found": "Export not found (HTTP 404); resource availability and export support are unknown.",
  "unsupported": "Letta Cloud doesn't offer this export (the address isn't served), for any companion. This is expected: chats, memory and settings are backed up separately.",
  "authentication": "Export authentication or authorization failed.",
  "timeout": "Export request timed out.",
  "transport": "Export transport failed.",
  "request-failed": "Export request failed.",
  "malformed-response": "Export returned malformed JSON or an unexpected response type.",
  "schema-validation": "Export failed the supported AgentFile schema validation.",
  "source-identity": "Exported agent identity does not match the requested source.",
} as const;
export class AgentFileCaptureError extends Error {
  readonly status?: number;
  constructor(readonly category: keyof typeof captureFailures, status?: unknown) {
    super(captureFailures[category]);
    this.name = "AgentFileCaptureError";
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) this.status = status;
  }
}
/** Never persist upstream messages, bodies, URLs, headers or nested causes. */
export function agentFileCaptureFailure(error: unknown): string {
  const category = error instanceof AgentFileCaptureError && Object.hasOwn(captureFailures, error.category) ? error.category : "request-failed";
  const status = error instanceof AgentFileCaptureError ? error.status : undefined;
  const http = category !== "not-found" && category !== "unsupported" && typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : "";
  return `Raw Cloud context export unavailable [${category}]${http}: ${captureFailures[category]} No history was replayed.`;
}
function captureRequestError(error: unknown): AgentFileCaptureError {
  const info = object(error) ? error : {};
  const failure = (category: keyof typeof captureFailures) => new AgentFileCaptureError(category, info.status);

  if (info.status === 404 && /Cannot GET \/v1\/agents\/[^/\s]+\/export/.test(`${String(info.message ?? "")} ${typeof info.error === "string" ? info.error : ""}`)) return failure("unsupported");
  if (info.status === 404) return failure("not-found");
  if (info.status === 401 || info.status === 403) return failure("authentication");
  if (info.status === 408 || info.status === 504 || info.name === "APIConnectionTimeoutError" || info.name === "TimeoutError" || info.code === "ETIMEDOUT") return failure("timeout");
  if (info.name === "APIConnectionError" || ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(info.code))) return failure("transport");
  if (error instanceof SyntaxError) return failure("malformed-response");
  return failure("request-failed");
}
export async function captureAgentFile(client: AgentFileClient, sourceAgentId: string, conversationId?: string) {
  let received: unknown;
  try {
    // Bounded through the whole download: an export that stalls must not hang the backup (cloud-deadline.ts).
    received = await client.agents.exportFile(sourceAgentId, { conversation_id: conversationId, scrub_messages: false, use_legacy_format: false }, { maxRetries: 0, ...cloudDeadline(CLOUD_EXPORT_DEADLINE_MS) });
  } catch (error) { throw captureRequestError(error); }

  const raw = typeof received === "string" ? received : received !== null && typeof received === "object" && !Array.isArray(received) ? JSON.stringify(received) : null;
  if (raw === null) throw new AgentFileCaptureError("malformed-response");
  let sanitized: ReturnType<typeof sanitizeAgentFile>;
  try { sanitized = sanitizeAgentFile(raw); }
  catch (error) { throw new AgentFileCaptureError(error instanceof SyntaxError ? "malformed-response" : "schema-validation"); }
  if (sanitized.original.agents[0].id !== sourceAgentId) throw new AgentFileCaptureError("source-identity");
  return { bytes: sanitized.bytes, manifest: { sourceAgentId, conversationId: conversationId ?? null, sha256: hash(sanitized.bytes), originalSha256: hash(raw), contextMessageCount: (sanitized.original.agents[0].in_context_message_ids as string[]).length, exportedMessageCount: (sanitized.original.agents[0].messages as unknown[]).length, historyCoverage: "unproven" as const, contextCoverage: "exported-ids-resolve" as const, otherConversations: "archived-only" as const, quarantined: sanitized.quarantined } };
}

export class AgentFileImportError extends Error {
  readonly retrySafe = false;
  constructor(message: string, readonly allocation: "unknown" | "allocated", readonly agentIds: string[] = []) { super(message); this.name = "AgentFileImportError"; }
}
function payload(message: RecordValue) {
  // Only server-remapped identity fields are ignored. Content, compaction messages,
  // tool calls/returns, timestamps and all remaining raw fields must be identical.
  const { id: _id, agent_id: _agentId, approval_request_id: _approval, ...rest } = message;
  return canonical(rest);
}
export function verifyAgentFileContext(before: AF, after: AF): Record<string, string> {
  const source = before.agents[0], target = after.agents[0];
  for (const field of ["system", "compaction_settings", "message_buffer_autoclear"]) {
    if (canonical(source[field] ?? null) !== canonical(target[field] ?? null)) throw new Error(`Context configuration changed: ${field}`);
  }
  const memoryPayload = (file: AF) => (file.blocks as RecordValue[]).map(({ id: _id, ...block }) => canonical(block)).sort();
  if (canonical(memoryPayload(before)) !== canonical(memoryPayload(after))) throw new Error("Core memory payload changed");
  const oldMessages = source.messages as RecordValue[], newMessages = target.messages as RecordValue[];
  if (oldMessages.length !== newMessages.length) throw new Error("Exported message coverage changed");
  const mapping: Record<string, string> = {};
  const available = new Map<string, RecordValue[]>();
  for (const message of newMessages) { const key = payload(message); available.set(key, [...(available.get(key) ?? []), message]); }
  for (const message of oldMessages) {
    const candidates = available.get(payload(message));
    if (!candidates || candidates.length !== 1) throw new Error("Message payload changed or identity mapping is ambiguous");
    mapping[String(message.id)] = String(candidates[0]!.id); available.delete(payload(message));
  }
  for (const message of oldMessages) {
    const restored = newMessages.find((candidate) => candidate.id === mapping[String(message.id)])!;
    if ((message.approval_request_id == null ? null : mapping[String(message.approval_request_id)]) !== (restored.approval_request_id ?? null)) throw new Error("Approval message reference changed");
  }
  const expected = (source.in_context_message_ids as string[]).map((id) => mapping[id]);
  if (canonical(expected) !== canonical(target.in_context_message_ids)) throw new Error("Selected context order changed");
  return mapping;
}

export async function importAgentFile(client: AgentFileClient, bytes: Buffer, options: { sourceAgentId: string; operationId: string; name?: string }) {
  if (!options.sourceAgentId || !options.operationId) throw new Error("Source agent and operation ID required");
  const sanitized = sanitizeAgentFile(bytes);
  const file = validateAgentFile(sanitized.bytes);
  // Use the runtime's real creation policy: MemFS is a Git-memory tag, not
  // an invented AgentFile boolean. Never carry source automation tags across.
  file.agents[0].tags = buildCreatedAgentTags({ enableMemfs: true, tags: [`hearthside-restore:${options.operationId}`, "hearthside-recovery-inactive"] });
  const upload = await toFile(Buffer.from(JSON.stringify(file)), "recovery.af", { type: "application/json" });
  let ids: string[];
  try {
    const result = await client.agents.importFile({ file: upload, name: options.name, strip_messages: false, override_existing_tools: false }, { maxRetries: 0 });
    ids = result.agent_ids;
  } catch { throw new AgentFileImportError("Agent file import outcome unknown; do not retry automatically", "unknown"); }
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !/^agent-[A-Za-z0-9_-]+$/.test(ids[0]) || ids[0] === options.sourceAgentId || ids[0] === sanitized.original.agents[0].id) throw new AgentFileImportError("Import did not identify exactly one new agent; reconciliation required", "unknown", Array.isArray(ids) ? ids : []);
  try {
    const exported = await client.agents.exportFile(ids[0], { scrub_messages: false, use_legacy_format: false }, { maxRetries: 0, ...cloudDeadline(CLOUD_EXPORT_DEADLINE_MS) });
    const readback = validateAgentFile(typeof exported === "string" ? exported : JSON.stringify(exported));
    for (const key of ["tools", "groups", "mcp_servers", "sources"]) if ((readback[key] as unknown[]).length) throw new Error("Unexpected capability attached on import");
    const restored = readback.agents[0];
    for (const key of ["tools", "tool_ids", "tool_rules", "group_ids", "source_ids"]) if (Array.isArray(restored[key]) && restored[key].length) throw new Error("Unexpected agent capability on import");
    if (restored.enable_sleeptime === true) throw new Error("Automatic capability enabled on import");
    const messageIdMap = verifyAgentFileContext(file, readback);
    return { agentId: ids[0], messageIdMap, agentIdMap: { [options.sourceAgentId]: ids[0] }, selectedActiveContextRestored: true as const, historyCoverage: "unproven" as const, otherConversations: "archived-only" as const, quarantined: sanitized.quarantined };
  } catch { throw new AgentFileImportError("New agent allocated but readback verification failed; leave inactive and reconcile, do not retry", "allocated", ids); }
}
