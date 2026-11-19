// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
/**
 * The contract between the Electron main process and the renderer.
 * Types only - the renderer imports this file with `import type`.
 */

/** Runtime permission modes (from the letta-code App Server protocol). */
import type { Followup, FollowupCreate, FollowupPolicy, FollowupView } from "./intentions";
export type * from "./intentions";

export type PermissionMode = "standard" | "acceptEdits" | "unrestricted" | "strict";


/**
 * Where agents live and where their tools run:
 * - local:  agents stored on this machine, tools run on this machine
 * - cloud:  agents stored in Letta Cloud, tools run on this or the selected computer
 * - remote: a self-hosted Letta app server owns both
 */
export type BackendKind = "local" | "cloud" | "remote";

export type ExecutionComputer = {
  deviceId: string;
  name: string;
  status: "online" | "offline";
  workingDirectory?: string;
};

/** Stable device identity only; never a listener/lease id. */
export type ExecutionComputerTarget = Pick<ExecutionComputer, "deviceId" | "name">;

/**
 * Coarse phase behind the human activity sentence.
 *
 * `activity` stays the short label the chat has always shown. The phase lets the
 * renderer keep its own rotation and iconography working when the sentence is a
 * full policy explanation rather than one of the handful of known labels.
 */
export type TurnActivityPhase =
  | "starting" | "thinking" | "writing" | "tool" | "approval" | "question"
  | "retry" | "stopping" | "sending" | "held" | "elsewhere" | "moving";

/** One place a conversation can run, as offered in the picker. */
export type ExecutionPlace = {
  /** Opaque to the renderer; pass it back to moveConversation unchanged. */
  id: string;
  /**
   * `this-pc` is this computer's registered listener, never the desktop app itself.
   *
   * `app` and `follow` are the two entries that relocate nothing, and they are
   * kept apart from the rest for that reason:
   * - `app`: Hearthside itself runs the conversation's next message, in this
   *   process, on this computer. Nothing is handed to Letta and no teleport is
   *   requested, so a channel bound to the chat is not asked to follow it
   *   anywhere. Offered only when this app can actually host the chat's turns.
   * - `follow`: keep the conversation exactly where it is already running, and
   *   send the next message there. Also no teleport, and offered only while a
   *   live owner is verified — there is nothing to continue otherwise.
   */
  kind: "this-pc" | "cloud" | "computer" | "app" | "follow";
  name: string;
  online: boolean;
  /**
   * Verified, fresh evidence that the conversation is running here *now*.
   *
   * Never a cached or stale observation: a conversation nobody owns is running
   * nowhere, and saying otherwise is how a person ends up told their idle chat
   * is busy on a computer they are looking at.
   */
  current: boolean;
  /**
   * Where this conversation's next message goes, chosen explicitly and verified.
   *
   * Intent, not evidence: an idle conversation has a destination and no owner at
   * the same time, which is the normal state between messages.
   */
  selectedDestination?: boolean;
  /** Human reason a move here is refused. Absent means no known refusal. */
  moveBlocked?: string;
};

/**
 * Progress of one native move. The destination phases are deliberately not
 * collapsed: "we could not attach" and "the move failed" are opposite facts
 * about where the conversation is, and conflating them strands the person.
 */
export type ConversationMovePhase =
  /** Idempotency key persisted and the request issued; no acceptance yet. */
  | "requested"
  /** The request was lost in flight. The outcome is genuinely unknown. */
  | "unconfirmed"
  /** Accepted. The source is finishing the work it already took on. */
  | "waiting-source"
  /** The source released the conversation and the destination is starting. */
  | "starting"
  /** Letta reports the move finished; Hearthside is attaching to the destination. */
  | "connecting"
  /** Attached: approvals and Stop are routable at the destination. */
  | "attached"
  /** Moved, but Hearthside could not attach. It is running there, not here. */
  | "unobserved"
  /** Letta reports the move failed. The conversation never left the source. */
  | "failed";

export type ConversationMoveState = {
  conversationId: string;
  /** Null until a receipt exists; an unconfirmed request has no ID to read. */
  moveId: string | null;
  place: { id: string; name: string };
  phase: ConversationMovePhase;
  /**
   * Where the conversation is believed to be running, from observation rather
   * than from the phase. Never derive this in the renderer.
   */
  location: "source" | "destination" | "unknown";
  /** Verbatim from Letta, when it gave a reason. */
  error?: string;
  revision: number;
};

/**
 * What choosing a place in the picker actually did.
 *
 * One control, two honest outcomes. A conversation with a verified live owner is
 * handed over natively, which is a move. A conversation nobody owns has nothing
 * to hand over: choosing a place records where its next message goes, and no
 * move is requested at all. The two are never merged, because "moved" and "will
 * run there next" are different facts about where the work is right now.
 */
export type ConversationDestinationOutcome =
  | { kind: "moved"; move: ConversationMoveState }
  | { kind: "destination"; execution: ConversationExecutionState };

export type ConversationExecutionTarget =
  | { kind: "follow-owner" }
  | { kind: "default" }
  | { kind: "desktop" }
  | { kind: "desktop-listener" }
  | { kind: "cloud" }
  | { kind: "computer"; deviceId: string; name: string };
export type ConversationExecutionState = {
  conversationId: string;
  selected: ConversationExecutionTarget;
  /** Ephemeral routing presentation, not persisted ownership proof. */
  followsOwner?: boolean;
  /** No established route: absence of a listener cannot authorize provisioning. */
  requiresDestination?: boolean;
  /** Fresh read-only chooser hints, never mutation authority; absent means false. */
  canFollowCurrentOwner?: boolean;
  canMoveExecution?: boolean;
  /** Durable account-scoped routing provenance, never inferred by viewing. */
  provenance?: "desktop" | "owner" | "selected";
  /** Exact listener used by a successfully sent, explicitly selected remote turn. */
  selectedConnectionId?: string;
  /** Explicit move acknowledgement, bound to the owner observed at consent. */
  moveFrom?: { connectionId: string | null };
  /** Exact source identity learned from an owned session, when available. */
  desktopConnectionId?: string;
  /** Account-scoped recovery IDs only; never the input text or credentials. */
  pendingDelivery?: { agentId: string; conversationId: string; clientMessageId: string; superRunId?: string; workflowId?: string };
  observed: null | { kind: "desktop" | "cloud" | "computer"; connectionId?: string; deviceId?: string; name?: string; observedAt: number };
  /**
   * Whether the main process can act on Stop for this conversation right now,
   * decided from what it can actually reach. `at-destination` means the control
   * exists but only where the work is; `unavailable` carries why not.
   */
  controls?: { stop: "available" | "at-destination" | "unavailable"; reason?: string };
  /** The live native move, while one is in flight or unresolved. */
  move?: ConversationMoveState;
  status: "unknown" | "confirmed" | "blocked";
  revision: number;
  detail?: string;
};

export type AppSettings = {
  /** Cloud tool execution only. Missing/null means this computer. */
  executionComputer?: ExecutionComputerTarget | null;
  backend: BackendKind;
  serverUrl: string;
  apiBaseUrl: string;
  /** Secrets never leave the main process; the renderer only learns whether one is set. */
  hasApiKey: boolean;
  /** Hearthside: signed in to Letta Cloud with "Sign in with Letta". */
  hasLettaSignIn: boolean;
  hasServerToken: boolean;
  /** Opaque identity revision; changes on account/connection replacement, not token refresh. */
  connectionRevision?: string;
  permissionMode: PermissionMode;
  /** Agent selected for the current backend. */
  agentId: string | null;
  recentCwds: string[];
  defaultCwd: string;
  /** Hearthside appearance and display preferences. */
  theme: ThemePreference;
  textSize: TextSize;
  showReasoning: boolean;
  /** Hearthside: closing the window keeps the app running in the system tray. */
  closeToTray: boolean;
  /** Hearthside: on Letta Cloud, keep this computer reachable (Letta's remote computer) while Hearthside runs. */
  reachableComputer: boolean;
  /** Hearthside: the name this computer has on Letta Cloud; empty = its existing name or the computer's own. */
  computerName: string;
  /** Hearthside: starred agents, shown first in the agent list. */
  favouriteAgents: string[];
  /** Hearthside: show the context meter by the message box. */
  showUsage: boolean;
  /** Hearthside: show "earlier messages were summarised" dividers in chats. */
  showCompactions: boolean;
  /** Hearthside: desktop notifications for replies and approvals when the app isn't in front. */
  notifications: boolean;
  /** Hearthside: start (quietly, in the tray) when the computer starts. */
  startAtLogin: boolean;
  /** Hearthside: the first-run welcome has been seen. */
  welcomed: boolean;
  /** Hearthside: the guided tour has been shown (or skipped). */
  toured: boolean;
  /** Hearthside: the runtime writes a detailed debug log (Diagnostics), for tracing slow or stuck replies. */
  runtimeDebugLog: boolean;
  /** Hearthside: run on your existing ~/.letta (Letta Code's folder) instead of Hearthside's own. */
  useRealLettaHome: boolean;
  /**
   * Hearthside: mods are turned off for every runtime Hearthside starts
   * (LETTA_DISABLE_MODS). Changed through `setModsOff`, not `updateSettings`,
   * because it only takes effect when the runtime restarts.
   */
  modsOff: boolean;
  /** Hearthside: a Telegram/Discord bot has been set up (read-only). */
  channelsUsed: boolean;
  /** Hearthside: this build can send GIFs (it has a KLIPY key; read-only). */
  gifsAvailable: boolean;
  /** Hearthside: agents may send GIFs. */
  gifs: boolean;
  gifFilter: GifFilter;
  /** Hearthside: agents can check the weather (Open-Meteo). */
  weather: boolean;
  /** Hearthside: the person's home town, used when the agent checks the weather. */
  homeTown: string;
  /** Hearthside: an Obsidian vault folder agents can read (and, with approval, write). Empty when unset. */
  obsidianVault: string;
  /** Hearthside: which signed-in CLI makes images, or off. */
  imageEngine: ImageEngine | "off";
};

/** Local organisation only: never changes a conversation's server-side title. */
export type ChatPreference = { pinned: boolean; starred: boolean; icon: string | null; pinnedAt: number | null };
export type ChatPreferencePatch = Partial<Pick<ChatPreference, "pinned" | "starred" | "icon">>;
export type ChatPreferencesView = { scope: string; revision: number; items: Record<string, ChatPreference> };

