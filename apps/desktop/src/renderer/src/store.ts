// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { create } from "zustand";
import type { ChatPreference, ChatPreferencePatch, ConversationExecutionState, ConversationExecutionTarget, ConversationMoveState, Looks, ReasoningEffort, TurnActivityPhase } from "@hearthside/ipc-contract";
import { prepareAskUserQuestionNotif } from "@letta-ai/letta-code/ask-user-question";
import { MAX_ATTACHMENTS, readAttachments } from "./lib/attachments";
import { isChannelAttempt, pendingChannelCallIds } from "./lib/channel-delivery";
import { isRetryOfSamePlace, moveInFlight } from "./lib/move-status";
import { parseCommand, readSlash, rememberMessage, unknownCommandNotice, withModCommands } from "./lib/commands";
import { resolveModel, sessionModel } from "./lib/models";
import { historyConnects, mergeHistory, optimisticUserRow, rowIdentity, upsertRows } from "./lib/rows";
import type {
  ChannelServiceStatus,
  CreateAgentInput,
  ReadyUpdate,
  AgentSummary,
  AgentUpdate,
  AppEvent,
  AppSettings,
  ApprovalDecision,
  Attachment,
  ApprovalRequest,
  ChatCommandCatalog,
  ChatRow,
  ChatTextRow,
  ChatUsage,
  RuntimeCommand,
  ConnectionState,
  ConversationSummary,
  MemoryFile,
  ModelOption,
  ProviderSummary,
  SettingsUpdate,
} from "./types";

const api = window.bridge;
let memoryRefresh: ReturnType<typeof setTimeout> | null = null;
let attachmentGeneration = 0;
const historyRequests = new Map<string, number>();
let chatPreferencesRequest = 0;

/** Key for the chat that has not been sent yet. */
export const NEW_CHAT = "new";


export function composerKey(state: { activeId: string | null; agentId: string | null }): string {
  return state.activeId ?? `${NEW_CHAT}:${state.agentId ?? ""}`;
}

/** Whether a composer slot is a new chat (not yet a conversation). */
export function isNewChatKey(key: string): boolean {
  return key === NEW_CHAT || key.startsWith(`${NEW_CHAT}:`);
}
const HISTORY_PAGE = 100;
/** The most one load asks for (the main process accepts up to 500). */
const HISTORY_MAX = 500;

/** Older pages prepend; unlike latest-page reconciliation they need not overlap. */
function prependHistory(older: ChatRow[], current: ChatRow[]): ChatRow[] {
  const seen = new Set(current.map(rowIdentity));
  return [...older.filter((row) => !seen.has(rowIdentity(row))), ...current];
}

export type ChatState = {
  execution?: ConversationExecutionState;
  executionLoading?: boolean;
  executionSaving?: boolean;
  executionError?: string | null;
  rows: ChatRow[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  nextBefore?: string | null;
  messageKeys?: Record<string, string[]>;
  historyCursors?: string[];
  limit: number;
  running: boolean;
  /** Ephemeral call IDs first observed in this turn's live rows, never from history. */
  liveChannelCallIds?: string[];
  activity: string | null;
  /**
   * Hearthside: the runtime's own phase for this turn, and the long version of
   * what it said. The phase decides what the status line claims — that the agent
   * is thinking, or that it is waiting on a computer somewhere else — so it is
   * only ever the runtime's, never worked out from the sentence here.
   */
  activityPhase?: TurnActivityPhase | null;
  activityDetail?: string | null;
  /** Hearthside: this conversation moving to another computer, as the backend reports it. */
  move?: ConversationMoveState | null;
  /** A move request in flight, and why the last one never got sent. */
  moveSending?: boolean;
  moveError?: string | null;
  error: string | null;
  approvals: ApprovalRequest[];
  /** Hearthside: messages waiting to send when the current turn ends. */
  queue: QueuedMessage[];
  /** Hold the queue (after Stop or an error) until the person sends it. */
  queuePaused: boolean;
  /** Sticky safety holds only; execution availability is a live gate, not consent. */
  queuePauseReason?: "stopped" | "offline" | "detached" | "device-change" | "error" | "failed-send" | "delivery" | "destination-required";
  /** Hearthside: how full the context is (from the last turn). */
  usage: ChatUsage | null;
  /** Hearthside: tools still running after the reply, and when the last one finished. */
  backgroundTools?: number;
  backgroundEndedAt?: number;


  approvalSending?: string | null;
  approvalError?: string | null;


  stopRequested?: boolean;


  historyError?: string | null;
};

/** Hearthside: a message written while the agent was busy. */
export type QueuedMessage = { id: string; text: string; attachments: Attachment[]; cwd: string; model?: string; reasoningEffort?: ReasoningEffort; agentId?: string;
  /** IPC rejection is not proof of non-acceptance. Quarantined, never replayed. */
  deliveryUnconfirmed?: boolean;
  /**
   * Why this message is sitting here, when the main process proved it was never
   * submitted and named a reason this app can clear. Only `destination-required`
   * exists: the person pressed Send, nothing left the app, and the one thing
   * missing was a destination. Any other failure leaves this unset and the
   * message waits for the person.
   */
  heldReason?: "destination-required";
};

/** Async composer work is valid only for the selection and draft it started with. */
export type ComposerSnapshot = {
  epoch: number; agentId: string | null; activeId: string | null;
  executionDeviceId: string | null;
  executionIdentity: string;
  draft: string | undefined; attachments: Attachment[] | undefined;
  cwd: string | undefined; model: string | undefined;
};
export function captureComposer(): ComposerSnapshot {
  const state = useAppStore.getState();
  const key = composerKey(state);
  return {
    epoch: state.backendEpoch, agentId: state.agentId, activeId: state.activeId,
    executionDeviceId: executionDeviceId(state.settings),
    executionIdentity: executionIdentity(state.chats[key]?.execution),
    draft: state.drafts[key], attachments: state.attachments[key],
    cwd: state.cwdOverrides[key], model: state.modelOverrides[key],
  };
}

function composerMatches(state: AppState, source: ComposerSnapshot): boolean {
  const key = composerKey(source);
  return state.connection?.status === "ready" && state.backendEpoch === source.epoch &&
    state.agentId === source.agentId && state.activeId === source.activeId &&
    executionDeviceId(state.settings) === source.executionDeviceId &&
    executionIdentity(state.chats[key]?.execution) === source.executionIdentity && !state.chats[key]?.executionSaving &&
    state.drafts[key] === source.draft && state.attachments[key] === source.attachments &&
    state.cwdOverrides[key] === source.cwd && state.modelOverrides[key] === source.model;
}

function executionIdentity(execution?: ConversationExecutionState): string {
  return JSON.stringify([execution?.selected, execution?.observed?.kind, execution?.observed?.deviceId, execution?.status === "blocked", execution?.followsOwner === true, execution?.requiresDestination === true]);
}

function executionDeviceId(settings: AppSettings | null): string | null {
  return settings?.backend === "cloud" ? settings.executionComputer?.deviceId ?? null : null;
}

/** No secrets: the local profile and server address distinguish known destinations. */
function backendKey(settings: AppSettings | null): string {
  // Hearthside: This computer is the same store whatever Letta Cloud or server
  // details are saved beside it. Counting those in made a Letta sign-out (or an
  // expired sign-in) while on This computer look like a new account: the window
  // dropped its companions and chats, and nothing reloaded them because the
  // local connection had not changed.
  if (settings?.backend === "local") return JSON.stringify(["local", settings.useRealLettaHome, settings.connectionRevision]);
  // A self-hosted server is likewise its own store whoever is signed in to Letta.
  if (settings?.backend === "remote") return JSON.stringify(["remote", settings.serverUrl, settings.hasServerToken, settings.connectionRevision]);
  return JSON.stringify(settings && [settings.backend, settings.serverUrl, settings.apiBaseUrl,
    settings.useRealLettaHome, settings.hasApiKey, settings.hasLettaSignIn, settings.hasServerToken,
    settings.connectionRevision]);
}

export type MemoryState = {
  loading: boolean;
  error: string | null;
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type SettingsTab = "general" | "appearance" | "connection" | "providers" | "backups" | "mods" | "intentions" | "diagnostics" | "about";

const EMPTY_CHAT: ChatState = {
  rows: [],
  loaded: false,
  loading: false,
  hasMore: false,
  limit: HISTORY_PAGE,
  running: false,
  activity: null,
  error: null,
  approvals: [],
  queue: [],
  queuePaused: false,
  usage: null,
};

type AppState = {
  settings: AppSettings | null;
  connection: ConnectionState | null;
  /** Invalidate asynchronous writes whenever the connection or account changes. */
  backendEpoch: number;
  backendIdentity: string | null;
  agents: AgentSummary[];
  agentsLoaded: boolean;
  agentId: string | null;
  models: ModelOption[];
  /** null until loaded, or when the backend manages providers itself. */
  providers: ProviderSummary[] | null;
  /** What the main area shows for the selected agent. */
  view: "chat" | "memory" | "skills" | "schedules" | "calendar" | "channels" | "connectors" | "files";
  memory: MemoryState | null;
  conversations: ConversationSummary[];
  conversationsLoaded: boolean;
  /** Hearthside: this companion's read-only history parts (restored from a Cloud backup), oldest first. */
  historyVolumes: ConversationSummary[];
  /** Hearthside: why the history parts couldn't be listed; distinct from having none. */
  historyVolumesError: string | null;
  /** Hearthside: a message to scroll to once its chat has loaded (from a search result). */
  focus: { conversationId: string; messageId: string } | null;
  /** null is the new, unsent chat. */
  activeId: string | null;
  chats: Record<string, ChatState>;
  /** Hearthside: slash commands the runtime advertises, per chat; missing until asked. */
  chatCommands: Record<string, ChatCommandCatalog>;
  /** Unsent composer text per chat. */
  drafts: Record<string, string>;
  /** Hearthside: attachments waiting in the composer, per chat. */
  attachments: Record<string, Attachment[]>;
  attachmentReads: number;
  /** Working directory and model picked in the composer but not yet sent. */
  cwdOverrides: Record<string, string>;
  modelOverrides: Record<string, string>;
  /** The first message of a new chat, shown while its conversation is created. */
  pendingFirstMessage: ChatTextRow | null;
  notice: string | null;
  /**
   * Hearthside: chats that finished a turn or asked for something while the
   * person was looking somewhere else. The desktop notification only fires when
   * the window isn't in front (see main/libs/notifications.ts), so without this
   * nothing told you an agent had finished in another chat while Hearthside was
   * the window you were using.
   *
   * "waiting" (an approval or a question) outranks "replied": it is the one that
   * needs the person. A chat is read again as soon as it is opened, or as soon
   * as the window comes back with that chat already on screen.
   */
  unread: Record<string, "replied" | "waiting">;
  /**
   * The newest of those, for the in-app notice. Separate from `notice`, which is
   * for problems and is styled as one; this is good news and leads somewhere.
   */
  finished: { conversationId: string; kind: "replied" | "waiting" } | null;
  /** Hearthside: a downloaded update's version, ready to install. */
  updateReady: ReadyUpdate | null;
  /** Hearthside: the Telegram/Discord channel service on this computer; null until read. */
  channelService: ChannelServiceStatus | null;
  /** Hearthside: pictures and chat backgrounds ("make it yours"); null until loaded. */
  looks: Looks | null;
  chatPreferences: Record<string, ChatPreference>;
  chatPreferencesLoaded: boolean;
  chatPreferencesScope: string | null;
  chatPreferencesRevision: number;
  chatPreferencesError: string | null;
  refreshChatPreferences: () => Promise<void>;
  updateChatPreference: (conversationId: string, patch: ChatPreferencePatch) => Promise<void>;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  newAgentOpen: boolean;
  /** Hearthside: open the New agent dialog straight on the companion builder. */
  newAgentStart: "choose" | "companion";
  agentSettingsOpen: boolean;

  refreshExecution: (conversationId: string, options?: { background?: boolean }) => Promise<void>;
  setExecution: (conversationId: string, target: ConversationExecutionTarget) => Promise<void>;
  /**
   * Choose where this conversation runs, through the picker.
   *
   * The main process decides what that means against fresh ownership: a live
   * owner is asked to hand the conversation over (resolving means Letta accepted
   * the request, not that anything has moved — the phase on the result and on
   * later `conversation.move` events says where it actually is), while an idle
   * conversation gets its next destination recorded and is not moved at all.
   */
  moveConversation: (conversationId: string, placeId: string) => Promise<void>;
  bootstrap: () => Promise<void>;
  handleEvent: (event: AppEvent) => void;
  refreshAgents: () => Promise<void>;
  reloadModels: () => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  createAgent: (input: CreateAgentInput) => Promise<void>;
  updateAgent: (update: AgentUpdate) => Promise<AgentSummary>;
  deleteAgent: () => Promise<void>;
  openChat: (conversationId: string | null, focusMessageId?: string) => void;
  /** Hearthside: list this companion's read-only history parts. */
  loadHistoryVolumes: () => Promise<void>;


  continueFromHistory: (quote: string | null, date: string | null) => void;
  loadHistory: (conversationId: string, limit?: number, quiet?: boolean, options?: { before?: string; around?: string }) => Promise<void>;
  loadEarlier: (conversationId: string) => Promise<void>;
  /** extra: attachments that go with this message only (e.g. a GIF's frames). */
  send: (text: string, extra?: Attachment[], source?: ComposerSnapshot) => Promise<void>;
  addAttachments: (files: Iterable<File>) => Promise<void>;
  removeAttachment: (index: number) => void;
  /** Hearthside: answer (or, with null, dismiss) questions the agent posted. */
  answerQuestion: (toolCallId: string, questions: AskQuestion[], answers: Record<string, string> | null) => void;
  removeQueued: (id: string) => void;
  /** `fromComposer: false` for a command chosen from a menu: what is typed in the message box is not the command, and stays. */
  runCommand: (command: RuntimeCommand, args: string, typed: string, fromComposer?: boolean) => Promise<void>;
  /** Hearthside: the slash commands the runtime advertises for a chat, once asked. */
  loadChatCommands: (conversationId: string) => Promise<void>;
  /** Hearthside: run a command a mod registered (never built-ins; those have their own path). */
  runModCommand: (commandId: string, args: string, typed: string) => Promise<void>;
  forkConversation: (conversationId: string) => Promise<void>;
  exportConversation: (conversationId: string) => Promise<void>;
  compactConversation: (conversationId: string) => Promise<void>;
  setChatContextWindow: (conversationId: string, limit: number | null) => Promise<void>;
  sendQueueNow: () => void;
  stop: () => void;
  respondApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  /**
   * Hearthside: archive several chats at once. The agent's main chat is never
   * archived, whatever is passed in — it is the one conversation that can't be,
   * and a tick-everything gesture must not be able to try.
   */
  archiveConversations: (conversationIds: string[]) => Promise<void>;
  saveSettings: (update: SettingsUpdate) => Promise<void>;
  loadProviders: () => Promise<void>;
  connectProvider: (input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }) => Promise<void>;
  disconnectProvider: (input: { providerId: string; providerName?: string }) => Promise<void>;
  openMemory: () => void;
  openSkills: () => void;
  openSchedules: () => void;
  /** Hearthside: reload the chat list (new chats can come from Telegram/Discord). */
  refreshConversations: () => Promise<void>;
  openChannels: () => void;
  openConnectors: () => void;
  openCalendar: () => void;
  openFiles: () => void;
  loadMemory: () => Promise<void>;
  saveMemoryFile: (path: string, content: string, target?: { agentId: string; epoch: number; file: Pick<MemoryFile, "path">; original?: string }) => Promise<void>;
  deleteMemoryFile: (path: string) => Promise<void>;
  openSettings: (tab: SettingsTab) => void;
  reconnect: () => void;
  pickCwd: () => Promise<void>;
  setCwd: (cwd: string) => void;
  setModel: (handle: string) => void;
  setDraft: (text: string) => void;
  setNotice: (notice: string | null) => void;
  /** Hearthside: this chat has been seen; drop its unread mark and any notice about it. */
  markChatRead: (conversationId: string) => void;
  /** Hearthside: dismiss the "finished" notice without opening the chat. */
  dismissFinished: () => void;
  /** Hearthside: open the chat a "finished in another chat" notice is about, under the companion it belongs to. */
  openFinished: (conversationId: string) => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean, start?: "choose" | "companion") => void;
  setAgentSettingsOpen: (open: boolean) => void;
};

