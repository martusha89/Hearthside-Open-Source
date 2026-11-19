// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { AgentDetails, AgentUpdate } from "../types";
import { resolveModel } from "../lib/models";
import { PromptRepairPanel } from "./PromptRepairPanel";
import { companionPromptParts, replaceCompanionPersonal } from "../lib/companion-prompt";
import { LettaDefaultReference } from "./LettaDefaultReference";
import { ToolsetPanel } from "./ToolsetPanel";
import { SecretsPanel } from "./SecretsPanel";
import { DreamSettingsPanel } from "./DreamSettingsPanel";
import { AgentLookPanel } from "./LookSettings";
import { ModelPicker } from "./ModelPicker";
import { Spinner } from "./icons";
import { FullPage } from "./FullPage";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DeleteAgent({ agent }: { agent: AgentDetails }) {
  const deleteAgent = useAppStore((state) => state.deleteAgent);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAgent();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-3.5 py-3">
        <div>
          <div className="text-sm font-medium text-ink-900">Delete this companion</div>
          <div className="text-xs text-muted">
            Removes this companion, their memory, and all of their chats. This cannot be undone.
          </div>
        </div>
        <button
          type="button"
          className="button-secondary shrink-0 text-error"
          onClick={() => setConfirming(true)}
        >
          Delete...
        </button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-error/30 bg-error-light px-3.5 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed === agent.name && !busy) void remove();
      }}
    >
      <label className="grid gap-1.5">
        <span className="text-sm text-ink-900">
          Type <span className="font-semibold">{agent.name}</span> to delete this companion, their memory,
          and all of its chats.
        </span>
        <input
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          spellCheck={false}
          className="field"
        />
      </label>
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setTyped("");
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={typed !== agent.name || busy}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-error px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Delete permanently
        </button>
      </div>
    </form>
  );
}

const CONTEXT_PRESETS = [16_000, 32_000, 64_000, 128_000, 200_000, 272_000, 400_000, 1_000_000];

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * Hearthside: context window size. The model's listed size is a guide, not a
 * hard limit (providers differ), so bigger values are allowed with a warning.
 * The custom box keeps what's typed and applies it on Enter or when leaving it.
 */
