import { BackupSourceError, backupSourceFailure } from "./diagnostics";



export async function captureArchivalPassages(
  list: (query: { after?: string; limit: number; ascending: boolean }) => PromiseLike<unknown>,
): Promise<Buffer> {
  const passages: Record<string, unknown>[] = [], ids = new Set<string>();
  let after: string | undefined, bytes = 0;
  for (let page = 0; page < 1_000; page++) {
    const context = { operation: "passages.list" as const, page: page + 1, count: passages.length, limit: 100 };
    let rows: unknown;
    try { rows = await list({ after, limit: 100, ascending: true }); }
    catch (error) { throw backupSourceFailure(error, context); }
    if (!Array.isArray(rows)) throw new BackupSourceError(context, "invalid_response");
    if (!rows.length) return Buffer.from(JSON.stringify({ version: 1, passages }));
    const observation = { ...context, returned: rows.length };

    const fresh = after !== undefined && (rows[0] as { id?: unknown } | null)?.id === after ? rows.slice(1) : rows;
    if (!fresh.length) return Buffer.from(JSON.stringify({ version: 1, passages }));
    for (const row of fresh) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) throw new BackupSourceError(observation, "cursor_missing");
      // A record returning twice means the cursor isn't moving: that is incomplete
      // history, never a shorter archive reported as complete.
      if (ids.has(row.id)) throw new BackupSourceError(observation, "cursor_repeated");
      if (typeof row.text !== "string") throw new BackupSourceError(observation, "invalid_response");
      // Preserve content/provenance, not provider configuration or credentials.
      // Embeddings are not silently re-created (that can incur provider charges).
      const value = Object.fromEntries(["id", "text", "tags", "created_at", "archive_id", "file_id", "file_name", "metadata"].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > 64 * 1024 * 1024 || passages.length >= 100_000) throw new BackupSourceError(observation, "capture_limit");
      ids.add(row.id); passages.push(value); after = row.id;
    }
  }
  throw new BackupSourceError({ operation: "passages.list", page: 1_000, count: passages.length, limit: 100 }, "page_limit");
}
