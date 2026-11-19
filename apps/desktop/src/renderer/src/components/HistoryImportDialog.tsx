import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { HistoryImportPreview, HistoryImportResult } from "../types";
import { Spinner } from "./icons";

/**
 * Hearthside: bring past ChatGPT or Claude conversations into an agent's
 * memory as a searchable archive. Nothing is written until the person has
 * seen the preview and pressed Import.
 */

const errorText = (failure: unknown) =>
  (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

export function HistoryImportDialog({ agentId, agentName, open, onOpenChange }: { agentId: string; agentName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null);
  const [result, setResult] = useState<HistoryImportResult | null>(null);
  const [personName, setPersonName] = useState("");
  // Archived chats are part of the history too; on unless the person says otherwise.
  const [includeArchived, setIncludeArchived] = useState(true);

  const chosen = preview
    ? {
        conversations: includeArchived ? preview.conversations : preview.conversations - preview.archived,
        messages: includeArchived ? preview.messages : preview.messages - (preview.archivedMessages ?? 0),
      }
    : { conversations: 0, messages: 0 };
  const [busy, setBusy] = useState<"choose" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Letta Cloud uploads file by file: show how far along it is.
  useEffect(() => window.bridge.onEvent((event) => {
    if (event.type === "history.progress") setProgress({ done: event.done, total: event.total });
  }), []);

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
    setBusy(null);
  };
  const choose = async () => {
    setBusy("choose");
    setError(null);
    try {
      const next = await window.bridge.chooseHistoryImport(agentId);
      if (next) setPreview(next);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  const run = async () => {
    if (!preview) return;
    setBusy("import");
    setError(null);
    setProgress(null);
    try {
      setResult(await window.bridge.runHistoryImport(preview.token, { ...(personName.trim() ? { personName: personName.trim() } : {}), includeArchived }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  const omitted = preview
    ? [
        preview.omitted.systemOrTool && plural(preview.omitted.systemOrTool, "system or tool message"),
        preview.omitted.hidden && plural(preview.omitted.hidden, "hidden message"),
        preview.omitted.empty && plural(preview.omitted.empty, "empty message"),
      ].filter(Boolean)
    : [];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg min-w-0 grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-elevated [overflow-wrap:anywhere] focus:outline-none">
          <div>
            <Dialog.Title className="text-base font-semibold text-ink-900">Import past conversations</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              Bring your ChatGPT or Claude history into {agentName}'s memory, so they can look things up. It goes into a history folder they
              search when needed; it doesn't change who they are.
            </Dialog.Description>
          </div>

          {!preview && !result && (
            <div className="grid min-w-0 grid-cols-1 gap-3 text-sm text-ink-800">
              <div className="grid min-w-0 grid-cols-1 gap-1 rounded-xl bg-surface-secondary p-3 text-xs">
                <span className="font-medium text-ink-900">Getting your export</span>
                <span>
                  <b>ChatGPT:</b> Settings → Data controls → Export data. You'll get an email with a .zip.
                </span>
                <span>
                  <b>Claude:</b> Settings → Privacy → Export data. You'll get an email with a .zip.
                </span>
                <span className="text-muted">Choose the .zip as it is (or the conversations.json inside it). It stays on this computer.</span>
              </div>
              <button type="button" className="button-primary justify-self-start" disabled={busy !== null} onClick={() => void choose()}>
                {busy === "choose" && <Spinner className="h-3.5 w-3.5" />}
                {busy === "choose" ? "Reading the export…" : "Choose export file"}
              </button>
            </div>
          )}

          {preview && !result && (
            <div className="grid min-w-0 grid-cols-1 gap-3 text-sm text-ink-800" aria-label="Import preview">
              <div className="grid min-w-0 grid-cols-1 gap-1 rounded-xl border border-border p-3">
                <span className="font-medium text-ink-900">
                  {preview.sourceLabel} export · {preview.fileName}
                </span>
                <span>
                  {plural(chosen.conversations, "conversation")}, {plural(chosen.messages, "message")}
                  {preview.firstDate && preview.lastDate ? `, from ${preview.firstDate} to ${preview.lastDate}` : ""}.
                </span>
                {preview.alreadyImported > 0 && (
                  <span className="text-xs text-muted">{plural(preview.alreadyImported, "conversation")} are already in memory; importing again won't duplicate them.</span>
                )}
                {omitted.length > 0 && <span className="text-xs text-muted">Left out, as they weren't part of what you saw: {omitted.join(", ")}.</span>}
                {preview.omitted.images > 0 && <span className="text-xs text-muted">{plural(preview.omitted.images, "image")} noted as [image] (pictures aren't copied).</span>}
              </div>
              {/*
                Hearthside: two limits of this importer, said before importing rather than
                discovered afterwards in memory — which version of an edited chat it keeps, and
                that it decides a speaker from the role alone. Both are about what Hearthside
                does with the file, not about what the file contains; they are also written into
                the import record (history/imports-<source>.md).
              */}
              <div className="grid min-w-0 grid-cols-1 gap-1.5 rounded-xl bg-surface-secondary p-3 text-xs text-ink-700" aria-label="What this import doesn't carry across">
                <span className="font-medium text-ink-900">What this import doesn't carry across</span>
                {preview.omitted.otherBranches > 0 ? (
                  <span>
                    <b className="font-medium">{plural(preview.omitted.otherBranches, "message")}</b> sit on versions you edited or regenerated away and aren't brought across. {preview.branchNote}
                  </span>
                ) : (
                  <span>{preview.branchNote}</span>
                )}
                <span>{preview.attributionNote}</span>
              </div>
              {preview.sample.length > 0 && (
                <div className="grid min-w-0 grid-cols-1 gap-1">
                  <span className="text-xs font-medium text-ink-700">Newest conversations</span>
                  <ul className="grid min-w-0 grid-cols-1 gap-0.5 text-xs">
                    {preview.sample.map((item, index) => (
                      <li key={index} className="flex gap-2">
                        <span className="w-20 shrink-0 tabular-nums text-muted">{item.date ?? "undated"}</span>
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        <span className="shrink-0 text-muted">{item.messages}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="grid min-w-0 grid-cols-1 gap-1">
                <span className="text-xs font-medium text-ink-700">Your name in these chats</span>
                <input className="field" value={personName} placeholder="User" onChange={(event) => setPersonName(event.target.value)} />
                <span className="text-xs text-muted">Shown beside your messages, so {agentName} knows they were yours.</span>
              </label>
              {preview.archived > 0 && (
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
                  <span>
                    <span className="block text-sm text-ink-900">Include archived chats ({preview.archived.toLocaleString()})</span>
                    <span className="block text-xs text-muted">Chats you archived in {preview.sourceLabel}. Untick to leave them out of {agentName}'s history.</span>
                  </span>
                </label>
              )}
              {preview.destination === "cloud" && (
                <p className="rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">
                  {agentName} lives on Letta Cloud, so this goes into a read-only history folder on your Letta account, attached to {agentName}.
                  Their own memory isn't changed. A big history takes a few minutes to upload.
                </p>
              )}
              {!preview.supported && (
                <p className="rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">
                  This agent can't take an import from here: it works for agents on This computer, and on Letta Cloud when you're signed in.
                </p>
              )}
            </div>
          )}

          {result && (
            <p role="status" className="rounded-xl bg-accent-subtle px-3 py-2.5 text-sm text-ink-900">
              Done: {plural(result.conversations, "conversation")} are in {agentName}'s {preview?.destination === "cloud" ? "history folder on Letta Cloud" : "memory under history/"}
              {result.written === 0 ? " (nothing new: they were all there already)." : "."} {agentName} will find them when they're relevant.
            </p>
          )}

          {error && (
            <p role="alert" className="break-words text-xs text-error">
              {error}
            </p>
          )}

          <div className="flex min-w-0 flex-wrap justify-end gap-2 [&>button]:max-w-full [&>button]:whitespace-normal">
            {preview && !result && (
              <button type="button" className="button-secondary" disabled={busy !== null} onClick={reset}>
                Choose another file
              </button>
            )}
            <Dialog.Close className="button-secondary" disabled={busy !== null}>
              {result ? "Close" : "Cancel"}
            </Dialog.Close>
            {preview && !result && (
              <button type="button" className="button-primary" disabled={busy !== null || !preview.supported || chosen.conversations === 0} onClick={() => void run()}>
                {busy === "import" && <Spinner className="h-3.5 w-3.5" />}
                {busy === "import"
                  ? progress && progress.total > 0
                    ? `Uploading ${Math.min(progress.done, progress.total).toLocaleString()} of ${progress.total.toLocaleString()}…`
                    : "Importing…"
                  : `Import ${plural(chosen.conversations, "conversation")}`}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