export type GifResult = { id: string; title: string; url: string; preview: string; width: number; height: number; page: string };

/** KLIPY's content filter: "high" filters the most. */
export type GifFilter = "high" | "medium" | "low" | "off";

export type ThemePreference = "system" | "light" | "dark";
export type TextSize = "small" | "medium" | "large";

export type SettingsUpdate = {
  executionComputer?: ExecutionComputerTarget | null;
  backend?: BackendKind;
  serverUrl?: string;
  apiBaseUrl?: string;
  /** A string replaces the saved secret, null clears it, undefined keeps it. */
  apiKey?: string | null;
  serverToken?: string | null;
  permissionMode?: PermissionMode;
  agentId?: string | null;
  theme?: ThemePreference;
  textSize?: TextSize;
  showReasoning?: boolean;
  closeToTray?: boolean;
  reachableComputer?: boolean;
  computerName?: string;
  favouriteAgents?: string[];
  showUsage?: boolean;
  showCompactions?: boolean;
  notifications?: boolean;
  startAtLogin?: boolean;
  welcomed?: boolean;
  toured?: boolean;
  runtimeDebugLog?: boolean;
  useRealLettaHome?: boolean;
  /**
   * Main process only: deliberately absent from the IPC schema, so the window
   * cannot turn mods on or off through the general settings request. It goes
   * through `setModsOff`, which also restarts the runtime.
   */
  modsOff?: boolean;
  gifs?: boolean;
  gifFilter?: GifFilter;
  weather?: boolean;
  homeTown?: string;
  obsidianVault?: string;
  imageEngine?: ImageEngine | "off";
};

/** Hearthside: an event in the built-in calendar. All-day events use dates, with an exclusive end. */
export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  timezone: string;
  location: string | null;
  notes: string | null;
  /** Remind this many minutes before; null for none. */
  reminderMinutes: number | null;
  /** Also tell this agent (in its main chat) when the reminder fires. */
  remindAgentId: string | null;
  /** "person" or the agent id that made it. */
  createdBy: string;
  revision: number;
  updated: string;
};
export type CalendarEventInput = {
  id?: string;
  /** The revision last seen, for updates; a newer one is refused. */
  revision?: number;
  title: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  notes?: string | null;
  reminderMinutes?: number | null;
  remindAgentId?: string | null;
};
/** One showing of an event: a Hearthside event, or one from an imported (read-only) calendar. */
export type CalendarOccurrence = {
  id: string;
  eventId: string;
  /** "hearthside", or the subscription id. */
  source: string;
  sourceName: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  reminderMinutes: number | null;
  remindAgentId: string | null;
  revision: number;
  readOnly: boolean;
};
export type PresenceCalendarSummary = {
  /** Whether this companion is currently allowed to use Hearthside's calendar tools. */
  shared: boolean;
  /** The next occurrence in the requested bounded window; never returned without access. */
  occurrence: CalendarOccurrence | null;
};
/** An imported calendar (iCal link). The link itself never leaves the main process. */
export type CalendarSubscription = {
  id: string;
  name: string;
  host: string;
  lastFetched: string | null;
  status: "ok" | "stale" | "error" | "pending";
  error: string | null;
  count: number;
};

/** Hearthside: CLIs that can make images with the person's own sign-in. */
export type ImageEngine = "codex" | "grok";
export type ImageEngineStatus = Record<ImageEngine, { installed: boolean; signedIn: boolean }>;

/** Hearthside: how Codex is signed in. An API key is a different, billed account than a ChatGPT plan. */
export type CodexAuthMode = "chatgpt" | "api-key" | "other";

/**
 * Hearthside: what the ChatGPT image connection card shows. `signedIn` is what
 * the Codex CLI itself reports, not whether a sign-in file exists, and nothing
 * here says the account has image generation left — only making one finds out.
 */
export type ImageProviderStatus = {
  /** OpenAI publishes Codex for this platform, so Hearthside can set it up. */
  supported: boolean;
  installed: boolean;
  /** "user": a Codex they installed themselves. "managed": the copy Hearthside fetched. */
  source: "user" | "managed" | null;
  version: string | null;
  signedIn: boolean;
  authMode: CodexAuthMode | null;
  /** The CLI's own words, for showing when something is unexpected. */
  detail: string;
  /** An install or sign-in is running right now. */
  busy: boolean;
};

export type ImageConnectStatus = { codex: ImageProviderStatus; grok: { installed: boolean; signedIn: boolean } };

/** Installing Codex and signing in are separate steps, and neither makes an image. */
export type ImageSetupStep = "install" | "login";
/** How to sign in: in this computer's browser, or with a one-time code shown here. */
export type ImageSetupMode = "browser" | "device";

export type ImageSetupState = {
  step: ImageSetupStep;
  /** "waiting": it needs the person to do something in their browser. */
  phase: "working" | "waiting" | "done" | "error";
  /** Download progress, 0–1, or null when the size isn't known. */
  progress: number | null;
  /** OpenAI's sign-in page. Only ever one of OpenAI's own sign-in addresses. */
  url: string | null;
  /** The one-time code to type on that page. */
  code: string | null;
  message: string;
};

export type ConnectionState = (
  | { status: "connecting"; backend: BackendKind }
  | {
      status: "ready";
      backend: BackendKind;
      detail: string;
      /** True when the server keeps its own model provider keys (the local backend). */
      providers: boolean;
    }
  | { status: "error"; backend: BackendKind; error: string }
) & {
  /** Desktop management can restart independently of these hosted sessions. */
  activeRemoteConversationIds?: string[];
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  /** Hearthside: the reasoning level Letta holds for the agent; null if its settings don't name one. */
  effort?: ReasoningEffort | null;
};

/** Hearthside: one step a helper (subagent) took: a tool call, a thought, or what it wrote. */
export type ChatHelperStep = { kind: "tool" | "thought" | "text"; id: string; name: string; detail: string; at: number; failed?: boolean };

/** Hearthside: a helper an agent sent off in a chat (the runtime's subagents), for the side panel. */
export type ChatHelper = {
  id: string;
  /** general-purpose, memory, recall, … */
  type: string;
  /** The job, in a few words. */
  description: string;
  prompt: string;
  /** running, completed, failed, … as the runtime reports it. */
  status: string;
  model: string | null;
  background: boolean;
  startedAt: number;
  durationMs: number | null;
  toolCalls: number;
  totalTokens: number | null;
  error: string | null;
  /** Its own conversation, when it has one. */
  conversationId: string | null;
  steps: ChatHelperStep[];
  updatedAt: number;
};

export type AgentDetails = AgentSummary & {
  /** Stored base override, not the compiled prompt. Cloud null inherits Letta's default. */
  system: string | null;
  /** Hearthside: current context window in tokens, when known. */
  contextWindow: number | null;
};

/**
 * Hearthside: how a companion looks in the app ("make it yours"): its picture,
 * a theme colour the whole app takes on while it is selected, and a blurred
 * picture behind its chats.
 */
export type Look = {
  /** A small square picture as a data URL, or null for a lettered circle. */
  avatar: string | null;
  /** A mid-tone colour (#rrggbb) the accent and surfaces are re-derived from; null keeps Hearthside's teal. */
  accent: string | null;
  /** A picture behind the chat, as a data URL. */
  background: string | null;
  /** How much the background picture is blurred, in pixels (0–40). */
  blur: number;
};

export type Looks = {
  /** The person's own picture, shown beside their messages. */
  me: { avatar: string | null };
  agents: Record<string, Look>;
};

/** Fields left out are not changed; a null accent means Hearthside's own colours. */
export type LookStyle = { accent?: string | null; blur?: number };

/** Hearthside: when and how the agent "dreams" (background memory reflection). */
export type DreamSettings = {
  /** off, after every N agent steps, or when the context window is compacted. */
  trigger: "off" | "step-count" | "compaction-event";
  stepCount: number;
  /** auto: apply memory updates directly. explicit: the agent reviews them before applying. */
  merge: "auto" | "explicit";
  /** Guidance for the reviewing agent (used with explicit merge). */
  mergeInstructions: string;
};

/** Fields left out are not changed. */
export type AgentUpdate = {
  name?: string;
  description?: string;
  /** Default model for new chats. */
  model?: string;
  system?: string;
  /** Hearthside: context window limit in tokens for the agent's default. */
  contextWindowLimit?: number;
};

/**
 * Hearthside: the reasoning levels Letta accepts, the same closed set the SDK
 * takes for a session. A chat's level is read out of Letta's model settings,
 * which are shaped differently for each of its many providers, so a value from
 * there is only used when it is one of these.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ModelOption = {
  /** Catalog id to use by default (the model's default reasoning tier). */
  id: string;
  handle: string;
  label: string;
  /** Maximum context window in tokens, when the catalog says. */
  contextWindow?: number;
  /** Hearthside: reasoning tiers, each with its own catalog id. Empty when not adjustable. */
  reasoning: Array<{ id: string; effort: string }>;
  /** Hearthside: where this model comes from and who pays for it, in plain words. */
  source?: ModelSource;
};

/** Hearthside: "letta" Letta's own, "hosted" a provider Letta hosts (Letta credits), "plan" a sign-in
 * subscription, "key" the person's own API key or connection, "server" a self-hosted Letta server. */
export type ModelSource = { kind: "letta" | "hosted" | "plan" | "key" | "server" | "unknown"; label: string };

export type ProviderField = {
  key: string;
  label: string;
  placeholder: string | null;
  secret: boolean;
  required: boolean;
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  description: string;
  fields: ProviderField[];
};

export type ProviderSummary = {
  id: string;
  name: string;
  description: string;
  /** Subscription sign-in. These are connected from the Letta CLI, not here. */
  oauth: boolean;
  fields: ProviderField[];
  /** Set instead of `fields` when a provider offers more than one way to authenticate. */
  authMethods: ProviderAuthMethod[];
  connections: Array<{ name: string; authType: "api" | "oauth" | null; baseUrl: string | null }>;
  /** Hearthside: shown but not connectable here, with the reason (e.g. Claude subscription on Letta Cloud). */
  unavailable?: string;
  /**
   * Hearthside: on This computer, what is known about a saved connection.
   * "verified" the provider accepted it; "unchecked" it was saved and could not
   * be checked; "unreachable" a local server that wasn't answering. Absent on
   * Letta Cloud, where Letta checks a key before keeping it.
   */
  check?: "verified" | "unchecked" | "unreachable";
};

