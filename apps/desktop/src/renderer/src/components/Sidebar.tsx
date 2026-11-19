// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { modelLabel, relativeTime } from "../lib/format";
import { composerKey, selectModel, useAppStore } from "../store";
import type { AgentSummary, ConnectionState, ConversationSummary, MessageSearchResult } from "../types";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
  MemoryIcon,
  PresenceIcon,
  SkillsIcon,
  CalendarIcon,
  ClockIcon,
  PlugIcon,
  SendIcon,
  FolderIcon,
  MoreIcon,
  PlusIcon,
  SettingsIcon,
  Spinner,
} from "./icons";
import { ArchivedChatsDialog } from "./ArchivedChatsDialog";
import { HistoryDialog } from "./HistoryDialog";
import { Avatar } from "./Avatar";
import { ChatIconDialog } from "./ChatIconDialog";
import { DEFAULT_CHAT_PREFERENCE, organiseChats } from "../lib/chat-organisation";
import { updateFailureText } from "../lib/update-install";

const isMac = window.bridge.platform === "darwin";

const menuContent =
  "z-50 min-w-[220px] rounded-xl border border-border bg-surface p-1 shadow-elevated";
const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-800 outline-none data-[highlighted]:bg-surface-tertiary";

/** Hearthside: offer a search box once the agent list gets long. */
const SEARCH_FROM = 7;
const NO_FAVOURITES: string[] = [];

function StarButton({ starred, name, onToggle }: { starred: boolean; name: string; onToggle: () => void }) {
  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <button
      type="button"
      aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
      aria-pressed={starred}
      title={starred ? "Remove from favourites" : "Add to favourites"}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={(event) => {
        stop(event);
        onToggle();
      }}
      className={`ml-auto shrink-0 rounded p-0.5 text-base leading-none transition-colors ${starred ? "text-warning" : "text-muted-light opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[highlighted]:opacity-100 hover:text-warning"}`}
    >
      {starred ? "\u2605" : "\u2606"}
    </button>
  );
}

