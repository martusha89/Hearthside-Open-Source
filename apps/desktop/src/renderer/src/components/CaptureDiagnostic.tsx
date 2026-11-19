import React, { useState } from "react";
import type { BackupCaptureDiagnostic, BackupChatDiagnostic } from "@hearthside/ipc-contract";
import { Spinner } from "./icons";

/**
 * Hearthside: Settings → Backups → "What does this connection report?".
 *
 * A count, on purpose and on request. It reads through the same readers a
 * backup uses, and shows only numbers and words this app chose: no message
 * text, no prompts, no tool arguments, no token counts, no addresses and no
 * identifiers, in the panel or in what the copy button puts on the clipboard.
 * A check that reached a limit says so, and says "not observed within the range
 * scanned" rather than claiming something isn't there.
 *
 * Colours here are the ones that clear WCAG AA for normal text (4.5:1) in both
 * themes, measured in `tests/ui/capture-diagnostic.browser.mjs`: `muted` is
 * 4.19:1 on the dark surface and the plain `warning` is 3.67:1 on the light
 * one, so this panel uses `ink-800` for its secondary text and
 * `warning-strong` for a bounded or stopped result.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const size = (value: number) => (value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`);

const failures = (report: BackupCaptureDiagnostic) => report.chats.filter((chat) => chat.scan === "failed").length;

const counted = (counts: Record<string, number>) => Object.entries(counts).filter(([, value]) => value > 0).map(([name, value]) => `${name} ${value}`).join(", ") || "none";

/** One chat's line. The panel shows exactly what the copy button copies. */
const chatLine = (chat: BackupChatDiagnostic): string => [
  `${chat.chat}${chat.main ? " · main" : ""}${chat.archived ? " · archived" : ""}: ${chat.messagesRead} message(s) counted over ${chat.pagesRead} page(s)${chat.messagesReceived > chat.messagesRead ? ` (${chat.messagesReceived} arrived)` : ""}`,
  `summaries ${chat.summaries} (with stats ${chat.summariesWithStats}${chat.unknownCompactionStatFields > 0 ? `, ${chat.unknownCompactionStatFields} unknown field(s)` : ""})`,
  ...(chat.otherRowsWithCompactionStats > 0 ? [`other row(s) carrying compaction stats: ${chat.otherRowsWithCompactionStats}`] : []),
  `stat fields: ${counted(chat.compactionStatFields)}`,
  `active-context window: ${chat.contextFailure !== null ? "unknown — this chat's own record could not be read" : chat.sourceWindowIds === null ? "not reported" : `${chat.sourceWindowIds} id(s)`} (${chat.contextFields.join(", ") || "no context fields"}; ${chat.contextSource})`,
  `types: ${counted(chat.messageTypes)}`,
  ...(counted(chat.roles) === "none" ? [] : [`roles: ${counted(chat.roles)}`]),
  `scan: ${chat.scan}${chat.stoppedBecause ? ` — ${chat.stoppedBecause}` : ""}${chat.failure ? ` — ${chat.failure}` : ""}`,
].join(" · ");

export const captureDiagnosticText = (report: BackupCaptureDiagnostic): string => [
  `Hearthside connection check v${report.version} · ${report.backend} · ${report.startedAt}`,
  `Scanned ${report.chatsScanned} of ${report.chatsReported} chat(s) listed${report.listingBounded ? " so far (the listing itself stopped at a limit)" : ""}, ${report.messagesRead} message(s) counted of ${report.messagesReceived} received, ${size(report.jsonBytesRead)} received, ${report.elapsedMs} ms${report.cancelled ? " · stopped on request" : report.bounded ? " · stopped at a limit" : ""}`,
  `Summaries ${report.summaries} (with stats ${report.summariesWithStats}) · chats reporting an active-context window ${report.chatsWithSourceWindow}${report.abandonedReads > 0 ? ` · ${report.abandonedReads} read(s) abandoned` : ""}`,
  ...report.findings.map((line) => `- ${line}`),
  ...report.chats.map(chatLine),
  `Limits: ${report.limits.chats} chats, ${report.limits.listPages} listing page(s) per listing, ${report.limits.pagesPerChat} message pages each, ${report.limits.messagesPerChat} messages each, ${size(report.limits.jsonBytes)}, ${Math.round(report.limits.milliseconds / 1000)} s in all and ${Math.round(report.limits.readMilliseconds / 1000)} s for any one read.`,
  "Limits: a page is measured only once it has arrived, so the last page of a chat can carry the counts past the byte limit; and when this check stops waiting for a read it stops waiting, which is not the same as stopping the read — where the connection cannot be cancelled, the read may go on.",
].join("\n");