/**
 * Hearthside: a ChatGPT Plus/Pro plan's own usage, as ChatGPT reports it
 * through the runtime (`chatgpt_usage_read`). Every figure here comes from that
 * report; nothing is derived from the tokens a chat has spent.
 */
export type GptUsageWindow = {
  /** The window's name as reported ("primary", "secondary", or a named limit). */
  label: string;
  /** Percent of the allowance used. Null when the plan doesn't report one. */
  usedPercent: number | null;
  /** How long the window is, in minutes. Null when it isn't reported. */
  windowMinutes: number | null;
  /** When the window resets (ISO). Null when it isn't reported. */
  resetsAt: string | null;
};

/** A spend limit on the account, reported as text amounts rather than percentages. */
export type GptUsageSpendLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: string;
};

export type GptUsageSnapshot = {
  providerName: string;
  /** When this reading was taken (ISO). */
  fetchedAt: string;
  /** The plan as ChatGPT names it. Null when it isn't reported. */
  planType: string | null;
  /** True when the plan is rate limited right now. Null when it isn't reported. */
  limitReached: boolean | null;
  /** Which limit was reached, as reported. */
  limitReachedType: string | null;
  windows: GptUsageWindow[];
  spendLimit: GptUsageSpendLimit | null;
  /** The runtime's own one-line summary of the same reading. */
  summary: string;
};

/** One manual usage reset ChatGPT has granted to this plan. */
export type GptUsageReset = {
  id: string;
  title: string | null;
  description: string | null;
  resetType: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
};

export type GptUsageResets = {
  /** How many resets the plan reports as available. */
  availableCount: number;
  credits: GptUsageReset[];
  fetchedAt: string;
};

/** A reading Hearthside itself took and kept, so usage can be drawn over time. */
export type GptUsageReading = { at: string; label: string; usedPercent: number };

/** Why usage or resets couldn't be read, in the runtime's own terms. */
export type GptUsageFailure = {
  code: string;
  message: string;
  retryAfterMs: number | null;
};

export type GptUsageView = {
  /** Which ChatGPT connection the figures are about, and where it lives. */
  source: {
    target: "local" | "cloud";
    providerName: string | null;
    /** Plain words for where this plan is connected ("on this computer"…). */
    where: string;
  };
  /** False when no ChatGPT subscription is connected here; nothing was asked for. */
  connected: boolean;
  /**
   * An opaque handle for the plan these figures came from, bound to the account
   * and the runtime connection they were read on. It has to be given back to
   * spend a reset, so a view left open across a sign-in or backend change can
   * never act on whichever plan is connected now. Null when nothing was read.
   *
   * Not a credential: a digest of non-secret identifiers, minted per read and
   * never stored.
   */
  token: string | null;
  usage: GptUsageSnapshot | null;
  usageError: GptUsageFailure | null;
  resets: GptUsageResets | null;
  resetsError: GptUsageFailure | null;
  /** Earlier readings of the same windows, oldest first. Only ones actually taken. */
  readings: GptUsageReading[];
};

export type GptResetOutcome = {
  outcome: "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";
  tone: "success" | "info" | "warning";
  message: string;
  /** The state after the reset, from the runtime's own refreshed reading. */
  view: GptUsageView;
};

/**
 * Spending a reset. `confirm` is the one word that means a person pressed
 * through the confirmation, and `resetId` names the exact reset they were
 * shown — so no code path can spend one as a side effect of reading usage.
 * `token` is the handle from the view the reset was offered in, so the press
 * can only ever land on the connection it was made on.
 */
export type GptResetRequest = {
  providerName: string;
  resetId: string;
  token: string;
  confirm: "use-one-reset";
};

export type MemoryFile = {
  /** Path relative to the agent's memory folder. */
  path: string;
  /** System files are always in the agent's context. */
  system: boolean;
  description: string | null;
  /** The body, without the file's header. Use readMemoryFile for the whole file. */
  content: string;
  size: number;
  kind: "markdown" | "image";
  /** Hearthside: memory paths this file links to with [[path]], resolved by the runtime. */
  references: string[];
};

export type MemoryOverview = {
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type MemoryCommit = {
  sha: string;
  message: string;
  timestamp: number;
  author: string | null;
};

export type ConversationSummary = {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  model: string | null;
  /**
   * Hearthside: the reasoning level Letta holds for this chat, from its own
   * model settings. `model` is only a handle, so without this the level a chat
   * runs at is invisible after a restart. Null means Letta's settings don't
   * name one — the chat follows its agent, or the model's own default. Null is
   * not a level: nothing should show or send one on the strength of it.
   */
  effort?: ReasoningEffort | null;
  cwd: string | null;
  /** Hearthside: the agent's default conversation ("Main chat"), always listed first. */
  main?: boolean;
  /** Hearthside: this chat's own context window limit (null = the agent's). */
  contextWindowLimit?: number | null;
  /** Hearthside: the channel this chat comes from (telegram, discord), if any. */
  channel?: string;
  /** Hearthside: a read-only part of a restored chat's history (see HistoryVolume). */
  history?: HistoryVolume;
};

/** A bounded, human-authored preview for a recent conversation. */
export type ConversationPreview = {
  conversationId: string;
  kind: "user" | "assistant";
  text: string;
  date: string | null;
};

/**
 * Hearthside: one read-only part of a chat's history, restored from a Cloud backup
 * (backup/cloud-native.ts). Nothing can be sent into it; "Continue from here" starts
 * a new chat instead.
 */
export type HistoryVolume = {
  /** The chat it belongs to: "main", or that chat's original ID. */
  of: string;
  part: number;
  firstAt: string | null;
  lastAt: string | null;
};

export type ChatTextRow = {
  kind: "user" | "assistant" | "reasoning";
  /** Controller inputs are not authored by the human, despite SDK input role. */
  source?: "controller";
  key: string;
  text: string;
  /** Correlates an optimistic user row with the message Letta persists. */
  otid?: string;
  /** Hearthside: images attached to a message just sent (history keeps only their names). */
  images?: Array<{ name: string; mediaType: ImageMediaType; data: string }>;
  /** Hearthside: when the message was sent (ISO), when known. */
  date?: string;
  /** Hearthside: drawn the moment it was sent from this window, before Letta has it. */
  optimistic?: boolean;
};

/** Hearthside: image types the models accept. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Hearthside: something attached to a message. Text files are sent inline. */
export type Attachment =
  | { kind: "image"; name: string; mediaType: ImageMediaType; data: string }
  | { kind: "text"; name: string; text: string }
  /** Read to text in the main process before sending. */
  | { kind: "pdf"; name: string; data: string };

export type ChatToolRow = {
  kind: "tool_call";
  key: string;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: "streaming" | "ready" | "complete";
  result?: { content: string; isError: boolean };
};

/** Hearthside: older messages were summarised to make room (a compaction). */
export type ChatCompactionRow = {
  kind: "compaction";
  key: string;
  summary: string;
};

/** Hearthside: the agent's built-in tool set. */
export type ToolsetPreference = "auto" | "default" | "codex" | "letta" | "none";
export type ToolsetInfo = {
  preference: ToolsetPreference;
  /** What "auto" resolved to, or the chosen set. */
  current: string | null;
  options: Array<{ id: ToolsetPreference; name: string; description: string }>;
};

/** Hearthside: what the Diagnostics tab shows. */
export type Diagnostics = {
  appVersion: string;
  electronVersion: string;
  runtimeVersion: string | null;
  platform: string;
  logPath: string;
  logTail: string;
  lettaHome: string;
  sandbox: boolean;
};

/** Hearthside: a message found by searching an agent's chats. */
export type MessageSearchResult = { messageId: string; conversationId: string; role: string; text: string; date: string | null };

/** Hearthside: channels (Telegram, Discord). */
export type DmPolicy = "pairing" | "allowlist" | "open";
export type ChannelField = {
  key: string;
  label: string;
  description: string;
  type: "text" | "secret" | "select" | "boolean" | "number" | "string-array" | "key-value-map";
  required: boolean;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  scope: "app" | "account";
};
export type ChannelInfo = {
  id: string;
  name: string;
  configured: boolean;
  running: boolean;
  pendingPairings: number;
  approvedUsers: number;
  routes: number;
  /** The settings the channel needs, as the runtime describes them. */
  fields: ChannelField[];
};
export type ChannelAccount = {
  /** Hearthside: the connection this bot belongs to ("local", "cloud", "remote:<url>"); null when not yet placed. */
  connection: string | null;
  /** Hearthside: where it belongs, in words, when that isn't the current connection; null when it is. */
  connectionLabel: string | null;
  /** Hearthside: belongs to the current connection, so it may run here. */
  here: boolean;
  /** Hearthside: the companion this bot belongs to; null when nobody has claimed it yet. */
  ownerAgentId: string | null;
  /**
   * Hearthside: the agent the runtime has this bot bound to, as it reports it.
   * A suggestion for an unclaimed bot, never an owner — on Telegram the runtime
   * can report an agent taken from one of the bot's routes.
   */
  boundAgentId: string | null;
  /** Hearthside: owned by the companion that asked for this list, on this connection. */
  mine: boolean;
  /** Hearthside: owned by the companion that asked, but belonging to another connection. */
  elsewhere: boolean;
  /** Hearthside: from before bots belonged to companions; waiting to be claimed. */
  unclaimed: boolean;
  /** Hearthside: unclaimed AND able to run here, so it can be claimed from this window. */
  claimable: boolean;
  /** Hearthside: the recorded owner and the runtime's binding disagree, so the bot is held. */
  conflict: boolean;
  /**
   * Hearthside: a move to another companion that didn't finish — the bot is held
   * off until the move is finished or undone. Null when there isn't one.
   */
  unfinishedMove: { fromAgentId: string | null; toAgentId: string } | null;
  /** Hearthside: who may message it. */
  access: ChannelAccess;
  /** Hearthside: where server messages go (Discord). */
  chatMode: ChannelChatMode;
  channelId: string;
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  /** Other Discord bots that may start a turn in an already-authorized server room. */
  companionParticipation: { version: 1; ambient: boolean; mentions: boolean; reactions: boolean; mode: "native" | "legacy" };
};
export type ChannelPairing = { channelId: string; accountId: string; code: string; senderId: string; senderName: string; chatId: string; expiresAt: string | null };
/** Hearthside: who may message a bot. "just-me" locks it to the first person approved. */
export type ChannelAccess = "just-me" | "pairing" | "open";
/** Hearthside: where a Discord bot's server messages go. */
export type ChannelChatMode = "main" | "server" | "channel";
export type ChannelRoute = {
  channelId: string;
  accountId: string;
  chatId: string;
  chatType: "direct" | "channel";
  /** Discord threads follow their parent channel's listening policy. */
  threadId?: string | null;
  conversationId: string;
  enabled: boolean;
  /** Hearthside: a readable name when known, e.g. "#general · Cosy corner". */
  label: string | null;
};
/** Hearthside: a Discord channel the bot has been turned off in. */
export type MutedChannel = { accountId: string; chatId: string; label: string | null };
/** Hearthside: what moving a bot to another companion would do, before it is done. */
export type ChannelBotReassign = {
  channelId: string;
  accountId: string;
  /** The companion that owns it now. Confirming sends this back, and the move is refused if it has changed since. */
  fromAgentId: string;
  toAgentId: string;
  /** The connection the bot belongs to, sent back with the confirmation for the same reason. */
  connection: string;
  /** Existing chats that will move with the bot, rather than being dropped. */
  movingRoutes: number;
  /**
   * Of those, how many are in a chat of the old companion's. Conversations
   * belong to one companion, so these start again in the new companion's main
   * chat: the chat keeps working, its earlier messages stay with the old
   * companion. Said plainly in the window before anything changes.
   */
  resetChats: number;
  /** The bot is meant to be running, so it will be stopped and started again. */
  running: boolean;
};

/** Hearthside: schedules (the runtime's cron). */
export type Schedule = {
  id: string;
  agentId: string;
  conversationId: string | null;
  name: string;
  description: string;
  /** Five-field cron pattern ("0 9 * * *"). */
  cron: string;
  timezone: string;
  recurring: boolean;
  /** The message sent to the agent. */
  prompt: string;
  status: "active" | "paused" | "fired" | "missed" | "cancelled";
  /** For one-off schedules: when it runs (ISO). */
  scheduledFor: string | null;
  lastRunAt: string | null;
  lastRunOutcome: string | null;
  lastRunError: string | null;
  fireCount: number;
};
export type ScheduleInput = {
  agentId: string;
  /** null or a main:<agent> id targets the main chat. */
  conversationId?: string | null;
  name: string;
  description?: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduledFor?: string | null;
};
export type ScheduleRun = { at: number; status: string; error: string | null; summary: string | null };

/** Hearthside: skills. */
export type SkillSource = { owner: string; repo: string; ref: string; path: string };
export type SkillTarget = "agent" | "computer";
/** Hearthside: what a skill needs to work (read from its SKILL.md). */
export type SkillNeeds = {
  /** Programs it runs, e.g. "gog" or "gh". */
  programs: string[];
  /** API keys it mentions, e.g. "OPENAI_API_KEY" (set them as the agent's secrets). */
  secrets: string[];
  /** Its own setup / requirements section, as written. */
  setup: string | null;
};
export type CatalogSkill = { source: SkillSource; name: string; description: string; group: string; needs: SkillNeeds; icon: string | null };
export type InstalledSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  /** bundled: comes with the runtime; global: this computer; agent: in the agent's memory; project: the working folder. */
  source: "bundled" | "global" | "agent" | "project";
  needs?: SkillNeeds;
};