function AgentSwitcher() {
  const agents = useAppStore((state) => state.agents);
  const favourites = useAppStore((state) => state.settings?.favouriteAgents ?? NO_FAVOURITES);
  const looks = useAppStore((state) => state.looks);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [query, setQuery] = useState("");
  const agentId = useAppStore((state) => state.agentId);
  const models = useAppStore((state) => state.models);
  const selectAgent = useAppStore((state) => state.selectAgent);
  const setNewAgentOpen = useAppStore((state) => state.setNewAgentOpen);
  const setAgentSettingsOpen = useAppStore((state) => state.setAgentSettingsOpen);
  const current = agents.find((agent) => agent.id === agentId);
  // Hearthside: show the model the open chat actually uses (same as the composer).
  const chatModel = useAppStore((state) => selectModel(state, composerKey(state)));
  // Starred agents first (in the order they were starred), then the rest.
  const listed = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (agent: AgentSummary) => terms.every((term) => agent.name.toLowerCase().includes(term));
    const starred = favourites.flatMap((id) => agents.filter((agent) => agent.id === id));
    const rest = agents.filter((agent) => !favourites.includes(agent.id));
    return { starred: starred.filter(matches), rest: rest.filter(matches) };
  }, [agents, favourites, query]);
  const toggleStar = (id: string) =>
    void saveSettings({ favouriteAgents: favourites.includes(id) ? favourites.filter((item) => item !== id) : [...favourites, id] });
  const row = (agent: AgentSummary) => (
    <DropdownMenu.Item
      key={agent.id}
      className={`group ${menuItem}`}
      onSelect={() => agent.id !== agentId && void selectAgent(agent.id)}
    >
      <span className="w-4 shrink-0">
        {agent.id === agentId && <CheckIcon className="h-4 w-4 text-accent" />}
      </span>
      <Avatar name={agent.name} src={looks?.agents[agent.id]?.avatar} px={24} />
      <span className="min-w-0">
        <span className="block truncate">{agent.name}</span>
        <span className="block truncate text-xs text-muted">{modelLabel(agent.model, models)}</span>
      </span>
      <StarButton starred={favourites.includes(agent.id)} name={agent.name} onToggle={() => toggleStar(agent.id)} />
    </DropdownMenu.Item>
  );

  return (
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenu.Trigger className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-ink-900/5 transition-colors outline-none">
        {current && <Avatar name={current.name} src={looks?.agents[current.id]?.avatar} px={32} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink-900">
            {current?.name ?? "No companion"}
          </span>
          <span className="block truncate text-xs text-muted">
            {current ? modelLabel(chatModel, models) : "Create a companion to begin"}
          </span>
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${menuContent} w-[256px]`} align="start" sideOffset={6}>
          {agents.length >= SEARCH_FROM && (
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Keep typing in the box instead of the menu's jump-to-item.
              onKeyDown={(event) => event.key !== "Escape" && event.stopPropagation()}
              placeholder="Search companions"
              aria-label="Search companions"
              className="field mb-1 w-full text-sm"
            />
          )}
          <div className="max-h-72 overflow-y-auto">
            {listed.starred.length > 0 && (
              <DropdownMenu.Label className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                Favourites
              </DropdownMenu.Label>
            )}
            {listed.starred.map(row)}
            {listed.starred.length > 0 && listed.rest.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
            {listed.rest.map(row)}
            {query && listed.starred.length + listed.rest.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">No companions match.</p>
            )}
          </div>
          {agents.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          {current && (
            <DropdownMenu.Item className={menuItem} onSelect={() => setAgentSettingsOpen(true)}>
              <SettingsIcon className="h-4 w-4 shrink-0 text-muted" />
              Companion settings...
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={menuItem} onSelect={() => setNewAgentOpen(true)}>
            <PlusIcon className="h-4 w-4 shrink-0 text-muted" />
            New companion...
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Hearthside: a new version has downloaded: what's new, and restart to use it. */
// Hearthside: the Telegram/Discord service should be up and isn't; say so where it's seen.
function ChannelServiceNotice() {
  const status = useAppStore((state) => state.channelService);
  const openChannels = useAppStore((state) => state.openChannels);
  const channelsOpen = useAppStore((state) => state.view === "channels");
  if (!status || channelsOpen || (status.state !== "failed" && status.state !== "blocked")) return null;
  return (
    <button
      type="button"
      onClick={openChannels}
      title={status.reason}
      role="status"
      className="mx-3 mb-2 flex items-center gap-2 rounded-xl bg-error-light px-3 py-2 text-left text-xs text-error hover:underline"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-error" />
      <span className="truncate">{status.state === "blocked" ? "Channels need attention" : "Channels off · retrying"}</span>
    </button>
  );
}

function UpdateBanner() {
  const update = useAppStore((state) => state.updateReady);
  const [busy, setBusy] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [later, setLater] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!update || later === update.version) return null;
  return (
    <div className="mx-3 mb-2 grid gap-1.5 rounded-xl bg-accent-subtle px-3 py-2 text-xs text-ink-800" role="status">
      <span className="font-medium text-ink-900">Hearthside {update.version} is ready</span>
      {update.notes && (
        <>
          <button type="button" className="justify-self-start text-accent hover:underline" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            {notesOpen ? "Hide what's new" : "What's new"}
          </button>
          {notesOpen && <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-ink-800">{update.notes}</p>}
        </>
      )}
      <span className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          className="font-medium text-accent hover:underline disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            setError(null);
            void window.bridge.installUpdate().catch((failure: unknown) => {
              // Say why nothing happened; the button used to go quietly back.
              setError(updateFailureText(failure));
              setBusy(false);
            });
          }}
        >
          {busy ? "Restarting…" : "Restart to update"}
        </button>
        <button type="button" className="text-muted hover:text-ink-700 hover:underline" disabled={busy} onClick={() => setLater(update.version)}>
          Later
        </button>
      </span>
      {error && <p role="alert" className="text-error">{error}</p>}
    </div>
  );
}

/** Hearthside: filter chats by title; Enter searches inside messages too. */
function ChatSearch({ query, onQuery, agentId }: { query: string; onQuery: (query: string) => void; agentId: string }) {
  const openChat = useAppStore((state) => state.openChat);
  const [results, setResults] = useState<MessageSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await window.bridge.searchMessages(agentId, query.trim()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-2 grid gap-1.5">
      <input
        value={query}
        onChange={(event) => {
          onQuery(event.target.value);
          setResults(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void search();
          if (event.key === "Escape") {
            onQuery("");
            setResults(null);
          }
        }}
        placeholder="Search chats (Enter searches messages)"
        aria-label="Search chats"
        className="field py-1.5 text-xs"
      />
      {busy && <Spinner className="mx-auto h-3.5 w-3.5 text-muted" />}
      {error && <p className="px-1 text-[11px] text-error">{error}</p>}
      {results && (
        <div className="grid max-h-64 gap-1 overflow-y-auto rounded-lg border border-border bg-surface p-1" aria-label="Message search results">
          {results.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">No messages found.</p>}
          {results.map((result) => (
            <button
              key={result.messageId}
              type="button"
              onClick={() => openChat(result.conversationId, result.messageId)}
              className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-tertiary"
            >
              <span className="line-clamp-2 text-ink-800">{result.text}</span>
              {result.date && <span className="block text-[10px] text-muted">{new Date(result.date).toLocaleString()}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewAgentButton() {
  const setNewAgentOpen = useAppStore((state) => state.setNewAgentOpen);
  const ready = useAppStore((state) => state.connection?.status === "ready");
  return (
    <button
      type="button"
      onClick={() => setNewAgentOpen(true)}
      disabled={!ready}
      aria-label="New companion"
      title="New companion"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-ink-900/5 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PlusIcon className="h-4 w-4" />
    </button>
  );
}

function ConversationItem({
  conversation,
  now,
  onRename,
  onResume,
  selection,
}: {
  conversation: ConversationSummary;
  now: number;
  onRename: (conversation: ConversationSummary) => void;
  onResume: (conversation: ConversationSummary) => void;
  /** Hearthside: set while picking chats to archive; absent the rest of the time. */
  selection?: { selected: boolean; onToggle: () => void };
}) {
  const active = useAppStore(
    (state) => state.view === "chat" && state.activeId === conversation.id,
  );
  const running = useAppStore((state) => state.chats[conversation.id]?.running ?? false);
  const waiting = useAppStore((state) => (state.chats[conversation.id]?.approvals.length ?? 0) > 0);
  // Hearthside: finished (or asked something) while the person was elsewhere, and
  // hasn't been opened since. Outlives the notice, so nothing is only announced once.
  const unread = useAppStore((state) => state.unread[conversation.id] ?? null);
  const openChat = useAppStore((state) => state.openChat);
  const archiveConversation = useAppStore((state) => state.archiveConversation);
  const forkConversation = useAppStore((state) => state.forkConversation);
  const exportConversation = useAppStore((state) => state.exportConversation);
  const compactConversation = useAppStore((state) => state.compactConversation);
  const preference = useAppStore((state) => state.chatPreferences[conversation.id] ?? DEFAULT_CHAT_PREFERENCE);
  const preferencesLoaded = useAppStore((state) => state.chatPreferencesLoaded);
  const updatePreference = useAppStore((state) => state.updateChatPreference);
  const [iconOpen, setIconOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const update = async (patch: { pinned?: boolean; starred?: boolean; icon?: string | null }) => {
    setSaving(true);
    try { await updatePreference(conversation.id, patch); }
    finally { setSaving(false); }
  };

  // While picking, the row ticks instead of opening: one gesture, no chat switching
  // under the person as they work down the list. The main chat can't be archived, so
  // it has no tick at all rather than a tick that quietly does nothing.
  const picking = Boolean(selection) && !conversation.main;
  return (
    <div
      className={`group relative flex items-center rounded-lg transition-colors ${active ? "bg-ink-900/8" : "hover:bg-ink-900/5"}`}
    >
      {selection && (
        <span className="flex w-7 shrink-0 items-center justify-center">
          {conversation.main ? (
            <span className="text-xs text-muted-light" title="The companion's original conversation is always kept">
              —
            </span>
          ) : (
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              checked={selection.selected}
              aria-label={`Select ${conversation.title || "New chat"}`}
              onChange={selection.onToggle}
            />
          )}
        </span>
      )}
      <button
        type="button"
        onClick={() => (picking ? selection!.onToggle() : openChat(conversation.id))}
        className={`flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 text-left outline-none ${selection ? "pl-0" : "pl-2.5"}`}
      >
        {preference.icon && <span aria-hidden="true" className="shrink-0">{preference.icon}</span>}
        {preference.starred && <span role="img" aria-label="Starred" className="shrink-0 text-warning">★</span>}
        <span
          className={`min-w-0 flex-1 truncate text-sm ${active ? "text-ink-900" : unread ? "text-ink-900" : "text-ink-800"} ${conversation.main || unread ? "font-medium" : ""}`}
          title={conversation.main ? "The companion's original conversation" : undefined}
        >
          {conversation.title || "New chat"}
        </span>
        {conversation.channel && (
          <span title={`Also on ${conversation.channel === "discord" ? "Discord" : conversation.channel === "telegram" ? "Telegram" : conversation.channel}`} className="shrink-0 text-accent">
            <SendIcon className="h-3 w-3" />
          </span>
        )}
        {running ? (
          waiting ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-warning" title="Waiting for you" />
          ) : (
            <Spinner className="h-3.5 w-3.5 shrink-0 text-muted" />
          )
        ) : unread ? (
          // Not a colour-only difference: the title is also bold, and the dot has a label.
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${unread === "waiting" ? "bg-warning" : "bg-accent"}`}
            role="img"
            aria-label={unread === "waiting" ? "Waiting for you" : "New reply"}
            title={unread === "waiting" ? "Waiting for you" : "New reply"}
          />
        ) : (
          <span className="shrink-0 text-xs text-muted-light group-hover:hidden">
            {relativeTime(conversation.updatedAt, now)}
          </span>
        )}
      </button>
      {selection ? null : (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label="Chat options"
          className="mr-1 shrink-0 rounded-md p-1 text-muted opacity-0 hover:bg-ink-900/10 hover:text-ink-800 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 focus-visible:outline focus-visible:outline-2"
        >
          <MoreIcon className="h-4 w-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuContent} align="start" sideOffset={6}>
            <DropdownMenu.Item className={`${menuItem} data-[disabled]:opacity-50`} disabled={!preferencesLoaded || saving} onSelect={() => void update({ pinned: !preference.pinned }).catch(() => undefined)}>
              {preference.pinned ? "Unpin chat" : "Pin chat"}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItem} data-[disabled]:opacity-50`} disabled={!preferencesLoaded || saving} onSelect={() => void update({ starred: !preference.starred }).catch(() => undefined)}>
              {preference.starred ? "Unstar chat" : "Star chat"}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={`${menuItem} data-[disabled]:opacity-50`} disabled={!preferencesLoaded || saving} onSelect={() => setIconOpen(true)}>
              Choose icon…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            {/* Hearthside: the main chat can't be renamed or archived. */}
            {!conversation.main && (
              <DropdownMenu.Item className={menuItem} onSelect={() => onRename(conversation)}>
                Rename
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className={menuItem} onSelect={() => void forkConversation(conversation.id)}>
              Fork chat
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => void compactConversation(conversation.id)}>
              Summarise older messages
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => void exportConversation(conversation.id)}>
              Save as Markdown…
            </DropdownMenu.Item>
            {!conversation.main && (
              <DropdownMenu.Item className={menuItem} onSelect={() => onResume(conversation)}>
                Resume in Letta Code
              </DropdownMenu.Item>
            )}
            {!conversation.main && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item className={`${menuItem} text-error`} onSelect={() => void archiveConversation(conversation.id)}>
                  Archive
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      )}
      {iconOpen && <ChatIconDialog title={conversation.title || "New chat"} icon={preference.icon} onSave={(icon) => update({ icon })} onClose={() => setIconOpen(false)} />}
    </div>
  );
}

/**
 * Hearthside: tick several chats and archive them in one go, instead of opening the
 * same menu once per chat ("mass archive"). The agent's main chat is left out of
 * both the ticks and "Select all" — it is the one chat that cannot be archived, so
 * offering it would only produce an error. Archived chats keep their messages and
 * come back from "Archived chats", which is why this asks once rather than per chat.
 */
function ArchiveSelection({
  conversations,
  selected,
  onSelected,
  onDone,
}: {
  conversations: ConversationSummary[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  onDone: () => void;
}) {
  const archiveConversations = useAppStore((state) => state.archiveConversations);
  const [busy, setBusy] = useState(false);
  const archivable = conversations.filter((item) => !item.main);
  const all = archivable.length > 0 && archivable.every((item) => selected.has(item.id));
  const count = selected.size;

  const archive = async () => {
    setBusy(true);
    try {
      await archiveConversations([...selected]);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-1 grid grid-cols-1 gap-2 rounded-lg border border-border bg-surface-secondary px-2.5 py-2">
      <label className="flex items-center gap-2 text-xs text-ink-800">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          checked={all}
          disabled={archivable.length === 0 || busy}
          onChange={() => onSelected(all ? new Set() : new Set(archivable.map((item) => item.id)))}
        />
        Select all
        <span className="ml-auto text-muted">{count === 0 ? "none chosen" : `${count} chosen`}</span>
      </label>
      <div className="flex items-center gap-1.5">
        <button type="button" className="button-secondary flex-1 justify-center" disabled={busy} onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="button-primary flex-1 justify-center" disabled={count === 0 || busy} onClick={() => void archive()}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Archive{count > 0 ? ` ${count}` : ""}
        </button>
      </div>
      <span className="text-[0.6875rem] leading-snug text-muted">
        Archived chats keep their messages; bring them back from Archived chats. The original conversation is always kept.
      </span>
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: ConnectionState | null }) {
  if (!connection || connection.status === "connecting") {
    return (
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
        <Spinner className="h-3 w-3 shrink-0" />
        Connecting
      </span>
    );
  }
  const ready = connection.status === "ready";
  if (ready) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted" title={connection.detail}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
        <span className="truncate">{connection.detail}</span>
      </span>
    );
  }
  return <ConnectionProblem error={connection.error} />;
}

// Hearthside: say why we're not connected, with a way to fix it right here.
function ConnectionProblem({ error }: { error?: string }) {
  const reconnect = useAppStore((state) => state.reconnect);
  const openSettings = useAppStore((state) => state.openSettings);
  const needsSignIn = /sign in/i.test(error ?? "");
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted" role="status">
      <span className="flex min-w-0 items-center gap-2" title={error}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-error" />
        <span className="truncate">Not connected</span>
      </span>
      {error && <span className="line-clamp-3 text-[11px] leading-snug">{error}</span>}
      <span className="flex gap-3">
        <button type="button" className="underline hover:text-ink-800" onClick={reconnect}>
          Reconnect
        </button>
        {needsSignIn && (
          <button type="button" className="underline hover:text-ink-800" onClick={() => openSettings("connection")}>
            Sign in
          </button>
        )}
      </span>
    </div>
  );
}

const dialogOverlay = "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]";
const dialogContent =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none";

function RenameDialog({
  conversation,
  onClose,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
}) {
  const renameConversation = useAppStore((state) => state.renameConversation);
  const [title, setTitle] = useState(conversation.title);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={dialogContent} aria-describedby={undefined}>
          <Dialog.Title className="text-base font-semibold text-ink-900">Rename chat</Dialog.Title>
          <form
            className="mt-3 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim()) void renameConversation(conversation.id, title);
              onClose();
            }}
          >
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="field"
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button-primary" disabled={!title.trim()}>
                Rename
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResumeDialog({
  conversation,
  onClose,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = `letta --conv ${conversation.id}`;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={dialogContent}>
          <Dialog.Title className="text-base font-semibold text-ink-900">
            Resume in Letta Code
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Run this in a terminal to continue the chat from the command line.
          </Dialog.Description>
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-tertiary px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink-900">{command}</code>
            <button
              type="button"
              className="button-secondary shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(command).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Sidebar() {
  const conversations = useAppStore((state) => state.conversations);
  // The untouched chat the runtime makes with each new agent is left out in main (listConversations).
  const [chatQuery, setChatQuery] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const preferences = useAppStore((state) => state.chatPreferences);
  const preferencesError = useAppStore((state) => state.chatPreferencesError);
  const retryPreferences = useAppStore((state) => state.refreshChatPreferences);
  const groups = organiseChats(conversations, preferences, chatQuery, starredOnly);
  const visibleConversations = [...groups.pinned, ...groups.rest];
  const conversationsLoaded = useAppStore((state) => state.conversationsLoaded);
  const agentId = useAppStore((state) => state.agentId);
  const connection = useAppStore((state) => state.connection);
  const openChat = useAppStore((state) => state.openChat);
  const openPresence = useAppStore((state) => state.openPresence);
  const openMemory = useAppStore((state) => state.openMemory);
  const openSettings = useAppStore((state) => state.openSettings);
  const presenceOpen = useAppStore((state) => state.view === "presence");
  const memoryOpen = useAppStore((state) => state.view === "memory");
  const skillsOpen = useAppStore((state) => state.view === "skills");
  const openSkills = useAppStore((state) => state.openSkills);
  const schedulesOpen = useAppStore((state) => state.view === "schedules");
  const openSchedules = useAppStore((state) => state.openSchedules);
  const calendarOpen = useAppStore((state) => state.view === "calendar");
  const openCalendar = useAppStore((state) => state.openCalendar);
  const channelsOpen = useAppStore((state) => state.view === "channels");
  const openChannels = useAppStore((state) => state.openChannels);
  const connectorsOpen = useAppStore((state) => state.view === "connectors");
  const openConnectors = useAppStore((state) => state.openConnectors);
  const filesOpen = useAppStore((state) => state.view === "files");
  const openFiles = useAppStore((state) => state.openFiles);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  // Hearthside: "Archive several…" — which chats are ticked, and whether we're ticking at all.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const historyCount = useAppStore((state) => state.historyVolumes.length);
  const historyError = useAppStore((state) => state.historyVolumesError);
  const [moreOpen, setMoreOpen] = useState(() => {
    try {
      return localStorage.getItem("hearthside.sidebarMore") === "1";
    } catch {
      return false;
    }
  });
  // Open while one of its pages is showing.
  const moreShown = moreOpen || skillsOpen || connectorsOpen || filesOpen;
  const toggleMore = () => {
    const next = !moreShown;
    setMoreOpen(next);
    try {
      localStorage.setItem("hearthside.sidebarMore", next ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };
  const [resuming, setResuming] = useState<ConversationSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Keep the relative timestamps fresh.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Ticks belong to the companion whose chats they were: switching agents starts over,
  // so a tick made against one list can never archive a chat in another.
  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
    setStarredOnly(false);
    setChatQuery("");
  }, [agentId]);

  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className={`app-drag shrink-0 ${isMac ? "h-12" : "h-3"}`} />
      <div className="px-2.5">
        {/* Hearthside: agent creation is a visible button, not only a menu item. */}
        <div className="flex items-center gap-1" data-tour="agents">
          <div className="min-w-0 flex-1">
            <AgentSwitcher />
          </div>
          <NewAgentButton />
        </div>
        <button
          type="button"
          data-tour="presence"
          disabled={!agentId}
          onClick={openPresence}
          aria-pressed={presenceOpen}
          className={`mt-2 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${presenceOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
        >
          <PresenceIcon className="h-4 w-4" />
          Presence
        </button>
        <button
          type="button"
          data-tour="new-chat"
          disabled={!agentId}
          onClick={() => openChat(null)}
          className="mt-1 flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium text-ink-800 hover:bg-surface-tertiary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" />
          New chat
          <kbd className="ml-auto font-sans text-xs text-muted-light">{isMac ? "⌘N" : "Ctrl+N"}</kbd>
        </button>
        <button
          type="button"
          data-tour="memory"
          disabled={!agentId}
          onClick={openMemory}
          aria-pressed={memoryOpen}
          className={`mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${memoryOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
        >
          <MemoryIcon className="h-4 w-4" />
          Memory
        </button>
        <div data-tour="tools">
        <button
          type="button"
          disabled={!agentId}
          onClick={openSchedules}
          aria-pressed={schedulesOpen}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${schedulesOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
        >
          <ClockIcon className="h-4 w-4" />
          Schedules
        </button>
        <button
          type="button"
          disabled={!agentId}
          onClick={openCalendar}
          aria-pressed={calendarOpen}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${calendarOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
        >
          <CalendarIcon className="h-4 w-4" />
          Calendar
        </button>
        <button
          type="button"
          disabled={!agentId}
          onClick={openChannels}
          aria-pressed={channelsOpen}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${channelsOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
        >
          <SendIcon className="h-4 w-4" />
          Channels
        </button>
        </div>
        {/* Hearthside: the less-used pages fold away under More. */}
        <button
          type="button"
          data-tour="more"
          onClick={() => toggleMore()}
          aria-expanded={moreShown}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:bg-ink-900/5 hover:text-ink-800"
        >
          <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${moreShown ? "rotate-90" : ""}`} />
          Tools &amp; history
        </button>
        {moreShown && (
          <div className="pl-2">
            <button
              type="button"
              disabled={!agentId}
              onClick={openSkills}
              aria-pressed={skillsOpen}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${skillsOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
            >
              <SkillsIcon className="h-4 w-4" />
              Skills
            </button>
            <button
              type="button"
              disabled={!agentId}
              onClick={openConnectors}
              aria-pressed={connectorsOpen}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${connectorsOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
            >
              <PlugIcon className="h-4 w-4" />
              Connectors
            </button>
            <button
              type="button"
              disabled={!agentId}
              onClick={openFiles}
              aria-pressed={filesOpen}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${filesOpen ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
            >
              <FolderIcon className="h-4 w-4" />
              Files
            </button>
            {/* Archived chats are kept, so offer a way back to them. */}
            <button
              type="button"
              disabled={!agentId}
              onClick={() => setShowArchived(true)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-800 transition-colors hover:bg-ink-900/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <HistoryIcon className="h-4 w-4" />
              Archived chats
            </button>
            
            {(historyCount > 0 || historyError) && (
              <button
                type="button"
                onClick={() => setShowHistory(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-800 transition-colors hover:bg-ink-900/5"
              >
                <HistoryIcon className="h-4 w-4" />
                History
              </button>
            )}
          </div>
        )}
      </div>

      <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {agentId && preferencesError && <div role="status" className="mb-2 rounded-lg border border-border px-2.5 py-2 text-xs text-muted">
          Pins, stars and icons are unavailable. Your chats still work.
          <button type="button" className="ml-1 text-accent hover:underline" onClick={() => void retryPreferences()}>Retry organisation</button>
        </div>}
        {/* Hearthside: history parts are searchable too, even when there is only the main chat. */}
        {agentId && (conversations.length > 1 || historyCount > 0) && <ChatSearch query={chatQuery} onQuery={setChatQuery} agentId={agentId} />}
        {agentId && <div className="mb-2 flex gap-1" aria-label="Chat filters">
          <button type="button" aria-pressed={!starredOnly} className="rounded-lg px-2.5 py-1 text-xs text-ink-800 aria-pressed:bg-ink-900/8" onClick={() => setStarredOnly(false)}>All chats</button>
          <button type="button" aria-pressed={starredOnly} className="rounded-lg px-2.5 py-1 text-xs text-ink-800 aria-pressed:bg-ink-900/8" onClick={() => setStarredOnly(true)}>Starred</button>
        </div>}
        {agentId && conversationsLoaded && visibleConversations.length === 0 && (
          <div className="px-2.5 py-3 text-xs text-muted">
            <p>{starredOnly ? "No starred chats match." : chatQuery.trim() ? "No chats match." : "No chats yet."}</p>
            {(starredOnly || chatQuery.trim()) && <button type="button" className="mt-1 text-accent hover:underline" onClick={() => { setStarredOnly(false); setChatQuery(""); }}>Show all chats</button>}
          </div>
        )}
        {/* Hearthside: tidying up several chats at once, rather than one menu at a time.
            Only offered once there is more than the chat that can't be archived anyway. */}
        {agentId && conversationsLoaded && conversations.filter((item) => !item.main).length > 1 && (
          selecting ? (
            <ArchiveSelection
              conversations={visibleConversations}
              selected={selected}
              onSelected={setSelected}
              onDone={() => {
                setSelecting(false);
                setSelected(new Set());
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setSelecting(true)}
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-ink-900/5 hover:text-ink-800"
            >
              <HistoryIcon className="h-3.5 w-3.5" />
              Archive several…
            </button>
          )
        )}
        <div className="flex flex-col gap-0.5">
          {([{ label: "Pinned", chats: groups.pinned }, { label: starredOnly ? "Starred chats" : "Chats", chats: groups.rest }]).map((section) => section.chats.length > 0 && <section key={section.label} aria-label={section.label}>
          <h2 className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">{section.label}</h2>
          {section.chats.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              now={now}
              onRename={setRenaming}
              onResume={setResuming}
              {...(selecting
                ? {
                    selection: {
                      selected: selected.has(conversation.id),
                      onToggle: () =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (next.has(conversation.id)) next.delete(conversation.id);
                          else next.add(conversation.id);
                          return next;
                        }),
                    },
                  }
                : {})}
            />
          ))}
          </section>)}
        </div>
      </nav>

      <ChannelServiceNotice />
      <UpdateBanner />
      <div className="flex shrink-0 items-start justify-between gap-2 border-t border-border px-3.5 py-2.5">
        <ConnectionBadge connection={connection} />
        <button
          type="button"
          onClick={() => openSettings("general")}
          data-tour="settings"
          aria-label="Settings"
          title="Settings"
          className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-ink-900/8 hover:text-ink-800 transition-colors"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </div>

      {renaming && <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} />}
      {showArchived && agentId && <ArchivedChatsDialog agentId={agentId} onClose={() => setShowArchived(false)} />}
      {showHistory && <HistoryDialog onClose={() => setShowHistory(false)} />}
      {resuming && <ResumeDialog conversation={resuming} onClose={() => setResuming(null)} />}
    </aside>
  );
}
