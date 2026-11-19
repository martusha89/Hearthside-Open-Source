// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { historyChatTitle, historySpan } from "./HistoryDialog";
import { composerKey, EMPTY_CHAT, selectCwd, useAppStore } from "../store";
import type { ChatRow } from "../types";
import { ApprovalPanel } from "./ApprovalPanel";
import { Composer } from "./Composer";
import { DaySeparator, TranscriptRow, isQuestionRow, questionAnswers, questionId } from "./Transcript";
import { dayStarts, viewerTimeZone } from "../lib/chronology";
import { TurnStatus } from "./TurnStatus";
import { ArrowDownIcon, HelpersIcon, Spinner } from "./icons";
import { HelpersPanel } from "./HelpersPanel";
import { ToolRun } from "./ToolRun";
import { segmentRows } from "../lib/tool-runs";
import { backgroundStyle } from "../lib/looks";
import { Avatar } from "./Avatar";

const FOLLOW_THRESHOLD = 80;
// Transient view state only; no transcript content is copied or persisted here.
const viewports = new Map<string, { top: number; atBottom: boolean }>();
const focusedSearches = new WeakSet<object>();

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  );
}

/** What fills the transcript area when there is no conversation to show. */
function Placeholder() {
  const connection = useAppStore((state) => state.connection);
  const agentsLoaded = useAppStore((state) => state.agentsLoaded);
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId));
  const reconnect = useAppStore((state) => state.reconnect);
  const openSettings = useAppStore((state) => state.openSettings);
  const setNewAgentOpen = useAppStore((state) => state.setNewAgentOpen);
  // Known to have no provider connected (not merely still loading).
  const needsProvider = useAppStore(
    (state) =>
      state.providers !== null &&
      !state.providers.some((provider) => provider.connections.length > 0),
  );

  if (connection?.status === "error") {
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-6 py-2">
        {/* A held queue can leave a short transcript viewport. Do not center an
            oversized error panel outside its scrollable bounds. */}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">Can't connect to Letta</h2>
          <p className="max-w-md break-words text-xs text-muted">{connection.error}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="button-primary" onClick={reconnect}>
            Try again
          </button>
          <button type="button" className="button-secondary" onClick={() => openSettings("connection")}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  if (connection?.status !== "ready" || !agentsLoaded) {
    return (
      <Centered>
        <Spinner className="h-5 w-5 text-muted" />
        <p className="mt-3 text-sm text-muted">Starting Letta</p>
      </Centered>
    );
  }

  if (needsProvider) {
    return (
      <Centered>
        <h2 className="text-lg font-semibold text-ink-900">Add a model to talk to</h2>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Agents on this computer need a model to think with. Add an API key, or point to a local
          server such as Ollama or LM Studio.
        </p>
        <button
          type="button"
          className="button-primary mt-5"
          onClick={() => openSettings("providers")}
        >
          Connect a provider
        </button>
      </Centered>
    );
  }

  if (!agent) {
    return (
      <Centered>
        <h2 className="text-lg font-semibold text-ink-900">Meet your first companion</h2>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Create a companion to talk with, or connect one you already know. You can work with files together too.
        </p>
        <button type="button" className="button-primary mt-5" onClick={() => setNewAgentOpen(true, "companion")}>
          Create a companion
        </button>
      </Centered>
    );
  }

  return (
    <Centered>
      <h2 className="text-xl font-semibold text-ink-900">Talk with {agent.name}.</h2>
      <p className="mt-2 max-w-sm text-sm text-muted">
        Start wherever you like. Choose a folder only when you want to work with files.
      </p>
    </Centered>
  );
}

