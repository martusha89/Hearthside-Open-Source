// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import type { ChatRow, ChatTextRow } from "../types";
import { preserveToolResult } from "../../../shared/tool-results";

/**
 * Identity used to reconcile a row across the live stream, restored history,
 * and the optimistic user row drawn before Letta has seen the message.
 * Keep in sync with `rowIdentity` in src/electron/libs/transcript.ts.
 */
export function rowIdentity(row: ChatRow): string {
  return (row.kind === "user" || row.kind === "assistant" || row.kind === "reasoning") && row.otid
    ? `${row.kind}:otid:${row.otid}`
    : row.key;
}

/** Replace rows that already exist and append the rest, keeping first-seen order. */
export function upsertRows(rows: ChatRow[], incoming: ChatRow[]): ChatRow[] {
  const next = [...rows];
  const index = new Map(next.map((row, position) => [rowIdentity(row), position]));
  for (const row of incoming) {
    const identity = rowIdentity(row);
    const position = index.get(identity);
    if (position === undefined) {
      index.set(identity, next.length);
      // An undated row may be imported history, not a newly written message.
      next.push(row);
    } else {
      const previous = next[position]!;
      // Preserve a known timestamp until the source supplies a replacement.
      next[position] = row.kind !== "tool_call" && row.kind !== "compaction" && !row.date && previous.kind === row.kind && previous.date
        ? { ...row, date: previous.date }
        : preserveToolResult(row, previous);
    }
  }
  return next;
}

/**
 * History rows, plus rows that only exist on screen, each kept on its own side:
 * rows older than the loaded page stay above it, newer rows (the live turn, a
 * message just sent) stay below. Hearthside: a refresh loads only the latest
 * page, so once older rows slipped off it they used to be re-added at the bottom.
 */
/** Whether a loaded page connects to what is on screen (nothing on screen counts as connected). */
export function historyConnects(history: ChatRow[], current: ChatRow[]): boolean {
  if (current.length === 0 || history.length === 0) return true;
  const seen = new Set(history.map(rowIdentity));
  return current.some((row) => seen.has(rowIdentity(row)));
}

export function mergeHistory(history: ChatRow[], current: ChatRow[]): ChatRow[] {
  const seen = new Set(history.map(rowIdentity));
  const first = current.findIndex((row) => seen.has(rowIdentity(row)));
  if (first === -1) {

    return history.length === 0 ? current : [...history, ...current.filter((row) => row.kind === "user" && row.optimistic === true && !seen.has(rowIdentity(row)))];
  }
  let last = current.length - 1;
  while (!seen.has(rowIdentity(current[last]!))) last -= 1;
  const currentById = new Map(current.map((row) => [rowIdentity(row), row]));
  return [
    ...current.slice(0, first),
    ...history.map((row) => preserveToolResult(row, currentById.get(rowIdentity(row)))),
    ...current.slice(last + 1).filter((row) => !seen.has(rowIdentity(row))),
  ];
}

/** The row drawn for a message the moment the user sends it. */
export function optimisticUserRow(text: string, otid: string): ChatTextRow {
  return { kind: "user", key: `user:otid:${otid}`, text, otid, date: new Date().toISOString(), optimistic: true };
}
