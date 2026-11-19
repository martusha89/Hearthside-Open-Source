import { useAppStore } from "../store";
import { ChevronRightIcon } from "./icons";

/** Navigation only: keep the active conversation, draft and loaded history. */
export function BackToChat({ onNavigate }: { onNavigate?: (navigate: () => void) => void } = {}) {
  const activeId = useAppStore((state) => state.activeId);
  const title = useAppStore((state) => state.conversations.find((chat) => chat.id === state.activeId)?.title);
  const label = activeId && title ? `Back to ${title}` : "Back to chat";
  return <button type="button" onClick={() => {
    const navigate = () => useAppStore.setState({ view: "chat" });
    if (onNavigate) onNavigate(navigate); else navigate();
  }}
    className="app-no-drag inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-surface-tertiary hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-accent"
    title={label} aria-label={label}><ChevronRightIcon className="h-3.5 w-3.5 rotate-180" /><span className="max-w-52 truncate">{label}</span></button>;
}
