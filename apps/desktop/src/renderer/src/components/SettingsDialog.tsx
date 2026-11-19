// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useState } from "react";
import { ExecutionComputerPicker } from "./ExecutionComputerPicker";
import { useAppStore, type SettingsTab } from "../store";
import type { AppSettings, BackendKind, SettingsUpdate } from "../types";
import { AppearanceSettings, GeneralSettings } from "./GeneralSettings";
import { FullPage } from "./FullPage";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { AboutSettings } from "./AboutSettings";
import { BackupSettings } from "./BackupSettings";
import { LettaSignIn } from "./LettaSignIn";
import { ProvidersPanel } from "./ProvidersPanel";
import { ReachableComputer } from "./ReachableComputer";
import { Spinner } from "./icons";
import { IntentionsPanel } from "./IntentionsPanel";
import { ModsPanel } from "./ModsPanel";


function BetaPill() {
  return <span className="ml-1.5 rounded-full bg-accent-subtle px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-accent">Beta</span>;
}

const TABS: Array<{ id: SettingsTab; label: string; beta?: boolean }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "connection", label: "Connection" },
  { id: "providers", label: "Model providers" },
  { id: "backups", label: "Backups" },
  { id: "mods", label: "Mods" },
  { id: "intentions", label: "Intentions", beta: true },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "about", label: "About" },
];