/** Hearthside: slash commands the runtime runs. */
export type RuntimeCommand = "doctor" | "dream" | "compact" | "init" | "reload" | "recompile";

// --- Mods (Letta Code's own extensions; see docs/MODS.md) -------------------

/** "machine": the runtime's mods folder. "agent": inside one agent's memory. */
export type ModScope = "machine" | "agent";

/** Which rule decided the folder, so the person can see why it is that one. */
export type ModDirectoryRule =
  | "LETTA_MODS_DIR"
  | "LETTA_EXTENSIONS_DIR"
  | "default"
  | "legacy-default"
  | "agent-memory";

export type ModFileInfo = {
  name: string;
  /** Where it is, as the runtime sees it. */
  path: string;
  bytes: number;
  modifiedAt: number;
  /** A link: Hearthside shows where it points but never reads through it. */
  linkTarget: string | null;
  /** Bigger than Hearthside will show. */
  tooLarge: boolean;
};

/** A managed package in `packages.json`, exactly as that file records it. */
export type ModPackageInfo = {
  source: string;
  version: string;
  enabled: boolean;
  entries: string[];
  root: string;
};

export type ModScopeInfo = {
  scope: ModScope;
  /** The folder the runtime actually reads, or null when there isn't one. */
  directory: string | null;
  rule: ModDirectoryRule;
  exists: boolean;
  /** Hearthside can read this folder from here. */
  inspectable: boolean;
  /** Hearthside will never write here. */
  readOnly: boolean;
  files: ModFileInfo[];
  packages: ModPackageInfo[];
  /** Something wrong with `packages.json` that stops the runtime loading packages. */
  packagesProblem: string | null;
  /** What to know about this folder, or why it can't be read. */
  note: string | null;
};

export type ModDiagnosticEntry = {
  modId: string;
  modPath: string;
  modScope: string;
  /** Where it went wrong: "transpile", "import", "activate", "command.run"… */
  phase: string;
  severity: "error" | "warning";
  message: string;
  capability: string | null;
  hint: string | null;
  at: number;
};

/**
 * The runtime's own diagnostics file. A record of problems at one moment, not a
 * list of what is loaded: a mod that loaded cleanly has no entry.
 */
export type ModDiagnosticsInfo = {
  path: string;
  generatedAt: number;
  errors: number;
  warnings: number;
  entries: ModDiagnosticEntry[];
};

/** What the runtime says a mod may use. Advertised, not guaranteed, and not a sandbox. */
export type ModCapabilityInfo = { id: string; name: string; machine: boolean; agent: boolean };

/** A command the runtime advertises. Only these three fields are sent. */
export type ModCommandInfo = { id: string; description: string; argument: string | null };

export type ModsOffState = {
  active: boolean;
  /** "setting": Hearthside's switch. "environment": a variable set outside Hearthside. */
  reason: "setting" | "environment" | null;
  /** The variable in force, when that is the reason. */
  variable: string | null;
  /** The switch has changed but the runtime hasn't restarted yet. */
  needsRestart: boolean;
};

export type ModsOverview = {
  off: ModsOffState;
  machine: ModScopeInfo;
  /** Null when no agent is selected, or when it has no mods folder. */
  agent: ModScopeInfo | null;
  diagnostics: ModDiagnosticsInfo | null;
  capabilities: ModCapabilityInfo[];
  /** What the runtime advertises as loaded right now; null when it couldn't be asked. */
  advertised: { commands: ModCommandInfo[]; agentId: string | null; asOf: number } | null;
  /** Why `advertised` is missing. */
  advertisedError: string | null;
  /** A selected connected computer runs its own mods, which can't be seen from here. */
  executionComputer: string | null;
};

export type ModSourceView = {
  scope: ModScope;
  name: string;
  path: string;
  bytes: number;
  /** The file as text. Hearthside reads it; it never runs it. */
  source: string;
  truncated: boolean;
};

export type ModImportPreview = {
  /** Confirms this exact previewed file, and expires. */
  token: string;
  name: string;
  bytes: number;
  source: string;
  from: string;
  target: string;
};

export type ModImportResult = { name: string; path: string };

export type ChatCommand = {
  id: string;
  description: string;
  argument: string | null;
  source: "builtin" | "mod";
  /** Typing it needs something after the name. */
  needsArgument?: boolean;
};

export type ChatCommandCatalog = {
  commands: ChatCommand[];
  agentId: string;
  conversationId: string;
  /** Null when the runtime answered; otherwise why only built-ins are listed. */
  error: string | null;
};

export type CommandRunResult = {
  output: string;
  success: boolean;
  /**
   * The command started a reply, observed from the runtime's own loop state
   * rather than guessed from its output.
   */
  startedTurn: boolean;
  /**
   * The reply reached a real terminal state. False means Hearthside stopped
   * following it — it may still be going — and nothing queued should be let go.
   */
  turnFinished: boolean;
  /**
   * The command's outcome is unknown: it timed out, or the connection went
   * away mid-flight, and it may still be running in the runtime. Nothing
   * queued may be sent, because it could land in a reply that command started.
   */
  uncertain: boolean;
};

export type ChatRow = ChatTextRow | ChatToolRow | ChatCompactionRow;

/** Hearthside: how full a chat's context is, and what the last turn used. */
export type ChatUsage = {
  /** Tokens currently in the context window, when the model reported it. */
  contextTokens: number | null;
  /** The context window size that applies to this chat. */
  contextWindow: number | null;
  /** Totals for the last turn. */
  promptTokens: number;
  completionTokens: number;
};

export type ApprovalRequest = {
  requestId: string;
  toolCallId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  /** "Don't ask again" style grants offered by the runtime. */
  suggestions: Array<{ id: string; text: string }>;
};

export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; suggestionIds?: string[] }
  | { behavior: "deny"; message?: string };

export type HistoryPageOptions = { before?: string; around?: string };

export type HistoryResult = {
  /** Oldest source message ID, not a projected row key or row count. */
  nextBefore?: string | null;
  /** Persisted message IDs can project to OTID-keyed rows (or several rows). */
  messageKeys?: Record<string, string[]>;
  rows: ChatRow[];
  hasMore: boolean;
  running: boolean;
  activity: string | null;
  approvals: ApprovalRequest[];
  /** Hearthside: the last known context usage for this chat. */
  usage?: ChatUsage | null;
};

/** Only the trusted main-process send boundary may prove a request was not submitted.
 * Generic IPC failures remain acceptance-unknown; this is a plain serializable value. */
export type SendMessageNotSubmitted = {
  kind: "not-submitted";
  clientMessageId: string;
  conversationId: string | null;
  error: string;
  /**
   * Why the send was refused, when the reason is one the app can act on.
   *
   * `destination-required` means exactly this: the message was never submitted
   * anywhere, and the only thing missing was a verified destination. It is set
   * by the send boundary itself, never read out of the error text, so resuming
   * on it cannot be triggered by a message that merely reads like this case.
   */
  reason?: "destination-required";
};
export type SendMessageResult = ConversationSummary | SendMessageNotSubmitted;

