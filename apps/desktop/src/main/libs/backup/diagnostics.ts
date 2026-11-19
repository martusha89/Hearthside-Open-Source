/** Only locally selected labels and bounded numeric observations may cross the backup error boundary. */
export type BackupOperation = "messages.list" | "agent.retrieve" | "conversations.list" | "metadata.recheck" | "artifacts.capture" | "git.capture" | "schedules.list" | "repositories.list" | "repository.read" | "passages.list";
export type BackupFailureCode = "request_failed" | "request_timeout" | "connection_failed" | "invalid_response" | "cursor_missing" | "cursor_repeated" | "cursor_stalled" | "page_limit" | "capture_limit" | "group_split";
type Context = { operation: BackupOperation; chat?: "main" | "named"; page?: number; count?: number; returned?: number; limit?: number };
const codes: readonly BackupFailureCode[] = ["request_failed", "request_timeout", "connection_failed", "invalid_response", "cursor_missing", "cursor_repeated", "cursor_stalled", "page_limit", "capture_limit", "group_split"];
const operations: readonly BackupOperation[] = ["messages.list", "agent.retrieve", "conversations.list", "metadata.recheck", "artifacts.capture", "git.capture", "schedules.list", "repositories.list", "repository.read", "passages.list"];

export class BackupSourceError extends Error {
  readonly context: Context;
  readonly code: BackupFailureCode;
  readonly status?: number;
  constructor(context: Context, code: BackupFailureCode, status?: number) {
    const safe: Context = { operation: operations.includes(context.operation) ? context.operation : "messages.list" };
    if (context.chat === "main" || context.chat === "named") safe.chat = context.chat;
    for (const key of ["page", "count", "returned", "limit"] as const) {
      const value = context[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    }
    const safeCode = codes.includes(code) ? code : "request_failed";
    const safeStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    // What was being read, in this build's own words: "Incomplete messages" is wrong
    // for an archival or repository read, and the omission it ends up in is read by
    // the person whose backup it is.
    const records = safe.operation === "messages.list" ? "messages" : safe.operation === "passages.list" ? "archival records" : "records";
    const label = safeCode.startsWith("cursor_") ? `Incomplete ${records}`
      : safeCode === "page_limit" ? "Backup page limit reached"
      // Our own bound, not the source failing: worth telling apart.
      : safeCode === "capture_limit" ? "Backup capture limit reached"
      : safeCode === "group_split" ? "A message's parts don't fit in one backup page"
      : "Backup source operation failed";
    super(`${label} [${Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(", ")}, code=${safeCode}${safeStatus ? `, status=${safeStatus}` : ""}]. Request details omitted.`);
    this.context = safe;
    this.code = safeCode;
    this.status = safeStatus;
  }
}

export function backupSourceFailure(error: unknown, context: Context): BackupSourceError {
  if (error instanceof BackupSourceError) return new BackupSourceError({ ...error.context, ...context }, error.code, error.status);
  // Do not classify by matching arbitrary message text, or copy upstream codes/messages.
  const value = error && typeof error === "object" ? error as { status?: unknown; code?: unknown; name?: unknown; cause?: unknown } : {};
  // Hearthside: fetch wraps the real reason ("TypeError: fetch failed" with the ECONNRESET in
  // `cause`), and the client wraps that again; look down the chain for a code worth classifying.
  const chain: Array<{ code?: unknown; name?: unknown }> = [];
  for (let at: unknown = value, depth = 0; at && typeof at === "object" && depth < 4; at = (at as { cause?: unknown }).cause, depth++) chain.push(at as { code?: unknown; name?: unknown });
  const has = (test: (link: { code?: unknown; name?: unknown }) => boolean) => chain.some(test);
  const code = has((link) => link.code === "ETIMEDOUT" || link.name === "AbortError" || link.name === "TimeoutError" || link.name === "APIConnectionTimeoutError" || link.code === "UND_ERR_CONNECT_TIMEOUT" || link.code === "UND_ERR_HEADERS_TIMEOUT" || link.code === "UND_ERR_BODY_TIMEOUT") ? "request_timeout"
    : has((link) => link.code === "ECONNRESET" || link.code === "ECONNREFUSED" || link.code === "ENOTFOUND" || link.code === "EAI_AGAIN" || link.code === "EPIPE" || link.code === "UND_ERR_SOCKET" || link.name === "APIConnectionError") ? "connection_failed" : "request_failed";
  const status = typeof value.status === "number" ? value.status : undefined;
  // What kind of thing failed, for the app log: class names and codes only, never a message or a URL.
  const kinds = chain.map((link) => [typeof link.name === "string" ? link.name : "?", typeof link.code === "string" ? link.code : ""].filter(Boolean).join(":")).join(" <- ");
  console.warn(`[backup] ${context.operation} failed: ${code}${status ? ` status ${status}` : ""} (${kinds})`);
  return new BackupSourceError(context, code, status);
}