export type AskQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hearthside: is the person looking at this chat right now? Only then does a
 * finished turn need no marker, so every way the chat can be out of sight has
 * to be asked about:
 *
 *  - the chat view is the open view, and this is the chat in it;
 *  - no full-page dialog is over it. Settings and Agent settings are FullPage
 *    and New agent is a modal overlay, so each one hides the chat completely —
 *    a turn that ends behind one has not been seen, and suppressing its mark
 *    there loses it for good;
 *  - the window has focus. That is what separates "on screen" from "on screen
 *    behind another window"; the second still deserves a mark, because the
 *    desktop notification meant to cover it can be turned off, or missed.
 *
 * Exported because the window-focus handler in App.tsx has to ask exactly this
 * question before clearing a mark. The two drifting apart is how a mark gets
 * dropped for a chat nobody can actually see.
 */
export function watchingChat(state: AppState, conversationId: string): boolean {
  if (state.view !== "chat" || state.activeId !== conversationId) return false;
  if (state.settingsOpen || state.agentSettingsOpen || state.newAgentOpen) return false;
  return typeof document !== "undefined" && document.hasFocus();
}

/** Hearthside: mark a chat unread, unless it is the one being watched. "waiting" never downgrades to "replied". */
function markUnread(state: AppState, conversationId: string, kind: "replied" | "waiting"): Partial<AppState> {
  if (watchingChat(state, conversationId)) return {};
  if (state.unread[conversationId] === "waiting" && kind === "replied") return {};
  return { unread: { ...state.unread, [conversationId]: kind }, finished: { conversationId, kind } };
}

function patchChat(
  state: AppState,
  conversationId: string,
  patch: (chat: ChatState) => Partial<ChatState>,
): Pick<AppState, "chats"> {
  const chat = state.chats[conversationId] ?? EMPTY_CHAT;
  return { chats: { ...state.chats, [conversationId]: { ...chat, ...patch(chat) } } };
}

function upsertConversation(
  list: ConversationSummary[],
  conversation: ConversationSummary,
): ConversationSummary[] {
  // Hearthside: the agent's main chat stays pinned first; the rest by recency.
  return [conversation, ...list.filter((item) => item.id !== conversation.id)].sort(
    (a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)) || b.updatedAt - a.updatedAt,
  );
}

const CLEARED = {
  chatPreferences: {} as Record<string, ChatPreference>,
  chatPreferencesLoaded: false,
  chatPreferencesScope: null as string | null,
  chatPreferencesRevision: 0,
  chatPreferencesError: null as string | null,
  agents: [],
  agentsLoaded: false,
  agentId: null,
  models: [],
  providers: null,
  view: "chat",
  memory: null,
  conversations: [],
  conversationsLoaded: false,
  historyVolumes: [],
  historyVolumesError: null,
  focus: null,
  activeId: null,
  chats: {},
  // Hearthside: what one runtime (and one companion) advertised. A different
  // account, agent or connection must start from nothing, not from these.
  chatCommands: {},
  pendingFirstMessage: null,
  // A different account, agent or connection has none of this agent's unread chats.
  unread: {},
  finished: null,
} satisfies Partial<AppState>;

