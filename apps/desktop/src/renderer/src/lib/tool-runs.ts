import type { ChatRow, ChatToolRow } from "../types";
import { describeTool } from "./tools";
import { channelReply } from "./tools";




export const FOLD_FROM = 4;

const NEVER_FOLD = new Set(["generate_image", "send_gif", "ViewImage", "view_image", "set_my_picture", "AskUserQuestion", "AskUserQuestionAsync", "ask_user_question", "voice_message"]);

export function foldable(row: ChatRow): row is ChatToolRow {
  if (row.kind !== "tool_call") return false;
  if (NEVER_FOLD.has(row.toolName) || /voice|speech|tts|elevenlabs/i.test(row.toolName)) return false;
  // Hearthside: a reply sent to Telegram/Discord is a message, never folded into a run of tools.
  if (channelReply(row.toolName, row.toolInput)) return false;
  return true;
}

export type Segment = { kind: "row"; row: ChatRow; index: number } | { kind: "run"; rows: ChatRow[]; tools: ChatToolRow[]; start: number; end: number };

/** Split rows into single rows and folded runs of FOLD_FROM or more tool calls (thoughts in between ride along). */
export function segmentRows(rows: readonly ChatRow[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!foldable(rows[i]!)) {
      out.push({ kind: "row", row: rows[i]!, index: i });
      i += 1;
      continue;
    }
    // Extend over tool calls and the thoughts between them; a run ends on a tool call.
    let j = i;
    let lastTool = i;
    while (j < rows.length && (foldable(rows[j]!) || rows[j]!.kind === "reasoning")) {
      if (foldable(rows[j]!)) lastTool = j;
      j += 1;
    }
    const slice = rows.slice(i, lastTool + 1);
    const tools = slice.filter(foldable);
    if (tools.length >= FOLD_FROM) {
      out.push({ kind: "run", rows: slice, tools, start: i, end: lastTool });
      i = lastTool + 1;
    } else {
      out.push({ kind: "row", row: rows[i]!, index: i });
      i += 1;
    }
  }
  return out;
}

const PLURAL: Record<string, (n: number) => string> = {
  "Read a file": (n) => `read ${n} files`,
  "Ran a command": (n) => `ran ${n} commands`,
  "Edited a file": (n) => `edited ${n} files`,
  "Wrote a file": (n) => `wrote ${n} files`,
  "Searched inside files": (n) => `searched files ${n} times`,
  "Looked through folders": (n) => `looked through folders ${n} times`,
  "Searched the web": (n) => `searched the web ${n} times`,
  "Opened a web page": (n) => `opened ${n} web pages`,
  "Read a note": (n) => `read ${n} notes`,
  "Updated memory": (n) => `updated memory ${n} times`,
  "Looked at memory": (n) => `looked at memory ${n} times`,
};

function phrase(label: string, count: number): string {
  if (count === 1) return label.charAt(0).toLowerCase() + label.slice(1);
  return PLURAL[label]?.(count) ?? `${label.charAt(0).toLowerCase()}${label.slice(1)} (${count}×)`;
}

/** The folded line: one kind of tool reads as itself, a mix as a total with the main kinds. */
export function summarizeRun(tools: readonly ChatToolRow[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const { label } = describeTool(tool.toolName, tool.toolInput);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => phrase(label, count));
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  const shown = parts.slice(0, 3).join(", ");
  return `Used ${tools.length} tools · ${shown}${parts.length > 3 ? ", …" : ""}`;
}