export type SendMessageInput = {
  agentId: string;
  /** null starts a new conversation. */
  conversationId: string | null;
  text: string;
  otid: string;
  cwd: string;
  model?: string;
  /**
   * Hearthside: the reasoning level to run this message at, when the person
   * chose one. Letta keeps the level apart from the model, so sending a model
   * without it would answer at that model's default; omitted, the chat keeps
   * whatever level Letta already holds for it.
   */
  reasoningEffort?: ReasoningEffort;
  /** Hearthside: images and text files sent with the message. */
  attachments?: Attachment[];
};

/**
 * Hearthside: what *this importer* does not carry across about who spoke.
 *
 * It reads one field per message to decide a speaker — ChatGPT's author.role
 * ("user"/"assistant"), Claude's sender ("human"/"assistant") — and labels every
 * reply with the source's name and every human line with the one name the person
 * chose for the import. It neither preserves nor verifies which model, custom
 * GPT or project produced a reply, or which individual typed a prompt in a
 * shared account.
 *
 * This is deliberately worded as a limitation of the importer, not of the export
 * file. An export may well carry more than role — ChatGPT messages can include
 * metadata.model_slug and similar fields — and reading only the role proves
 * nothing about what else is in there. Carrying any of it across is a separate
 * piece of work, not something this note should imply is impossible.
 *
 * Said out loud in the preview and kept in the import record, so nobody later
 * reads these labels as evidence of who actually wrote a line.
 */
export const ATTRIBUTION_NOTE =
  "Hearthside labels every reply with the source's name and every prompt with the name chosen for this import. It doesn't carry over or check which model, custom GPT or project answered, or which individual typed a prompt, so treat these labels as placeholders rather than a record of who wrote what.";

/**
 * Hearthside: what this importer keeps of a conversation that was edited.
 *
 * ChatGPT's mapping holds every branch; the importer walks back from
 * current_node, so it imports only the version last on screen and counts the
 * rest (omitted.otherBranches) rather than writing them — importing them would
 * put text the person had already replaced into memory with no way to tell which
 * version they saw. Claude exports are read as the flat chat_messages list they
 * are presented as, so the importer reconstructs no alternatives there either;
 * that is what this importer does, not a claim that a Claude export can never
 * hold any.
 */
export const BRANCH_NOTE =
  "Only the version of each conversation you last had on screen is imported. Where you edited a prompt or regenerated a reply, Hearthside doesn't bring the attempts you replaced across.";

/** Main -> renderer push events. */
/** Hearthside: what an export holds, before anything is written. */
export type HistoryImportPreview = {
  token: string;
  source: "chatgpt" | "claude";
  sourceLabel: string;
  fileName: string;
  conversations: number;
  messages: number;
  firstDate: string | null;
  lastDate: string | null;
  files: number;
  /** Conversations from this export already in memory (re-importing is safe). */
  alreadyImported: number;
  /** Hearthside: conversations the export marks archived (ChatGPT); the person can leave them out. */
  archived: number;
  /** Hearthside: messages in those archived conversations. */
  archivedMessages: number;
  omitted: {
    systemOrTool: number;
    hidden: number;
    images: number;
    empty: number;
    /**
     * Hearthside: messages the export keeps but the person had replaced — an edited
     * prompt's earlier text, a regenerated reply's earlier attempt. The importer
     * takes only the version last on screen, so these are disclosed, not written.
     */
    otherBranches: number;
  };
  /** Hearthside: what the importer doesn't carry across about who wrote a line, shown before importing. */
  attributionNote: string;
  /** Hearthside: what the importer doesn't carry across of a conversation that was edited. */
  branchNote: string;
  sample: Array<{ title: string; date: string | null; messages: number }>;
  /** Whether this agent can take an import (on this computer, or on Letta Cloud when signed in). */
  supported: boolean;
  /** Where it would go: the agent's memory on this computer, or a repository on Letta Cloud. */
  destination: "local" | "cloud" | null;
};

export type HistoryImportResult = { written: number; unchanged: number; conversations: number; files: number };

/** Hearthside: backups (see docs/PLAN.md, "Continuity"). */
export type BackupSettingsInfo = {
  folder: string | null;
  /** The folder holds a store this computer has the key for. */
  ready: boolean;
  includePictures: boolean;
  daily: boolean;
  dailyAt: string;
  keepDays: number;
  lastRun: Record<string, string>;
  /** The last failed backup per companion, until one succeeds. */
  lastError: Record<string, { at: string; message: string }>;
  /** Bytes the backup folder takes. */
  sizeOnDisk: number | null;
};
export type BackupSnapshotInfo = {
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  counts: Record<string, number>;
  objects: number;
  bytes: number;
  omissions: string[];
};
export type BackupVerification = { ok: boolean; checked: number; missing: string[]; corrupt: string[]; semanticErrors: string[]; warnings: string[] };
/**
 * Hearthside: what the connection reports about one companion, counted and
 * nothing else. Every field is a number, a boolean, or a word chosen by the
 * app: no message text, no prompts, no tool arguments, no token counts, no
 * URLs and no identifiers cross this boundary (see
 * apps/desktop/src/main/libs/backup/capture-diagnostic.ts).
 */
export type BackupCaptureDiagnosticLimits = {
  chats: number; pagesPerChat: number; messagesPerChat: number; jsonBytes: number; milliseconds: number;
  /** Pages of the chat listing itself, per listing (active, then archived). */
  listPages: number;
  /** How long any one read is waited for before the check stops waiting on it. */
  readMilliseconds: number;
};
export type BackupChatDiagnostic = {
  /** An ordinal label ("Main chat", "Chat 2"), never a title or an id. */
  chat: string;
  main: boolean;
  archived: boolean;
  pagesRead: number;
  /** Messages counted. A page can arrive longer than the remaining allowance. */
  messagesRead: number;
  /** Messages the pages actually contained, counted or not. */
  messagesReceived: number;
  messageTypes: Record<string, number>;
  roles: Record<string, number>;
  summaries: number;
  summariesWithStats: number;
  /**
   * Rows that carried a compaction-stats record but that this check does not
   * recognise as a compaction summary — an unknown message type, or a known
   * type that is not a summary. Counted as what they are and never added to
   * `summaries`: carrying stats does not make a row a summary.
   */
  otherRowsWithCompactionStats: number;
  /** Stat field names seen on any stat-bearing row, summary or not; closed allowlist. */
  compactionStatFields: Record<string, number>;
  unknownCompactionStatFields: number;
  contextFields: string[];
  contextSource: "agent.message_ids" | "conversation.retrieve" | "unrecognised" | "not-reported";
  /** How many ids the active-context window held, not the ids. */
  sourceWindowIds: number | null;
  /** The chat's own record could not be read, so its context is unknown here. */
  contextFailure: string | null;
  scan: "whole-chat" | "stopped-at-limit" | "cancelled" | "failed";
  stoppedBecause: string | null;
  failure: string | null;
};
export type BackupCaptureDiagnostic = {
  version: 1;
  backend: "cloud" | "local" | "remote" | "unknown";
  startedAt: string;
  elapsedMs: number;
  limits: BackupCaptureDiagnosticLimits;
  /** Chats the listing named within the pages this check read, not the chats that exist. */
  chatsReported: number;
  chatsScanned: number;
  messagesRead: number;
  /** Messages the pages contained, counted or not. */
  messagesReceived: number;
  /** Bytes of every answer this check received: listing, chat records and messages. */
  jsonBytesRead: number;
  summaries: number;
  summariesWithStats: number;
  chatsWithSourceWindow: number;
  /** A limit was reached: the report describes the range scanned, not the whole history. */
  bounded: boolean;
  /** The listing itself stopped at a limit, so how many chats exist is unknown. */
  listingBounded: boolean;
  /**
   * Reads this check stopped waiting for. On a connection whose reads accept no
   * cancellation, such a read may still have been running afterwards.
   */
  abandonedReads: number;
  cancelled: boolean;
  chats: BackupChatDiagnostic[];
  findings: string[];
};
export type BackupRestorePart = { path: string; kind: string };
export type BackupUnrestoredPart = { path: string; reason: string };
/** "translated-native": a Cloud backup converted into openable local chats (not its exact Cloud context). */
export type BackupContextCoverage = "archive-only" | "cloud-main-only" | "native-all-conversations" | "translated-native";
/** What converting a Cloud backup into local chats will carry, computed from that backup. */
export type BackupConversionSummary = {
  /** Picture parts in user messages, and whether they're shown as placeholders (a chosen degraded restore). */
  pictures: { policy: "block" | "placeholder"; parts: number; inWindow: number; chats: number; windowChats: number; captured: number; omitted: number; unknown: number; placeholders: number };
  unansweredCalls: number;
  unansweredCallsPolicy: "block" | "annotate";
  closedWindowCalls: number;
  windowCallsPolicy: "block" | "close";
  fallbacks: boolean;
  pendingWindowCalls: Array<{ chatId: string; title: string; calls: number }>;
  incompleteWindows: Array<{ chatId: string; title: string; missing: number }>;
  excludedChats: Array<{ chatId: string; title: string; missing: number; messages: number }>;
  activeContext: "source-window-carried" | "source-window-carried-qualified";
  qualifications: string[];
  reorderedResults: number;
  reorderedWindows: number;
  chats: number; messages: number; historyParts: number; bytes: number;
  transcript: "complete" | "partial";
  unconvertedTotal: number;
  unconvertedByReason: Array<{ reason: string; count: number }>;
  unconvertedByChat: Array<{ chat: string; count: number }>;
  examples: Array<{ chat: string; messageType: string; reason: string }>;
  synthesized: string[];
  notes: string[];
  blocked: string[];
};
export type RecoveryIdentity = { connection: string; agentId: string };
export type RecoveryReceipt = {
  id: string; verified: true; source: RecoveryIdentity; target: RecoveryIdentity;
  snapshotIdentity: string; sourceFingerprint: string; targetFingerprint: string;
  targetDataMark: string; capabilities: string[]; version: 1; createdAt: string;
  storeId: string; snapshotId: string; sourceConnectionIdentity: string | null; targetConnectionIdentity: string;
  contextCoverage: BackupContextCoverage; omissions: string[]; unrestoredParts: BackupUnrestoredPart[];
  artifacts: Array<{ path: string; hash: string; size: number }>;
};
export type RecoveryHandover = {
  version: 1; id: string; token: string; expiresAt: number;
  receipt: Pick<RecoveryReceipt, "id" | "verified" | "source" | "target" | "snapshotIdentity" | "sourceFingerprint" | "targetFingerprint" | "targetDataMark" | "capabilities">;
  approvedCapabilities: string[]; state: "preview" | "running" | "blocked" | "active" | "rolling-back" | "rolled-back";
  direction: "forward" | "rollback"; blockers: string[];
  steps: Array<{ action: "fence-source" | "configure-target" | "select-target" | "enable-target" | "fence-target" | "restore-source"; operationId: string; outcome: "intent" | "applied" | "unknown" | "not-applied" }>;
};
/**
 * A restored copy this computer holds a receipt for, so it can be opened again from
 * the backups screen after the restore panel has closed. `handoverId` names a
 * handover of it that stopped partway, if there is one.
 */
