import { useState } from "react";
import type { ChatRow, ChatToolRow } from "../types";
import { summarizeRun } from "../lib/tool-runs";
import { describeTool } from "../lib/tools";
import { ChevronRightIcon, Spinner } from "./icons";



export function ToolRun({
  rows,
  tools,
  live,
  renderRow,
}: {
  rows: ChatRow[];
  tools: ChatToolRow[];
  /** The agent is still working on this run (it's the end of a running turn). */
  live: boolean;
  renderRow: (row: ChatRow) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const failed = tools.filter((tool) => tool.result?.isError).length;
  const last = tools[tools.length - 1]!;
  const now = live ? describeTool(last.toolName, last.toolInput) : null;
  return (
    <div className="grid gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface-secondary px-3 py-2 text-left text-sm text-ink-800 transition-colors hover:bg-surface-tertiary"
      >
        <ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 truncate">
          {summarizeRun(tools)}
          {failed > 0 && <span className="text-error"> · {failed} failed</span>}
          {now && (
            <span className="text-muted">
              {" · now: "}
              {now.label.toLowerCase()}
              {now.detail ? ` ${now.detail}` : ""}
            </span>
          )}
        </span>
        {live && <Spinner className="h-3.5 w-3.5 shrink-0 text-muted" />}
      </button>
      {open && <div className="grid gap-2 border-l-2 border-border pl-3">{rows.map((row) => renderRow(row))}</div>}
    </div>
  );
}
