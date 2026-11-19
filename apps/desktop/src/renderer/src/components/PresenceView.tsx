import { useEffect, useMemo, useState } from "react";
import { modelLabel, relativeTime } from "../lib/format";
import { describeCron } from "../lib/schedule-presets";
import { useAppStore } from "../store";
import type { CalendarOccurrence, ChannelAccount, ConversationPreview, MemoryCommit, PresenceCalendarSummary, Schedule } from "../types";
import { Avatar } from "./Avatar";
import { CalendarIcon, ClockIcon, MemoryIcon, PlusIcon, SendIcon } from "./icons";

const RECENT_LIMIT = 4;
const CALENDAR_DAYS = 60;

type ChannelFacts = { accounts: ChannelAccount[] };

function compact(text: string, limit = 110): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1).trimEnd()}…` : oneLine;
}

function ago(timestamp: number, now: number): string {
  const relative = relativeTime(timestamp, now);
  return relative === "now" ? "just now" : relative ? `${relative} ago` : "recently";
}

function calendarMoment(item: CalendarOccurrence): string {
  const value = item.allDay && /^\d{4}-\d{2}-\d{2}/.test(item.start)
    ? new Date(`${item.start.slice(0, 10)}T00:00:00`)
    : new Date(item.start);
  if (Number.isNaN(value.getTime())) return "Upcoming";
  return value.toLocaleString(undefined, item.allDay
    ? { weekday: "short", day: "numeric", month: "short" }
    : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

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
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [previews, setPreviews] = useState<ConversationPreview[] | null | undefined>(null);
  const [memoryActivity, setMemoryActivity] = useState<MemoryCommit[] | null | undefined>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null | undefined>(null);
  const [calendarSummary, setCalendarSummary] = useState<PresenceCalendarSummary | null | undefined>(null);
  const [channelFacts, setChannelFacts] = useState<ChannelFacts | null | undefined>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const agentId = useAppStore((state) => state.agentId);
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId) ?? null);
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : null));
  const models = useAppStore((state) => state.models);
  const connection = useAppStore((state) => state.connection);
  const conversationsLoaded = useAppStore((state) => state.conversationsLoaded);
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
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT),
    [conversations],
  );
  const recentKey = recent.map((conversation) => `${conversation.id}:${conversation.updatedAt}`).join("|");

  useEffect(() => {
    if (!agentId) return;
    setPreviews(null);
    setMemoryActivity(null);
    setSchedules(null);
    setCalendarSummary(null);
    setChannelFacts(null);
  }, [agentId]);

  useEffect(() => window.bridge.onEvent((event) => {
    if (event.type === "memory.updated") setMemoryRevision((value) => value + 1);
  }), []);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const ids = recent.map((conversation) => conversation.id);
    if (ids.length) {
      void window.bridge.listConversationPreviews(agentId, ids)
        .then((items) => !cancelled && setPreviews(items))
        .catch(() => !cancelled && setPreviews(undefined));
    } else {
      setPreviews([]);
    }
    return () => {
      cancelled = true;
    };
  }, [agentId, recentKey]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void window.bridge.listMemoryActivity(agentId, 3)
      .then((items) => !cancelled && setMemoryActivity([...items].sort((a, b) => b.timestamp - a.timestamp)))
      .catch(() => !cancelled && setMemoryActivity(undefined));
    return () => {
      cancelled = true;
    };
  }, [agentId, memoryRevision]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void window.bridge.listSchedules(agentId)
      .then((items) => !cancelled && setSchedules(items))
      .catch(() => !cancelled && setSchedules(undefined));
    const from = Date.now();
    if (connection?.backend === "remote") {
      setCalendarSummary({ shared: false, occurrence: null });
    } else {
      void window.bridge.getPresenceCalendar(agentId, from, from + CALENDAR_DAYS * 86_400_000)
        .then((summary) => !cancelled && setCalendarSummary(summary))
        .catch(() => !cancelled && setCalendarSummary(undefined));
    }
    return () => {
      cancelled = true;
    };
  }, [agentId, connection?.backend]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    if (connection?.backend === "remote") {
      setChannelFacts({ accounts: [] });
    } else {
      void Promise.all([
        window.bridge.listChannelAccounts("telegram", agentId),
        window.bridge.listChannelAccounts("discord", agentId),
      ])
        .then(([telegram, discord]) => !cancelled && setChannelFacts({ accounts: [...telegram, ...discord] }))
        .catch(() => !cancelled && setChannelFacts(undefined));
    }
    return () => {
      cancelled = true;
    };
  }, [agentId, connection?.backend, channelService?.revision]);

  const previewOf = useMemo(() => new Map((previews ?? []).map((preview) => [preview.conversationId, preview])), [previews]);

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

  const agentName = agent.name;
  const main = conversations.find((conversation) => conversation.main) ?? null;
  const remotelyActive = new Set(connection?.activeRemoteConversationIds ?? []);
  const running = conversations.filter((conversation) => chats[conversation.id]?.running || remotelyActive.has(conversation.id)).length;
  const waiting = conversations.filter((conversation) => (chats[conversation.id]?.approvals.length ?? 0) > 0 || unread[conversation.id] === "waiting").length;
  const replies = conversations.filter((conversation) => unread[conversation.id] === "replied").length;
  const latestMemory = memoryActivity?.[0] ?? null;
  const memoryDetail = memory?.loading || memoryActivity === null
    ? "Reading the memory landscape…"
    : memory?.error
      ? "The memory landscape is temporarily unavailable."
      : memory?.enabled === false
        ? "This companion does not use file-based memory."
        : latestMemory
          ? `${/^merge\(reflection\):/i.test(latestMemory.message) ? "Dreamed" : "Memory changed"} ${ago(latestMemory.timestamp, now)} · ${compact(latestMemory.message.replace(/^merge\(reflection\):\s*/i, ""))}`
          : memoryActivity === undefined
            ? `${memory?.files.length ?? 0} memory files. Recent activity is unavailable.`
            : `${memory?.files.length ?? 0} memory files. No recorded changes yet.`;

  const ownedAccounts = (channelFacts?.accounts ?? []).filter((account) => account.mine || account.ownerAgentId === agentId);
  const configuredAccounts = ownedAccounts.filter((account) => account.configured);
  const runningAccounts = configuredAccounts.filter((account) => account.here && account.enabled && account.running && !account.conflict && !account.unfinishedMove);
  const channelProblems = configuredAccounts.filter((account) => account.conflict || account.unfinishedMove || (account.here && account.enabled && !account.running));
  const channelConversations = conversations.filter((conversation) => Boolean(conversation.channel)).length;
  const reachDetail = connection?.backend === "remote"
    ? "Channels are managed on your server."
    : channelService?.state === "failed" || channelService?.state === "blocked"
    ? "One or more channels need attention."
    : channelFacts === null
      ? "Checking connected channels…"
      : channelFacts === undefined
        ? "Channel details are temporarily unavailable."
        : channelProblems.length
          ? `${channelProblems.length} ${channelProblems.length === 1 ? "bot needs" : "bots need"} attention.`
          : runningAccounts.length
            ? `${runningAccounts.length} running ${runningAccounts.length === 1 ? "bot" : "bots"}${channelConversations ? ` · ${channelConversations} channel ${channelConversations === 1 ? "chat" : "chats"} visible` : ""}.`
            : configuredAccounts.length
              ? `${configuredAccounts.length} connected ${configuredAccounts.length === 1 ? "bot" : "bots"}; none running here.`
              : channelConversations
                ? `${channelConversations} channel-linked ${channelConversations === 1 ? "chat is" : "chats are"} visible; no companion-owned bot is configured here.`
                : "No companion-owned channels are configured here.";

  const active = schedules ? schedules.filter((schedule) => schedule.status === "active") : [];
  const scheduleDetail = schedules === null
    ? "Checking schedules…"
    : schedules === undefined
      ? "Schedule summary is temporarily unavailable."
      : active.length === 1
        ? `${active[0]!.name} · ${describeCron(active[0]!.cron, active[0]!.recurring, active[0]!.scheduledFor)}`
        : active.length > 1
          ? `${active.length} active schedules · ${compact(active.map((schedule) => schedule.name).join(", "), 72)}`
          : "No active schedules.";

  const nextCalendar = calendarSummary?.occurrence ?? null;
  const calendarDetail = connection?.backend === "remote"
    ? "Hearthside's calendar tools are unavailable on remote chats."
    : calendarSummary === null
    ? "Checking shared time…"
    : calendarSummary === undefined
      ? "Calendar summary is temporarily unavailable."
      : !calendarSummary.shared
        ? `Calendar is not shared with ${agentName}.`
        : nextCalendar
          ? `${nextCalendar.title} · ${calendarMoment(nextCalendar)}`
          : `Shared with ${agentName} · nothing in the next ${CALENDAR_DAYS} days.`;

  const connectionText = connection?.status === "ready"
    ? connection.backend === "local" ? "Here on this computer" : connection.backend === "cloud" ? "Here through Letta Cloud" : "Here through your server"
    : connection?.status === "error" ? "Connection needs attention" : "Connecting";

  return (
    <main className="relative min-w-0 flex-1 overflow-y-auto bg-surface">
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
                New chat
              </button>
            </div>
          </div>
          <div className="relative mt-7 flex flex-wrap items-center gap-2 border-t border-border pt-5 text-xs text-ink-700" role="status">
            <span className="mr-1 font-semibold uppercase tracking-[0.14em] text-muted">Now</span>
            {!conversationsLoaded ? (
              <span className="rounded-full bg-surface-tertiary px-3 py-1.5">Checking conversation activity…</span>
            ) : connection?.status === "error" ? (
              <span className="rounded-full bg-error-light px-3 py-1.5 text-error">Connection needs attention</span>
            ) : running === 0 && waiting === 0 && replies === 0 ? (
              <span className="rounded-full bg-surface-tertiary px-3 py-1.5">Nothing visible needs your attention</span>
            ) : (
              <>
                {running > 0 && <span className="rounded-full bg-accent-light px-3 py-1.5">{running} active {running === 1 ? "thread" : "threads"}</span>}
                {waiting > 0 && <span className="rounded-full bg-warning-light px-3 py-1.5 text-warning-strong">{waiting} waiting for you</span>}
                {replies > 0 && <span className="rounded-full bg-surface-tertiary px-3 py-1.5">{replies} new {replies === 1 ? "reply" : "replies"}</span>}
              </>
            )}
          </div>
        </section>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
          <section>
            <div className="mb-3 px-1">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Conversations</p>
                <h2 className="mt-1 text-xl font-semibold text-ink-900">Recent chats</h2>
              </div>
            </div>
            <div className="overflow-hidden rounded-[1.4rem] border border-border bg-surface-secondary shadow-soft">
              {recent.length === 0 ? (
                <p className="px-5 py-8 text-sm text-muted">No conversations yet. Start wherever you like.</p>
              ) : recent.map((conversation, index) => {
                const state = chats[conversation.id];
                const preview = previewOf.get(conversation.id);
                const isRunning = state?.running || remotelyActive.has(conversation.id);
                const previewAt = preview?.date ? Date.parse(preview.date) : Number.NaN;
                const recency = Number.isFinite(previewAt) ? previewAt : conversation.updatedAt;
                const attention = state?.approvals.length ? "Waiting for you" : isRunning ? "Active now" : unread[conversation.id] === "waiting" ? "Waiting for you" : unread[conversation.id] === "replied" ? "New reply" : relativeTime(recency, now);
                const fallback = conversation.channel ? `${conversation.channel} conversation` : conversation.main ? "Main chat" : "Conversation";
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => openChat(conversation.id)}
                    className={`flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-tertiary ${index ? "border-t border-border" : ""}`}
                  >
                    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${isRunning ? "bg-accent" : attention === "Waiting for you" ? "bg-warning" : unread[conversation.id] ? "bg-accent" : "bg-border"}`} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-ink-900">{conversation.title || "New conversation"}</strong>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {preview ? `${preview.kind === "user" ? "You" : agentName}: ${preview.text}` : previews === null ? "Reading the latest message…" : fallback}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{attention}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-3 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Beyond conversation</p>
              <h2 className="mt-1 text-xl font-semibold text-ink-900">What exists beyond chat</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <Territory icon={<MemoryIcon className="h-7 w-7" />} eyebrow="Inner world" title="Memory" detail={memoryDetail} onOpen={openMemory} />
              <Territory icon={<SendIcon className="h-7 w-7" />} eyebrow="Reach" title="Channels" detail={reachDetail} onOpen={openChannels} />
              <div className="grid gap-3">
                <Territory icon={<ClockIcon className="h-6 w-6" />} eyebrow="Rhythm" title="Schedules" detail={scheduleDetail} onOpen={openSchedules} />
                <Territory icon={<CalendarIcon className="h-6 w-6" />} eyebrow="Shared time" title="Calendar" detail={calendarDetail} onOpen={openCalendar} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
