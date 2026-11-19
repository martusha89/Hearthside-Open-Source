import { useEffect, useMemo, useState } from "react";
import { modelLabel, relativeTime } from "../lib/format";
import { useAppStore } from "../store";
import { Avatar } from "./Avatar";
import { CompanionPageHeader } from "./CompanionPageHeader";
import { CalendarIcon, ClockIcon, MemoryIcon, PlusIcon, SendIcon } from "./icons";

function Territory({
  icon,
  eyebrow,
  title,
  detail,
  onOpen,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  detail: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative min-h-28 overflow-hidden rounded-[1.4rem] border border-border bg-surface-secondary p-4 text-left shadow-soft transition duration-200 hover:-translate-y-0.5 hover:border-border-hover hover:shadow-card"
    >
      <span className="absolute right-4 top-4 text-accent opacity-45 transition-opacity group-hover:opacity-80">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{eyebrow}</span>
      <strong className="mt-3 block text-lg font-semibold text-ink-900">{title}</strong>
      <span className="mt-1 block max-w-xs text-sm leading-6 text-ink-600">{detail}</span>
    </button>
  );
}

export function PresenceView() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const agentId = useAppStore((state) => state.agentId);
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId) ?? null);
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : null));
  const models = useAppStore((state) => state.models);
  const connection = useAppStore((state) => state.connection);
  const conversations = useAppStore((state) => state.conversations);
  const chats = useAppStore((state) => state.chats);
  const unread = useAppStore((state) => state.unread);
  const memory = useAppStore((state) => state.memory);
  const loadMemory = useAppStore((state) => state.loadMemory);
  const channelService = useAppStore((state) => state.channelService);
  const openChat = useAppStore((state) => state.openChat);
  const openMemory = useAppStore((state) => state.openMemory);
  const openCalendar = useAppStore((state) => state.openCalendar);
  const openSchedules = useAppStore((state) => state.openSchedules);
  const openChannels = useAppStore((state) => state.openChannels);

  useEffect(() => {
    if (agentId && memory === null) void loadMemory();
  }, [agentId, memory, loadMemory]);

  const recent = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [conversations],
  );
  const main = conversations.find((conversation) => conversation.main) ?? null;
  const running = conversations.filter((conversation) => chats[conversation.id]?.running).length;
  const waiting = conversations.filter((conversation) => (chats[conversation.id]?.approvals.length ?? 0) > 0 || unread[conversation.id] === "waiting").length;
  const replies = conversations.filter((conversation) => unread[conversation.id] === "replied").length;
  const memoryDetail = memory?.loading
    ? "Reading the memory landscape…"
    : memory?.error
      ? "The memory landscape is temporarily unavailable."
      : memory?.enabled === false
        ? "This companion does not use file-based memory."
        : `${memory?.files.length ?? 0} memory files, with their history and living connections.`;
  const reachDetail = channelService?.state === "failed" || channelService?.state === "blocked"
    ? "One or more channels need attention."
    : channelService?.state === "running"
      ? "Connected beyond the desktop."
      : "Choose where this companion can meet you.";

  if (!agentId || !agent) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center bg-surface px-8 text-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Presence</p>
          <h1 className="mt-3 text-3xl font-semibold text-ink-900">No companion is selected.</h1>
        </div>
      </main>
    );
  }

  const connectionText = connection?.status === "ready"
    ? connection.backend === "local" ? "Here on this computer" : connection.backend === "cloud" ? "Here through Letta Cloud" : "Here through your server"
    : connection?.status === "error" ? "Connection needs attention" : "Connecting";

  return (
    <main className="relative min-w-0 flex-1 overflow-y-auto bg-surface">
      <CompanionPageHeader title="Presence" />

      <div className="mx-auto w-full max-w-6xl px-8 pb-14 pt-10">
        <section className="relative overflow-hidden rounded-[2rem] border border-border bg-surface-secondary px-7 py-8 shadow-card sm:px-9">
          <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-accent opacity-[0.08] blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-wrap items-center gap-6">
            <div className="rounded-full border border-border bg-surface p-1.5 shadow-card">
              <Avatar name={agent.name} src={look?.avatar} px={88} />
            </div>
            <div className="min-w-60 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{connectionText}</p>
              <h1 className="mt-2 text-4xl font-semibold tracking-[-0.03em] text-ink-900">{agent.name}</h1>
              {agent.description && <p className="mt-2 max-w-2xl text-base leading-7 text-ink-600">{agent.description}</p>}
              <p className="mt-3 text-xs text-muted">{modelLabel(agent.model, models)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button-primary min-h-10 px-5" disabled={!main} onClick={() => main && openChat(main.id)}>
                <SendIcon className="h-4 w-4" />
                Open main chat
              </button>
              <button type="button" className="button-secondary min-h-10 px-5" onClick={() => openChat(null)}>
                <PlusIcon className="h-4 w-4" />
                New room
              </button>
            </div>
          </div>
          {(running > 0 || waiting > 0 || replies > 0) && (
            <div className="relative mt-7 flex flex-wrap gap-2 border-t border-border pt-5 text-xs text-ink-700">
              {running > 0 && <span className="rounded-full bg-accent-light px-3 py-1.5">{running} active {running === 1 ? "thread" : "threads"}</span>}
              {waiting > 0 && <span className="rounded-full bg-warning-light px-3 py-1.5 text-warning-strong">{waiting} waiting for you</span>}
              {replies > 0 && <span className="rounded-full bg-surface-tertiary px-3 py-1.5">{replies} new {replies === 1 ? "reply" : "replies"}</span>}
            </div>
          )}
        </section>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
          <section>
            <div className="mb-3 flex items-end justify-between gap-4 px-1">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Conversations</p>
                <h2 className="mt-1 text-xl font-semibold text-ink-900">Rooms you share</h2>
              </div>
              <button type="button" className="text-sm text-accent hover:underline" onClick={() => openChat(null)}>Start a room</button>
            </div>
            <div className="overflow-hidden rounded-[1.4rem] border border-border bg-surface-secondary shadow-soft">
              {recent.length === 0 ? (
                <p className="px-5 py-8 text-sm text-muted">No conversations yet. Start wherever you like.</p>
              ) : recent.map((conversation, index) => {
                const state = chats[conversation.id];
                const attention = state?.approvals.length ? "Waiting for you" : state?.running ? "Active now" : unread[conversation.id] === "waiting" ? "Waiting for you" : unread[conversation.id] === "replied" ? "New reply" : relativeTime(conversation.updatedAt, now);
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => openChat(conversation.id)}
                    className={`flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-tertiary ${index ? "border-t border-border" : ""}`}
                  >
                    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${state?.running ? "bg-accent" : attention === "Waiting for you" ? "bg-warning" : unread[conversation.id] ? "bg-accent" : "bg-border"}`} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-ink-900">{conversation.title || "New conversation"}</strong>
                      <span className="mt-0.5 block text-xs text-muted">{conversation.main ? "Main relationship thread" : conversation.channel ? `Also on ${conversation.channel}` : "Conversation"}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{attention}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-3 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Their world</p>
              <h2 className="mt-1 text-xl font-semibold text-ink-900">Continuity beyond chat</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <Territory icon={<MemoryIcon className="h-7 w-7" />} eyebrow="Inner world" title="Memory" detail={memoryDetail} onOpen={openMemory} />
              <Territory icon={<SendIcon className="h-7 w-7" />} eyebrow="Reach" title="Channels" detail={reachDetail} onOpen={openChannels} />
              <div className="grid grid-cols-2 gap-3">
                <Territory icon={<ClockIcon className="h-6 w-6" />} eyebrow="Rhythm" title="Schedules" detail="Chosen moments to return." onOpen={openSchedules} />
                <Territory icon={<CalendarIcon className="h-6 w-6" />} eyebrow="Shared time" title="Calendar" detail="What is coming next." onOpen={openCalendar} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