const BACKENDS: Array<{ kind: BackendKind; label: string; detail: string }> = [
  {
    kind: "local",
    label: "This computer",
    detail: "Agents and their memory are stored on this machine. No account needed.",
  },
  {
    kind: "cloud",
    label: "Letta Cloud",
    detail: "Agents are stored in Letta Cloud. Choose which computer runs their tools below.",
  },
  {
    kind: "remote",
    label: "Self-hosted server",
    detail: "Connect to a Letta app server you run yourself.",
  },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

function SettingsForm({ settings, onClose }: { settings: AppSettings; onClose: () => void }) {
  const connection = useAppStore((state) => state.connection);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const reconnect = useAppStore((state) => state.reconnect);

  const [backend, setBackend] = useState(settings.backend);
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl);
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [serverToken, setServerToken] = useState("");
  const [executionComputer, setExecutionComputer] = useState(settings.executionComputer ?? null);
  const credentialsDirty = Boolean(apiKey.trim()) || apiBaseUrl.trim() !== settings.apiBaseUrl.trim();
  useEffect(() => {
    setExecutionComputer(settings.executionComputer ?? null);
  }, [settings.connectionRevision, settings.executionComputer, credentialsDirty]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const update: SettingsUpdate = { backend };
    if (backend === "cloud") {
      update.apiBaseUrl = apiBaseUrl;
      update.executionComputer = credentialsDirty ? settings.executionComputer ?? null : executionComputer;
      // An empty field keeps the saved key.
      if (apiKey.trim()) update.apiKey = apiKey;
    }
    if (backend === "remote") {
      update.serverUrl = serverUrl;
      if (serverToken.trim()) update.serverToken = serverToken;
    }
    try {
      await saveSettings(update);
      setApiKey("");
      setServerToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const canSave = backend !== "remote" || serverUrl.trim().length > 0;

  return (
    <form
      className="mt-4 grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-medium text-ink-700">Where Hearthside runs your agents</legend>
        {BACKENDS.map((option) => (
          <label
            key={option.kind}
            className={`flex cursor-pointer gap-3 rounded-xl border px-3.5 py-3 transition-colors ${backend === option.kind ? "border-accent bg-accent-subtle" : "border-border hover:bg-surface-tertiary"}`}
          >
            <input
              type="radio"
              name="backend"
              className="mt-1 accent-[var(--color-accent)]"
              checked={backend === option.kind}
              onChange={() => setBackend(option.kind)}
            />
            <span>
              <span className="block text-sm font-medium text-ink-900">{option.label}</span>
              <span className="block text-xs text-muted">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {backend === "cloud" && (
        <div className="grid gap-3">
          <LettaSignIn settings={settings} />
          <Field
            label={settings.hasLettaSignIn ? "API key (not needed while signed in)" : "Or use an API key"}
            hint={
              settings.hasApiKey
                ? "A key is saved. Enter a new one to replace it."
                : "Create one at app.letta.com/settings. Leave empty if you ran `letta login`."
            }
          >
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings.hasApiKey ? "Saved" : "sk-let-..."}
              className="field font-mono"
            />
          </Field>
          <Field label="API base URL" hint="Optional. Leave empty for api.letta.com.">
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="https://api.letta.com"
              className="field font-mono"
            />
          </Field>
          <ExecutionComputerPicker
            value={executionComputer}
            onChange={setExecutionComputer}
            connectionRevision={settings.connectionRevision}
            disabled={saving || credentialsDirty || settings.backend !== "cloud"}
            saveFirst={credentialsDirty || settings.backend !== "cloud"}
          />
          {/* Once connected to Letta Cloud: keep this computer reachable for messages sent from elsewhere. */}
          {settings.backend === "cloud" && <ReachableComputer settings={settings} />}
        </div>
      )}

      {backend === "remote" && (
        <div className="grid gap-3">
          <Field
            label="Server URL"
            hint="Start one with: letta server --backend local --listen ws://127.0.0.1:4500"
          >
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="ws://127.0.0.1:4500"
              className="field font-mono"
            />
          </Field>
          <Field
            label="Access token"
            hint={
              settings.hasServerToken
                ? "A token is saved. Enter a new one to replace it."
                : "Only needed if the server was started with --ws-auth."
            }
          >
            <input
              type="password"
              autoComplete="off"
              value={serverToken}
              onChange={(event) => setServerToken(event.target.value)}
              placeholder={settings.hasServerToken ? "Saved" : "Optional"}
              className="field font-mono"
            />
          </Field>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <div className="min-w-0 flex-1 text-xs" role="status">
          {error ? (
            <span className="text-error">{error}</span>
          ) : connection && connection.backend !== backend ? (
            // Hearthside: the status below belongs to the current connection, not the one being chosen.
            <span className="text-muted">Save to switch to {backend === "local" ? "this computer" : backend === "cloud" ? "Letta Cloud" : "your server"}.</span>
          ) : !connection || connection.status === "connecting" ? (
            <span className="flex items-center gap-2 text-muted">
              <Spinner className="h-3 w-3" />
              Connecting
            </span>
          ) : connection.status === "ready" ? (
            <span className="text-success">Connected to {connection.detail}</span>
          ) : (
            <span className="flex items-start gap-2 text-error">
              <span className="min-w-0 break-words">{connection.error}</span>
              <button type="button" className="shrink-0 underline" onClick={reconnect}>
                Retry
              </button>
            </span>
          )}
        </div>
        <button type="button" className="button-secondary" onClick={onClose}>
          Close
        </button>
        <button type="submit" className="button-primary" disabled={!canSave || saving}>
          Save
        </button>
      </div>
    </form>
  );
}

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const tab = useAppStore((state) => state.settingsTab);
  const settings = useAppStore((state) => state.settings);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const openSettings = useAppStore((state) => state.openSettings);
  const current = TABS.find((item) => item.id === tab) ?? TABS[0]!;

  return (
    <FullPage open={open} onOpenChange={setSettingsOpen} title="Settings">
      {/* Hearthside: the categories down the left; on a narrow window the list scrolls on its own. */}
      <nav
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings categories"
        className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface-secondary p-2 sm:w-52 sm:p-3"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => openSettings(item.id)}
            className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${tab === item.id ? "bg-accent-subtle font-medium text-ink-900" : "text-ink-600 hover:bg-surface-tertiary hover:text-ink-900"}`}
          >
            {item.label}
            {item.beta && <BetaPill />}
          </button>
        ))}
      </nav>
      <div role="tabpanel" aria-label={current.label} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-2xl px-5 py-6 sm:px-8">
          <h2 className="text-lg font-semibold text-ink-900">{current.label}{current.beta && <BetaPill />}</h2>
          {/* Mounted per open so the form always starts from the saved settings. */}
          {open && tab === "connection" && settings && (
            <SettingsForm settings={settings} onClose={() => setSettingsOpen(false)} />
          )}
          {open && tab === "providers" && <ProvidersPanel />}
          {open && tab === "general" && settings && <GeneralSettings settings={settings} />}
          {open && tab === "appearance" && settings && <AppearanceSettings settings={settings} />}
          {open && tab === "diagnostics" && settings && <DiagnosticsPanel settings={settings} />}
          {open && tab === "about" && <AboutSettings />}
          {open && tab === "backups" && <BackupSettings />}
          {open && tab === "mods" && <ModsPanel />}
          {open && tab === "intentions" && <IntentionsPanel />}
        </div>
      </div>
    </FullPage>
  );
}
