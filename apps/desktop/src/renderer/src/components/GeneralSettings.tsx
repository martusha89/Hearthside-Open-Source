// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { AppSettings, SettingsUpdate, TextSize, ThemePreference } from "../types";
import { MyPicturePanel } from "./LookSettings";
import { updateFailureText } from "../lib/update-install";

const THEMES: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const TEXT_SIZES: Array<{ id: TextSize; label: string }> = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-xl bg-surface-tertiary p-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            onClick={() => onChange(option.id)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${value === option.id ? "bg-surface font-medium text-ink-900 shadow-soft" : "text-ink-600 hover:text-ink-900"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Save a change straight away, keeping the error to show. */
function useSave() {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [error, setError] = useState<string | null>(null);
  const save = (update: SettingsUpdate) => {
    setError(null);
    void saveSettings(update).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  return { save, error };
}

/** Hearthside: how the whole app looks (each companion's own colour and picture live in its Agent settings). */
export function AppearanceSettings({ settings }: { settings: AppSettings }) {
  const { save, error } = useSave();
  return (
    <div className="mt-4 grid gap-5">
      <Segmented label="Theme" options={THEMES} value={settings.theme} onChange={(theme) => save({ theme })} />
      <Segmented
        label="Text size"
        options={TEXT_SIZES}
        value={settings.textSize}
        onChange={(textSize) => save({ textSize })}
      />
      <MyPicturePanel />
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}

/** Hearthside: display and app preferences. Changes apply immediately. */
export function GeneralSettings({ settings }: { settings: AppSettings }) {
  const { save, error } = useSave();

  return (
    <div className="mt-4 grid gap-5">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.showReasoning}
          onChange={(event) => save({ showReasoning: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Show the agent's reasoning</span>
          <span className="block text-xs text-muted">The "Thought" sections in chat. The agent still reasons when they are hidden.</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.showUsage}
          onChange={(event) => save({ showUsage: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Show how full the context is</span>
          <span className="block text-xs text-muted">A small gauge by the message box, with token usage when you click it.</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.showCompactions}
          onChange={(event) => save({ showCompactions: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Show when older messages were summarised</span>
          <span className="block text-xs text-muted">A divider in the chat where the agent made room; open it to read the summary.</span>
        </span>
      </label>
      {window.bridge.platform !== "darwin" && (
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.closeToTray}
            onChange={(event) => save({ closeToTray: event.target.checked })}
            className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-sm text-ink-900">Keep running in the tray when closed</span>
            <span className="block text-xs text-muted">The close button hides Hearthside by the clock, so your agent stays reachable. Quit from the tray icon.</span>
          </span>
        </label>
      )}
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.notifications}
          onChange={(event) => save({ notifications: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Notifications</span>
          <span className="block text-xs text-muted">When Hearthside isn't in front: when your agent replies, or needs your approval or an answer.</span>
        </span>
      </label>
      {window.bridge.platform !== "darwin" && (
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.startAtLogin}
            onChange={(event) => save({ startAtLogin: event.target.checked })}
            className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-sm text-ink-900">Start Hearthside when Windows starts</span>
            <span className="block text-xs text-muted">It opens quietly in the tray, so your agent is reachable without opening the window. Works in the installed app.</span>
          </span>
        </label>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <AppVersion />
      <ReplayTour />
    </div>
  );
}

/** Hearthside: start the guided tour again. */
function ReplayTour() {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  return (
    <button
      type="button"
      className="justify-self-start text-xs text-accent hover:underline"
      onClick={() => {
        setSettingsOpen(false);
        void saveSettings({ toured: false });
      }}
    >
      Show me around again
    </button>
  );
}

/** Hearthside: which version is installed. */
function AppVersion() {
  const macDiagnostic = window.bridge.platform === "darwin";
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    void window.bridge.getAppVersion().then(setVersion).catch(() => undefined);
  }, []);
  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      const outcome = await window.bridge.checkForUpdates();
      setResult(
        outcome.status === "up-to-date"
          ? "You have the latest version."
          : outcome.status === "downloading"
            ? `Version ${outcome.version} is downloading. A "Restart to update" button appears here when it's ready.`
            : outcome.status === "ready"
              ? `Version ${outcome.version} is ready.`
              : outcome.status === "not-installed"
                ? "Updates work in the installed app, not in development."
                : `Couldn't check for updates: ${outcome.message}`,
      );
    } catch (failure) {
      setResult(`Couldn't check for updates: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setChecking(false);
    }
  };
  // Hearthside: a downloaded update can be installed from here too, not only from the
  // sidebar banner (which "Later" hides until the next start).
  const ready = useAppStore((state) => state.updateReady);
  const [installing, setInstalling] = useState(false);
  if (!version) return null;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted">
          Hearthside {version}. {macDiagnostic ? "Mac diagnostic builds are updated manually." : "Updates download by themselves in the installed app."}
        </p>
        {!macDiagnostic && (ready ? (
          <button
            type="button"
            className="button-primary px-3 py-1 text-xs"
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              setResult(null);
              void window.bridge.installUpdate().catch((failure: unknown) => {
                setResult(updateFailureText(failure));
                setInstalling(false);
              });
            }}
          >
            {installing ? "Restarting…" : `Restart to update to ${ready.version}`}
          </button>
        ) : (
          <button type="button" className="button-secondary px-3 py-1 text-xs" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
        ))}
      </div>
      {result && (
        <p role="status" className="text-xs text-ink-800">
          {result}
        </p>
      )}
    </div>
  );
}
