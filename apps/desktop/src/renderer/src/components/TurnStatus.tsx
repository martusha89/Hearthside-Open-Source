import { useState } from "react";
import type { ConversationMoveState, TurnActivityPhase } from "@hearthside/ipc-contract";
import type { ChatRow } from "../types";
import { ActivityIndicator } from "./ActivityIndicator";
import { moveInFlight, moveNotice } from "../lib/move-status";
import { CloseIcon } from "./icons";

/**
 * Hearthside: the one status line, pinned just above the message box.
 *
 * It used to sit at the end of the transcript, which meant it scrolled away
 * exactly when it mattered — scrolled up, or after a long run of tool rows, the
 * person had no idea whether anything was still happening. Here it is always in
 * the same place, under the last message and above where they type.
 *
 * There is only ever one line. While a conversation is moving, the move *is*
 * what is happening, and it is the line that names the computer; at any other
 * time the turn's own activity is. Everything longer than a line — which
 * computer is running it, what went wrong, what not to do about it — is folded
 * into "Details".
 */
export function TurnStatus({ running, activity, phase, detail, rows, move }: {
  running: boolean;
  activity: string | null;
  phase?: TurnActivityPhase | null;
  detail?: string | null;
  rows: readonly ChatRow[];
  move?: ConversationMoveState | null;
}) {
  // Dismissing only hides a finished notice, and only this exact one: a later
  // report, or a move that changes, says its piece again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notice = moveNotice(move);
  const stamp = move ? `${move.moveId ?? "no-id"}:${move.phase}:${move.revision}` : null;

  if (notice && move && notice.tone !== "progress" && stamp !== dismissed) {
    const tone = notice.tone === "error" ? "text-error" : "text-warning-strong";
    return (
      <div className="grid gap-1 text-sm">
        <div className="flex items-start gap-2" role="status">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notice.tone === "error" ? "bg-error" : "bg-warning"}`} />
          <span className={`min-w-0 flex-1 ${tone}`}>{notice.line}</span>
          {notice.settled && (
            <button
              type="button"
              onClick={() => setDismissed(stamp)}
              aria-label="Dismiss this notice"
              title="Hide this notice. Nothing about the conversation changes."
              className="shrink-0 rounded-full p-0.5 text-muted hover:bg-surface-tertiary hover:text-ink-800"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60">Details</summary>
          <p className="mt-1 whitespace-pre-wrap break-words pl-4">{notice.detail}</p>
        </details>
      </div>
    );
  }

  // A move under way is the thing that is happening; it names the computer, so
  // it says it better than the turn's own line would.
  if (notice && moveInFlight(move)) {
    return <ActivityIndicator activity={notice.line} rows={rows} phase="moving" detail={notice.detail} />;
  }

  if (!running) return null;
  return <ActivityIndicator activity={activity ?? "Starting"} rows={rows} phase={phase} detail={detail} />;
}
