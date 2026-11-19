import React, { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { AppSettings, ConversationExecutionState, ConversationExecutionTarget, ExecutionComputer } from "@hearthside/ipc-contract";
import { useAppStore } from "../store";
import { ChevronDownIcon, MonitorIcon } from "./icons";
import { executionDestinationNotice } from "../lib/execution-guidance";

export function destinationLabel(target: ConversationExecutionTarget, settings: AppSettings | null): string {
  if (target.kind === "follow-owner") return "Follow current owner (across devices)";
  if (target.kind === "cloud") return "Cloud sandbox";
  if (target.kind === "computer") return target.name;
  if (target.kind === "desktop") return "Desktop";
  if (target.kind === "desktop-listener") return "Desktop · native handoff";
  return `Configured default (${settings?.backend === "cloud" ? settings.executionComputer?.name ?? "Desktop" : settings?.backend === "remote" ? "Self-hosted server" : "Desktop"})`;
}

export function observationLabel(execution?: ConversationExecutionState): string {
  if (!execution?.observed) return "Execution location unknown";
  const observed = execution.observed;
  const label = observed.kind === "cloud" ? "Cloud sandbox" : observed.kind === "desktop" ? "Desktop" : observed.name ?? "Another computer";
  return `Last observed: ${label} · ${new Date(observed.observedAt).toLocaleTimeString()}`;
}

export function nextDestinationLabel(execution: ConversationExecutionState | undefined, settings: AppSettings | null): string {
  if (execution?.requiresDestination) return execution.canMoveExecution || execution.canFollowCurrentOwner ? "Choose destination" : "Check execution status";
  if (!execution?.followsOwner) return destinationLabel(execution?.selected ?? { kind: "default" }, settings);
  const observed = execution.observed;
  const location = observed?.kind === "cloud" ? "Cloud sandbox" : observed?.name;
  return location ? `Current location (${location})` : "Current destination";
}

export function localFolderAvailable(settings: AppSettings | null, execution: ConversationExecutionState | undefined, conversationId: string | null): boolean {
  if (conversationId && (!execution || execution.status === "blocked")) return false;
  if (execution?.followsOwner || execution?.requiresDestination) return false;
  // A same-machine registered listener is still a separate runtime, not
  // authority to apply this app's cwd or desktop callbacks.
  if (!execution?.moveFrom && execution?.provenance !== "desktop" && execution?.observed && execution.observed.kind !== "desktop") return false;
  const target = execution?.selected;
  if (target && target.kind !== "default") return target.kind === "desktop";
  return settings?.backend !== "remote" && !(settings?.backend === "cloud" && settings.executionComputer);
}

/** Selection affects the next turn only; runtime observations never imply a live attachment. */
export function ConversationExecution({ compact = false }: { compact?: boolean }) {
  const id = useAppStore((state) => state.activeId);
  const settings = useAppStore((state) => state.settings);
  const chat = useAppStore((state) => id ? state.chats[id] : undefined);
  const pending = useAppStore((state) => state.pendingFirstMessage !== null);
  const ready = useAppStore((state) => state.connection?.status === "ready");
  const refresh = useAppStore((state) => state.refreshExecution);
  const choose = useAppStore((state) => state.setExecution);
  const epoch = useAppStore((state) => state.backendEpoch);
  const discoveryGeneration = useRef(0);
  useEffect(() => { discoveryGeneration.current++; setComputers([]); setComputerError(null); }, [epoch, id]);
  const [computers, setComputers] = useState<ExecutionComputer[]>([]);
  const [computerError, setComputerError] = useState<string | null>(null);
  const execution = chat?.execution;
  useEffect(() => {
    if (!id || !ready) return;
    const check = () => { if (document.visibilityState === "visible") void refresh(id, { background: true }); };
    check();
    const timer = setInterval(check, 4_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [id, ready, refresh]);
  const disabled = !id || !ready || !execution || Boolean(execution.pendingDelivery) || pending || !!chat?.executionSaving || !!chat?.executionLoading;
  const refreshDisabled = !id || !ready || !!chat?.executionSaving || !!chat?.executionLoading;
  const guidance = executionDestinationNotice(execution, Boolean(chat?.running));
  const label = id && !execution ? (chat?.executionError ? "Destination unavailable" : "Loading destination…") : nextDestinationLabel(execution, settings);
  const options: ConversationExecutionTarget[] = [{ kind: "default" }, { kind: "desktop" }, ...(settings?.backend === "cloud" ? [{ kind: "follow-owner" } as const, { kind: "desktop-listener" } as const, { kind: "cloud" } as const, ...computers.filter((c) => c.status === "online").map((c) => ({ kind: "computer" as const, deviceId: c.deviceId, name: c.name }))] : [])];
  return <DropdownMenu.Root onOpenChange={(open) => {
    if (open && settings?.backend === "cloud") {
      const generation = ++discoveryGeneration.current;
      const current = () => generation === discoveryGeneration.current && useAppStore.getState().backendEpoch === epoch && useAppStore.getState().activeId === id;
      void window.bridge.listExecutionComputers().then((items) => { if (current()) { setComputers(items); setComputerError(null); } }, (error: unknown) => { if (current()) setComputerError(String(error)); });
    }
  }}>
    <DropdownMenu.Trigger className={`chip min-w-0 whitespace-nowrap ${compact ? "composer-destination" : "max-w-[14rem]"}`} title={`Next turn: ${label}`} aria-label={`Execution destination: ${label}`}>
      <MonitorIcon className="h-3.5 w-3.5 shrink-0" />
      {/* Compact (in the composer): icon only, like the folder and permission chips; the full text stays in the tooltip and accessible name. A mark shows when the chat needs attention. */}
      {compact
        ? (execution?.requiresDestination || execution?.status === "blocked") && <span className="text-warning-strong">!</span>
        : <><span className="truncate">Next: {label}</span><ChevronDownIcon className="h-3 w-3 shrink-0" /></>}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-elevated">
      <DropdownMenu.Label className="px-2 py-1 text-sm font-medium">Next-turn destination</DropdownMenu.Label>
      <p className="px-2 pb-2 text-xs text-muted">Opening this chat does not move execution. Your choice applies to this chat's next send, not an active turn. Remote tools and files may differ.</p>
      {chat?.executionLoading
        ? <p role="status" className="px-2 pb-2 text-xs text-muted">Checking execution status…</p>
        : !ready ? <p role="status" className="px-2 pb-2 text-xs text-muted">Reconnect to check execution status. No destination has been changed.</p>
        : guidance && <p role="status" className="px-2 pb-2 text-xs text-muted">{guidance}</p>}
      {options.map((target) => <DropdownMenu.Item key={target.kind === "computer" ? target.deviceId : target.kind} disabled={disabled || !(target.kind === "follow-owner" ? execution?.canFollowCurrentOwner : execution?.canMoveExecution) || (target.kind !== "follow-owner" && !!chat?.running && execution?.status !== "blocked") || (target.kind === "desktop-listener" && !settings?.reachableComputer)} onSelect={() => { if (id) void choose(id, target); }} className="cursor-pointer rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-tertiary data-[disabled]:opacity-50">{destinationLabel(target, settings)}{JSON.stringify(target) === JSON.stringify(execution?.selected) ? " ✓" : ""}</DropdownMenu.Item>)}
      {settings?.backend === "cloud" && <p className="px-2 py-2 text-xs text-muted">{settings.reachableComputer ? "Desktop handoff needs this PC's registered listener online." : "Desktop handoff requires Remote Access, enabled by you in Settings."} After a move, use the destination runtime for approvals and Stop.</p>}
      {execution?.selected.kind === "computer" && !options.some((target) => target.kind === "computer" && execution.selected.kind === "computer" && target.deviceId === execution.selected.deviceId) && <DropdownMenu.Item disabled className="rounded-lg px-2 py-2 text-sm opacity-50">{execution.selected.name} — unavailable (selected)</DropdownMenu.Item>}
      <DropdownMenu.Separator className="my-1 border-t border-border" />
      <DropdownMenu.Item data-execution-refresh disabled={refreshDisabled} onSelect={(event) => {
        event.preventDefault(); // Keep the chooser open while the read completes.
        if (id) void refresh(id);
      }} className="cursor-pointer rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-tertiary data-[disabled]:opacity-50">
        {chat?.executionLoading ? "Checking execution status…" : "Refresh execution status"}
      </DropdownMenu.Item>
      <div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted" role="status">
        <p>{observationLabel(execution)}</p>
        {!localFolderAvailable(settings, execution, id) && <p className="mt-1">{execution?.requiresDestination
          ? execution.canMoveExecution || execution.canFollowCurrentOwner ? "Choose an execution destination before working with files." : "Folder controls stay unavailable until execution is verified."
          : execution?.status === "blocked" ? "Folder controls are unavailable until this conversation's execution is recovered."
          : !execution && id ? "Folder controls are available once this conversation's execution is known."
          : "The destination manages its working folder. Change it there; this window does not expose local folders for that destination."}</p>}
        {execution?.followsOwner && <p className="mt-1">Messages follow the conversation's current destination without moving it. That runtime keeps its model, permissions, and tools.</p>}
        {execution?.detail && <p className="mt-1">{execution.detail}</p>}
        {execution?.status === "blocked" && <p className="mt-1">Messages are held. This window cannot follow, stop, or approve the native turn elsewhere. {execution.pendingDelivery ? "The retained delivery must be reconciled before changing destination; uncertain acceptance cannot be cleared here." : execution.canFollowCurrentOwner ? "You can explicitly follow its current owner without moving it. Moving execution must wait until it is idle." : "Wait for a verified destination before changing execution."} Queued messages stay paused.</p>}
        {!id && <p className="mt-1">Start a chat before choosing its destination.</p>}
        {(chat?.running || pending) && <p className="mt-1">Wait until the turn is idle to change the next destination.</p>}
        {chat?.executionSaving && <p>Saving destination…</p>}
        {(chat?.executionError || computerError) && <p role="alert">{chat?.executionError || computerError}</p>}
      </div>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