export function CaptureDiagnostic({ agentId }: { agentId: string }) {
  const [report, setReport] = useState<BackupCaptureDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    setCopied(false);
    try {
      setReport(await window.bridge.runCaptureDiagnostic(agentId));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Connection check" className="grid gap-2 border-t border-border pt-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void run()}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {busy ? "Checking…" : "Check what this connection reports"}
        </button>
        {/* A Stop that itself fails is not worth an error: the check it was
            aimed at reports what it did either way. Swallowed, like the copy. */}
        {busy && (
          <button type="button" className="text-accent hover:underline" onClick={() => { void window.bridge.cancelCaptureDiagnostic().catch(() => undefined); }}>
            Stop
          </button>
        )}
        {report && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => { void navigator.clipboard.writeText(captureDiagnosticText(report)).then(() => setCopied(true)).catch(() => undefined); }}
          >
            {copied ? "Copied" : "Copy these counts"}
          </button>
        )}
      </div>
      <p className="text-ink-800">
        Counts only, and only when you ask: how many messages of each kind this companion's chats report, how many compaction summaries, and whether a chat reports an
        active context. No message text, prompts, tool details, token counts, addresses or identifiers are shown or copied. Nothing is written, sent or scheduled.
      </p>
      {report && (
        <div className="grid gap-1.5">
          <span className="text-ink-900">
            {report.chatsScanned} of {report.chatsReported} chat(s) listed{report.listingBounded ? " so far" : ""} · {report.messagesRead.toLocaleString()} message(s) · {report.summaries} summary
            row(s) ({report.summariesWithStats} with stats) · {report.chatsWithSourceWindow} chat(s) report an active context
          </span>
          <ul className="grid gap-1 text-ink-800">
            {report.findings.map((line, index) => (
              <li key={index} className={report.cancelled || report.bounded ? "text-warning-strong" : undefined}>{line}</li>
            ))}
          </ul>
          {/* The per-chat counts are the detail behind the findings, not a second
              story: they start folded, and the copy button copies them either way. */}
          <details className="grid gap-1">
            <summary className="cursor-pointer text-ink-800">
              Per-chat counts ({report.chats.length} chat(s){failures(report) > 0 ? `, ${failures(report)} could not be read` : ""})
            </summary>
            <ul className="mt-1 grid gap-1 text-ink-800">
              {report.chats.map((chat) => (
                <li key={chat.chat} className={chat.scan === "failed" ? "text-error" : undefined}>{chatLine(chat)}</li>
              ))}
            </ul>
          </details>
          <span className="text-ink-800">
            Bounded at {report.limits.chats} chats, {report.limits.listPages} listing page(s), {report.limits.pagesPerChat} message pages and {report.limits.messagesPerChat} messages each,{" "}
            {size(report.limits.jsonBytes)} and {Math.round(report.limits.milliseconds / 1000)} seconds, with {Math.round(report.limits.readMilliseconds / 1000)} seconds for any one read.
            A check that stopped early describes only what it read. A page is measured once it has arrived, so the last one can carry the counts past the byte limit, and when this check
            stops waiting for a read it stops waiting — not the same as stopping the read, which needs a connection that can be cancelled.
          </span>
        </div>
      )}
      {error && <p role="alert" className="break-words text-error">{error}</p>}
    </section>
  );
}