export type RecoveryCopy = { receiptId: string; createdAt: string; sourceAgentId: string; targetAgentId: string; snapshotId: string; handoverId: string | null; handoverState: string | null };
export type ManualRecoveryPreview = { token: string; receiptId: string; destinationAgentId: string; contextCoverage: BackupContextCoverage; omissions: string[]; unrestoredParts: BackupUnrestoredPart[]; warning: string };
export type BackupGitAncestry = "restored" | "unavailable" | "inert";
export type BackupRestorePlan = {
  token: string;
  contextCoverage: BackupContextCoverage;
  /** Planned ancestry outcome, conditional on successful restore and verification. */
  gitAncestry: BackupGitAncestry;
  storeId: string;
  sourceAgentId: string;
  snapshotId: string;
  snapshotIdentity: string;
  supportedParts: BackupRestorePart[];
  unrestoredParts: BackupUnrestoredPart[];
  omissions: string[];
  warnings: string[];
  blockers: string[];
  guarantees: string[];
  /** Present when the restore converts Cloud chats into local ones. */
  conversion?: BackupConversionSummary;
};
export type BackupRestoreResult = {
  ok: boolean;
  destinationAgentId?: string;
  /** The protection keeping the snapshot out of cleanup while the copy depends on it. */
  pinId?: string;
  /** Creating the copy was attempted but its outcome isn't known: a copy may exist. */
  allocationUnknown?: true;
  sourceUntouched: true;
  activeContextRehydrated: boolean;
  contextCoverage: BackupContextCoverage;
  /** Actual ancestry outcome, not inferred from recovered artifact kinds. */
  gitAncestry: BackupGitAncestry;
  receiptId?: string;
  restoredParts: BackupRestorePart[];
  unrestoredParts: BackupUnrestoredPart[];
  mappings: Array<{ kind: "agent" | "conversation" | "message" | "repository"; originalId: string; destinationId: string; originalName?: string; destinationName?: string; permissions?: "read" | "read_write" }>;
  error?: string;
};
/** Choosing a folder: a new store shows its recovery code once; an existing one may need the code typed in. */
export type BackupFolderResult = { folder: string; recoveryCode: string | null; needsRecoveryCode: boolean } | null;

/** Hearthside: a new agent; a companion also brings its prompt preset and memory files. */
export type CreateAgentInput = {
  name: string;
  model?: string;
  /** Full custom Companion base or advanced override. Omitted for Letta's managed default. */
  systemPrompt?: string;
  /** Letta owns placement, headers and indexing for core memory seeds. */
  coreMemory?: Array<{ label: string; value: string; description?: string }>;
  memory?: Array<{ path: string; content: string }>;
};

/** Hearthside: a downloaded update and what's new in it (plain text). */
export type ReadyUpdate = { version: string; notes: string | null };

/** Hearthside: the result of checking for an update by hand. */
export type UpdateCheck =
  | { status: "not-installed" }
  | { status: "up-to-date"; version: string }
  | { status: "downloading"; version: string }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

export type AppEvent =
  | { type: "conversation.execution"; state: ConversationExecutionState }
  /** Explicitly detached after verified idle; never triggers automatic queued sends. */
  | { type: "turn.detached"; conversationId: string }
  | { type: "connection"; state: ConnectionState }
  | { type: "turn.started"; conversationId: string }
  | { type: "turn.rows"; conversationId: string; rows: ChatRow[] }
  | { type: "turn.rows.removed"; conversationId: string; keys: string[] }
  | { type: "turn.activity"; conversationId: string; activity: string | null; phase?: TurnActivityPhase; detail?: string }
  | { type: "conversation.move"; state: ConversationMoveState }
  | { type: "turn.finished"; conversationId: string; error?: string }
  /** Hearthside: tools still running after the reply finished (0 = all done). */
  | { type: "turn.background"; conversationId: string; tools: number }
  /** Hearthside: a history import's progress (Letta Cloud uploads file by file). */
  | { type: "history.progress"; done: number; total: number }
  /** Hearthside: a picture or chat background changed. */
  | { type: "looks.changed"; looks: Looks }
  /** Hearthside: the helpers of a chat changed (the side panel follows). */
  | { type: "helpers.changed"; conversationId: string; helpers: ChatHelper[] }
  /** Hearthside: where a restore preview or restore has got to. */
  | { type: "recovery.progress"; phase: "preview" | "restore"; step: "check" | "memory" | "carry" | "save" | "verify"; done?: number; total?: number; what?: string }
  /** Hearthside: a backup's progress. */
  | { type: "backup.progress"; agentId: string; done: number; total: number; what: string }
  | { type: "approval.requested"; conversationId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; conversationId: string; requestId: string }
  | { type: "conversation.updated"; conversation: ConversationSummary }
  /** Hearthside: an agent changed outside a request the window made (a waiting companion was given a model). */
  | { type: "agent.updated"; agent: AgentSummary }
  | { type: "menu"; command: "new-chat" | "settings" }
  // Hearthside: subscription sign-in for model providers (ChatGPT, Claude, Copilot, Grok…).
  // Hearthside: the agent's memory changed (the runtime's memory_updated push).
  | { type: "memory.updated"; paths: string[] }
  // Hearthside: a new version has downloaded and is ready to install.
  | { type: "update.ready"; version: string; notes: string | null }
  // Hearthside: a notification was clicked; show this chat.
  | { type: "open.chat"; conversationId: string; agentId: string }
  // Hearthside: token usage reported during a turn.
  | { type: "turn.usage"; conversationId: string; usage: ChatUsage }
  // Hearthside: settings changed in the main process (e.g. a Letta sign-in expired).
  | { type: "settings.updated"; settings: AppSettings }
  // Hearthside: whether this computer is reachable from Letta Cloud right now.
  | { type: "computer.status"; status: ComputerStatusInfo }
  // Hearthside: the channel service (Telegram/Discord gateway) changed state.
  | { type: "channels.service"; status: ChannelServiceStatus }
  | { type: "signin.update"; sessionId: string; state: ProviderSignInState }
  | { type: "signin.finished"; sessionId: string; ok: boolean; error?: string }
  // Hearthside: progress through installing Codex or signing it in to ChatGPT.
  | { type: "imagesetup.update"; sessionId: string; state: ImageSetupState }
  | { type: "imagesetup.finished"; sessionId: string; ok: boolean; error?: string };

/** Hearthside: this computer as Letta Cloud sees it (the background listener). */
export type ComputerStatusInfo = { state: "off" | "starting" | "connected" | "working" | "reconnecting" | "error"; name: string | null; error?: string };

/**
 * Hearthside: the Telegram/Discord channel service on this computer. "running"
 * means the service process is up, not that a bot is connected. "blocked": its
 * last run left an ownership lease that can't be reclaimed by itself.
 */
export type ChannelServiceStatus = {
  state: "off" | "starting" | "running" | "failed" | "blocked";
  /** Why it is failed or blocked, in words safe to show. */
  reason?: string;
  /** When the next automatic start is due (ms since epoch), if one is scheduled. */
  nextRetryAt?: number | null;
  /** Grows with every change; a view ignores an older snapshot or event. */
  revision: number;
  /** A lease recovery the service performed by itself at this start. */
  recovered?: string | null;
};

/** What a running provider sign-in currently needs from the person. */
export type ProviderSignInState = {
  providerId: string;
  /** Page to open in the browser, when the provider gave one. */
  url: string | null;
  /** One-time code to enter on that page (device-code sign-in). */
  code: string | null;
  /** The runtime is asking a question that needs a typed answer. */
  prompt: string | null;
  /** Recent plain-text output, for context. */
  lines: string[];
};