export function ChatView() {
  const activeId = useAppStore((state) => state.activeId);
  const viewportScope = useAppStore((state) => JSON.stringify([state.backendEpoch, state.agentId, state.activeId]));
  const chat = useAppStore((state) => (activeId ? state.chats[activeId] : undefined)) ?? EMPTY_CHAT;
  const pendingFirstMessage = useAppStore((state) => state.pendingFirstMessage);
  const title = useAppStore(
    (state) => state.conversations.find((item) => item.id === activeId)?.title,
  );
  // Hearthside: a read-only part of a restored chat's history (backup/cloud-native.ts).
  const historyVolume = useAppStore((state) => (activeId ? state.historyVolumes.find((volume) => volume.id === activeId) : undefined));
  const focus = useAppStore((state) => state.focus);
  const continueFromHistory = useAppStore((state) => state.continueFromHistory);
  const ready = useAppStore(
    (state) => state.agentId !== null && (state.connection?.status === "ready" ||
      Boolean(state.activeId && state.backendIdentity)),
  );
  const cwd = useAppStore((state) => selectCwd(state, composerKey(state)));
  const loadHistory = useAppStore((state) => state.loadHistory);
  const loadHistoryEarlier = useAppStore((state) => state.loadEarlier);
  const respondApproval = useAppStore((state) => state.respondApproval);

  const rows: ChatRow[] = activeId ? chat.rows : pendingFirstMessage ? [pendingFirstMessage] : [];
  // Hearthside: the row a search result pointed at, once it's on screen.
  const focusKey = focus && focus.conversationId === activeId ? rows.find((row) => (row.key.includes(focus.messageId) || chat.messageKeys?.[focus.messageId]?.includes(row.key)))?.key : undefined;
  const running = activeId ? chat.running : pendingFirstMessage !== null;
  const answers = useMemo(() => questionAnswers(rows), [rows]);
  // Hearthside: four or more tool calls in a row fold into one line (see ToolRun).
  const segments = useMemo(() => segmentRows(rows), [rows]);
  const zone = viewerTimeZone();
  const starts = useMemo(() => dayStarts(rows, zone), [rows, zone]);
  const [dayNow, setDayNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setDayNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [keyboardRow, setKeyboardRow] = useState<string | null>(null);
  const messageRows = rows.filter((row) => row.kind === "user" || row.kind === "assistant");
  const keyboardKey = messageRows.find((row) => row.key === keyboardRow)?.key ?? messageRows[0]?.key;
  // Hearthside: turns started from Telegram/Discord don't reach the window as
  // they happen, so the open chat checks for new messages while channels are in use.
  const channelsUsed = useAppStore((state) => state.settings?.channelsUsed ?? false);
  // Also while a tool finishes in the background (an image), and for two minutes
  // after, so the agent's follow-up reply appears.
  const backgroundTools = activeId ? (chat.backgroundTools ?? 0) : 0;
  const backgroundEndedAt = activeId ? (chat.backgroundEndedAt ?? 0) : 0;
  useEffect(() => {
    if (!activeId) return;
    const watching = () => channelsUsed || backgroundTools > 0 || Date.now() - backgroundEndedAt < 120_000;
    if (!watching()) return;
    const timer = setInterval(() => {
      if (!watching()) {
        clearInterval(timer);
        return;
      }
      const current = useAppStore.getState().chats[activeId];
      if (current?.loaded && !current.running && !current.loading) void loadHistory(activeId, undefined, true);
    }, 5_000);
    return () => clearInterval(timer);
  }, [channelsUsed, activeId, loadHistory, backgroundTools, backgroundEndedAt]);

  useEffect(() => {
    if (!activeId) return;
    let last: string | null | undefined;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      const current = useAppStore.getState().chats[activeId];
      // Also while a reply from here is waiting: it may be queued behind one running elsewhere.
      if (!current?.loaded || current.loading) return;
      busy = true;
      try {
        const mark = await window.bridge.latestMessageMark(activeId);
        // The first check reloads too, for anything that arrived while the chat was opening.
        if (mark !== last) await loadHistory(activeId, undefined, true);
        last = mark;
      } catch {
        // Quiet: the next check tries again.
      } finally {
        busy = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 4_000);
    const onShow = () => void check();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [activeId, loadHistory]);
  // A Discord thread or channel starts its own chat, so the list is checked too.
  const refreshConversations = useAppStore((state) => state.refreshConversations);
  useEffect(() => {
    if (!channelsUsed) return;
    const timer = setInterval(() => void refreshConversations(), 10_000);
    return () => clearInterval(timer);
  }, [channelsUsed, refreshConversations]);
  // Hearthside: the companion's own chat background, if they gave it one.
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : undefined));
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId) ?? null);
  const activity = activeId ? chat.activity : pendingFirstMessage ? "Starting" : null;
  const approval = activeId ? chat.approvals[0] : undefined;
  const loadingFirstPage = Boolean(activeId) && !chat.loaded;
  const showPlaceholder = rows.length === 0 && !loadingFirstPage && !chat.error && !chat.historyError;

  const [helpersOpen, setHelpersOpen] = useState(() => {
    try {
      return localStorage.getItem("hearthside.helpersOpen") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("hearthside.helpersOpen", helpersOpen ? "1" : "0");
    } catch {
      // Remembered only when storage works.
    }
  }, [helpersOpen]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusKey || (focus && focusedSearches.has(focus))) return;
    followingRef.current = false;
    setFollowing(false);
    let nested: number | undefined;
    const frame = requestAnimationFrame(() => { nested = requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector(`[data-row-key="${CSS.escape(focusKey)}"]`);
      if (target) { target.scrollIntoView({ block: "center" }); if (focus) focusedSearches.add(focus); }
    }); });
    return () => { cancelAnimationFrame(frame); if (nested !== undefined) cancelAnimationFrame(nested); };
  }, [focusKey, focus]);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const heightBeforeLoadRef = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);

  const scrollToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  const follow = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    scrollToBottom();
  }, [scrollToBottom]);

  // Keep the newest output in view while the reader is at the bottom.
  // The viewport is watched too: it shrinks when an approval prompt appears.
  useEffect(() => {
    const content = contentRef.current;
    const container = scrollRef.current;
    if (!content || !container) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollToBottom, showPlaceholder]);


  const wasRunningRef = useRef(running);
  // undefined until first shown, so opening the view also lands on the latest message.
  const shownChatRef = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const switched = shownChatRef.current !== viewportScope;
    const started = running && !wasRunningRef.current;
    shownChatRef.current = viewportScope;
    wasRunningRef.current = running;
    if (!switched && !started) return;
    const saved = switched && !started ? viewports.get(viewportScope) : undefined;
    if (saved && !saved.atBottom && scrollRef.current) {
      followingRef.current = false;
      setFollowing(false);
      scrollRef.current.scrollTop = saved.top;
      return;
    }
    followingRef.current = true;
    scrollToBottom();
  }, [viewportScope, running, scrollToBottom]);

  // Loading earlier messages must not move what the reader is looking at.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || heightBeforeLoadRef.current === null || chat.loading) return;
    container.scrollTop += container.scrollHeight - heightBeforeLoadRef.current;
    heightBeforeLoadRef.current = null;
  }, [chat.rows, chat.loading]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_THRESHOLD;
    followingRef.current = atBottom;
    setFollowing(atBottom);
    viewports.delete(viewportScope);
    viewports.set(viewportScope, { top: container.scrollTop, atBottom });
    if (viewports.size > 100) viewports.delete(viewports.keys().next().value!);
  };

  const loadEarlier = () => {
    if (!activeId || chat.loading) return;
    heightBeforeLoadRef.current = scrollRef.current?.scrollHeight ?? null;
    followingRef.current = false;
    setFollowing(false);
    void loadHistoryEarlier(activeId);
  };

  return (
    <div className="flex min-w-0 flex-1">
    <main className="relative isolate flex min-w-0 flex-1 flex-col bg-surface">
      {/* Hearthside: the companion's background picture, blurred, behind the whole chat column. */}
      {look?.background && (
        <div aria-hidden data-chat-background="image" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute inset-0" style={backgroundStyle(look)} />
        </div>
      )}
      <header className="app-drag relative flex h-16 shrink-0 items-center border-b border-border bg-surface/85 px-4 pr-14 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-3">
          {agent && <Avatar name={agent.name} src={look?.avatar} px={30} />}
          <span className="min-w-0">
            <strong className="block truncate text-sm font-semibold text-ink-900">{agent?.name ?? "Companion"}</strong>
            <span className="block truncate text-xs text-muted">
              {historyVolume ? `${historyChatTitle(historyVolume)} · history · ${historySpan(historyVolume)}` : activeId ? title || "New conversation" : "New conversation"}
            </span>
          </span>
        </div>
        {/* Hearthside: the helpers this chat's agent sent off (as the old app's Subagents panel). */}
        <button
          type="button"
          aria-label="Helpers"
          aria-pressed={helpersOpen}
          title="Helpers your agent sent off in this chat"
          onClick={() => setHelpersOpen(!helpersOpen)}
          className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${helpersOpen ? "bg-surface-tertiary text-ink-900" : "text-muted hover:bg-surface-tertiary hover:text-ink-800"}`}
        >
          <HelpersIcon className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} onScroll={onScroll} data-chat-transcript className="min-h-0 flex-1 overflow-y-auto">
        {showPlaceholder ? (
          <Placeholder />
        ) : (
          <div ref={contentRef} className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-4 px-6 py-6 [&>*]:min-w-0">
            {loadingFirstPage && (
              <div className="flex justify-center py-8">
                <Spinner className="h-5 w-5 text-muted" />
              </div>
            )}
            {chat.loaded && chat.hasMore && (
              <button
                type="button"
                onClick={loadEarlier}
                disabled={chat.loading}
                className="mx-auto flex items-center gap-2 rounded-full px-3 py-1 text-xs text-muted hover:bg-surface-tertiary hover:text-ink-800 transition-colors"
              >
                {chat.loading && <Spinner className="h-3 w-3" />}
                Load earlier messages
              </button>
            )}
            {segments.map((segment) => {
              const renderRow = (row: ChatRow, index = rows.indexOf(row)) => (
                // Hearthside: a found message is scrolled to and outlined (search -> history).
                <div key={row.key} data-row-key={row.key}
                  tabIndex={row.kind === "user" || row.kind === "assistant" ? row.key === keyboardKey ? 0 : -1 : undefined}
                  onFocus={(event) => { if (event.target === event.currentTarget) setKeyboardRow(row.key); }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    const index = messageRows.findIndex((message) => message.key === row.key);
                    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? messageRows.length - 1 : -1;
                    const target = messageRows[next];
                    if (!target) return;
                    event.preventDefault(); setKeyboardRow(target.key);
                    scrollRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(target.key)}"]`)?.focus();
                  }}
                  className={`group/transcript-row rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent/60 ${focusKey === row.key ? "ring-2 ring-accent/50 ring-offset-4 ring-offset-surface" : ""}`}>
                  <TranscriptRow
                    row={row}
                    cwd={cwd}
                    running={running}
                    channelPending={running && row.kind === "tool_call" && (chat.liveChannelCallIds?.includes(row.toolCallId) ?? false)}
                    active={running && index === rows.length - 1}
                    answer={isQuestionRow(row) ? answers.get(questionId(row)) : undefined}
                  />
                </div>
              );
              if (segment.kind === "row") {
                const day = starts.get(segment.row.key);
                return <Fragment key={segment.row.key}>{day && <DaySeparator day={day} now={dayNow} timeZone={zone} />}{renderRow(segment.row, segment.index)}</Fragment>;
              }
              return (
                <ToolRun
                  key={`run:${segment.rows[0]!.key}`}
                  rows={segment.rows}
                  tools={segment.tools}
                  live={running && segment.end === rows.length - 1}
                  renderRow={(row) => renderRow(row)}
                />
              );
            })}
            {(chat.error ?? chat.historyError) && (
              <div
                role="alert"
                className="whitespace-pre-wrap break-words rounded-xl border border-error/20 bg-error-light px-3.5 py-2.5 text-sm text-error"
              >
                {chat.error ?? chat.historyError}
                {/* Hearthside: nothing loaded yet: offer to load it again. */}
                {rows.length === 0 && activeId && (
                  <button type="button" className="ml-2 underline" onClick={() => void loadHistory(activeId)}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!following && rows.length > 0 && (
        <div className="pointer-events-none relative h-0">
          <button
            type="button"
            onClick={follow}
            aria-label="Jump to latest"
            className="pointer-events-auto absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-ink-700 shadow-card hover:bg-surface-tertiary"
          >
            <ArrowDownIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Hearthside: a long approval, queue or draft must never push the buttons below the window: those parts
          scroll on their own (ApprovalPanel, the queue, the draft box). Nothing here may clip, or the model
          and GIF pop-ups that open upwards get cut off (Aria, 15 Oct). */}
      <div className="shrink-0">
        {/* Hearthside: while a turn runs there is always a line, even before the
            runtime has said anything — and it stays here, above the message box,
            where it can't scroll out of sight. */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-2 empty:hidden">
          <TurnStatus
            running={running}
            activity={activity}
            phase={activeId ? chat.activityPhase : null}
            detail={activeId ? chat.activityDetail : null}
            rows={rows}
            move={activeId ? chat.move : null}
          />
        </div>
        {approval && chat.execution?.status !== "blocked" && (
          <ApprovalPanel
            request={approval}
            queued={chat.approvals.length - 1}
            cwd={cwd}
            onDecide={(decision) => void respondApproval(approval.requestId, decision)}
            sending={chat.approvalSending === approval.requestId}
            error={chat.approvalError ?? null}
          />
        )}
        {historyVolume ? (
          <div className="mx-auto w-full max-w-3xl px-6 pb-5">
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-secondary px-4 py-3 text-sm text-ink-800">
              <span className="min-w-0 flex-1">
                Older messages from {historyChatTitle(historyVolume)}, kept as they were. Nothing can be sent here.
              </span>
              <button
                type="button"
                className="button-primary shrink-0"
                onClick={() => {
                  const chosen = (focus?.conversationId === activeId ? rows.find((row) => (row.key.includes(focus.messageId) || chat.messageKeys?.[focus.messageId]?.includes(row.key))) : undefined) ?? [...rows].reverse().find((row) => row.kind === "user" || row.kind === "assistant");
                  continueFromHistory(chosen && "text" in chosen ? chosen.text : null, chosen && "date" in chosen ? chosen.date ?? null : historyVolume.history?.lastAt ?? null);
                }}
              >
                Continue from here
              </button>
            </div>
          </div>
        ) : (
          <Composer disabled={!ready} />
        )}
      </div>
    </main>
    {helpersOpen && <HelpersPanel conversationId={activeId} onClose={() => setHelpersOpen(false)} />}
    </div>
  );
}
