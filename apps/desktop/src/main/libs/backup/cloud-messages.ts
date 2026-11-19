import Letta from "@letta-ai/letta-client";
import { getConnectionConfig } from "../settings";
import { currentLettaAccessToken } from "../letta-signin";
import { BackupSourceError } from "./diagnostics";
import { CLOUD_PAGE_DEADLINE_MS, cloudDeadline } from "./cloud-deadline";
import type { MessagePage } from "./collect";

/** Read the complete API page, not the runtime listener's UI-sized slice.
 * A source message can project to several components sharing its ID. Never
 * trim, deduplicate or synthesize IDs here; `after` is a source-message cursor.
 */
export async function cloudBackupMessages(
  conversationId: string,
  options: { after?: string; before?: string; limit: number; order: "asc" | "desc" },
  agentId?: string,
  /** A caller's own deadline, when it is stricter than the standing page one. */
  deadline?: { signal: AbortSignal },
): Promise<MessagePage> {
  const config = getConnectionConfig();
  if (config.backend !== "cloud") throw new Error("Cloud history capture requires the Cloud connection.");
  const token = await currentLettaAccessToken() || (config.lettaSignedIn ? "" : config.apiKey) /* signed in: never quietly swap to the saved key */;
  if (!token) throw new Error("Cloud credentials are unavailable for history capture.");
  const client = new Letta({ apiKey: token, baseURL: config.apiBaseUrl || "https://api.letta.com", maxRetries: 0, timeout: 30_000 });
  // The deadline covers the body read below too; see cloud-deadline.ts.
  const response = await client.conversations.messages.list(conversationId, {
    ...options,
    ...(agentId ? { agent_id: agentId } : {}),
  }, deadline ?? cloudDeadline(CLOUD_PAGE_DEADLINE_MS)).asResponse();
  // ArrayPage normalizes falsy response bodies to []; inspect the actual JSON
  // so a malformed null/false/0 cannot masquerade as end-of-history.
  const messages: unknown = await response.json();
  if (!Array.isArray(messages)) throw new BackupSourceError({ operation: "messages.list", chat: agentId ? "main" : "named" }, "invalid_response");
  // Neither a short projected page nor the runtime's older-direction has_more
  // proves ascending completion. The collector bounds the walk to an empty page.
  return { messages, hasMore: messages.length > 0, identity: "source-id-components-v1" };
}