/** Renderer -> main requests. Every method is an `ipcRenderer.invoke` round trip. */
export type AppRequests = {
  listExecutionComputers(): ExecutionComputer[];
  getConversationExecution(conversationId: string): ConversationExecutionState;
  /** Hearthside: the companion a chat belongs to, when the app knows it; null when it doesn't. */
  getConversationAgent(conversationId: string): string | null;
  setConversationExecution(conversationId: string, target: ConversationExecutionTarget): ConversationExecutionState;
  /** Places this conversation could be moved to, each with its own refusal. */
  listExecutionPlaces(conversationId: string): ExecutionPlace[];
  /**
   * Choose where this conversation runs, through the one picker.
   *
   * What that means is decided against fresh, authoritative execution status,
   * not against what the picker was showing. A verified live owner is asked to
   * hand the conversation over (`kind: "moved"`; resolving means the request was
   * accepted, not that the conversation moved — read `phase` on the result and
   * on subsequent `conversation.move` events). A conversation nobody owns gets
   * its next destination recorded instead (`kind: "destination"`), with no move
   * requested. Unknown, stale or conflicting ownership rejects.
   */
  moveConversation(conversationId: string, placeId: string): ConversationDestinationOutcome;
  getFollowups(agentId: string, conversationId: string): FollowupView;
  saveFollowupPolicy(agentId: string, conversationId: string, policy: FollowupPolicy): FollowupView;
  createFollowup(agentId: string, conversationId: string, input: FollowupCreate): Followup;
  updateFollowup(agentId: string, conversationId: string, id: string, revision: number, patch: Partial<FollowupCreate>): Followup;
  changeFollowup(agentId: string, conversationId: string, id: string, revision: number, action: "adopt" | "defer" | "resolve" | "cancel", notBefore?: string): Followup;
  scanFollowups(agentId: string, conversationId: string): { scanned: number; proposed: number };
  getSettings(): AppSettings;
  getChatPreferences(agentId: string, connectionRevision: string): ChatPreferencesView;
  setChatPreference(agentId: string, conversationId: string, scope: string, patch: ChatPreferencePatch): ChatPreferencesView;
  updateSettings(update: SettingsUpdate): AppSettings;
  getConnection(): ConnectionState;
  reconnect(): ConnectionState;
  listAgents(): AgentSummary[];
  createAgent(input: CreateAgentInput): AgentSummary;
  getAgent(agentId: string): AgentDetails;
  restoreCompanionPrompt(agentId: string, expectedSystem: string, expectedReplacement: string, confirmed: true): { backupPath: string; mode: "companion-custom" };
  updateAgent(agentId: string, update: AgentUpdate): AgentSummary;
  deleteAgent(agentId: string): void;
  listModels(refresh?: boolean): ModelOption[];
  listProviders(): ProviderSummary[];
  connectProvider(input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }): ProviderSummary[];
  disconnectProvider(input: { providerId: string; providerName?: string }): ProviderSummary[];
  /** Hearthside: the ChatGPT plan's own usage windows, resets and kept readings. */
  getGptUsage(refresh?: boolean): GptUsageView;
  /** Hearthside: spend one manual usage reset. Only ever from a confirmed press. */
  useGptReset(input: GptResetRequest): GptResetOutcome;
  listMemory(agentId: string): MemoryOverview;
  readMemoryFile(agentId: string, path: string): string;
  /** `expected`: the file as the editor loaded it. The save is refused if the file has changed since. */
  /** A string is the loaded text (including an empty file); null requires a new path. */
  writeMemoryFile(agentId: string, path: string, content: string, expected?: string | null): void;
  deleteMemoryFile(agentId: string, path: string): void;
  listMemoryHistory(agentId: string, path: string): MemoryCommit[];
  readMemoryFileAt(agentId: string, path: string, sha: string): string;
  /** Hearthside: recent commits across all memory files (for the activity heatmap). */
  listMemoryActivity(agentId: string, limit: number): MemoryCommit[];
  /** Hearthside: the unified diff of one memory commit. */
  readMemoryCommitDiff(agentId: string, sha: string): string;
  listConversations(agentId: string): ConversationSummary[];
  /** Latest meaningful message for at most five conversations owned by this companion. */
  listConversationPreviews(agentId: string, conversationIds: string[]): ConversationPreview[];
  loadHistory(conversationId: string, limit: number, options?: HistoryPageOptions): HistoryResult;
  /** Hearthside: id and time of the chat's newest message, to notice messages that arrived from elsewhere. */
  latestMessageMark(conversationId: string): string | null;
  renameConversation(conversationId: string, title: string): ConversationSummary;
  archiveConversation(conversationId: string): void;
  /** Hearthside: archived chats for an agent, and restoring one. */
  listArchivedConversations(agentId: string): ConversationSummary[];
  restoreConversation(conversationId: string): ConversationSummary;
  sendMessage(input: SendMessageInput): SendMessageResult;
  stopTurn(conversationId: string): void;
  /** Hearthside: which of these programs are installed on the computer running the agent. */
  checkPrograms(names: string[]): Record<string, boolean>;
  /** Hearthside: browse the working folder (paths relative to root). */
  listDirectory(root: string, path: string): { folders: string[]; files: string[] };
  readWorkingFile(root: string, path: string): string;
  /** Hearthside: connectors (MCP servers) for this agent: this computer's plus, on Cloud, the Letta account's. */
  listConnectors(agentId: string): { connectors: Connector[]; lettaError: string | null };
  saveConnector(input: ConnectorInput): Connector;
  removeConnector(id: string): void;
  /** Turn a connector on or off for these agents (this computer's connectors). */
  setConnectorAgents(id: string, agentIds: string[]): void;
  /** Attach or detach a Letta account tool for an agent (Cloud). */
  setLettaToolAttached(agentId: string, toolId: string, attached: boolean, discoveryId: string): void;
  /** Connect once and list its tools. */
  testConnector(id: string): ConnectorTool[];
  /** Try a connector before adding it (nothing is saved). */
  testConnectorInput(input: ConnectorInput): ConnectorTool[];
  /** Add connectors from pasted JSON ({"mcpServers": {...}} and similar). Returns the names added. */
  addConnectorsFromJson(json: string, agentIds: string[]): string[];
  /** Sign in to a web connector in the browser (OAuth). */
  signInConnector(id: string): void;
  signOutConnector(id: string): void;
  /** Which of a connector's tools the agent gets. */
  setConnectorTools(id: string, names: string[]): void;
  setConnectorVoice(id: string, voice: ConnectorVoice | null): void;
  setConnectorVoiceModel(id: string, model: string | null): void;
  /** Ask a speech connector for its voices. */
  listConnectorVoices(id: string): ConnectorVoice[];
  listConnectorImports(): ConnectorImport[];
  importConnectors(picks: Array<{ from: string; name: string }>, agentIds: string[]): number;
  /** Hearthside: the built-in calendar between two moments (epoch ms). */
  listCalendar(fromMs: number, toMs: number): CalendarOccurrence[];
  /** Access-checked next calendar occurrence for one companion's Presence view. */
  getPresenceCalendar(agentId: string, fromMs: number, toMs: number): PresenceCalendarSummary;
  saveCalendarEvent(input: CalendarEventInput): CalendarEvent;
  deleteCalendarEvent(id: string): void;
  listCalendarSubscriptions(): CalendarSubscription[];
  addCalendarSubscription(name: string, url: string): CalendarSubscription;
  removeCalendarSubscription(id: string): void;
  refreshCalendarSubscription(id: string): void;
  /** Agents allowed to use the calendar. */
  calendarAccess(): string[];
  setCalendarAccess(agentId: string, on: boolean): string[];
  /** Hearthside: whether Codex and Grok are installed and signed in. */
  imageEngineStatus(): ImageEngineStatus;
  /** Hearthside: the image connection cards, with the sign-in Codex itself reports. */
  imageConnectStatus(): ImageConnectStatus;
  /** Hearthside: install Codex for this user, or run its own ChatGPT sign-in. Never makes an image. */
  startImageSetup(step: ImageSetupStep, mode?: ImageSetupMode): { sessionId: string };
  /** Hearthside: stop the setup this app started. Never signs anyone out. */
  cancelImageSetup(sessionId: string): void;
  /** Hearthside: an image an agent made, as a data: URL. */
  readImageFile(path: string): string;
  /** Hearthside: an audio file an agent made, as a data: URL for the player. */
  readAudioFile(path: string): string;
  /** Hearthside: GIFs for the picker (trending when the search is empty). */
  listGifs(query: string): GifResult[];
  /** The bytes of a KLIPY GIF (base64), so the window can show its frames to the agent. */
  fetchGif(url: string): string;
  /** Show an agent-made audio file in Explorer/Finder. */
  revealAudioFile(path: string): void;
  listSecretNames(agentId: string): string[];
  setSecret(agentId: string, name: string, value: string): string[];
  removeSecret(agentId: string, name: string): string[];
  getDiagnostics(): Diagnostics;
  /** Hearthside: whether this computer is reachable from Letta Cloud right now. */
  getComputerStatus(): ComputerStatusInfo;
  /** Hearthside: the channel service's current state (snapshot; changes arrive as channels.service events). */
  getChannelServiceStatus(): ChannelServiceStatus;
  /** Hearthside: a person's answer to a blocked or stopped channel service: move a lease nothing owns aside and start again. */
  recoverChannelService(): ChannelServiceStatus;
  openLogFolder(): void;
  /** Hearthside: open a file an agent linked to in a reply (a sandbox-download link or a path), when it's on this computer. */
  openFileLink(href: string, cwd: string | null, conversationId?: string | null): { opened: boolean; path: string; message: string | null };
  /** Hearthside: a reply's "Open computer" (#letta-computer): the chat's Cloud sandbox desktop, in the browser. */
  openLettaComputer(conversationId: string): void;
  /** Hearthside: switch to (true) or from your existing ~/.letta, backing it up first. Returns the backup folder, if one was made. */
  setUseRealLettaHome(value: boolean): { backup: string | null };
  /** Hearthside: a new chat that continues from this one's history. */
  forkConversation(conversationId: string): ConversationSummary;
  /** Hearthside: save a chat as Markdown (asks where). Returns the file path, or null if cancelled. */
  exportConversation(conversationId: string): string | null;
  searchMessages(agentId: string, query: string): MessageSearchResult[];
  listChannels(): ChannelInfo[];
  /**
   * Hearthside: the channel's bots as they look to one companion. Each says
   * whose it is; `agentId` is the companion asking, not a filter the main
   * process trusts for changes — every mutation re-checks the owner.
   */
  listChannelAccounts(channelId: string, agentId: string): ChannelAccount[];
  setupChannel(input: { channelId: string; agentId: string; name: string; access: ChannelAccess; config: Record<string, unknown>; companionParticipation?: { version: 1; ambient: boolean; mentions: boolean } }): ChannelAccount;
  /** Hearthside: change who may message a bot, and the allowed list (sender ids). */
  setChannelAccess(channelId: string, accountId: string, access: ChannelAccess, allowedUsers: string[], agentId: string): ChannelAccount;
  setDiscordCompanionParticipation(accountId: string, policy: { version: 1; ambient: boolean; mentions: boolean }, agentId: string): ChannelAccount;
  /** Hearthside: turn a Discord bot off (or back on) in one server channel. */
  setDiscordChannelListening(accountId: string, chatId: string, on: boolean, agentId: string): void;
  /** Hearthside: the Discord server channels a bot has been turned off in. */
  listMutedChannels(accountId: string, agentId: string): MutedChannel[];
  /** Hearthside: where a Discord bot's server messages go; re-points existing channels. */
  setChannelChatMode(accountId: string, mode: ChannelChatMode, agentId: string): void;
  /** Hearthside: take on a bot that isn't assigned to a companion yet. */
  claimChannelBot(channelId: string, accountId: string, agentId: string): ChannelAccount;
  /** Hearthside: what moving a bot to another companion would do; ask before doing it. */
  previewChannelBotReassign(channelId: string, accountId: string, toAgentId: string): ChannelBotReassign;
  /**
   * Hearthside: move a bot to another companion, taking its existing chats with
   * it. `fromAgentId` and `connection` are what the preview showed; the move is
   * refused if either has changed, so a confirmation is always about the bot the
   * person was actually looking at.
   */
  reassignChannelBot(input: { channelId: string; accountId: string; fromAgentId: string; toAgentId: string; connection: string }): ChannelAccount;
  /**
   * Hearthside: a move that didn't finish, put right. "finish" completes it for
   * the new companion; "undo" puts the bot back with the old one. Either way the
   * bot stays switched off until someone starts it again.
   */
  resumeChannelBotMove(channelId: string, accountId: string, action: "finish" | "undo"): ChannelAccount;
  /** Hearthside: hide a pairing request (it also expires on its own). */
  declinePairing(code: string): void;
  setChannelAccountRunning(channelId: string, accountId: string, running: boolean, agentId: string): ChannelAccount;
  removeChannelAccount(channelId: string, accountId: string, agentId: string): void;
  /** Hearthside: people waiting to be approved on this companion's bots only. */
  listPairings(channelId: string, agentId: string): ChannelPairing[];
  /**
   * Hearthside: `agentId` is the companion approving; the chat is bound to the
   * BOT'S owner, so approving from the wrong page can't move a bot. The code
   * must still be waiting on that same bot, or the approval is refused.
   */
  approvePairing(input: { channelId: string; accountId: string; code: string; agentId: string }): void;
  listChannelRoutes(agentId: string): ChannelRoute[];
  removeChannelRoute(channelId: string, accountId: string, chatId: string, agentId: string): void;
  listSchedules(agentId: string): Schedule[];
  addSchedule(input: ScheduleInput): Schedule;
  updateSchedule(id: string, input: Partial<ScheduleInput>): Schedule;
  setSchedulePaused(id: string, paused: boolean): void;
  runScheduleNow(id: string): void;
  deleteSchedule(id: string): void;
  listScheduleRuns(id: string): ScheduleRun[];
  listSkills(agentId: string): InstalledSkill[];
  listSkillCatalog(): CatalogSkill[];
  installSkill(input: { source?: SkillSource; url?: string; target: SkillTarget; agentId: string }): { name: string };
  removeSkill(input: { agentId: string; skill: InstalledSkill }): void;
  /** Hearthside: the downloaded update, if one is ready, with its release notes. */
  getUpdateReady(): ReadyUpdate | null;
  /** Hearthside: restart into the downloaded update. */
  installUpdate(): void;
  /** Hearthside: check for an update now ("Check for updates" in Settings). */
  checkForUpdates(): UpdateCheck;
  /** Hearthside: the app's version. */
  getAppVersion(): string;
  getToolset(agentId: string): ToolsetInfo;
  setToolset(agentId: string, preference: ToolsetPreference): ToolsetInfo;
  /** Hearthside: run a runtime slash command (doctor, dream, compact, init, reload) in a chat. */
  runCommand(conversationId: string, command: RuntimeCommand, args: string): CommandRunResult;
  /**
   * Hearthside: mods. The folders the runtime actually reads, what is in them,
   * and what it advertises as loaded. Reads files; never runs them.
   */
  getModsOverview(agentId: string | null): ModsOverview;
  /** One mod file as text, read and never executed. */
  readModSource(input: { scope: ModScope; agentId: string | null; name: string }): ModSourceView;
  /** Pick a mod file and preview it. Nothing is written yet. */
  chooseModFile(): ModImportPreview | null;
  /** Copy the previewed file into the runtime's mods folder. Never overwrites. */
  confirmModImport(token: string): ModImportResult;
  /** Turn mods off (or on) for every runtime Hearthside starts; restarts the runtime. */
  setModsOff(off: boolean): ModsOffState;
  /** The runtime's own `/reload`, for this chat's scope. Needs the chat to be idle. */
  reloadMods(conversationId: string): CommandRunResult;
  /** Hearthside: this companion's read-only history parts, oldest first. */
  listHistory(agentId: string): ConversationSummary[];
  /** Slash commands this chat can run: Hearthside's built-ins plus the runtime's mod commands. */
  listChatCommands(conversationId: string): ChatCommandCatalog;
  /** Run a discovered mod command. Refused unless the runtime advertises it for this chat. */
  runChatCommand(conversationId: string, commandId: string, args: string): CommandRunResult;
  /** Hearthside: set (or, with null, clear) a chat's own context window limit. */
  setConversationContextWindow(conversationId: string, limit: number | null): ConversationSummary;
  respondApproval(conversationId: string, requestId: string, decision: ApprovalDecision): void;
  selectDirectory(): string | null;
  /** Hearthside: pick a ChatGPT/Claude export for an agent and preview it (null if cancelled). */
  chooseHistoryImport(agentId: string): HistoryImportPreview | null;
  /** Hearthside: write a previewed import into the agent's memory, in one save. */
  runHistoryImport(token: string, options: { personName?: string; includeArchived?: boolean }): HistoryImportResult;
  /** Hearthside: start a subscription sign-in for an OAuth model provider (local backend). */
  startProviderSignIn(providerId: string): { sessionId: string };
  /** Answer a question the sign-in asked (a pasted code, a URL, or blank for the default). */
  answerProviderSignIn(sessionId: string, text: string): void;
  cancelProviderSignIn(sessionId: string): void;
  /** Hearthside: browser sign-in to Letta Cloud. Resolves when finished or cancelled. */
  signInWithLetta(): AppSettings;
  cancelLettaSignIn(): void;
  signOutOfLetta(): AppSettings;
  getDreamSettings(agentId: string): DreamSettings;
  setDreamSettings(agentId: string, settings: DreamSettings): DreamSettings;
  /** Hearthside: every picture and chat background ("make it yours"). */
  getLooks(): Looks;
  /** Set a picture for an agent or the person (target "me"), or an agent's background picture, from a data URL the window resized. */
  setLookImage(target: string, kind: "avatar" | "background", dataUrl: string): Looks;
  clearLookImage(target: string, kind: "avatar" | "background"): Looks;
  /** The theme colour (or none) and how much the background picture is blurred. */
  setLookStyle(agentId: string, style: LookStyle): Looks;
  /** Hearthside: the helpers sent off in a chat (running and previous). */
  listChatHelpers(conversationId: string): ChatHelper[];
  /** Hearthside: backups. */
  getBackupSettings(): BackupSettingsInfo;
  /** Pick the backup folder (a new store there, or an existing one). */
  chooseBackupFolder(): BackupFolderResult;
  /** Unlock an existing backup folder with its recovery code. */
  unlockBackupFolder(recoveryCode: string): BackupSettingsInfo;
  /** Hearthside: replace a lost recovery code (this computer keeps the key). */
  newBackupRecoveryCode(): { recoveryCode: string };
  updateBackupSettings(update: { includePictures?: boolean; daily?: boolean; dailyAt?: string; keepDays?: number }): BackupSettingsInfo;
  /** Hearthside: `full` re-reads every message; otherwise the routine incremental run (a full one is taken weekly anyway). */
  backUpNow(agentId: string, full?: boolean): BackupSnapshotInfo;
  listBackups(agentId: string): BackupSnapshotInfo[];
  listBackupCompanions(): Array<{ agentId: string; agentName: string; snapshots: number; latest: string }>;
  verifyBackup(agentId: string, snapshotId: string): BackupVerification;
  /**
   * Read-only, metadata-only: count what the connection reports for this
   * companion. Bounded in chats, pages, messages, bytes and time; stoppable
   * with `cancelCaptureDiagnostic`. Nothing is written, sent or scheduled.
   */
  runCaptureDiagnostic(agentId: string): BackupCaptureDiagnostic;
  cancelCaptureDiagnostic(): { cancelled: boolean };
  previewBackupRestore(agentId: string, snapshotId: string, options?: { pictures?: "block" | "placeholder"; unansweredCalls?: "block" | "annotate"; windowCalls?: "block" | "close"; excludeChats?: string[]; fallbacks?: boolean }): BackupRestorePlan;
  restoreBackupCopy(token: string): BackupRestoreResult;
  getRecoveryReceipt(id: string): RecoveryReceipt;
  /** Restored copies with a receipt on this computer, newest first. Reads only. */
  listRecoveryCopies(): RecoveryCopy[];
  previewRecoveryHandover(receiptId: string): RecoveryHandover;
  confirmRecoveryHandover(token: string, capabilities: string[]): RecoveryHandover;
  rollbackRecoveryHandover(id: string): RecoveryHandover;
  getRecoveryHandover(id: string): RecoveryHandover;
  previewManualRecoveryCopy(receiptId: string): ManualRecoveryPreview;
  confirmManualRecoveryCopy(token: string): { receiptId: string; destinationAgentId: string; manualOnly: true; exclusiveMigration: false };
};