// Share reads across the header/composer without treating transport activity as
// visible loading. Explicit destination choices still wait for these checks.
const executionChecks = new Map<string, { epoch: number; promise: Promise<boolean> }>();
/** How many times loading the companions has failed for one connection (see refreshAgents). */
const agentLoadAttempts = new Map<number, number>();
const agentLoadRetry = new Set<number>();

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  connection: null,
  backendEpoch: 0,
  backendIdentity: null,
  ...CLEARED,
  drafts: {},
  attachments: {},
  attachmentReads: 0,
  cwdOverrides: {},
  modelOverrides: {},
  notice: null,
  updateReady: null,
  channelService: null,
  looks: null,
  settingsOpen: false,
  settingsTab: "connection",
  newAgentOpen: false,
  newAgentStart: "choose",
  agentSettingsOpen: false,

  refreshExecution: async (conversationId, options) => {
    const epoch = get().backendEpoch;
    const chat = get().chats[conversationId];
    if (chat?.executionSaving) return;
    if (!options?.background || !chat?.execution) {
      set((state) => patchChat(state, conversationId, () => ({ executionLoading: true })));
    }
    const pending = executionChecks.get(conversationId);
    if (pending?.epoch === epoch) { await pending.promise; return; }
    const check = { epoch, promise: Promise.resolve(false) };
    executionChecks.set(conversationId, check);
    check.promise = (async () => {
      try {
        const execution = await api.getConversationExecution(conversationId);
        if (get().backendEpoch !== epoch) return false;
        get().handleEvent({ type: "conversation.execution", state: execution });
        return true;
      } catch (error) {
        if (get().backendEpoch === epoch) set((state) => patchChat(state, conversationId, () => ({ executionError: errorMessage(error) })));
        return false;
      } finally {
        if (executionChecks.get(conversationId) === check) executionChecks.delete(conversationId);
        if (get().backendEpoch === epoch && get().chats[conversationId]?.executionLoading) {
          set((state) => patchChat(state, conversationId, () => ({ executionLoading: false })));
        }
      }
    })();
    await check.promise;
  },

  setExecution: async (conversationId, target) => {
    const chat = get().chats[conversationId];
    const eligible = target.kind === "follow-owner" ? chat?.execution?.canFollowCurrentOwner : chat?.execution?.canMoveExecution;
    if (get().connection?.status !== "ready" || !eligible || chat?.execution?.pendingDelivery ||
      (chat?.running && chat.execution?.status !== "blocked" && target.kind !== "follow-owner") || chat?.executionSaving || chat?.executionLoading || get().pendingFirstMessage) return;
    const epoch = get().backendEpoch;
    set((state) => patchChat(state, conversationId, () => ({ executionSaving: true, executionError: null })));
    let destinationConfirmed = false;
    try {
      const check = executionChecks.get(conversationId);
      if (check?.epoch === epoch) {
        const checked = await check.promise;
        if (get().backendEpoch !== epoch) return;
        if (!checked) return; // The check's actual error remains visible; never replay the choice.
        const fresh = get().chats[conversationId];
        const allowed = target.kind === "follow-owner" ? fresh?.execution?.canFollowCurrentOwner : fresh?.execution?.canMoveExecution;
        if (get().connection?.status !== "ready" || !allowed || fresh?.execution?.pendingDelivery || get().pendingFirstMessage ||
          (fresh?.running && fresh.execution?.status !== "blocked" && target.kind !== "follow-owner")) {
          throw new Error("Execution status changed. Check the current status before choosing a destination.");
        }
      }
      const execution = await api.setConversationExecution(conversationId, target);
      if (get().backendEpoch === epoch) {
        const current = get().chats[conversationId]?.execution;
        destinationConfirmed = !current || execution.revision >= current.revision;
        get().handleEvent({ type: "conversation.execution", state: execution });
      }
    } catch (error) {
      if (get().backendEpoch === epoch) set((state) => patchChat(state, conversationId, () => ({ executionError: errorMessage(error) })));
    } finally {
      if (get().backendEpoch === epoch) {
        // A failed/cancelled move must not release waiting input to the old
        // destination, including on a later healthy observation.
        set((state) => patchChat(state, conversationId, (current) => ({ executionSaving: false,
          ...(!destinationConfirmed && current.queue.length ? { queuePaused: true, queuePauseReason: "error" as const } : {}) })));
        if (destinationConfirmed) flushQueue(conversationId);
      }
    }
  },

  moveConversation: async (conversationId, placeId) => {
    const chat = get().chats[conversationId];
    if (get().connection?.status !== "ready" || chat?.moveSending) return;
    // A move already under way is left alone: asking again could move the
    // conversation twice. Asking for the same place after it stalled is a
    // reconcile, which the backend recognises from the key it kept.
    if (moveInFlight(chat?.move) && !isRetryOfSamePlace(chat?.move, placeId)) return;
    const epoch = get().backendEpoch;
    const identity = get().backendIdentity;
    set((state) => patchChat(state, conversationId, () => ({ moveSending: true, moveError: null })));
    try {
      const outcome = await api.moveConversation(conversationId, placeId);
      if (get().backendEpoch !== epoch) return;
      if (outcome.kind === "moved") {
        // Nothing has moved yet; this is the first report, handled like any other.
        get().handleEvent({ type: "conversation.move", state: outcome.move });
      } else {
        // Nothing moved and nothing was sent: this conversation now has a
        // verified destination for its next message.
        get().handleEvent({ type: "conversation.execution", state: outcome.execution });
        resumeAfterDestination(conversationId, epoch, identity);
      }
    } catch (error) {
      if (get().backendEpoch === epoch) set((state) => patchChat(state, conversationId, () => ({ moveError: errorMessage(error) })));
    } finally {
      if (get().backendEpoch === epoch) set((state) => patchChat(state, conversationId, () => ({ moveSending: false })));
    }
  },

  bootstrap: async () => {
    const [settings, connection, updateReady, looks, channelService] = await Promise.all([api.getSettings(), api.getConnection(), api.getUpdateReady(), api.getLooks(), api.getChannelServiceStatus().catch(() => null)]);
    // An event may already have arrived while this snapshot was on its way, and
    // a snapshot that couldn't be read says nothing: neither replaces a newer status.
    const heard = get().connection;
    set((state) => ({ settings, updateReady, looks,
      channelService: channelService === null || (state.channelService && state.channelService.revision > channelService.revision) ? state.channelService : channelService }));
    // The same goes for the connection. The snapshot is usually "connecting"
    // (the runtime takes seconds to start); if "ready" was announced while it
    // was on its way, applying the snapshot afterwards counted as a disconnect,
    // cancelled the load in progress and left "Starting Letta" with no further
    // event to end it. Only a window that has heard nothing takes the snapshot.
    if (!heard) get().handleEvent({ type: "connection", state: connection });
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "conversation.execution": {
        const incoming = event.state;
        const previous = get().chats[incoming.conversationId]?.execution;
        if (previous && incoming.revision < previous.revision) break;
        set((state) => patchChat(state, incoming.conversationId, () => ({ execution: incoming, executionError: null })));
        // Resume only unsent work; sticky safety holds and receipt guards remain in flushQueue.
        flushQueue(incoming.conversationId);
        break;
      }
      case "connection": {
        const previous = get().connection;
        if (previous && previous.backend !== event.state.backend) {
          set((state) => ({ ...CLEARED, drafts: {}, attachments: {}, cwdOverrides: {}, modelOverrides: {},
            backendEpoch: state.backendEpoch + 1, backendIdentity: null }));
        }
        set({ connection: event.state });
        if (event.state.status === "ready" && (previous?.status !== "ready" || previous.backend !== event.state.backend)) {
          void get().refreshAgents();
        } else if (event.state.status !== "ready" && previous?.status === "ready") {
          // Keep unsent work, but never automatically resume it after a disconnect.
          // Desktop metadata failure is not failure of an independent remote
          // turn. Keep its selected chat, approvals and Stop control reachable.
          const remote = new Set(event.state.activeRemoteConversationIds ?? []);
          set((state) => ({
            // Retain the known account/chat for local drafting. Settings identity
            // changes still clear all private work; readiness never grants dispatch.
            backendEpoch: state.backendEpoch + 1,
            chats: Object.fromEntries(Object.entries(state.chats).map(([id, chat]) => [id, {
              ...chat, loading: false, queuePaused: true, queuePauseReason: "offline" as const,
              ...(remote.has(id) ? {} : { running: false, liveChannelCallIds: [], activity: null, activityPhase: null, activityDetail: null, approvals: [] }),
            }])),
          }));
        }
        break;
      }
      case "turn.detached":
        set((state) => patchChat(state, event.conversationId, () => ({ running: false, liveChannelCallIds: [], activity: null, activityPhase: null, activityDetail: null, approvals: [], approvalSending: null, approvalError: null, stopRequested: false, queuePaused: true, queuePauseReason: "detached" })));
        break;
      case "turn.started":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: true,
            liveChannelCallIds: [],
            error: null,
            activity: "Starting",
            activityPhase: null,
            activityDetail: null,
          })),
        );
        break;
      case "turn.rows":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => {
            const rows = upsertRows(chat.rows, event.rows);
            const known = new Set(chat.rows.flatMap((row) => row.kind === "tool_call" ? [row.toolCallId] : []));
            const live = new Set(chat.liveChannelCallIds);
            for (const row of event.rows) {
              if (row.kind === "tool_call" && isChannelAttempt(row) && !known.has(row.toolCallId)) live.add(row.toolCallId);
            }
            return {
              rows,
              liveChannelCallIds: chat.running ? pendingChannelCallIds(rows, live) : [],
            };
          }),
        );
        break;
      case "turn.rows.removed": {
        const removed = new Set(event.keys);
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            rows: chat.rows.filter((row) => !removed.has(row.key)),
          })),
        );
        break;
      }
      case "turn.background":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            backgroundTools: event.tools,
            ...(event.tools === 0 ? { backgroundEndedAt: Date.now() } : {}),
          })),
        );
        break;
      case "turn.activity":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            activity: event.activity,
            activityPhase: event.phase ?? null,
            activityDetail: event.detail ?? null,
          })),
        );
        break;
      case "conversation.move": {
        const incoming = event.state;
        const previous = get().chats[incoming.conversationId]?.move;
        // Revisions only go forward: a late report must not undo a newer one.
        if (previous && incoming.revision < previous.revision) break;
        set((state) => patchChat(state, incoming.conversationId, () => ({ move: incoming })));
        break;
      }
      case "turn.finished": {
        const before = get().chats[event.conversationId];
        // Hearthside: after Stop or an error the queue waits for the person.
        const hold = Boolean(event.error) || Boolean(before?.queuePaused) || Boolean(before?.stopRequested);
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: false,
            activity: null,
            activityPhase: null,
            activityDetail: null,
            approvals: [],
            approvalSending: null,
            approvalError: null,
            stopRequested: false,
            error: event.error ?? null,
            queuePaused: hold && (before?.queue.length ?? 0) > 0,
            queuePauseReason: before?.stopRequested ? "stopped" : event.error ? "error" : before?.queuePauseReason,
            liveChannelCallIds: [],
          })),
        );
        // Hearthside: tell the person it finished, if they weren't watching this chat.
        // An error already shows in the chat itself and is not good news to announce.
        if (!event.error) set((state) => markUnread(state, event.conversationId, "replied"));
        if (!hold) flushQueue(event.conversationId);
        // Hearthside: after an error, show what Letta actually holds for this chat (the reply may
        // have been retried, or carried on somewhere else), quietly.
        if (event.error && before?.loaded) void get().loadHistory(event.conversationId, undefined, true);
        // The agent may have rewritten its memory during the turn.
        if (get().view === "memory") void get().loadMemory();
        break;
      }
      case "approval.requested":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: [
              ...chat.approvals.filter((item) => item.requestId !== event.request.requestId),
              event.request,
            ],
          })),
        );
        // A chat that is waiting for an answer is the one that most needs finding again.
        set((state) => markUnread(state, event.conversationId, "waiting"));
        break;
      case "approval.resolved":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: chat.approvals.filter((item) => item.requestId !== event.requestId),
          })),
        );
        break;
      case "agent.updated":
        // The main chat has no model of its own; its entry repeats the agent's.
        set((state) => ({
          agents: state.agents.map((item) => (item.id === event.agent.id ? event.agent : item)),
          conversations: state.conversations.map((item) => (item.main && item.agentId === event.agent.id ? { ...item, model: event.agent.model, effort: event.agent.effort ?? null } : item)),
        }));
        break;
      case "conversation.updated":
        if (event.conversation.agentId !== get().agentId) break;
        set((state) => ({
          conversations: upsertConversation(state.conversations, event.conversation),
        }));
        break;
      case "settings.updated":
        if (get().backendIdentity !== null && get().backendIdentity !== backendKey(event.settings)) {
          set((state) => ({ ...CLEARED, drafts: {}, attachments: {}, cwdOverrides: {}, modelOverrides: {},
            backendEpoch: state.backendEpoch + 1, backendIdentity: backendKey(event.settings) }));
          // What was cleared has to come back. A connection that is being
          // rebuilt reloads on its way to ready; one that is not (it was
          // already ready and stays so) would leave the window empty for good.
          set({ settings: event.settings });
          // Not on Letta Cloud: there the main process is about to rebuild (or
          // deliberately fail) the connection itself, and asking it for the
          // companions now would start a connection it is in the middle of
          // closing — on a saved API key, possibly as another account.
          if (event.settings.backend !== "cloud" && get().connection?.status === "ready") void get().refreshAgents();
          break;
        } else if (executionDeviceId(get().settings) !== executionDeviceId(event.settings)) {
          // Invalidate async composer work immediately, before reconnect events arrive.
          // Same Cloud account: keep drafts, attachments, agent and chat selection.
          set((state) => ({
            backendEpoch: state.backendEpoch + 1,
            chats: Object.fromEntries(Object.entries(state.chats).map(([id, chat]) => [id, {
              ...chat, queuePaused: true, queuePauseReason: "device-change" as const,
            }])),
          }));
        }
        set({ settings: event.settings });
        break;
      case "update.ready":
        set({ updateReady: { version: event.version, notes: event.notes } });
        break;
      case "channels.service":
        set((state) => state.channelService && state.channelService.revision > event.status.revision ? {} : { channelService: event.status });
        break;
      case "looks.changed":
        set({ looks: event.looks });
        break;
      case "open.chat":
        void (async () => {
          if (get().agentId !== event.agentId) await get().selectAgent(event.agentId);
          get().openChat(event.conversationId);
        })();
        break;
      case "turn.usage":
        set((state) => patchChat(state, event.conversationId, () => ({ usage: event.usage })));
        break;
      case "memory.updated":
        // Hearthside: memory changes outside a chat too (dreams, channels); refresh, batched.
        if (get().view !== "memory") break;
        if (memoryRefresh) clearTimeout(memoryRefresh);
        memoryRefresh = setTimeout(() => {
          memoryRefresh = null;
          if (get().view === "memory") void get().loadMemory();
        }, 600);
        break;
      case "menu":
        if (event.command === "new-chat") get().openChat(null);
        else get().openSettings("general");
        break;
    }
  },

  refreshAgents: async () => {
    let epoch = get().backendEpoch;
    try {
      const [agents, settings] = await Promise.all([api.listAgents(), api.getSettings()]);
      if (get().backendEpoch !== epoch || get().connection?.status !== "ready") return;
      const identity = backendKey(settings);
      if (get().backendIdentity !== null && get().backendIdentity !== identity) {
        set((state) => ({ ...CLEARED, drafts: {}, attachments: {}, cwdOverrides: {}, modelOverrides: {},
          backendEpoch: state.backendEpoch + 1 }));
        // This load belongs to the connection as it is now. Left on the old
        // number, everything read below (the model list first of all) was
        // thrown away as stale: after signing back in to Letta the picker
        // stayed empty until a reconnect.
        epoch = get().backendEpoch;
      }
      agentLoadAttempts.delete(epoch);
      set({ agents, agentsLoaded: true, settings, backendIdentity: identity });
      // One more try a little later if the first read fails (a runtime still
      // warming up): a failure left the picker empty until something else
      // happened to read the list. Neither answer is kept after a reconnect.
      const loaded = epoch;
      const keepModels = (models: ModelOption[]) => { if (get().backendEpoch === loaded) set({ models }); };
      void api.listModels().then(keepModels).catch(() => {
        setTimeout(() => { if (get().backendEpoch === loaded) void api.listModels().then(keepModels).catch(() => undefined); }, 3_000);
      });
      const connection = get().connection;
      if (connection?.status === "ready" && connection.providers) void get().loadProviders();

      const agentId =
        agents.find((agent) => agent.id === settings.agentId)?.id ?? agents[0]?.id ?? null;
      if (agentId && agentId === get().agentId) {
        await get().refreshConversations();
        if (get().activeId) void get().refreshExecution(get().activeId!);
        // A chat opened while the runtime was restarting has no command list
        // (the load is skipped when not connected), and nothing asked again.
        if (get().activeId) void get().loadChatCommands(get().activeId!);
        // Likewise its messages: a load cut short by the connection dropping is
        // thrown away, and the chat sat on its spinner until it was clicked again.
        const open = get().activeId ? get().chats[get().activeId!] : undefined;
        if (get().activeId && !isNewChatKey(get().activeId!) && (!open || (!open.loaded && !open.loading))) void get().loadHistory(get().activeId!);
      } else if (agentId) await get().selectAgent(agentId);
      else {
        set({
          agentId: null,
          conversations: [],
          conversationsLoaded: true,
          activeId: null,
          view: "chat",
          memory: null,
        });
      }
    } catch (error) {
      if (get().backendEpoch !== epoch) return;
      // A failed read is not "no companions": saying so invited creating a
      // first companion while the real ones were simply not loaded. Try again
      // a few times before settling for the message.
      // One retry in flight per connection: two loads failing together (a
      // reload and a create, say) must not each spend the budget and give up
      // in a third of the time.
      const failed = epoch;
      if (agentLoadRetry.has(failed)) return;
      const attempt = (agentLoadAttempts.get(failed) ?? 0) + 1;
      agentLoadAttempts.set(failed, attempt);
      if (attempt <= 3 && get().connection?.status === "ready") {
        agentLoadRetry.add(failed);
        setTimeout(() => {
          agentLoadRetry.delete(failed);
          if (get().backendEpoch === failed && get().connection?.status === "ready") void get().refreshAgents();
        }, 2_000 * attempt);
        return;
      }
      agentLoadAttempts.delete(failed);
      set({ agentsLoaded: true, notice: `Your companions couldn't be loaded: ${errorMessage(error)} Press Reconnect in the sidebar, or restart Hearthside.` });
    }
  },

  selectAgent: async (agentId) => {
    const epoch = get().backendEpoch;
    set({
      agentId,
      chatPreferences: {}, chatPreferencesLoaded: false, chatPreferencesScope: null, chatPreferencesRevision: 0, chatPreferencesError: null,
      conversations: [],
      conversationsLoaded: false,
      historyVolumes: [],
      historyVolumesError: null,
      focus: null,
      activeId: null,
      pendingFirstMessage: null,
      view: "chat",
      memory: null,
    });
    void get().loadHistoryVolumes();
    void get().refreshChatPreferences();
    void api
      .updateSettings({ agentId })
      .then((settings) => { if (get().backendEpoch === epoch) set({ settings }); })
      .catch(() => undefined);
    try {
      const conversations = await api.listConversations(agentId);
      if (get().agentId === agentId && get().backendEpoch === epoch) {
        set({ conversations, conversationsLoaded: true });
        // Hearthside: open the agent's main chat, its ongoing conversation, by default.
        const main = conversations.find((item) => item.main);
        if (main && get().activeId === null && get().view === "chat") get().openChat(main.id);
      }
    } catch (error) {
      if (get().agentId === agentId && get().backendEpoch === epoch) {
        set({ conversationsLoaded: true, notice: errorMessage(error) });
      }
    }
  },

  refreshChatPreferences: async () => {
    const { agentId, backendEpoch } = get();
    if (!agentId) return;
    const request = ++chatPreferencesRequest;
    const mine = () => get().agentId === agentId && get().backendEpoch === backendEpoch && request === chatPreferencesRequest;
    try {
      const result = await api.getChatPreferences(agentId, get().settings?.connectionRevision ?? "initial");
      if (!mine()) return;
      if (!result || !result.scope || !Number.isSafeInteger(result.revision) || !result.items) throw new Error("Chat organisation is unavailable.");
      if (get().chatPreferencesScope === result.scope && result.revision < get().chatPreferencesRevision) return;
      set({ chatPreferences: result.items, chatPreferencesScope: result.scope, chatPreferencesRevision: result.revision,
        chatPreferencesLoaded: true, chatPreferencesError: null });
    } catch (error) {
      if (mine()) set({ chatPreferencesLoaded: false, chatPreferencesError: errorMessage(error) });
    }
  },

  updateChatPreference: async (conversationId, patch) => {
    const { agentId, backendEpoch, chatPreferencesScope: scope, chatPreferencesLoaded } = get();
    if (!agentId || !scope || !chatPreferencesLoaded || !get().conversations.some((chat) => chat.id === conversationId && chat.agentId === agentId)) {
      throw new Error("Reopen this chat before changing its organisation.");
    }
    const mine = () => get().agentId === agentId && get().backendEpoch === backendEpoch && get().chatPreferencesScope === scope;
    try {
      const result = await api.setChatPreference(agentId, conversationId, scope, patch);
      if (!mine() || result.scope !== scope || result.revision < get().chatPreferencesRevision) return;
      set({ chatPreferences: result.items, chatPreferencesRevision: result.revision, chatPreferencesError: null });
    } catch (error) {
      if (mine()) set({ notice: `Chat organisation wasn't saved: ${errorMessage(error)}` });
      throw error;
    }
  },

  refreshConversations: async () => {
    const epoch = get().backendEpoch;
    const agentId = get().agentId;
    if (!agentId) return;
    try {
      const conversations = await api.listConversations(agentId);
      // Only if nothing changed meanwhile (another agent, or a chat just started here).
      if (get().agentId === agentId && get().backendEpoch === epoch) set({ conversations });
    } catch {
      // Quietly try again next time.
    }
  },

  createAgent: async (input) => {
    const agent = await api.createAgent(input).catch(async (error: unknown) => {
      // Hearthside: a companion can be created even if a memory file then fails; show it in the list.
      await get().refreshAgents().catch(() => undefined);
      throw error;
    });
    set((state) => ({ agents: [agent, ...state.agents.filter((item) => item.id !== agent.id)] }));
    await get().selectAgent(agent.id);
  },

  // Update and delete reject on failure so the dialog can show the reason.
  updateAgent: async (update) => {
    const { agentId } = get();
    if (!agentId) throw new Error("No agent is selected.");
    const agent = await api.updateAgent(agentId, update);
    set((state) => ({
      agents: state.agents.map((item) => (item.id === agent.id ? agent : item)),
      // The main chat has no model of its own: its entry carries the agent's, as
      // it was when the list was read. Left alone it went on naming the old
      // model after the default changed, though messages already used the new one.
      conversations: update.model === undefined ? state.conversations
        : state.conversations.map((item) => (item.main && item.agentId === agent.id ? { ...item, model: agent.model, effort: agent.effort ?? null } : item)),
    }));
    return agent;
  },

  deleteAgent: async () => {
    const { agentId } = get();
    if (!agentId) return;
    await api.deleteAgent(agentId);
    set({ agentSettingsOpen: false });
    // Picks another agent, or shows the "create your first agent" screen.
    await get().refreshAgents();
  },

  openChat: (conversationId, focusMessageId) => {
    set({ activeId: conversationId, view: "chat", focus: conversationId && focusMessageId ? { conversationId, messageId: focusMessageId } : null });
    if (!conversationId) return;
    get().markChatRead(conversationId);
    const chat = get().chats[conversationId];

    const knownHistory = get().historyVolumes.some((volume) => volume.id === conversationId);
    const history = knownHistory || (Boolean(focusMessageId) && !get().conversations.some((item) => item.id === conversationId));
    const focusLoaded = focusMessageId && chat?.rows.some((row) => row.key.includes(focusMessageId) || chat.messageKeys?.[focusMessageId]?.includes(row.key));
    if (focusMessageId && !focusLoaded) {
      if (knownHistory) void get().loadHistory(conversationId, HISTORY_MAX);
      else void get().loadHistory(conversationId, history ? HISTORY_MAX : HISTORY_PAGE, false, { around: focusMessageId });
    } else if (!chat?.loaded && !chat?.loading) void get().loadHistory(conversationId, history ? HISTORY_MAX : undefined);
    if (!history) void get().loadChatCommands(conversationId);
    // Hearthside: off Letta Cloud nothing pushes a chat's execution state when it
    // is merely opened, and the working-folder chip and Stop both read it. It is
    // a local read there (no Letta request), so ask once per chat.
    if (!history && !chat?.execution && get().settings?.backend !== "cloud" && get().connection?.status === "ready") {
      void get().refreshExecution(conversationId, { background: true });
    }
  },

  loadHistoryVolumes: async () => {
    const agentId = get().agentId, epoch = get().backendEpoch;
    if (!agentId) return;
    try {
      const volumes = await api.listHistory(agentId);
      if (get().agentId !== agentId || get().backendEpoch !== epoch) return;
      set({ historyVolumes: volumes, historyVolumesError: null });
      // An open part that was loaded before it was known to be history: load it whole now.
      const open = get().activeId;
      const chat = open ? get().chats[open] : undefined;
      if (open && volumes.some((volume) => volume.id === open) && chat?.loaded && ((chat.limit ?? HISTORY_PAGE) < HISTORY_MAX || get().focus?.conversationId === open)) void get().loadHistory(open, HISTORY_MAX);
    } catch (error) {
      if (get().agentId === agentId && get().backendEpoch === epoch) set({ historyVolumesError: errorMessage(error) });
    }
  },

  continueFromHistory: (quote, date) => {
    const agentId = get().agentId;
    if (!agentId) return;
    const lines = quote ? quote.trim().split("\n").slice(0, 12).map((line) => `> ${line}`).join("\n") : "";
    const carried = quote ? `Picking up from our earlier chat${date ? ` on ${new Date(date).toLocaleDateString()}` : ""}:\n${lines}\n\n` : "";
    // An unsent draft already waiting in the new chat is kept; the quote goes after it.
    set((state) => {
      const key = `${NEW_CHAT}:${agentId}`;
      const existing = state.drafts[key]?.trimEnd() ?? "";
      return { activeId: null, view: "chat", focus: null, drafts: { ...state.drafts, [key]: existing ? `${existing}\n\n${carried}` : carried } };
    });
  },

  /**
   * Hearthside: which slash commands this chat can run. The built-ins are
   * always offered; the mod commands come from what the runtime advertises for
   * this chat right now, so they have to be asked for per chat.
   *
   * A reply that arrives after the chat, the companion or the connection
   * changed is dropped: offering another chat's commands would run the wrong
   * thing.
   */
  loadChatCommands: async (conversationId) => {
    const epoch = get().backendEpoch;
    const agentId = get().agentId;
    if (get().connection?.status !== "ready") return;
    try {
      const catalog = await api.listChatCommands(conversationId);
      if (get().backendEpoch !== epoch || get().agentId !== agentId) return;
      if (catalog.agentId !== agentId) return;
      set((state) => ({ chatCommands: { ...state.chatCommands, [conversationId]: catalog } }));
    } catch (error) {
      if (get().backendEpoch !== epoch || get().agentId !== agentId) return;
      set((state) => ({
        chatCommands: {
          ...state.chatCommands,
          [conversationId]: { commands: [], agentId: agentId ?? "", conversationId, error: errorMessage(error) },
        },
      }));
    }
  },

  /**
   * Hearthside: run a command a mod registered. The main process checks it
   * against the runtime's own catalog again before sending anything, so a
   * stale list here cannot run something that is no longer loaded.
   */
  runModCommand: async (commandId, args, typed) => {
    const state = get();
    const conversationId = state.activeId ?? state.conversations.find((item) => item.main)?.id ?? null;
    if (!conversationId) {
      set({ notice: "Open a chat first." });
      return;
    }
    if (state.chats[conversationId]?.running) {
      set({ notice: "The agent is still working. Try the command when it's done." });
      return;
    }
    const key = composerKey(state);
    // Everything after the await belongs to this connection, this companion
    // and this chat. A reply that lands after any of them changed is dropped:
    // the typed command and its arguments are the person's private text, and
    // the old chat id would otherwise be loaded against the new backend.
    const epoch = state.backendEpoch;
    const agentId = state.agentId;
    const mine = () => get().backendEpoch === epoch && get().agentId === agentId;
    set((current) => ({
      ...clearComposer(key)(current),
      ...patchChat(current, conversationId, () => ({ running: true, error: null, activity: `Running /${commandId}`, activityPhase: null, activityDetail: null })),
    }));
    if (!state.activeId) get().openChat(conversationId);
    let holdQueue = false;
    try {
      const result = await api.runChatCommand(conversationId, commandId, args);
      if (!mine()) return;
      if (result.uncertain) {
        // The command may still be running, and may be about to ask the agent
        // something. A queued message must not land in that.
        holdQueue = true;
        set({ notice: `${result.output} Anything you've queued is being held.` });
      } else if (result.startedTurn && !result.turnFinished) {
        // Hearthside stopped following the reply; it may still be going, so
        // nothing queued is released into it.
        holdQueue = true;
        set({ notice: `/${commandId} started a reply that is taking a long time. Hearthside has stopped following it — reopen the chat to see where it got to. Anything you've queued is being held.` });
      } else if (result.startedTurn) {
        set({ notice: `/${commandId} asked your companion, and the reply has finished.` });
      } else if (result.output) {
        set({ notice: result.output.length > 600 ? `${result.output.slice(0, 600)}…` : result.output });
      } else if (!result.success) {
        set({ notice: `/${commandId} didn't succeed, and said nothing about why.` });
      }
    } catch (error) {
      if (!mine()) return;
      // A command that was refused never reached the runtime, so the queue is
      // safe; anything else is reported through `uncertain` above and holds it.
      set((current) => ({ notice: errorMessage(error), drafts: { ...current.drafts, [key]: current.drafts[key] || typed } }));
    } finally {
      // Local cleanup only when this is still the same scope; the chat entry
      // is gone from the store otherwise, and patching it would resurrect it.
      if (mine()) {
        set((current) => patchChat(current, conversationId, (chat) => ({
          running: false,
          activity: null,
          activityPhase: null,
          activityDetail: null,
          queuePaused: (holdQueue || chat.queuePaused || Boolean(chat.stopRequested)) && chat.queue.length > 0,
          queuePauseReason: chat.stopRequested ? "stopped" : holdQueue ? "error" : chat.queuePauseReason,
        })));
        await get().loadHistory(conversationId);
        if (mine()) {
          // A mod command can register or remove commands, and can change memory.
          void get().loadChatCommands(conversationId);
          if (get().view === "memory") void get().loadMemory();
          if (!holdQueue) flushQueue(conversationId);
        }
      }
    }
  },

  loadEarlier: async (conversationId) => {
    const chat = get().chats[conversationId];
    if (!chat?.loaded || chat.loading || !chat.hasMore || !chat.nextBefore) return;
    await get().loadHistory(conversationId, HISTORY_PAGE, false, { before: chat.nextBefore });
  },

  loadHistory: async (conversationId, limit, quiet, options) => {
    if (quiet && get().chats[conversationId]?.loading) return;
    const epoch = get().backendEpoch;
    const requestId = (historyRequests.get(conversationId) ?? 0) + 1;
    historyRequests.set(conversationId, requestId);
    const valid = () => get().backendEpoch === epoch && historyRequests.get(conversationId) === requestId;
    const pageSize = Math.max(1, Math.min(HISTORY_MAX, limit ?? HISTORY_PAGE));
    // Hearthside: a quiet refresh (channel messages) doesn't show a loading state.
    if (!quiet) set((state) => patchChat(state, conversationId, () => ({ loading: true, limit: pageSize })));
    try {
      let history = options ? await api.loadHistory(conversationId, pageSize, options) : await api.loadHistory(conversationId, pageSize);
      if (!valid()) return;
      // A restored volume can be discovered while a search seek is in flight.
      // Volumes are at most 400 source messages: retain their whole-volume view.
      if (options?.around && get().historyVolumes.some((volume) => volume.id === conversationId)) {
        history = await api.loadHistory(conversationId, HISTORY_MAX);
        if (!valid()) return;
      }
      // Hearthside: a tool-heavy stretch elsewhere (a bot on Railway) can be more than a page
      // long; a refresh that doesn't reach back to what is on screen fetches further back.
      const onScreen = get().chats[conversationId]?.rows ?? [];
      if (quiet && pageSize < HISTORY_MAX && !historyConnects(history.rows, onScreen)) {
        history = await api.loadHistory(conversationId, HISTORY_MAX);
        if (!valid()) return;
      }
      set((state) =>
        patchChat(state, conversationId, (chat) => {
          const keepsFocus = quiet && state.focus?.conversationId === conversationId && !historyConnects(history.rows, chat.rows);
          const rows = options?.before ? prependHistory(history.rows, chat.rows) : options?.around ? history.rows : keepsFocus
            ? prependHistory(chat.rows, history.rows) : mergeHistory(history.rows, chat.rows);
          // The newest page no longer reaches what was on screen, so the screen
          // was replaced by it. The old "load earlier" position described rows
          // that are gone; keeping it left everything before this page unreachable.
          const replaced = !options && !keepsFocus && chat.rows.length > 0 && !historyConnects(history.rows, chat.rows);
          const takeCursor = Boolean(options) || chat.nextBefore === undefined || (!quiet && limit !== undefined) || replaced;
          return {
            rows,
            liveChannelCallIds: history.running ? pendingChannelCallIds(rows, new Set(chat.liveChannelCallIds)) : [],
            messageKeys: options?.around ? history.messageKeys : { ...chat.messageKeys, ...history.messageKeys },
            loaded: true,
            loading: false,
            historyError: null,
            // Latest-page refreshes must not move an already-loaded oldest cursor forward.
            nextBefore: takeCursor ? history.nextBefore : chat.nextBefore,
            hasMore: takeCursor
              ? history.hasMore && (!options?.before || (history.nextBefore !== options.before && !chat.historyCursors?.includes(history.nextBefore ?? "")))
              : chat.hasMore,
            historyCursors: options?.around || replaced ? [] : options?.before ? [...(chat.historyCursors ?? []), options.before] : chat.historyCursors,
            running: history.running,
            activity: history.running ? (chat.activity ?? history.activity) : null,
            ...(history.running ? {} : { activityPhase: null, activityDetail: null }),
            approvals: history.approvals,
            usage: history.usage ?? chat.usage,
          };
        }),
      );
    } catch (error) {
      if (!valid()) return;
      // Hearthside: a background refresh that fails stays quiet; the next one tries again.
      if (quiet) return;
      const message = errorMessage(error);
      set((state) =>
        patchChat(state, conversationId, () => ({
          loaded: true,
          loading: false,
          historyError: /^Timed out waiting for/.test(message)
            ? "Letta took too long to send this chat's messages. It may be busy with a reply in this chat. Try again in a moment."
            : message,
        })),
      );
    }
  },

  send: async (rawText, extra = [], source) => {
    if (source && !composerMatches(get(), source)) {
      set({ notice: "The chat or draft changed while the GIF loaded. Nothing was sent. Choose the GIF again when you're ready." });
      return;
    }
    const offline = get().connection?.status !== "ready";
    if (offline && (!get().activeId || !get().agentId || !get().backendIdentity)) return;
    if (get().attachmentReads > 0) {
      set({ notice: "Attachments are still being prepared. Wait before sending." });
      return;
    }
    if ((get().attachments[composerKey(get())]?.length ?? 0) + extra.length > MAX_ATTACHMENTS) {
      set({ notice: `Up to ${MAX_ATTACHMENTS} attachments per message, including GIF frames. Remove an attachment and try again.` });
      return;
    }
    let executionChat = get().chats[composerKey(get())];
    // A new explicit Send is not a retry of historical work. An empty queue's old
    // hold must not poison it, but never release older held inputs or a pending Stop.
    if (rawText.trim() || extra.length || get().attachments[composerKey(get())]?.length) {
      if (executionChat?.queuePaused && executionChat.queue.length === 0 && !offline &&
          !executionChat.stopRequested && !executionChat.executionSaving &&
          executionChat.execution?.status !== "blocked" && !executionChat.execution?.requiresDestination &&
          !executionChat.execution?.pendingDelivery) {
        set((state) => patchChat(state, composerKey(state), () => ({ queuePaused: false, queuePauseReason: undefined })));
        executionChat = get().chats[composerKey(get())];
      }
    }
    const deliveryHeld = offline || executionChat?.execution?.status === "blocked" ||
      executionChat?.execution?.pendingDelivery || executionChat?.executionSaving || executionChat?.queuePaused || executionChat?.stopRequested;
    const holdAdmission = deliveryHeld || executionChat?.execution?.requiresDestination;
    let text = rawText.trim();
    // Hearthside: slash commands. Built-ins first, then whatever the runtime
    // advertises for this chat; a name that matches neither is not sent at all.
    const typedSlash = readSlash(text);
    if (typedSlash && (get().attachments[composerKey(get())] ?? []).length === 0) {
      // Cloud recompile is server-side management. Destination uncertainty alone
      // is not a delivery hold; main still checks exact scope, account and idle.
      const cloudRecompile = typedSlash.name === "recompile" && get().settings?.backend === "cloud";
      if (holdAdmission && (!cloudRecompile || deliveryHeld)) {
        set({ notice: "Commands cannot run while delivery is held. Your draft is kept here." });
        return;
      }
      const openChatId = get().activeId;
      const catalog = openChatId ? get().chatCommands[openChatId] : undefined;
      const slash = parseCommand(text, withModCommands(catalog?.commands ?? []));
      if (!slash) {
        set({ notice: unknownCommandNotice(typedSlash.name, Boolean(catalog) && !catalog?.error) });
        return;
      }
      const { command, args } = slash;
      if (command.needsArgument && !args) {
        set({ notice: `Type what to ${command.name} after /${command.name}.` });
        return;
      }
      if (command.name === "remember") {
        text = rememberMessage(args);
      } else if (command.name === "new") {
        set(clearComposer(composerKey(get())));
        get().openChat(null);
        return;
      } else if (command.runtime) {
        await get().runCommand(command.runtime, args, rawText.trim());
        return;
      } else if (command.mod) {
        await get().runModCommand(command.name, args, rawText.trim());
        return;
      }
    }
    const state = get();
    const { agentId, activeId } = state;
    const key = composerKey({ activeId, agentId });
    const attachments = [...(state.attachments[key] ?? []), ...extra];
    if ((!text && attachments.length === 0) || !agentId) return;
    if (!activeId && state.pendingFirstMessage) return;

    const cwd = selectCwd(state, key);

    const pickedModel = state.modelOverrides[key];
    const openChat = activeId ? state.conversations.find((item) => item.id === activeId) : undefined;
    const written: { model?: string; reasoningEffort?: ReasoningEffort } = pickedModel
      ? sessionModel(pickedModel, state.models)
      : {
          ...(openChat?.model ? { model: openChat.model } : {}),
          ...(openChat?.effort ? { reasoningEffort: openChat.effort } : {}),
        };
    const message: QueuedMessage = { id: crypto.randomUUID(), agentId, text, attachments, cwd, ...written };
    set(clearComposer(key));

    // Hearthside: while the agent is busy, the message waits its turn.
    const chat = activeId ? state.chats[activeId] : undefined;
    if (activeId && (holdAdmission || (chat && (chat.running || chat.queue.length > 0)))) {
      set((current) => patchChat(current, activeId, (c) => ({ queue: [...c.queue, message],
        queuePaused: offline || Boolean(c.stopRequested) || c.queuePaused,
        queuePauseReason: offline ? "offline" : c.stopRequested ? "stopped" : c.queuePauseReason })));
      flushQueue(activeId);
      return;
    }
    await dispatch(activeId, message, (held) =>
      // Keep the exact failed message separate from anything written meanwhile.
      set((current) => patchChat(current, key, (chat) => ({
        queue: [message, ...chat.queue], queuePaused: true, queuePauseReason: held ?? "failed-send",
      }))),
    );
  },

  addAttachments: async (files) => {
    const key = composerKey(get());
    const generation = attachmentGeneration;
    // Copy first: a file input's list empties when the input is reset.
    const picked = [...files];
    set((state) => ({ attachmentReads: state.attachmentReads + 1 }));
    try {
      const { attachments, problems } = await readAttachments(picked);
      if (generation !== attachmentGeneration) return;
      const current = get().attachments[key] ?? [];
      const room = MAX_ATTACHMENTS - current.length;
      if (attachments.length > room) problems.push(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      set((state) => ({
        attachments: { ...state.attachments, [key]: [...current, ...attachments.slice(0, Math.max(0, room))] },
        ...(problems.length ? { notice: problems.join(" ") } : {}),
      }));
    } catch {
      if (generation === attachmentGeneration) set({ notice: "An attachment could not be read. Please choose it again." });
    } finally {
      if (generation === attachmentGeneration) set((state) => ({ attachmentReads: state.attachmentReads - 1 }));
    }
  },

  removeAttachment: (index) => {
    const key = composerKey(get());
    set((state) => ({
      attachments: { ...state.attachments, [key]: (state.attachments[key] ?? []).filter((_, i) => i !== index) },
    }));
  },

  answerQuestion: (toolCallId, questions, answers) => {
    const { activeId } = get();
    if (!activeId) return;
    const text = prepareAskUserQuestionNotif(
      answers
        ? { type: "ask_user_question_response", version: 2, toolCallId, questions, status: "answered", answers }
        : { type: "ask_user_question_response", version: 2, toolCallId, questions, status: "dismissed" },
    );
    const state = get();
    const message: QueuedMessage = { id: crypto.randomUUID(), agentId: state.agentId ?? undefined, text, attachments: [], cwd: selectCwd(state, activeId) };
    const chat = state.chats[activeId];
    const offline = state.connection?.status !== "ready";
    // The same holds an ordinary message respects. An answer used to skip all
    // of them, and offline it simply vanished with nothing said.
    const held = offline || chat?.execution?.status === "blocked" || Boolean(chat?.execution?.pendingDelivery) || Boolean(chat?.execution?.requiresDestination)
      || Boolean(chat?.executionSaving) || Boolean(chat?.queuePaused) || Boolean(chat?.stopRequested);
    if (chat?.running || held) {
      // Answers jump the queue: the agent is waiting on them.
      set((current) => ({
        ...patchChat(current, activeId, (c) => ({ queue: [message, ...c.queue] })),
        ...(offline ? { notice: "You're offline, so your answer is waiting in the queue. It goes as soon as you're connected again." } : {}),
      }));
    } else {
      // An answer that didn't go is kept at the head of the queue rather than dropped.
      void dispatch(activeId, message, () => set((current) => patchChat(current, activeId, (c) => ({
        queue: c.queue.some((item) => item.id === message.id) ? c.queue : [message, ...c.queue], queuePaused: true, queuePauseReason: "error",
      }))));
    }
  },

  setChatContextWindow: async (conversationId, limit) => {
    const conversation = await api.setConversationContextWindow(conversationId, limit);
    set((state) => ({
      conversations: upsertConversation(state.conversations, conversation),
      // The runtime emits the resolved inherited limit (including unknown).
      // Do not restore the old override after that authoritative usage event.
    }));
  },

  forkConversation: async (conversationId) => {
    try {
      const conversation = await api.forkConversation(conversationId);
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation) }));
      get().openChat(conversation.id);
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  exportConversation: async (conversationId) => {
    try {
      const path = await api.exportConversation(conversationId);
      if (path) set({ notice: `Saved to ${path}` });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  compactConversation: async (conversationId) => {
    get().openChat(conversationId);
    await get().runCommand("compact", "", "/compact", false);
  },

  runCommand: async (command, args, typed, fromComposer = true) => {
    const state = get();
    const epoch = state.backendEpoch;
    const agentId = state.agentId;
    const mine = () => get().backendEpoch === epoch && get().agentId === agentId;
    // A command needs a chat; from the new-chat screen it runs in the main chat.
    const conversationId = state.activeId ?? state.conversations.find((item) => item.main)?.id ?? null;
    if (!conversationId) {
      set({ notice: "Open a chat first." });
      return;
    }
    if (state.chats[conversationId]?.execution?.followsOwner && !(command === "recompile" && state.settings?.backend === "cloud")) {
      set({ notice: "Run slash commands in the destination runtime. Nothing ran on this desktop." });
      return;
    }
    if (state.chats[conversationId]?.running) {
      set({ notice: "The agent is still working. Try the command when it's done." });
      return;
    }
    const key = composerKey(state);
    set((current) => ({
      ...(fromComposer ? clearComposer(key)(current) : {}),
      ...patchChat(current, conversationId, () => ({ running: true, error: null, activity: `Running /${command}`, activityPhase: null, activityDetail: null })),
    }));
    if (!state.activeId) get().openChat(conversationId);
    let holdQueue = false;
    try {
      const result = await api.runCommand(conversationId, command, args);
      if (!mine()) return;
      holdQueue = Boolean(result.uncertain || (result.startedTurn && !result.turnFinished));
      if (holdQueue) {
        set({ notice: `${result.output || `/${command} may still be running.`} Anything you've queued is being held.` });
      } else if (result.output) {
        set({ notice: result.output.length > 600 ? `${result.output.slice(0, 600)}…` : result.output });
      } else if (result.success === false) {
        set({ notice: `/${command} didn't succeed, and said nothing about why.` });
      }
    } catch (error) {
      if (!mine()) return;
      set((current) => ({ notice: errorMessage(error), ...(fromComposer ? { drafts: { ...current.drafts, [key]: current.drafts[key] || typed } } : {}) }));
    } finally {
      if (!mine() && get().backendEpoch === epoch && get().chats[conversationId]) {
        // Another companion was opened meanwhile. Its chats are still in the
        // store, so this one must not be left showing "Running /…" in the sidebar.
        set((current) => patchChat(current, conversationId, () => ({ running: false, stopRequested: false, activity: null, activityPhase: null, activityDetail: null })));
      }
      if (mine()) {
        set((current) => patchChat(current, conversationId, (chat) => ({
          // A Stop pressed during the command has nothing further to wait for once the command is over.
          stopRequested: false,
          running: false, activity: null, activityPhase: null, activityDetail: null, queuePaused: (holdQueue || chat.queuePaused || Boolean(chat.stopRequested)) && chat.queue.length > 0,
          queuePauseReason: chat.stopRequested ? "stopped" : holdQueue ? "error" : chat.queuePauseReason,
        })));
        // Command completion belongs to the initiating account and companion.
        await get().loadHistory(conversationId);
        if (mine()) {
          if (command === "reload" && !holdQueue) void get().loadChatCommands(conversationId);
          if (get().view === "memory") void get().loadMemory();
          if (!holdQueue) flushQueue(conversationId);
        }
      }
    }
  },

  removeQueued: (id) => {
    const activeId = composerKey(get());
    set((state) =>
      patchChat(state, activeId, (chat) => {
        const queue = chat.queue.filter((item) => item.id !== id || (item.agentId && item.agentId !== state.agentId));
        return { queue, queuePaused: chat.queuePaused && queue.length > 0, queuePauseReason: queue.length ? chat.queuePauseReason : undefined };
      }),
    );
  },

  sendQueueNow: () => {
    const activeId = composerKey(get());
    if (get().connection?.status !== "ready" || !get().chats[activeId]?.queue.length || get().chats[activeId]?.queue.some((item) => item.deliveryUnconfirmed) || get().chats[activeId]?.execution?.status === "blocked" || get().chats[activeId]?.execution?.requiresDestination || get().chats[activeId]?.execution?.pendingDelivery || get().chats[activeId]?.executionSaving || get().chats[activeId]?.stopRequested) return;
    set((state) => patchChat(state, activeId, () => ({ queuePaused: false, queuePauseReason: undefined })));
    flushQueue(activeId);
  },

  stop: () => {
    const { activeId } = get();
    if (!activeId || get().chats[activeId]?.execution?.status === "blocked") return;
    // Held whether or not something is queued yet: a message written while it stops waits too.
    set((state) => patchChat(state, activeId, (chat) => ({ stopRequested: true, queuePaused: chat.queue.length > 0 ? true : chat.queuePaused, queuePauseReason: "stopped" })));
    const release = () => set((state) => patchChat(state, activeId, () => ({ stopRequested: false })));
    void Promise.resolve(api.stopTurn(activeId)).then(
      // Nothing was running by the time the stop arrived, so no "finished" will come to clear this.
      () => { if (!get().chats[activeId]?.running) release(); },
      // The stop was refused (the work is another computer's, say). Waiting on it would hold the chat for good.
      (error: unknown) => { release(); get().setNotice(error instanceof Error ? error.message : String(error)); },
    );
  },

  respondApproval: async (requestId, decision) => {
    const { activeId } = get();
    if (!activeId || get().chats[activeId]?.approvalSending || get().chats[activeId]?.execution?.status === "blocked") return;

    set((state) => patchChat(state, activeId, () => ({ approvalSending: requestId, approvalError: null })));
    try {
      await api.respondApproval(activeId, requestId, decision);
      set((state) =>
        patchChat(state, activeId, (chat) => ({
          approvals: chat.approvals.filter((item) => item.requestId !== requestId),
          approvalSending: null,
        })),
      );
    } catch (error) {
      set((state) => patchChat(state, activeId, () => ({ approvalSending: null, approvalError: `Your answer didn't arrive: ${errorMessage(error)}. Try again.` })));
    }
  },

  renameConversation: async (conversationId, title) => {
    try {
      const conversation = await api.renameConversation(conversationId, title);
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversationId ? { ...item, title: conversation.title } : item,
        ),
      }));
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  archiveConversation: async (conversationId) => {
    try {
      await api.archiveConversation(conversationId);
      set((state) => {
        const chats = { ...state.chats };
        delete chats[conversationId];
        const unread = { ...state.unread };
        delete unread[conversationId];
        return {
          chats,
          unread,
          finished: state.finished?.conversationId === conversationId ? null : state.finished,
          conversations: state.conversations.filter((item) => item.id !== conversationId),
          activeId: state.activeId === conversationId ? null : state.activeId,
        };
      });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  archiveConversations: async (conversationIds) => {
    const start = get();
    // The ids were chosen against this companion on this connection, and there
    // is an await between every one of them. If either changes part-way, the
    // rest of the batch is abandoned: archiving cannot be undone, and an id
    // picked from the old chat list must never be sent to a new backend, where
    // it means nothing or means something else. Same scope check as the
    // composer and the chat commands use.
    const epoch = start.backendEpoch;
    const agentId = start.agentId;
    const mine = () => get().backendEpoch === epoch && get().agentId === agentId;
    // A renderer-side guard only; the real refusal is server-side in
    // runtime.archiveConversation ("The main chat can't be archived.").
    const protectedIds = new Set(start.conversations.filter((item) => item.main).map((item) => item.id));
    const wanted = [...new Set(conversationIds)].filter((id) => !protectedIds.has(id));
    if (wanted.length === 0) return;
    // One at a time, in order: the bridge archives one chat per call, and a failure
    // part-way through must leave the ones that did work archived, not be retried.
    const failed: string[] = [];
    const archived: string[] = [];
    for (const id of wanted) {
      if (!mine()) break;
      try {
        await api.archiveConversation(id);
        archived.push(id);
      } catch {
        failed.push(id);
      }
    }
    // Nothing is written back into a store that has moved on: the chats, marks
    // and notice all belong to the companion and connection that are gone. What
    // did archive is already archived on the server, so the list the person
    // comes back to is loaded correctly from there.
    if (!mine()) return;
    if (archived.length > 0) {
      const gone = new Set(archived);
      set((state) => {
        const chats = { ...state.chats };
        const unread = { ...state.unread };
        for (const id of gone) {
          delete chats[id];
          delete unread[id];
        }
        return {
          chats,
          unread,
          finished: state.finished && gone.has(state.finished.conversationId) ? null : state.finished,
          conversations: state.conversations.filter((item) => !gone.has(item.id)),
          activeId: state.activeId && gone.has(state.activeId) ? null : state.activeId,
        };
      });
    }
    if (failed.length > 0) {
      const titles = get().conversations.filter((item) => failed.includes(item.id)).map((item) => item.title || "Untitled chat");
      set({
        notice:
          `${archived.length} of ${wanted.length} chats were archived. ` +
          `${failed.length === 1 ? "This one is" : "These are"} still here: ${(titles.length ? titles : failed).join(", ")}.`,
      });
    }
  },
  saveSettings: async (update) => {
    const settings = await api.updateSettings(update);
    get().handleEvent({ type: "settings.updated", settings });
  },

  loadProviders: async () => {
    try {
      set({ providers: await api.listProviders() });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  // Connect and disconnect reject on failure so the form can show the reason.
  connectProvider: async (input) => {
    set({ providers: await api.connectProvider(input) });
    await get().reloadModels();
  },

  disconnectProvider: async (input) => {
    set({ providers: await api.disconnectProvider(input) });
    await get().reloadModels();
  },

  // Hearthside: read the models again (after the providers change, or when
  // their panel is opened), and what is known about each connection with them.
  reloadModels: async () => {
    const epoch = get().backendEpoch;
    const models = await api.listModels(true);
    if (get().backendEpoch !== epoch) return;
    set({ models });
    // A companion given a model by this read is announced by the main process
    // (agent.updated). Reading the whole list here as well could put back an
    // older answer over a companion created or changed in the meantime.
    const connection = get().connection;
    if (connection?.status === "ready" && connection.providers) void get().loadProviders();
  },

  openSkills: () => set({ view: "skills" }),
  openSchedules: () => set({ view: "schedules" }),
  openChannels: () => set({ view: "channels" }),
  openConnectors: () => set({ view: "connectors" }),
  openCalendar: () => set({ view: "calendar" }),
  openFiles: () => set({ view: "files" }),

  openMemory: () => {
    set({ view: "memory" });
    void get().loadMemory();
  },

  loadMemory: async () => {
    const { agentId, backendEpoch } = get();
    if (!agentId) return;
    set((state) => ({
      memory: { ...(state.memory ?? { enabled: true, files: [] }), loading: true, error: null },
    }));
    try {
      const overview = await api.listMemory(agentId);
      if (get().agentId === agentId && get().backendEpoch === backendEpoch) set({ memory: { ...overview, loading: false, error: null } });
    } catch (error) {
      if (get().agentId !== agentId || get().backendEpoch !== backendEpoch) return;
      set((state) => ({
        memory: {
          enabled: state.memory?.enabled ?? true,
          files: state.memory?.files ?? [],
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  },

  saveMemoryFile: async (path, content, target) => {
    const { agentId, backendEpoch } = get();
    if (!agentId) throw new Error("No agent is selected.");
    const validate = () => {
      const state = get();
      if (state.agentId !== agentId || state.backendEpoch !== backendEpoch ||
          (target && (target.agentId !== agentId || target.epoch !== backendEpoch || target.file.path !== path))) {
        throw new Error("The memory destination changed. Your edit has not been saved.");
      }
      if (target && !state.memory?.files.some((file) => file.path === path)) {
        throw new Error("This memory file no longer exists. Your edit has not been saved.");
      }
    };
    validate();
    if (target) {
      // Refresh before writing, so a disappeared file is not silently recreated.
      const overview = await api.listMemory(agentId);
      validate();
      if (!overview.files.some((file) => file.path === path)) {
        throw new Error("This memory file no longer exists. Your edit has not been saved.");
      }
    }
    const expected = target ? target.original : null; // New file: require absence, not an empty file.
    await (expected === undefined ? api.writeMemoryFile(agentId, path, content) : api.writeMemoryFile(agentId, path, content, expected));
    if (get().agentId === agentId && get().backendEpoch === backendEpoch) await get().loadMemory();
  },

  deleteMemoryFile: async (path) => {
    const { agentId } = get();
    if (!agentId) return;
    await api.deleteMemoryFile(agentId, path);
    await get().loadMemory();
  },

  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab }),

  reconnect: () => {
    void api.reconnect();
  },

  pickCwd: async () => {
    const directory = await api.selectDirectory();
    if (directory) get().setCwd(directory);
  },

  setCwd: (cwd) =>
    set((state) => ({
      cwdOverrides: { ...state.cwdOverrides, [composerKey(state)]: cwd },
    })),

  setModel: (handle) =>
    set((state) => ({
      modelOverrides: { ...state.modelOverrides, [composerKey(state)]: handle },
    })),

  setDraft: (text) =>
    set((state) => ({ drafts: { ...state.drafts, [composerKey(state)]: text } })),

  setNotice: (notice) => set({ notice }),
  markChatRead: (conversationId) =>
    set((state) => {
      if (!state.unread[conversationId] && state.finished?.conversationId !== conversationId) return {};
      const unread = { ...state.unread };
      delete unread[conversationId];
      return { unread, finished: state.finished?.conversationId === conversationId ? null : state.finished };
    }),
  dismissFinished: () => set({ finished: null }),
  // The notice is raised for any companion's chat (a schedule, a bot, a queued
  // turn). Opening it under whichever companion happened to be selected showed
  // that chat with the wrong name, look and model, and a message sent there
  // went out as the wrong companion. So the companion is found first.
  openFinished: async (conversationId) => {
    const epoch = get().backendEpoch;
    const main = conversationId.startsWith("main:") ? conversationId.slice("main:".length) : null;
    const listed = get().conversations.find((item) => item.id === conversationId)?.agentId ?? null;
    const owner = main ?? listed ?? await api.getConversationAgent(conversationId).catch(() => null);
    if (get().backendEpoch !== epoch) return;
    // Not knowing is not "the selected one": that guess is the mistake this is here to prevent.
    if (!owner) {
      set({ finished: null, notice: "Hearthside couldn't tell which companion that chat belongs to. Open it from that companion's chat list." });
      return;
    }
    if (owner !== get().agentId) {
      if (!get().agents.some((agent) => agent.id === owner)) {
        set({ finished: null, notice: "That chat belongs to a companion that isn't in the list any more." });
        return;
      }
      // Switching companion opens its main chat on the way, which counts as
      // reading it. It is not what was asked for, so its marker is put back.
      const mainChat = `main:${owner}`;
      const marker = get().unread[mainChat];
      await get().selectAgent(owner);
      if (get().backendEpoch !== epoch || get().agentId !== owner) return;
      if (marker && conversationId !== mainChat) set((state) => ({ unread: { ...state.unread, [mainChat]: marker } }));
    }
    get().openChat(conversationId);
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setNewAgentOpen: (newAgentOpen, start = "choose") => set({ newAgentOpen, newAgentStart: start }),
  setAgentSettingsOpen: (agentSettingsOpen) => set({ agentSettingsOpen }),
}));

// Invalidate even a switch away and back: a completed read must never revive an abandoned draft.
useAppStore.subscribe((state, previous) => {
  if (state.backendEpoch !== previous.backendEpoch || state.agentId !== previous.agentId ||
      state.activeId !== previous.activeId ||
      (previous.drafts[composerKey(previous)] !== undefined && state.drafts[composerKey(previous)] === undefined)) {
    attachmentGeneration += 1;
    if (state.attachmentReads) useAppStore.setState({ attachmentReads: 0 });
  }
});

// --- Selectors --------------------------------------------------------------

type Selectable = Pick<
  AppState,
  "settings" | "conversations" | "cwdOverrides" | "modelOverrides" | "agents" | "agentId" | "models"
>;

/** Working directory the next message in a chat will run in. */
export function selectCwd(state: Selectable, key: string): string {
  return (
    state.cwdOverrides[key] ??
    state.conversations.find((item) => item.id === key)?.cwd ??
    state.settings?.recentCwds[0] ??
    state.settings?.defaultCwd ??
    ""
  );
}

/** Model the next message in a chat will use: an unsent choice, else what Letta holds for the chat. */
export function selectModel(state: Selectable, key: string): string | null {
  const picked = state.modelOverrides[key];
  if (picked) return picked;
  const conversation = state.conversations.find((item) => item.id === key);
  if (conversation?.model) return conversation.model;
  return state.agents.find((agent) => agent.id === state.agentId)?.model ?? null;
}

/**
 * Hearthside: the reasoning level the next message will run at, or null when
 * nothing says. Letta keeps the level in a chat's model settings, apart from
 * the model handle, and that setting is the authority — it may have been
 * changed from another computer since this one last looked. Only a choice the
 * person has made and not yet sent comes before it. A chat with no model of
 * its own follows its agent, as its model does.
 *
 * Null means unknown, and unknown is shown as unknown: filling it in with the
 * model's default would claim a level Letta may not hold, and the next message
 * would then send that claim back and overwrite the real one.
 */
export function selectEffort(state: Selectable, key: string): string | null {
  const picked = state.modelOverrides[key];
  if (picked) return resolveModel(picked, state.models)?.effort ?? null;
  const conversation = state.conversations.find((item) => item.id === key);
  if (conversation?.effort) return conversation.effort;
  if (conversation?.model) return null;
  return state.agents.find((agent) => agent.id === state.agentId)?.effort ?? null;
}

export { EMPTY_CHAT };

// --- Sending (Hearthside: shared by the composer, the queue and question answers) ---

/** Move a typed draft and its files from the new-chat slot to the chat that was just created from it. */
function carryNewChatComposer(current: AppState, from: string, to: string): Partial<AppState> {
  const draft = current.drafts[from];
  const files = current.attachments[from];
  if (!draft && !files?.length) return {};
  const drafts = { ...current.drafts };
  const attachments = { ...current.attachments };
  if (draft && !drafts[to]) { drafts[to] = draft; delete drafts[from]; }
  if (files?.length && !attachments[to]?.length) { attachments[to] = files; delete attachments[from]; }
  return { drafts, attachments };
}

function clearComposer(key: string) {
  return (current: AppState) => {
    const drafts = { ...current.drafts };
    const attachments = { ...current.attachments };
    const cwdOverrides = { ...current.cwdOverrides };
    const modelOverrides = { ...current.modelOverrides };
    delete drafts[key];
    delete attachments[key];
    delete cwdOverrides[key];
    delete modelOverrides[key];
    return { drafts, attachments, cwdOverrides, modelOverrides };
  };
}

/**
 * Let the person's own Send go on, once they have chosen the destination it was
 * waiting for. Nothing else is ever resumed by itself.
 *
 * The person already pressed Send. The main process proved that message was
 * never submitted anywhere and said why: it needed a destination. They have now
 * chosen one, and that choice was confirmed by the main process in this same
 * account and connection. Making them press "Send now" again would be asking
 * them to repeat a decision they have already made twice.
 *
 * Every other hold stays exactly where it is. A generic failed send, a Stop, a
 * disconnection, an account or device change, an unconfirmed delivery or a
 * blocked execution is not this case, and a message whose fate is unknown is
 * never sent again under any circumstances.
 */
function resumeAfterDestination(conversationId: string, epoch: number, identity: string | null): void {
  const state = useAppStore.getState();
  const chat = state.chats[conversationId];
  const head = chat?.queue[0];
  if (state.backendEpoch !== epoch || state.backendIdentity !== identity || state.connection?.status !== "ready") return;
  if (!chat || !head || chat.queuePauseReason !== "destination-required" || head.heldReason !== "destination-required") return;
  // One unknown anywhere in the queue holds all of it: FIFO order is the
  // person's order, and nothing may overtake an input that may already exist.
  if (chat.queue.some((item) => item.deliveryUnconfirmed) || head.deliveryUnconfirmed) return;
  if (chat.running || chat.stopRequested || chat.executionSaving) return;
  const execution = chat.execution;
  // The gate the message was held by, re-read from the state the main process
  // just published: still needing a destination means nothing was resolved.
  if (!execution || execution.status === "blocked" || execution.requiresDestination || execution.pendingDelivery) return;
  useAppStore.setState((current) => patchChat(current, conversationId, () => ({ queuePaused: false, queuePauseReason: undefined })));
  flushQueue(conversationId);
}

/** Send the next queued message of a chat, if it is idle. */
function flushQueue(conversationId: string): void {
  const state = useAppStore.getState();
  const chat = state.chats[conversationId];
  const next = chat?.queue.find((item) => !isNewChatKey(conversationId) || !item.agentId || item.agentId === state.agentId);
  if (state.connection?.status !== "ready" || !chat || !next || chat.queue.some((item) => item.deliveryUnconfirmed) || chat.running || chat.stopRequested || chat.queuePaused || chat.execution?.status === "blocked" || chat.execution?.requiresDestination || chat.execution?.pendingDelivery || chat.executionSaving ||
      (isNewChatKey(conversationId) && state.pendingFirstMessage)) return;
  useAppStore.setState((state) => patchChat(state, conversationId, (c) => ({ queue: c.queue.filter((item) => item !== next) })));
  void dispatch(isNewChatKey(conversationId) ? null : conversationId, next, (held) =>
    // Couldn't send: put it back at the front and hold the queue.
    useAppStore.setState((state) =>
      patchChat(state, conversationId, (c) => ({ queue: [next, ...c.queue], queuePaused: true, queuePauseReason: held ?? "failed-send" })),
    ),
  );
}

/** Send one message to a chat (null starts a new chat). */
async function dispatch(conversationId: string | null, message: QueuedMessage, onFailure: (held?: QueuedMessage["heldReason"]) => void): Promise<void> {
  const get = useAppStore.getState;
  const set = useAppStore.setState;
  const agentId = message.agentId ?? get().agentId;
  const epoch = get().backendEpoch;
  const identity = get().backendIdentity;
  if (!agentId || message.deliveryUnconfirmed || get().connection?.status !== "ready") return;
  const followsOwner = conversationId ? get().chats[conversationId]?.execution?.followsOwner === true : false;
  // One input retains one identity across transport outcomes.
  const otid = message.id;
  const images = message.attachments.flatMap((item) =>
    item.kind === "image" ? [{ name: item.name, mediaType: item.mediaType, data: item.data }] : [],
  );
  const userRow: ChatTextRow = {
    ...optimisticUserRow(messagePreview(message), otid),
    ...(images.length ? { images } : {}),
  };

  if (conversationId) {
    set((current) =>
      patchChat(current, conversationId, (chat) => ({
        rows: upsertRows(chat.rows, [userRow]),
        running: true,
        error: null,
        activity: "Starting",
        activityPhase: null,
        activityDetail: null,
      })),
    );
  } else {
    set({ pendingFirstMessage: userRow });
  }


  const inChat = conversationId ? get().conversations.find((item) => item.id === conversationId) : undefined;
  const sendModel = !followsOwner && message.model && message.model !== inChat?.model ? message.model : undefined;
  // The reasoning level goes with a model whenever one is sent — the new model
  // would otherwise answer at its own default — and on its own when it differs
  // from the level Letta holds for the chat. Current-destination delivery changes neither.
  const sendEffort =
    !followsOwner && message.reasoningEffort && (sendModel || message.reasoningEffort !== inChat?.effort) ? message.reasoningEffort : undefined;
  let definitelyNotSubmitted = false;
  let destinationRequired = false;
  try {
    const conversation = await api.sendMessage({
      agentId,
      conversationId,
      text: message.text,
      otid,
      cwd: followsOwner ? "" : message.cwd,
      ...(sendModel ? { model: sendModel } : {}),
      ...(sendEffort ? { reasoningEffort: sendEffort } : {}),
      ...(message.attachments.length ? { attachments: message.attachments } : {}),
    });
    if (!conversation || typeof conversation !== "object") throw new Error("Delivery response could not be verified.");
    if ("kind" in conversation) {
      // Only a correlated positive pre-submission result in this account/epoch
      // can return to the unsent queue. Arbitrary errors are not that proof.
      definitelyNotSubmitted = conversation.kind === "not-submitted" &&
        conversation.clientMessageId === otid && conversation.conversationId === conversationId &&
        typeof conversation.error === "string" && get().backendEpoch === epoch &&
        get().backendIdentity === identity &&
        !(conversationId && get().chats[conversationId]?.execution?.pendingDelivery);
      // The send boundary's own typed reason, on an input it proved never left.
      // Never read out of the error text: only this exact value may later let the
      // person's own message go on once they have chosen a destination.
      destinationRequired = definitelyNotSubmitted && conversation.reason === "destination-required";
      throw new Error(definitelyNotSubmitted ? conversation.error : "Delivery response could not be verified.");
    }
    if (typeof conversation.id !== "string" || typeof conversation.agentId !== "string") {
      throw new Error("Delivery response could not be verified.");
    }
    if (get().backendEpoch !== epoch) {
      // The message was accepted, so its placeholder has done its job. Left
      // set, it showed "Starting" on the new-chat screen and silently
      // swallowed every later first message until the companion was switched.
      if (!conversationId) set((current) => (current.pendingFirstMessage === userRow ? { pendingFirstMessage: null } : {}));
      return;
    }
    set((current) => ({
      conversations: current.agentId === agentId ? upsertConversation(current.conversations, {
        ...conversation,
        model: followsOwner ? conversation.model : message.model ?? conversation.model,
      }) : current.conversations,
      ...(conversationId
        ? {}
        : {
            // The turn may already be streaming into this conversation; the
            // first message always leads it.
            ...patchChat(current, conversation.id, (chat) => ({
              rows: upsertRows([userRow], chat.rows),
              loaded: true,
            })),
            pendingFirstMessage: current.pendingFirstMessage === userRow ? null : current.pendingFirstMessage,
            // What was typed while the chat was being created belongs to this
            // chat, not to the next new one: carry it across with the view.
            ...(current.agentId === agentId && current.pendingFirstMessage === userRow && current.activeId === null
              ? carryNewChatComposer(current, `${NEW_CHAT}:${agentId}`, conversation.id) : {}),
            activeId:
              current.agentId === agentId && current.pendingFirstMessage === userRow && current.activeId === null
                ? conversation.id
                : current.activeId,
          }),
    }));
  } catch (error) {
    // A reconnect to the same destination may fail an outstanding IPC request.
    // Restore that message, but never introduce old work into another account.
    if (get().backendIdentity !== identity) return;
    const pending = conversationId ? get().chats[conversationId]?.execution?.pendingDelivery : undefined;
    const expectedReceiptConversation = conversationId === `main:${agentId}` ? "default" : conversationId;
    if (conversationId && pending?.clientMessageId === otid && pending.agentId === agentId &&
        pending.conversationId === expectedReceiptConversation) {
      // Accepted or acceptance-unknown belongs to receipt reconciliation, never
      // to the unsent queue. Only this exact input belongs to that receipt;
      // another pending delivery must not swallow a different uncertain input.
      set((current) => ({ notice: errorMessage(error),
        ...patchChat(current, conversationId, () => ({ queuePaused: true, queuePauseReason: "delivery" })) }));
      return;
    }
    set((current) => ({
      notice: errorMessage(error),
      ...(conversationId
        ? patchChat(current, conversationId, (chat) => ({
            rows: chat.rows.filter((row) => rowIdentity(row) !== rowIdentity(userRow)),
            ...(current.backendEpoch === epoch ? { running: false, activity: null, activityPhase: null, activityDetail: null } : {}),
          }))
        : { pendingFirstMessage: current.pendingFirstMessage === userRow ? null : current.pendingFirstMessage }),
    }));
    // Generic transport failure remains quarantined. A positively correlated
    // not-submitted result instead returns the same item to the held unsent queue.
    message.deliveryUnconfirmed = !definitelyNotSubmitted;
    message.heldReason = destinationRequired ? "destination-required" : undefined;
    onFailure(message.heldReason);
  }
}

/**
 * The optimistic row shows the message as it will come back from history
 * (text files inline, image markers), so the two reconcile and render alike.
 * Keep in sync with messageText in main/libs/attachments.ts.
 */
function messagePreview(message: QueuedMessage): string {
  const escape = (name: string) =>
    name.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const parts = message.text ? [message.text] : [];
  for (const item of message.attachments) {
    parts.push(
      item.kind !== "image"
        ? `<attached-file name="${escape(item.name)}">\n${item.kind === "text" ? item.text : ""}\n</attached-file>`
        : `<attached-image name="${escape(item.name)}" />`,
    );
  }
  return parts.join("\n\n");
}
