import React, { useEffect, useState } from "react";
import type { ExecutionComputer, ExecutionComputerTarget } from "@hearthside/ipc-contract";

export function ExecutionComputerOptions({ computers, value }: { computers: ExecutionComputer[]; value: ExecutionComputerTarget | null }) {
  return <>
    <option value="">This computer</option>
    {value && !computers.some((computer) => computer.deviceId === value.deviceId) && (
      <option value={value.deviceId} disabled>{value.name} — unavailable</option>
    )}
    {computers.map((computer) => (
      <option key={computer.deviceId} value={computer.deviceId} disabled={computer.status !== "online"}>
        {computer.name}{computer.status === "offline" ? " — offline (unavailable)" : ""}
      </option>
    ))}
  </>;
}

export function ExecutionComputerPicker({ value, onChange, connectionRevision, disabled, saveFirst }: {
  value: ExecutionComputerTarget | null;
  onChange: (value: ExecutionComputerTarget | null) => void;
  connectionRevision?: string;
  disabled: boolean;
  saveFirst: boolean;
}) {
  const [computers, setComputers] = useState<ExecutionComputer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setComputers([]);
    setError(null);
    if (saveFirst) { setLoading(false); return; }
    setLoading(true);
    void window.bridge.listExecutionComputers().then((items) => {
      if (live) setComputers(items);
    }).catch((failure: unknown) => {
      if (live) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [connectionRevision, refresh, saveFirst]);
  const selected = computers.find((computer) => computer.deviceId === value?.deviceId);
  return <section className="grid gap-2">
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">Run tools on</span>
      <select className="field" value={value?.deviceId ?? ""} disabled={disabled || loading} onChange={(event) => {
        const computer = computers.find((item) => item.deviceId === event.target.value && item.status === "online");
        if (!event.target.value) onChange(null);
        else if (computer) onChange({ deviceId: computer.deviceId, name: computer.name });
      }}>
        <ExecutionComputerOptions computers={computers} value={value} />
      </select>
    </label>
    <div className="flex items-center gap-2 text-xs" role="status">
      <span className={error ? "text-error" : "text-muted"}>
        {saveFirst ? "Save connection first to choose a computer." : loading ? "Loading computers…" : error ?? (computers.length === 0 ? "No connected computers found." : "Choose an online computer.")}
      </span>
      <button type="button" className="button-secondary" disabled={disabled || loading} onClick={() => setRefresh((count) => count + 1)}>Refresh</button>
    </div>
    {value && !loading && !saveFirst && selected?.status !== "online" && <p className="text-xs text-error">{value.name} is unavailable. It remains selected; tools will not fall back to this computer.</p>}
    {value && <p className="text-xs text-muted">Remote working folder: {selected?.workingDirectory || "Uses the selected computer’s working folder"}</p>}
    <p className="text-xs text-muted">Your Cloud agent and history stay unchanged. This chooses where chat tools execute.</p>
    {value && <details className="text-xs text-muted">
      <summary className="cursor-pointer">Remote execution: first-version limits</summary>
      <p className="mt-2">The selected computer must be online. Its own runtime tools and integrations stay there. Desktop-only extras (Hearthside connectors, vault, calendar and image tools) are not registered for remote chats. This desktop's bot gateway is paused; existing bots on the remote computer are left alone. Remote file downloads/previews and the desktop runtime-command runner are not available yet.</p>
    </details>}
  </section>;
}
