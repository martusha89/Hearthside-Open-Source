import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { AppSettings, ComputerStatusInfo } from "../types";

/**
 * Hearthside: keep this computer reachable from Letta Cloud (Letta's "remote
 * computer"), so a message from the Letta website or app, or a schedule, can
 * run its tools here, without leaving a terminal window open.
 */
export function ReachableComputer({ settings }: { settings: AppSettings }) {
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [status, setStatus] = useState<ComputerStatusInfo | null>(null);
  const [name, setName] = useState(settings.computerName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.bridge.getComputerStatus().then((value) => live && setStatus(value)).catch(() => undefined);
    const off = window.bridge.onEvent((event) => {
      if (event.type === "computer.status") setStatus(event.status);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  useEffect(() => setName(settings.computerName), [settings.computerName]);

  const save = (update: { reachableComputer?: boolean; computerName?: string }) => {
    setError(null);
    void saveSettings(update).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  const shown = status?.name ?? (name || "this computer");
  const line =
    !settings.reachableComputer || !status || status.state === "off"
      ? null
      : status.state === "connected" || status.state === "working"
        ? { tone: "text-success", text: `Reachable as ${shown}${status.state === "working" ? " · working on something now" : ""}` }
        : status.state === "starting"
          ? { tone: "text-muted", text: `Connecting as ${shown}…` }
          : status.state === "reconnecting"
            ? { tone: "text-muted", text: `Reconnecting${status.error ? `: ${status.error}` : "…"}` }
            : { tone: "text-error", text: `Not reachable: ${status.error ?? "the Letta listener stopped."}` };

  return (
    <div className="grid gap-2 rounded-xl border border-border px-3.5 py-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.reachableComputer}
          onChange={(event) => save({ reachableComputer: event.target.checked })}
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm text-ink-900">Keep this computer reachable from Letta Cloud</span>
          <span className="block text-xs text-muted">
            While Hearthside is open, your agents can work on this computer when you message them from the Letta website or app, or from a schedule. No terminal window needed. Approvals for those messages are answered where you sent them from.
          </span>
        </span>
      </label>
      {settings.reachableComputer && (
        <label className="ml-7 grid gap-1">
          <span className="text-xs font-medium text-ink-700">Name on Letta</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() !== settings.computerName && save({ computerName: name })}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
            placeholder={status?.name ?? "Its existing name, or this computer's own"}
            className="field"
            maxLength={80}
          />
        </label>
      )}
      {line && (
        <p className={`ml-7 break-words text-xs ${line.tone}`} role="status">
          {line.text}
        </p>
      )}
      {error && <p className="ml-7 break-words text-xs text-error">{error}</p>}
    </div>
  );
}
