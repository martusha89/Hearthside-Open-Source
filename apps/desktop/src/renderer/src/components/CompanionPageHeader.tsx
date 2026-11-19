import type { ReactNode } from "react";
import { useAppStore } from "../store";
import { Avatar } from "./Avatar";

export function CompanionPageHeader({ title, leading, trailing }: { title: string; leading?: ReactNode; trailing?: ReactNode }) {
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId));
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : undefined));

  return (
    <header className="app-drag sticky top-0 z-20 grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-3 border-b border-border bg-surface/90 px-3 backdrop-blur-xl">
      <div className="min-w-0 justify-self-start [&>button]:max-w-full">{leading}</div>
      <div className="flex min-w-0 max-w-full items-center justify-self-center gap-2.5">
        {agent && <Avatar name={agent.name} src={look?.avatar} px={30} />}
        <span className="min-w-0">
          <strong className="block truncate text-sm font-semibold text-ink-900">{agent?.name ?? "Companion"}</strong>
          <span className="block truncate text-xs text-muted" title={title}>{title}</span>
        </span>
      </div>
      <div className="min-w-0 justify-self-end">{trailing}</div>
    </header>
  );
}
