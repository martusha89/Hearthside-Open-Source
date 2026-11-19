import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { AppSettings, Diagnostics } from "../types";
import { Spinner } from "./icons";

/**
 * Hearthside: what to look at when something goes wrong, plus where the
 * runtime keeps agents (Hearthside's own folder, or your existing ~/.letta).
 */
export function DiagnosticsPanel({ settings }: { settings: AppSettings }) {
  const reconnect = useAppStore((state) => state.reconnect);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const connection = useAppStore((state) => state.connection);
  const [info, setInfo] = useState<Diagnostics | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => void window.bridge.getDiagnostics().then(setInfo).catch(() => undefined);
  useEffect(load, []);

  const switchHome = async (value: boolean) => {
    if (value && !window.confirm("Hearthside will copy your ~/.letta folder to ~/.letta-backups first, then use it directly. Agents you made in Hearthside's own folder stay there. Continue?")) return;
    setBusy(true);
    try {
      const { backup } = await window.bridge.setUseRealLettaHome(value);
      setNotice(value ? (backup ? `Backed up to ${backup}. Now using your ~/.letta.` : "Now using your ~/.letta.") : "Now using Hearthside's own folder.");
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <Spinner className="mt-6 h-5 w-5 text-muted" />;
  return (
    <div className="mt-4 grid gap-4 text-sm">
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Hearthside</dt>
        <dd className="text-ink-800">{info.appVersion}</dd>
        <dt className="text-muted">Letta runtime</dt>
        <dd className="text-ink-800">{info.runtimeVersion ?? "unknown"}</dd>
        <dt className="text-muted">Electron</dt>
        <dd className="text-ink-800">{info.electronVersion}</dd>
        <dt className="text-muted">System</dt>
        <dd className="text-ink-800">{info.platform}</dd>
        <dt className="text-muted">Connection</dt>
        <dd className="text-ink-800">
          {connection?.status === "ready" ? `Connected (${connection.detail})` : connection?.status === "error" ? `Not connected: ${connection.error}` : "Connecting"}
        </dd>
        <dt className="text-muted">Agents folder</dt>
        <dd className="break-all font-mono text-ink-800">{info.lettaHome}</dd>
      </dl>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.runtimeDebugLog}
          onChange={(event) => void saveSettings({ runtimeDebugLog: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Detailed runtime log</span>
          <span className="block text-xs text-muted">
            Letta writes everything it does to letta-runtime-debug.log in the log folder, with timings. Turn it on to trace a slow or stuck reply, then send the
            file to us. The runtime restarts when you change this.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button-secondary" onClick={reconnect}>
          Restart the runtime
        </button>
        <button type="button" className="button-secondary" onClick={() => void window.bridge.openLogFolder()}>
          Open log folder
        </button>
        <button type="button" className="button-secondary" onClick={load}>
          Refresh
        </button>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.useRealLettaHome}
          disabled={busy}
          onChange={(event) => void switchHome(event.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-ink-900">Use my existing Letta Code folder (~/.letta)</span>
          <span className="block text-xs text-muted">
            For people moving over from Letta Code: your local agents, memory and chats appear here. Hearthside backs the folder up first.
          </span>
        </span>
      </label>
      {notice && <p className="text-xs text-ink-700" role="status">{notice}</p>}

      <div className="grid gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-ink-700">Recent log</span>
          <span className="truncate pl-2 font-mono text-[10px] text-muted">{info.logPath}</span>
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-tertiary p-2.5 font-mono text-[10px] leading-relaxed text-ink-700">
          {info.logTail || "(empty)"}
        </pre>
      </div>
    </div>
  );
}