function ContextWindowField({
  value,
  max,
  onChange,
}: {
  value: number | null;
  /** The size the runtime lists for this model. */
  max: number | null;
  onChange: (tokens: number) => void;
}) {
  const presets = [...new Set([...CONTEXT_PRESETS, ...(max ? [max] : [])])].sort((a, b) => a - b);
  const custom = value !== null && !presets.includes(value);
  const [draft, setDraft] = useState<string>(custom && value ? String(Math.round(value / 1000)) : "");
  useEffect(() => {
    if (!custom) setDraft("");
  }, [custom]);
  const apply = () => {
    const thousands = Math.round(Number(draft));
    if (!thousands) return;
    const tokens = Math.min(10_000_000, Math.max(4_000, thousands * 1000));
    setDraft(String(tokens / 1000));
    onChange(tokens);
  };
  const overListed = Boolean(max && value && value > max);
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">Context window</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => onChange(size)}
            aria-pressed={value === size}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${value === size ? "border-accent bg-accent-light text-ink-900" : "border-border text-ink-700 hover:bg-surface-tertiary"}`}
          >
            {formatTokens(size)}
            {size === max ? " (listed)" : ""}
          </button>
        ))}
        <label className="flex items-center gap-1 text-xs text-ink-700">
          Custom
          <input
            type="number"
            min={4}
            aria-label="Custom context window in thousands of tokens"
            value={draft}
            placeholder="—"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              }
            }}
            className={`field w-24 py-1 text-center ${custom ? "border-accent" : ""}`}
          />
          k
        </label>
      </div>
      {overListed && (
        <span className="text-xs text-warning">
          Above this model's listed size ({formatTokens(max!)}). Some providers allow it; others refuse it or cut it back.
        </span>
      )}
      <span className="text-xs text-muted">
        How much of the conversation the companion holds at once{value ? ` (now ${formatTokens(value)} tokens)` : ""}. Bigger
        remembers more of the chat directly but costs more and is slower; smaller compacts older messages sooner. Nothing
        is lost: the companion can still look up earlier messages.
      </span>
    </div>
  );
}

/** Stored base instructions, not the runtime's compiled memory and tools. */
export function SystemPromptField({ value, savedValue, disabled, onChange }: { value: string | null; savedValue: string | null; disabled: boolean; onChange: (value: string) => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const parts = savedValue === null ? null : companionPromptParts(savedValue);
  if (parts && savedValue !== null) {
    const suffix = parts.divider + parts.technical;
    const prefix = value?.endsWith(suffix) ? value.slice(0, -suffix.length) : parts.personal + parts.separator;
    const separator = parts.separator || "\n";
    const personal = prefix.endsWith(separator) ? prefix.slice(0, -separator.length) : prefix;
    return <div className="grid gap-3">
      <p className="text-xs text-muted">Companion deliberately uses a full custom base. Edit the personal foundation here; persona, human and relationship memory stay separate.</p>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-ink-700">System prompt, personal part</span>
        <textarea aria-label="System prompt, personal part" value={personal} disabled={disabled} rows={8} className="field resize-y text-xs leading-relaxed" onChange={event => onChange(replaceCompanionPersonal(savedValue, event.target.value)!)} />
      </label>
      <div className="grid min-w-0 gap-1.5">
        <span className="text-xs font-medium text-muted">System prompt, technical part (read-only)</span>
        <pre aria-label="System prompt, technical part" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-tertiary p-3 text-xs leading-relaxed text-muted">{parts.technical}</pre>
      </div>
      <p className="text-xs text-muted">Saving personal edits preserves the stored technical text exactly. Technical upgrades require the separate preview, backup and confirmation workflow when offered; they never happen on Save.</p>
    </div>;
  }
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">System prompt</span>
      {value === null ? (
        <p className="text-xs text-muted">
          Letta-managed default. No custom override is stored; this does not mean the agent has no instructions.
        </p>
      ) : (
        <p className="text-xs text-muted">Stored custom base{value === "" ? " (empty)" : ""}.</p>
      )}
      <p className="text-xs text-muted">
        This is the stored base, not the full runtime prompt with compiled memory and tools. Companion keeps its personal foundation here; persona, human and relationship memory remain separate.
      </p>
      {value === null && <LettaDefaultReference />}
      {!unlocked ? (
        <>
          {value !== null && (
            <pre aria-label="Stored system prompt" className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-tertiary p-3 text-xs leading-relaxed text-muted">{value}</pre>
          )}
          <button type="button" className="justify-self-start text-xs text-accent hover:underline" disabled={disabled} onClick={() => setUnlocked(true)}>
            Edit custom base (advanced)
          </button>
        </>
      ) : (
        <>
          <p className="rounded-lg bg-error-light px-2.5 py-1.5 text-xs text-error">
            Companion deliberately uses a custom base rather than Letta’s managed default. Advanced edits change the stored instructions directly and can affect memory or tools. When a Companion technical update is offered, use its reviewed, backed-up upgrade workflow. Custom bases do not receive Letta’s automatic default-prompt updates.
          </p>
          <textarea
            aria-label="Custom system prompt"
            disabled={disabled}
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            rows={10}
            spellCheck={false}
            className="field resize-y font-mono text-xs leading-relaxed"
          />
        </>
      )}
    </div>
  );
}

function AgentForm({ initial, backendEpoch }: { initial: AgentDetails; backendEpoch: number }) {
  const models = useAppStore((state) => state.models);
  const updateAgent = useAppStore((state) => state.updateAgent);
  // What is saved on the server, so only real changes are sent.
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [model, setModel] = useState(initial.model);
  const [system, setSystem] = useState(initial.system);
  const [contextWindow, setContextWindow] = useState(initial.contextWindow);
  const [repairBusy, setRepairBusy] = useState(false);
  const [promptBackupPath, setPromptBackupPath] = useState<string | null>(null);
  const [promptNeedsRefresh, setPromptNeedsRefresh] = useState(false);
  const promptInvalid = useRef(false);
  const promptMutationPending = useRef(false);
  const [promptRefreshBusy, setPromptRefreshBusy] = useState(false);
  const refreshingPrompt = useRef(false);
  const [promptRefreshError, setPromptRefreshError] = useState<string | null>(null);
  const [promptMutationError, setPromptMutationError] = useState<string | null>(null);
  const [promptUpdateConfirmed, setPromptUpdateConfirmed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const maxContext = resolveModel(model, models)?.model.contextWindow ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const update: AgentUpdate = {
    ...(name.trim() !== saved.name ? { name } : {}),
    ...(description.trim() !== (saved.description ?? "") ? { description } : {}),
    ...(model && model !== saved.model ? { model } : {}),
    ...(system !== null && system !== saved.system ? { system } : {}),
    ...(contextWindow !== null && contextWindow !== saved.contextWindow ? { contextWindowLimit: contextWindow } : {}),
  };
  const changed = Object.keys(update).length > 0;

  const inPromptScope = () => {
    const state = useAppStore.getState();
    return mounted.current && state.agentId === initial.id && state.backendEpoch === backendEpoch;
  };
  const invalidatePrompt = () => {
    if (!inPromptScope() || promptInvalid.current || busy || system !== saved.system) return false;
    // The ref closes the gap before React commits the disabled controls.
    promptInvalid.current = true;
    promptMutationPending.current = true;
    setPromptNeedsRefresh(true);
    setPromptRefreshError(null);
    setPromptMutationError(null);
    setPromptUpdateConfirmed(false);
    return true;
  };
  const refreshPrompt = async () => {
    if (!inPromptScope() || !promptInvalid.current || promptMutationPending.current || refreshingPrompt.current) return;
    refreshingPrompt.current = true;
    setPromptRefreshBusy(true);
    setPromptRefreshError(null);
    try {
      // Recovery retries are reads only: never repeat the upgrade mutation.
      const agent = await window.bridge.getAgent(initial.id);
      if (!inPromptScope()) return;
      if (agent.id !== initial.id || (agent.system !== null && typeof agent.system !== "string")) {
        throw new Error("The runtime did not return this agent's authoritative system prompt.");
      }
      setSystem(agent.system);
      setSaved((previous) => ({ ...previous, system: agent.system }));
      setJustSaved(false);
      promptInvalid.current = false;
      setPromptNeedsRefresh(false);
    } catch (failure) {
      // The old editor contents are unsafe even after the busy promise settles.
      if (inPromptScope()) setPromptRefreshError(errorMessage(failure));
    } finally {
      refreshingPrompt.current = false;
      if (inPromptScope()) setPromptRefreshBusy(false);
    }
  };
  const refreshRestoredPrompt = async (backupPath: string) => {
    if (!inPromptScope()) return;
    promptMutationPending.current = false;
    setPromptBackupPath(backupPath);
    setPromptUpdateConfirmed(true);
    await refreshPrompt();
  };
  const recoverUncertainPrompt = async (message: string) => {
    if (!inPromptScope()) return;
    promptMutationPending.current = false;
    setPromptMutationError(message);
    setPromptUpdateConfirmed(false);
    await refreshPrompt();
  };

  const save = async () => {
    if (promptInvalid.current || repairBusy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await updateAgent(update);
      setSaved({ ...agent, system, contextWindow });
      setJustSaved(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 grid gap-5">
      <form
        className="grid gap-4"
        onChange={() => setJustSaved(false)}
        onSubmit={(event) => {
          event.preventDefault();
          if (changed && name.trim() && !busy && !repairBusy && !promptNeedsRefresh) void save();
        }}
      >
        <div className="border-b border-border pb-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Identity</p>
          <h2 className="mt-1 text-lg font-semibold text-ink-900">Who they are here</h2>
        </div>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} className="field" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Description</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Who this companion is"
            className="field"
          />
        </label>
        <div className="mt-2 border-b border-border pb-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Thinking</p>
          <h2 className="mt-1 text-lg font-semibold text-ink-900">Model, context and technical instructions</h2>
          <p className="mt-1 text-xs leading-5 text-muted">These controls change how the runtime supports this companion. They do not define the whole of who they are.</p>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Default model</span>
          <ModelPicker
            value={model}
            models={models}
            placement="bottom"
            onChange={(handle) => {
              setModel(handle);
              setJustSaved(false);
            }}
          />
          <span className="text-xs text-muted">
            Used for new chats. A chat keeps the model you pick for it.
          </span>
        </div>
        <ContextWindowField
          value={contextWindow}
          max={maxContext}
          onChange={(tokens) => {
            setContextWindow(tokens);
            setJustSaved(false);
          }}
        />
        <SystemPromptField value={system} savedValue={saved.system} disabled={busy || repairBusy || promptNeedsRefresh} onChange={value => { if (!promptInvalid.current) setSystem(value); }} />
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 break-words text-xs" role="status">
            {error ? (
              <span className="text-error">{error}</span>
            ) : (
              justSaved && !changed && <span className="text-success">Saved</span>
            )}
          </p>
          <button type="submit" className="button-primary" disabled={!changed || !name.trim() || busy || repairBusy || promptNeedsRefresh}>
            {busy && <Spinner className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </form>
      {promptBackupPath && <p role="status" className="break-words text-xs text-muted">{promptUpdateConfirmed ? "Companion technical instructions updated. " : "Backup from the last confirmed update. "}Private same-agent backup: <code>{promptBackupPath}</code>.</p>}
      {promptMutationError && <p role="alert" className="break-words text-xs text-error">The update attempt returned an error; its outcome was not confirmed. {promptMutationError}</p>}
      {promptNeedsRefresh && <section className="space-y-2 rounded-lg border border-border p-3 text-xs">
        <p>Prompt editing, Save and technical updates are locked until the current saved prompt can be verified. The displayed text may be out of date.</p>
        {promptRefreshError && <p role="alert" className="break-words text-error">Prompt refresh failed: {promptRefreshError}</p>}
        <button type="button" className="button-secondary" disabled={repairBusy || promptRefreshBusy} onClick={() => void refreshPrompt()}>Retry prompt refresh</button>
        {(repairBusy || promptRefreshBusy) && <p role="status">Waiting for the update and authoritative prompt refresh…</p>}
      </section>}
      {system === saved.system && !busy
        ? <PromptRepairPanel agentId={saved.id} system={saved.system} blocked={promptNeedsRefresh} onMutationStart={invalidatePrompt} onRestoreUncertain={recoverUncertainPrompt} onBusyChange={setRepairBusy} onRestored={refreshRestoredPrompt} />
        : system !== saved.system && saved.system !== null && companionPromptParts(saved.system)
          ? <p className="text-xs text-muted">Save personal prompt edits before reviewing a technical update.</p>
          : null}
      <AgentLookPanel agentId={saved.id} name={saved.name} />
      <ToolsetPanel agentId={saved.id} />
      <SecretsPanel agentId={saved.id} />
      <DreamSettingsPanel agentId={saved.id} />
      <DeleteAgent agent={saved} />
    </div>
  );
}

function AgentSettingsBody({ agentId, backendEpoch }: { agentId: string; backendEpoch: number }) {
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.bridge
      .getAgent(agentId)
      .then((agent) => {
        if (!cancelled) setDetails(agent);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, backendEpoch]);

  if (error) return <p className="mt-4 break-words text-sm text-error">{error}</p>;
  if (!details) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="h-5 w-5 text-muted" />
      </div>
    );
  }
  return <AgentForm key={`${backendEpoch}:${agentId}`} initial={details} backendEpoch={backendEpoch} />;
}

/** Rename, describe, re-model, re-prompt, or delete the selected agent: one page filling the window. */
export function AgentSettingsDialog() {
  const open = useAppStore((state) => state.agentSettingsOpen);
  const backendEpoch = useAppStore((state) => state.backendEpoch);
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name);
  const setAgentSettingsOpen = useAppStore((state) => state.setAgentSettingsOpen);

  return (
    <FullPage open={open} onOpenChange={setAgentSettingsOpen} title={agentName ? `${agentName}'s settings` : "Companion settings"} subtitle="Identity, models, tools and continuity">
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-2xl px-5 pb-8 pt-2 sm:px-8">
          {/* Mounted per open so the form always starts from the saved agent. */}
          {open && agentId && <AgentSettingsBody key={`${backendEpoch}:${agentId}`} agentId={agentId} backendEpoch={backendEpoch} />}
        </div>
      </div>
    </FullPage>
  );
}
