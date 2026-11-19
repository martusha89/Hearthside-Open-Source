import { useEffect, useRef, useState } from "react";
import { upgradeCompanionPrompt } from "../lib/companion-prompt";

export function PromptRepairPanel({ agentId, system, onRestored, onBusyChange, onMutationStart, onRestoreUncertain, blocked = false }: {
  agentId: string;
  system: string | null;
  onRestored: (backupPath: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  /** Invalidate the parent's editable base synchronously, before any mutation. */
  onMutationStart?: () => boolean;
  onRestoreUncertain?: (message: string) => void | Promise<void>;
  blocked?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const scope = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    scope.current += 1;
    inFlight.current = false;
    setConfirmed(false);
    setBusy(false);
    setError(null);
    setResult(null);
    return () => { scope.current += 1; };
  }, [agentId, system]);
  const replacement = system === null ? null : upgradeCompanionPrompt(system);
  if (replacement === null || replacement === system || (blocked && !busy)) return null;

  const restore = async () => {
    if (!confirmed || blocked || inFlight.current || system === null) return;
    if (onMutationStart?.() === false) return;
    const generation = scope.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const restored = await window.bridge.restoreCompanionPrompt(agentId, system, replacement, true);
      if (generation !== scope.current) return;
      setResult(`Updated Companion technical instructions. Personal wording and existing memory were preserved. Private same-agent backup: ${restored.backupPath}.`);
      await onRestored(restored.backupPath);
    } catch (failure) {
      if (generation === scope.current) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        setConfirmed(false);
        // A rejected IPC call may have changed the prompt before disconnecting.
        // Never let the parent resume editing its old base without readback.
        await onRestoreUncertain?.(message);
      }
    } finally {
      if (generation === scope.current) { inFlight.current = false; setBusy(false); }
    }
  };

  return <section className="space-y-3 rounded-lg border border-border p-3 text-xs">
    <h3 className="font-medium">Update Companion technical instructions</h3>
    <p>Review the complete old and proposed prompts below. Only the technical portion changes; your personal wording stays exactly where it is. Existing persona, human and relationship memory will not be changed or duplicated.</p>
    <p>This remains Hearthside’s full custom Companion prompt, not Letta’s managed default. Future technical updates require explicit review.</p>
    <details open><summary>Current full prompt (will be backed up)</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap p-2">{system}</pre></details>
    <details open><summary>Proposed full Companion prompt</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap p-2">{replacement}</pre></details>
    <p>The old prompt is backed up in this agent’s private authored memory: a new folder index for v2, or a reference file for v1. Large prompts use ordered archive parts with exact reconstruction instructions and an integrity hash in that index. No shared memory is used. Keep this agent idle and stop other clients. These steps are not atomic; a failed upgrade may leave a backup. Memory limits can block the upgrade before the prompt changes.</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || !!result} onChange={event => setConfirmed(event.target.checked)} />I reviewed both prompts, paused this agent on other devices, and approve this technical update</label>
    <div className="flex gap-2">
      <button type="button" className="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={!confirmed || busy || !!result} onClick={() => void restore()}>{busy ? "Updating…" : "Confirm and update Companion instructions"}</button>
      <button type="button" className="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={busy || !!result} onClick={() => { setConfirmed(false); setError(null); }}>Cancel update</button>
    </div>
    {error && <p role="alert" className="break-words text-error">{error}</p>}
    {result && <p role="status" className="break-words">{result}</p>}
  </section>;
}