export type AppBridge = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => Promise<ReturnType<AppRequests[K]>>;
} & {
  onEvent(listener: (event: AppEvent) => void): () => void;
  platform: string;
};

/** Hearthside: a connector (MCP server). "computer" ones run from Hearthside; "letta" ones live on the Letta account. */
export type Connector = {
  id: string;
  name: string;
  where: "computer" | "letta";
  kind: "command" | "url";
  command: string;
  args: string[];
  url: string;
  /** Names only; the values never leave the main process. */
  envKeys: string[];
  headerKeys: string[];
  agentIds: string[];
  tools: ConnectorTool[];
  /** Cloud discovery evidence; absent for local connectors. Empty catalogs cannot prove attachment is off. */
  cloudDiscovery?: {
    /** Opaque proof binding mutations to this account and discovery result. */
    discoveryId: string;
    catalog: "success" | "unavailable";
    attachment: "on" | "off" | "partial" | "unknown";
    error: string | null;
  };
  /** A built-in preset it came from, e.g. "elevenlabs". */
  preset: string | null;
  /** Signed in through the browser (web connectors). */
  signedIn: boolean;
  /** Tools given to the agent; null until it has connected once. */
  enabledTools: string[] | null;
  /** Voice used when the agent doesn't pick one (speech tools). */
  defaultVoice: ConnectorVoice | null;
  /** Speech model for voice messages (ElevenLabs), null for the default. */
  voiceModel: string | null;
};
/** tokens: rough size it adds to every message (0 when unknown). */
export type ConnectorTool = { id: string; name: string; description: string; enabled: boolean | null; tokens: number; group: string };
export type ConnectorVoice = { id: string; name: string };
export type ConnectorInput = {
  id?: string;
  name: string;
  kind: "command" | "url";
  commandLine?: string;
  url?: string;
  /** Web connectors: Streamable HTTP (default) or SSE. */
  transport?: "http" | "sse";
  /** KEY=value lines. Undefined keeps the saved ones. */
  envText?: string;
  headersText?: string;
  agentIds: string[];
  preset?: string;
};
export type ConnectorImport = { from: string; name: string; kind: "command" | "url"; summary: string; already: boolean };
