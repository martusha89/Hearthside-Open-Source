import React, { useCallback, useEffect, useState } from "react";
import type { AppEvent, BackupConversionSummary, BackupSettingsInfo, BackupSnapshotInfo, BackupVerification, BackupRestorePlan, BackupRestoreResult, RecoveryCopy, RecoveryReceipt, RecoveryHandover, ManualRecoveryPreview } from "@hearthside/ipc-contract";
import { useAppStore } from "../store";
import { messageTime } from "../lib/format";
import { Spinner } from "./icons";
import { CaptureDiagnostic } from "./CaptureDiagnostic";
import { InfoTip } from "./InfoTip";
import { copiesOf, explainBackupFailure, explainBackupNote, groupBackupNotes, groupPartsByKind, groupUnrestoredParts, isFailedCheckNote } from "../lib/backup-notes";



function Note({ line, source }: { line: string; source?: string }) {
  const explanation = explainBackupNote(source ?? line);
  return <li>{line}{explanation && <InfoTip text={explanation} />}</li>;
}



function Notes({ lines }: { lines: string[] }) {
  return <>{groupBackupNotes(lines).map((note, index) => <Note key={index} line={note.text} source={note.source} />)}</>;
}



function FoldedNotes({ lines, label }: { lines: string[]; label?: string }) {
  const grouped = groupBackupNotes(lines);
  if (!grouped.length) return null;
  return <details className="text-xs">
    <summary className="cursor-pointer text-muted hover:text-ink-800">{label ?? `${grouped.length} ${grouped.length === 1 ? "note" : "notes"} about this backup`}</summary>
    <ul className="mt-1 grid gap-0.5 text-warning"><Notes lines={lines} /></ul>
  </details>;
}

/** Pieces not restored, one line per reason. */
function Unrestored({ parts }: { parts: Array<{ path: string; reason: string }> }) {
  return <>{groupUnrestoredParts(parts).map((part, index) => <li key={index}>{part.text}</li>)}</>;
}

/**
 * Hearthside: Settings → Backups. A folder of your choosing holds an
 * encrypted, incremental capture of available companion data. Omissions and
 * recovery limitations are shown per snapshot. "Back up now", or daily while
 * Hearthside is running. The recovery code shown when the folder is set up is
 * what opens the backup on another computer.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div role="dialog" aria-label="Your recovery code" className="grid gap-3 rounded-2xl border border-accent bg-accent-light p-4">
      <span className="text-sm font-semibold text-ink-900">Write this recovery code down. You'll see it once.</span>
      <code className="select-all rounded-xl bg-surface px-3 py-2 text-center font-mono text-base tracking-wider text-ink-900">{code}</code>
      <p className="text-xs text-ink-800">
        On this computer backups just work. On another computer (a new laptop, or this one reinstalled), the code is the only way to open them: without it the
        backup can't be read by anyone, including us. Keep it somewhere safe: a password manager, or paper.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-900">
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          I've saved it somewhere safe
        </label>
        <button type="button" className="button-primary ml-auto" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

const coverageText = (coverage: BackupRestorePlan["contextCoverage"]) => coverage === "translated-native" ? "Cloud chats carried over: each chat picks up from what your companion had in mind in Cloud, and older messages become read-only history you can open and search. It is a translation, not the exact Cloud context." : coverage === "native-all-conversations" ? "Native context: all captured conversations, including compaction state." : coverage === "cloud-main-only" ? "Cloud MAIN ONLY: main Agent File context; other conversation contexts are archived, not rehydrated." : "Archive only: no active context is rehydrated.";

/**
 * `handoverId` is a handover of this copy that stopped partway: it is loaded straight
 * away, so its steps and its rollback button are there without previewing a new one.
 */
