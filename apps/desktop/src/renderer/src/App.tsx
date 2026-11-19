// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect } from "react";
import { AgentSettingsDialog } from "./components/AgentSettingsDialog";
import { ChatView } from "./components/ChatView";
import { PresenceView } from "./components/PresenceView";
import { MemoryView } from "./components/MemoryView";
import { SkillsView } from "./components/SkillsView";
import { SchedulesView } from "./components/SchedulesView";
import { ConnectorsView } from "./components/ConnectorsView";
import { CalendarView } from "./components/CalendarView";
import { ChannelsView } from "./components/ChannelsView";
import { FilesView } from "./components/FilesView";
import { WelcomeGuide } from "./components/WelcomeGuide";
import { GuidedTour } from "./components/GuidedTour";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { CloseIcon } from "./components/icons";
import { useAppStore, watchingChat } from "./store";

const NOTICE_TIMEOUT_MS = 8_000;
/** Hearthside: long enough to read and act on, short enough not to sit over the chat. */
const FINISHED_TIMEOUT_MS = 10_000;

/**
 * Hearthside: "your agent finished, and it wasn't in the chat you're looking at".
 * The desktop notification only fires when the window isn't in front, so while
 * Hearthside is the window you're using nothing used to say a turn had ended
 * anywhere else. This says it, and opening it takes you there; the sidebar keeps
 * a mark afterwards, so a notice that times out loses nothing.
 */
export function FinishedNotice() {
  const finished = useAppStore((state) => state.finished);
  const title = useAppStore((state) =>
    state.finished ? state.conversations.find((item) => item.id === state.finished!.conversationId)?.title || null : null,
  );
  const openFinished = useAppStore((state) => state.openFinished);
  const dismissFinished = useAppStore((state) => state.dismissFinished);

  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(() => dismissFinished(), FINISHED_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [finished, dismissFinished]);

  if (!finished) return null;
  const waiting = finished.kind === "waiting";
  const where = title ? `in "${title}"` : "in another chat";
  return (
    <div
      role="status"
      className={`fixed left-1/2 top-4 z-[59] flex max-w-lg -translate-x-1/2 items-center gap-3 rounded-xl border px-4 py-3 shadow-elevated ${waiting ? "border-warning/30 bg-warning-light" : "border-border bg-surface"}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${waiting ? "bg-warning" : "bg-accent"}`} aria-hidden="true" />
      <span className="min-w-0 break-words text-sm text-ink-800">
        {waiting ? `Your agent is waiting for you ${where}.` : `Your agent finished ${where}.`}
      </span>
      <button type="button" className="button-secondary shrink-0" onClick={() => void openFinished(finished.conversationId)}>
        Open
      </button>
      <button type="button" aria-label="Dismiss" className="shrink-0 text-muted hover:text-ink-800" onClick={() => dismissFinished()}>
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Notice() {
  const notice = useAppStore((state) => state.notice);
  const setNotice = useAppStore((state) => state.setNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  if (!notice) return null;
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-4 z-[60] flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-xl border border-error/20 bg-error-light px-4 py-3 shadow-elevated"
    >
      <span className="min-w-0 break-words text-sm text-error">{notice}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-error hover:opacity-70"
        onClick={() => setNotice(null)}
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function App() {
  const view = useAppStore((state) => state.view);
  // Keyed by agent so switching agents starts the memory view fresh.
  const agentId = useAppStore((state) => state.agentId);
  // Hearthside: text size scales the whole UI (sizes are rem-based).
  const textSize = useAppStore((state) => state.settings?.textSize ?? "medium");
  useEffect(() => {
    document.documentElement.dataset.textSize = textSize;
  }, [textSize]);
  // Hearthside: the selected companion's theme colour; index.css re-derives the
  // accent and surfaces from it under [data-themed].
  const accent = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId]?.accent : null) ?? null);
  useEffect(() => {
    const root = document.documentElement;
    if (accent) {
      root.style.setProperty("--theme-accent", accent);
      root.dataset.themed = "";
    } else {
      root.style.removeProperty("--theme-accent");
      delete root.dataset.themed;
    }
  }, [accent]);

  // Hearthside: coming back to the window with a chat already open means that chat
  // has been seen, so its unread mark goes without having to click it again.
  // watchingChat is the same question the store asks before marking a chat
  // unread — a chat behind Settings has not been seen just because the window
  // came back, and clearing its mark here would be the one place it was lost.
  useEffect(() => {
    const seen = () => {
      const state = useAppStore.getState();
      if (state.activeId && watchingChat(state, state.activeId)) state.markChatRead(state.activeId);
    };
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, []);

  useEffect(() => {
    const { handleEvent, bootstrap, setNotice } = useAppStore.getState();
    // Subscribe before the first fetch so no state change is missed.
    const unsubscribe = window.bridge.onEvent(handleEvent);
    bootstrap().catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error));
    });
    return unsubscribe;
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-ink-900">
      <Sidebar />
      {view === "presence" ? <PresenceView key={agentId} /> : view === "memory" ? <MemoryView key={agentId} /> : view === "skills" ? <SkillsView key={agentId} /> : view === "schedules" ? <SchedulesView key={agentId} /> : view === "calendar" ? <CalendarView key={agentId} /> : view === "channels" ? <ChannelsView key={agentId} /> : view === "connectors" ? <ConnectorsView key={agentId} /> : view === "files" ? <FilesView /> : <ChatView />}
      <SettingsDialog />
      <NewAgentDialog />
      <WelcomeGuide />
      <GuidedTour />
      <AgentSettingsDialog />
      {/* A problem outranks good news: Notice sits above FinishedNotice. */}
      <FinishedNotice />
      <Notice />
    </div>
  );
}