export function RecoveryActions({ receiptId, handoverId }: { receiptId: string; handoverId?: string | null }) {
  const [receipt, setReceipt] = useState<RecoveryReceipt | null>(null);
  const [manual, setManual] = useState<ManualRecoveryPreview | null>(null);
  const [journal, setJournal] = useState<RecoveryHandover | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) {
      setMessage(`${errorText(error)} No automatic retry. Inspect the journal for partial or unknown outcomes.`);
      if (journal) try { setJournal(await window.bridge.getRecoveryHandover(journal.id)); } catch { /* Retain last observed journal, never invent an outcome. */ }
    } finally { setBusy(false); }
  };
  useEffect(() => { let current = true; window.bridge.getRecoveryReceipt(receiptId).then(value => { if (current) setReceipt(value); }).catch(error => { if (current) setMessage(errorText(error)); }); return () => { current = false; }; }, [receiptId]);
  useEffect(() => {
    if (!handoverId) return;
    let current = true;
    window.bridge.getRecoveryHandover(handoverId).then(value => { if (current) setJournal(value); }).catch(error => { if (current) setMessage(errorText(error)); });
    return () => { current = false; };
  }, [handoverId]);
  return <section aria-label="Verified recovery actions" className="grid gap-3 rounded-xl border border-border p-4 text-xs text-ink-800">
    <h3 className="font-semibold">Verified recovery receipt</h3>
    <p className="break-all">{receiptId}</p>
    {receipt && <><p>{receipt.source.connection} / {receipt.source.agentId} → {receipt.target.connection} / {receipt.target.agentId}</p><p>{coverageText(receipt.contextCoverage)}</p></>}
    <p>Nothing opens or enables automatically. Choose standalone text-only use, or preview an exclusive guarded handover. Unavailable ownership checks block handover.</p>
    <div className="flex flex-wrap gap-2"><button className="button-secondary" disabled={busy || !receipt} onClick={() => void perform(async () => { setManual(await window.bridge.previewManualRecoveryCopy(receiptId)); })}>Preview manual-only opening</button>
    <button className="button-secondary" disabled={busy || !receipt} onClick={() => void perform(async () => { setJournal(await window.bridge.previewRecoveryHandover(receiptId)); setApproved([]); })}>Preview guarded handover</button></div>
    {manual && <div className="grid gap-2"><p>{manual.warning} Text-only; tools, schedules and channels stay disabled.</p><ul><Notes lines={manual.omissions} /><Unrestored parts={manual.unrestoredParts} /></ul><button className="button-primary" disabled={busy} onClick={() => void perform(async () => { const result = await window.bridge.confirmManualRecoveryCopy(manual.token); setManual(null); setMessage(`Opened ${result.destinationAgentId} for manual-only use. Not an exclusive migration.`); })}>Confirm standalone manual-only opening</button></div>}
    {journal && <div className="grid gap-2"><p>Journal {journal.id}: {journal.state} · {journal.direction}</p><p>Only explicitly approved capabilities may be enabled. Source writers must be fenced first.</p>
      {journal.state === "preview" && ["manual", "schedules", "channels"].map(capability => <label key={capability} className="flex gap-2"><input type="checkbox" disabled={busy || !journal.receipt.capabilities.includes(capability)} checked={approved.includes(capability)} onChange={event => setApproved(current => event.target.checked ? [...current, capability] : current.filter(item => item !== capability))} />Approve {capability}{!journal.receipt.capabilities.includes(capability) && " (unavailable)"}</label>)}
      <ul>{journal.steps.map(step => <li key={step.operationId}>{step.action}: {step.outcome}</li>)}{journal.blockers.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <div className="flex flex-wrap gap-2">{journal.state === "preview" && <button className="button-primary" disabled={busy} onClick={() => void perform(async () => { setJournal(await window.bridge.confirmRecoveryHandover(journal.token, approved)); })}>Confirm guarded handover</button>}
      <button className="button-secondary" disabled={busy} onClick={() => void perform(async () => { setJournal(await window.bridge.getRecoveryHandover(journal.id)); })}>Refresh journal</button>
      {!["preview", "rolled-back"].includes(journal.state) && <button className="button-secondary" disabled={busy} onClick={() => void perform(async () => { setJournal(await window.bridge.rollbackRecoveryHandover(journal.id)); })}>Request guarded rollback</button>}</div><p>Rollback preserves new target data and blocks on unresolved writer outcomes; it is not guaranteed to complete.</p>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}



export type RecoveryProgressState = Omit<Extract<AppEvent, { type: "recovery.progress" }>, "type">;
type RecoveryStep = RecoveryProgressState["step"];
const STEP_LABELS: Record<RecoveryStep, string> = { check: "Checking your backup…", memory: "Setting up memory…", carry: "Carrying chats over…", save: "Saving chats…", verify: "Checking the copy…" };

/** The steps a restore of this plan goes through, in order. */
export function restoreSteps(plan: BackupRestorePlan): RecoveryStep[] {
  return ["check", "memory", ...(plan.conversion ? ["carry" as const] : []), ...(plan.conversion || plan.contextCoverage === "native-all-conversations" ? ["save" as const] : []), "verify"];
}

export function RecoveryProgressLine({ progress, steps }: { progress: RecoveryProgressState; steps?: RecoveryStep[] }) {
  const counted = progress.done !== undefined && progress.total ? progress.done / progress.total : 0;
  const detail = progress.done === undefined || !progress.total ? ""
    : progress.step === "carry" ? ` chat ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}${progress.what ? ` · ${progress.what}` : ""}`
    : ` ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} pieces`;
  const index = steps ? Math.max(0, steps.indexOf(progress.step)) : 0;
  const share = steps ? (index + counted) / steps.length : counted;
  return <div role="status" aria-label="Recovery progress" className="grid gap-1.5 text-xs text-ink-800">
    <span className="break-words">{steps && `Step ${index + 1} of ${steps.length} · `}{STEP_LABELS[progress.step]}{detail}</span>
    <div className="h-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(Math.min(1, share) * 100)}%` }} /></div>
    {steps && <span className="text-muted">This can take a few minutes for a big companion. Keep Hearthside open.</span>}
  </div>;
}

const chatName = (chat: string) => chat.startsWith("main:") || chat === "default" ? "Main chat" : chat;

/** Hearthside: what a Cloud-to-local restore carries over, and what it can't (stage 5). */
function ConversionReport({ summary }: { summary: BackupConversionSummary }) {
  return <div aria-label="What comes across" className="grid gap-2">
    <h4 className="font-semibold">What comes across</h4>
    <p>{summary.chats.toLocaleString()} {summary.chats === 1 ? "chat" : "chats"}, {summary.messages.toLocaleString()} messages ({bytes(summary.bytes)}). {summary.historyParts > 0 && `Older messages are split into ${summary.historyParts.toLocaleString()} read-only history ${summary.historyParts === 1 ? "part" : "parts"}.`}</p>
    {summary.pictures.placeholders > 0 && <p>Without pictures: {summary.pictures.placeholders.toLocaleString()} {summary.pictures.placeholders === 1 ? "picture is" : "pictures are"} shown as "[Picture not carried into this chat]", {summary.pictures.inWindow.toLocaleString()} of them in what your companion currently has in mind. {summary.pictures.omitted > 0 && `${summary.pictures.omitted.toLocaleString()} weren't in this backup (pictures were switched off). `}{summary.pictures.captured > 0 && `${summary.pictures.captured.toLocaleString()} are in the backup but can't go into a local chat. `}{summary.pictures.unknown > 0 && `${summary.pictures.unknown.toLocaleString()} have no record of whether they were kept.`}</p>}
    {summary.reorderedResults > 0 && <p>{summary.reorderedResults.toLocaleString()} tool {summary.reorderedResults === 1 ? "result was" : "results were"} recorded before the call that produced {summary.reorderedResults === 1 ? "it" : "them"}; {summary.reorderedResults === 1 ? "it is" : "they are"} placed after the call{summary.reorderedWindows > 0 && `, and ${summary.reorderedWindows.toLocaleString()} ${summary.reorderedWindows === 1 ? "chat's current window was" : "chats' current windows were"} put in that order too`}.</p>}
    {summary.closedWindowCalls > 0 && <p>{summary.closedWindowCalls.toLocaleString()} pending tool {summary.closedWindowCalls === 1 ? "call was" : "calls were"} abandoned by your choice: each keeps its call, with a note that the outcome is unknown and it must not be run again.</p>}
    {summary.excludedChats.length > 0 && <p>Kept as read-only incomplete history by your choice, with no live chat: {summary.excludedChats.map((item) => `${item.title} (${item.messages.toLocaleString()} messages)`).join("; ")}.</p>}
    {summary.unansweredCalls > 0 && summary.unansweredCallsPolicy === "annotate" && <p>{summary.unansweredCalls.toLocaleString()} tool {summary.unansweredCalls === 1 ? "call" : "calls"} in older messages never got a result in Cloud. Each is marked with a note saying so; the outcome is unknown, not failed.</p>}
    {summary.unconvertedTotal === 0
      ? <p>Every message comes across.</p>
      : <>
        <h4 className="font-semibold">What won't come across</h4>
        <p>{summary.unconvertedTotal.toLocaleString()} {summary.unconvertedTotal === 1 ? "message" : "messages"} can't be carried into a local chat. {summary.unconvertedTotal === 1 ? "It stays" : "They stay"} in your backup.</p>
        <ul>{summary.unconvertedByReason.map((item) => <li key={item.reason}>{item.count.toLocaleString()} · {item.reason}</li>)}</ul>
        {summary.unconvertedByChat.length > 1 && <details><summary className="cursor-pointer">By chat</summary><ul>{summary.unconvertedByChat.map((item) => <li key={item.chat} className="break-all">{chatName(item.chat)}: {item.count.toLocaleString()}</li>)}</ul></details>}
        {summary.examples.length > 0 && <details><summary className="cursor-pointer">Examples</summary><ul>{summary.examples.map((item, index) => <li key={index} className="break-all">{chatName(item.chat)} · {item.messageType}: {item.reason}</li>)}</ul></details>}
      </>}
  </div>;
}

export function RecoveryPreview({ plan, result, busy, progress, onConfirm, onClose }: { plan: BackupRestorePlan; result: BackupRestoreResult | null; busy: boolean; progress?: RecoveryProgressState | null; onConfirm: () => void; onClose: () => void }) {

  const c = plan.conversion;
  const compromises: string[] = [];
  if (c?.pictures.placeholders) compromises.push(`${c.pictures.placeholders.toLocaleString()} ${c.pictures.placeholders === 1 ? "picture is" : "pictures are"} replaced with "[Picture not carried into this chat]"${c.pictures.inWindow ? `, ${c.pictures.inWindow.toLocaleString()} of them in what your companion currently has in mind` : ""}. Your companion won't be able to see them.`);
  if (c?.unansweredCalls && c.unansweredCallsPolicy === "annotate") compromises.push(`${c.unansweredCalls.toLocaleString()} tool ${c.unansweredCalls === 1 ? "call" : "calls"} in older messages never got a result in Cloud; each gets a note saying the outcome is unknown.`);
  if (c?.closedWindowCalls) compromises.push(`${c.closedWindowCalls.toLocaleString()} tool ${c.closedWindowCalls === 1 ? "call" : "calls"} your companion was still waiting on (an approval you never answered, or a result that never came) ${c.closedWindowCalls === 1 ? "is" : "are"} closed with a note: outcome unknown, not to be run again. Your companion won't pick ${c.closedWindowCalls === 1 ? "it" : "them"} up.`);
  if (c?.excludedChats.length) compromises.push(`${c.excludedChats.length === 1 ? "1 chat is" : `${c.excludedChats.length} chats are`} kept as read-only history without a live chat, because ${c.excludedChats.length === 1 ? "its" : "their"} current window names messages the backup doesn't have: ${c.excludedChats.map((item) => item.title).join("; ")}. To continue from ${c.excludedChats.length === 1 ? "it" : "one"}, start a new chat and paste what you need.`);
  if (c?.reorderedWindows) compromises.push(`${c.reorderedResults.toLocaleString()} tool ${c.reorderedResults === 1 ? "result" : "results"} Cloud listed before ${c.reorderedResults === 1 ? "its" : "their"} call ${c.reorderedResults === 1 ? "is" : "are"} put after it.`);
  const backend = useAppStore(state => state.settings?.backend);
  return <section aria-label="Recovery preview" className="grid gap-3 rounded-xl border border-border bg-surface-secondary p-4 text-xs text-ink-800">
    <h3 className="text-sm font-semibold text-ink-900">Inactive recovery copy</h3>
    <p>The source stays untouched. No bots, schedules, tools or listeners are enabled. Archived conversations do not become active context. Nothing is sent, and the copy is not selected automatically.</p>
    <p>Currently selected destination: {backend === "cloud" ? "Letta Cloud" : backend === "local" ? "This computer" : "Unavailable / unsupported"}. No fallback destination or automatic switch.</p>
    <p>{coverageText(plan.contextCoverage)}</p>
    {(plan.contextCoverage === "native-all-conversations" || plan.contextCoverage === "translated-native") && <p>Confirming briefly stops and restarts the owned local runtime. Active turns block recovery.</p>}
    {plan.conversion && <ConversionReport summary={plan.conversion} />}
    <p>Anything not restored stays in your backup, which is kept safe from automatic cleanup while this copy depends on it. Only supported pieces are applied, with capabilities disabled.</p>
    {plan.blockers.length > 0 && <div role="alert" className="text-error"><h4 className="font-semibold">Recovery blocked</h4><ul>{plan.blockers.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
    {compromises.length > 0 && <div className="grid gap-2 rounded-lg border border-border p-3">
      <h4 className="font-semibold">What will be changed to make this restore possible</h4>
      <ul className="list-disc pl-5">{compromises.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <p>Everything else is restored as it is. Nothing is changed in your backup or in Cloud. These changes are listed in the copy's receipt.</p>
    </div>}
    
    <details>
      <summary className="cursor-pointer font-semibold">Details</summary>
      <div className="mt-2 grid gap-3">
        {plan.conversion && (plan.conversion.synthesized.length > 0 || plan.conversion.notes.length > 0) && <div><h4 className="font-semibold">How the chats are converted</h4><ul>{[...plan.conversion.synthesized, ...plan.conversion.notes].map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
        <p>Planned Git ancestry: {plan.gitAncestry === "restored" ? "will be restored only if recovery and verification succeed" : plan.gitAncestry === "inert" ? "not installed; bundles remain inert archive data" : "unavailable"}.</p>
        <p className="break-all">Snapshot: {plan.snapshotId}</p>
        <div><h4 className="font-semibold">Recoverable pieces</h4><ul>{groupPartsByKind(plan.supportedParts).map((part, index) => <li key={index}>{part.text}</li>)}</ul>{!plan.supportedParts.length && <p>None</p>}</div>
        <div><h4 className="font-semibold">Not restored</h4><ul><Unrestored parts={plan.unrestoredParts} /></ul></div>
        <div><h4 className="font-semibold">Omissions and warnings</h4><ul><Notes lines={[...new Set([...plan.omissions, ...plan.warnings])]} /></ul></div>
        <ul>{plan.guarantees.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </div>
    </details>
    {busy && !result && progress?.phase === "restore" && <RecoveryProgressLine progress={progress} steps={restoreSteps(plan)} />}
    {result && <div role="status" className={result.ok ? "text-success" : "text-error"}>
      <p>{result.ok ? "Local copy restored." : "The restore did not complete. Nothing in your backup or in Cloud was changed."}</p>
      {result.error && <p className="break-words font-medium">{result.error}</p>}
      {result.destinationAgentId && <p className="break-all">{result.ok ? "Copy" : "The unfinished copy is kept, inactive, so nothing is lost"}: {result.destinationAgentId}</p>}
      
      {!result.ok && result.destinationAgentId && <p>Trying again makes a new copy; this one stays until you remove it.</p>}
      {result.ok && <p>{result.restoredParts.length} pieces restored. {coverageText(result.contextCoverage)}</p>}
      
      <details>
        <summary className="cursor-pointer font-semibold">Details</summary>
        <div className="mt-2 grid gap-2">
          <p>Actual Git ancestry: {result.gitAncestry === "restored" ? "restored and verified" : result.gitAncestry === "inert" ? "not installed; bundles remain inert archive data" : "unavailable"}.</p>
          <p>{result.ok ? `${result.restoredParts.length} pieces restored.` : "The restore did not complete. The copy above is unfinished."} Source untouched. {coverageText(result.contextCoverage)} Complete active context rehydrated: {result.activeContextRehydrated ? "yes" : "no"}.</p>
          <ul>{groupPartsByKind(result.restoredParts).map((part, index) => <li key={index}>Restored: {part.text}</li>)}</ul>
          <ul><Unrestored parts={result.unrestoredParts} /></ul>
          {result.mappings.length > 0 && <details><summary className="cursor-pointer">How the old IDs map to the new ones ({result.mappings.length.toLocaleString()})</summary><ul>{result.mappings.map((mapping, index) => <li key={index}>{mapping.kind}: {mapping.originalName ?? mapping.originalId} ({mapping.originalId}) → {mapping.destinationName ?? mapping.destinationId} ({mapping.destinationId}) {mapping.permissions && `· ${mapping.permissions}`}</li>)}</ul></details>}
        </div>
      </details>
    </div>}
    {result?.ok && result.receiptId && <RecoveryActions receiptId={result.receiptId} />}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="button-primary" disabled={busy || !!result || plan.blockers.length > 0} onClick={onConfirm}>{busy ? "Working…" : "Restore local copy"}</button>
      <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Close preview</button>
    </div>
  </section>;
}

function CompanionBackups({ agentId, name, settings, onChanged, busy, setBusy, canBackUp }: { agentId: string; name: string; settings: BackupSettingsInfo; onChanged: () => void; busy: string | null; setBusy: (value: string | null) => void; canBackUp: boolean }) {
  const [snapshots, setSnapshots] = useState<BackupSnapshotInfo[] | null>(null);
  const [plan, setPlan] = useState<BackupRestorePlan | null>(null);
  const [result, setResult] = useState<BackupRestoreResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; what: string } | null>(null);
  const [recoveryProgress, setRecoveryProgress] = useState<RecoveryProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, BackupVerification>>({});
  // Hearthside: copies restored from this companion's backups, so one can be opened
  // again after the restore panel is closed or the app restarted. Before, a copy that
  // wasn't opened there and then stayed locked, with nothing left to press.
  const [copies, setCopies] = useState<RecoveryCopy[]>([]);
  const [openCopy, setOpenCopy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshots(await window.bridge.listBackups(agentId));
    } catch (failure) {
      setError(errorText(failure));
    }
    // Its own try: the list of copies is an extra, and must not hide the backups.
    try {
      setCopies(copiesOf(await window.bridge.listRecoveryCopies(), agentId));
    } catch { /* the list stays as it was */ }
  }, [agentId]);
  useEffect(() => {
    if (settings.ready) void refresh();
  }, [refresh, settings.ready]);
  useEffect(
    () =>
      window.bridge.onEvent((event) => {
        if (event.type === "backup.progress" && event.agentId === agentId) setProgress({ done: event.done, total: event.total, what: event.what });
        if (event.type === "recovery.progress") { const { type: _type, ...rest } = event; setRecoveryProgress(rest); }
      }),
    [agentId],
  );

  const backUp = async (full = false) => {
    setBusy("backup");
    setError(null);
    setProgress(null);
    try {
      await window.bridge.backUpNow(agentId, full);
      await refresh();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const verify = async (id: string) => {
    setBusy(`verify-${id}`);
    try {
      setVerified((current) => ({ ...current }));
      const result = await window.bridge.verifyBackup(agentId, id);
      setVerified((current) => ({ ...current, [id]: result }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const preview = async (id: string) => {
    setBusy(`preview-${id}`);
    setError(null);
    setPlan(null);
    setResult(null);
    setRecoveryProgress(null);
    // One computed preview: the conversion proposes every allowed fallback itself and
    // lists what it used; nothing runs until the person confirms exactly that plan.
    try { setPlan(await window.bridge.previewBackupRestore(agentId, id, { fallbacks: true })); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(null); setRecoveryProgress(null); }
  };
  const restore = async () => {
    if (!plan || busy || result || plan.blockers.length) return;
    setBusy("restore");
    setError(null);
    setRecoveryProgress(null);
    try { setResult(await window.bridge.restoreBackupCopy(plan.token)); void refresh(); }
    catch (failure) {
      // A consumed token must not be retried automatically; retain the error for review.
      setResult({ ok: false, sourceUntouched: true, activeContextRehydrated: false, contextCoverage: "archive-only", gitAncestry: "unavailable", restoredParts: [], unrestoredParts: [], mappings: [], error: errorText(failure) });
    }
    finally { setBusy(null); }
  };
  const latest = snapshots?.[0];
  return (
    <div className="grid gap-2 rounded-xl border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink-900">{name}</span>
          <span className="block text-xs text-muted">
            {latest
              ? `Last backup ${messageTime(latest.at)} · ${latest.counts.conversations ?? 0} conversations, ${(latest.counts.messages ?? 0).toLocaleString()} messages, ${latest.counts.memoryFiles ?? 0} local memory files, ${latest.counts.repositoryFiles ?? 0} repository files`
              : snapshots === null
                ? "…"
                : "Not backed up yet"}
          </span>
        </span>
        <button type="button" className="button-primary" disabled={busy !== null || !settings.ready || !canBackUp} onClick={() => void backUp()}>
          {busy === "backup" && <Spinner className="h-3.5 w-3.5" />}
          Back up now
        </button>
        
        <button type="button" className="button-secondary" disabled={busy !== null || !settings.ready || !canBackUp} title="Re-read every message of every chat, so edits and deletions are caught. Slow for a long history; it also happens by itself once a week." onClick={() => void backUp(true)}>
          Full backup
        </button>
      </div>
      {recoveryProgress?.phase === "preview" && busy?.startsWith("preview-") && <RecoveryProgressLine progress={recoveryProgress} />}
      {progress && busy === "backup" && (
        <span className="text-xs text-muted">
          {progress.done}/{progress.total} · {progress.what}
        </span>
      )}
      
      {settings.lastError?.[agentId] && busy !== "backup" && (
        <span className="break-words text-xs text-error">
          The last backup failed ({messageTime(settings.lastError[agentId]!.at)}): {settings.lastError[agentId]!.message}
          <InfoTip text={explainBackupFailure(settings.lastError[agentId]!.message)} />
        </span>
      )}
      {latest && <FoldedNotes lines={latest.omissions} label={`${groupBackupNotes(latest.omissions).length} ${groupBackupNotes(latest.omissions).length === 1 ? "note" : "notes"} about the last backup`} />}
      {snapshots && snapshots.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-ink-800">
            {snapshots.length} backup{snapshots.length === 1 ? "" : "s"} kept
          </summary>
          <ul className="mt-1.5 grid gap-1">
            {snapshots.map((snapshot) => {
              const check = verified[snapshot.id];
              return (
                <li key={snapshot.id} className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums text-ink-800">{messageTime(snapshot.at)}</span>
                  <span className="text-muted">
                    {(snapshot.counts.messages ?? 0).toLocaleString()} messages · {bytes(snapshot.bytes)}
                  </span>
                  {/* Hearthside: said on the row itself, not only inside the folded notes. */}
                  {snapshot.omissions.some(isFailedCheckNote) && <span className="text-error">didn't pass its check</span>}
                  <button type="button" className="text-accent hover:underline" disabled={busy !== null} onClick={() => void verify(snapshot.id)}>
                    {busy === `verify-${snapshot.id}` ? "Checking…" : "Check"}
                  </button>
                  <button type="button" className="text-accent hover:underline" disabled={busy !== null} onClick={() => void preview(snapshot.id)}>Preview recovery</button>
                  <div className="w-full"><FoldedNotes lines={snapshot.omissions} /></div>
                  {check && <div className="w-full">
                    <span className={check.ok ? "text-success" : "text-error"}>
                      {check.ok ? `Integrity checked · ${check.checked} pieces` : `${check.missing.length} missing, ${check.corrupt.length} damaged, ${check.semanticErrors.length} semantic errors`}
                    </span>
                    <p className="text-muted">Integrity checking does not guarantee complete recovery.</p>
                    <ul className="text-error">{[...check.missing.map((path) => `Missing: ${path}`), ...check.corrupt.map((path) => `Damaged: ${path}`), ...check.semanticErrors].map((line, index) => <li key={index}>{line}</li>)}</ul>
                    <ul className="text-warning">{check.warnings.map((line, index) => <li key={index}>{line}</li>)}</ul>
                  </div>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {copies.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-ink-800">
            {copies.length} restored {copies.length === 1 ? "copy" : "copies"}
          </summary>
          <ul className="mt-1.5 grid gap-1">
            {copies.map((copy) => (
              <li key={copy.receiptId} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-ink-800">Restored {messageTime(copy.createdAt)}</span>
                <span className="break-all text-muted">{copy.targetAgentId}</span>
                {copy.handoverId && <span className="text-warning">a handover to this copy is unfinished</span>}
                <button type="button" className="text-accent hover:underline" disabled={busy !== null} onClick={() => setOpenCopy(openCopy === copy.receiptId ? null : copy.receiptId)}>
                  {openCopy === copy.receiptId ? "Close" : copy.handoverId ? "Open or roll back…" : "Open this copy…"}
                </button>
                {openCopy === copy.receiptId && <div className="w-full"><RecoveryActions receiptId={copy.receiptId} handoverId={copy.handoverId} /></div>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {settings.ready && canBackUp && <CaptureDiagnostic agentId={agentId} />}
      {plan && <RecoveryPreview plan={plan} result={result} busy={busy !== null} progress={busy === "restore" ? recoveryProgress : null} onConfirm={() => void restore()} onClose={() => setPlan(null)} />}
      {error && <p role="alert" className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}

export function BackupSettings() {
  const agents = useAppStore((state) => state.agents);
  const [catalogue, setCatalogue] = useState<Array<{ agentId: string; agentName: string }>>([]);
  const [settings, setSettings] = useState<BackupSettingsInfo | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [typedCode, setTypedCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.bridge.getBackupSettings();
      setSettings(next);
      setCatalogue(next.ready ? await window.bridge.listBackupCompanions() : []);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <p className="mt-4 text-sm text-muted">…</p>;
  const needsCode = Boolean(settings.folder) && !settings.ready;
  return (
    <div className="mt-4 grid gap-5">
      <p className="text-sm text-ink-800">
        Backups encrypt available captured pieces in a folder you choose: memory, conversation archives and other supported data.
        Capture can be incomplete; each snapshot lists omissions. Integrity checks are not a promise of complete recovery.
        Preview exactly what can be copied into a new inactive companion on the currently selected Cloud or local connection before confirming.
      </p>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-ink-700">Backup folder</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg bg-surface-tertiary px-2.5 py-1.5 font-mono text-xs text-ink-900">{settings.folder ?? "Not chosen yet"}</span>
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null}
            onClick={() =>
              void act("folder", async () => {
                const picked = await window.bridge.chooseBackupFolder();
                if (picked?.recoveryCode) setRecoveryCode(picked.recoveryCode);
              })
            }
          >
            {busy === "folder" && <Spinner className="h-3.5 w-3.5" />}
            {settings.folder ? "Change…" : "Choose…"}
          </button>
        </div>
        <span className="text-xs text-muted">
          An empty folder on this computer, an external drive, or a synced folder (OneDrive, Dropbox).{settings.sizeOnDisk !== null ? ` Using ${bytes(settings.sizeOnDisk)}.` : ""}
        </span>
        
        {settings.ready && !recoveryCode && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Lost the recovery code? This computer still has the key, so it can make a new one. The old code stops working; your backups stay as they are.</span>
            <button
              type="button"
              className="button-secondary"
              disabled={busy !== null}
              onClick={() =>
                void act("newcode", async () => {
                  const { recoveryCode: code } = await window.bridge.newBackupRecoveryCode();
                  setRecoveryCode(code);
                })
              }
            >
              {busy === "newcode" && <Spinner className="h-3.5 w-3.5" />}
              Make a new recovery code
            </button>
          </div>
        )}
      </div>

      {recoveryCode && <RecoveryCode code={recoveryCode} onDone={() => setRecoveryCode(null)} />}

      {needsCode && (
        <div className="grid gap-2 rounded-2xl border border-border bg-surface-secondary p-4">
          <span className="text-sm font-medium text-ink-900">This folder holds a backup from another computer (or an earlier setup).</span>
          <span className="text-xs text-muted">Type its recovery code to open it here.</span>
          <div className="flex flex-wrap items-center gap-2">
            <input value={typedCode} onChange={(event) => setTypedCode(event.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" className="field min-w-0 flex-1 font-mono text-xs" aria-label="Recovery code" />
            <button type="button" className="button-primary" disabled={busy !== null || typedCode.trim().length < 10} onClick={() => void act("unlock", () => window.bridge.unlockBackupFolder(typedCode))}>
              Unlock
            </button>
          </div>
        </div>
      )}

      {settings.ready && (
        <>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" disabled={busy !== null} checked={settings.includePictures} onChange={(event) => void act("pictures", () => window.bridge.updateBackupSettings({ includePictures: event.target.checked }))} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="block text-sm text-ink-900">Include pictures</span>
              <span className="block text-xs text-muted">Photos sent and images made, stored once each. Off keeps the backup small; each left-out picture is noted.</span>
            </span>
          </label>
          <div className="grid gap-2">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" disabled={busy !== null} checked={settings.daily} onChange={(event) => void act("daily", () => window.bridge.updateBackupSettings({ daily: event.target.checked }))} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
              <span>
                <span className="block text-sm text-ink-900">Back up every day</span>
                <span className="block text-xs text-muted">While Hearthside is running. If it was closed at the time, the backup runs when it's next open.</span>
              </span>
            </label>
            {settings.daily && (
              <div className="ml-7 flex flex-wrap items-center gap-3 text-xs text-ink-700">
                <label className="flex items-center gap-1.5">
                  at
                  <input disabled={busy !== null} type="time" value={settings.dailyAt} onChange={(event) => event.target.value && void act("time", () => window.bridge.updateBackupSettings({ dailyAt: event.target.value }))} className="field py-1 text-xs" aria-label="Daily backup time" />
                </label>
                <label className="flex items-center gap-1.5">
                  keep
                  <input disabled={busy !== null} type="number" min={1} max={3650} value={settings.keepDays} onChange={(event) => void act("keep", () => window.bridge.updateBackupSettings({ keepDays: Math.max(1, Math.min(3650, Number(event.target.value) || 30)) }))} className="field w-20 py-1 text-xs" aria-label="Days of backups to keep" />
                  days of backups
                </label>
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <span className="text-xs font-medium text-ink-700">Companions</span>
            {agents.length === 0 && catalogue.length === 0 && <span className="text-xs text-muted">No companions or stored backups yet.</span>}
            {[...agents.map((agent) => ({ id: agent.id, name: agent.name, live: true })), ...catalogue.filter((stored) => !agents.some((agent) => agent.id === stored.agentId)).map((stored) => ({ id: stored.agentId, name: `${stored.agentName} · stored backup`, live: false }))].map((agent) => (
              <CompanionBackups key={agent.id} agentId={agent.id} name={agent.name} settings={settings} onChanged={() => void refresh()} busy={busy} setBusy={setBusy} canBackUp={agent.live} />
            ))}
          </div>
        </>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}
