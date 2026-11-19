// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { randomUUID } from "node:crypto";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRuntimeHome } from "../runtime/paths";
import { restoreCompanionPrompt as repairCompanionPrompt } from "./prompt-repair";
import { assertRecoveryAdmission, assertRecoveryAutomationAdmission, isManualOnlyRecovery } from "./backup/fences";
import { BackupSourceError, backupSourceFailure } from "./backup/diagnostics";
import { cloudBackupMessages } from "./backup/cloud-messages";
export { fenceAgentForRecovery, unfenceAgentForRecovery, isAgentRecoveryFenced, allowManualRecovery, isManualOnlyRecovery } from "./backup/fences";
import {
  LettaAgentClient,
  createTranscriptAccumulator,
  type AnyAgentTool,
  type CanUseToolResponse,
  type LettaAgent,
  type LettaCodeSession,
  type LettaConversation,
  type SDKMessage,
  type SendMessage,
  type TranscriptAccumulator,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";
import { REASONING_EFFORTS } from "@hearthside/ipc-contract";
import type {
  AgentDetails,
  ModelOption,
  AgentSummary,
  AgentUpdate,
  CreateAgentInput,
  AppEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatCommandCatalog,
  ChatRow,
  ChatUsage,
  CommandRunResult,
  ConnectionState,
  RuntimeCommand,
  ConversationPreview,
  ConversationSummary,
  HistoryVolume,
  ConversationDestinationOutcome,
  ConversationExecutionTarget,
  ConversationExecutionState,
  ConversationMoveState,
  ExecutionPlace,
  HistoryResult,
  ReasoningEffort,
  SendMessageInput,
  SendMessageResult,
  PermissionMode,
  TurnActivityPhase,
} from "@hearthside/ipc-contract";
import WebSocket from "ws";
import type { RuntimeEndpoint } from "../runtime/runtime-manager";
import { currentLettaAccessToken, onLettaAccessToken } from "./letta-signin";
import { type OwnedServer, startOwnedServer, runtimeStoppedStrict } from "./owned-server";
import { controlGeneration, deviceStatus, observeControlFrames, request, runtimeIdle, serverBackend, setControlTarget, withControlClient } from "./control.js";
import { observeRuntimeIdle } from "./runtime-idle";
import type { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import { readAdvertisedCommands } from "./mods/catalog";
import { commandInputLine } from "./mods/command-lifecycle";
import { type CommandScope, CommandUncertain, clearQuarantineForNewRuntime, clearQuarantineOnEnd, commandSlotKey, commandsInFlight, releaseCommandSlots, runGuardedCommand } from "./mods/command-run";
import { type CommandRunHandle, type ObserverClient, runModCommand } from "./mods/command-observer";
import { forgetModImport } from "./mods/import";
import { channelServiceStatus, gatewayRequest, setGatewayEventListener, setGatewayTarget } from "./channel-gateway";
import { onGatewayEvent, releaseArchivedChat, setChatModeHelpers } from "./channel-chat-mode";
import { botOwner, reconcileBotOwners } from "./channel-owners";
import { applyChannelPermissionMode } from "./channel-permission";
import { audienceChannelBindings, inventoryChannelAccounts, listChannelRoutes, stopBotsForAgent } from "./channels";
import { HISTORY_TAG } from "./backup/cloud-native";
import { isRecordedHistoryVolume } from "./backup/history-registry";
import { agentsAwaitingModel, channelsUsed, gifCustomerId, lastLocalModel, noteLocalModel, setAwaitingModel } from "./settings";
import {
  type ConnectionConfig,
  type StoredMoveRecord,
  forgetConversation,
  getConnectionConfig,
  getConversationCwd,
  getPermissionMode,
  getSettings,
  rememberCwd,
  setAgentId,
} from "./settings.js";
import { compactionRow, describeError, mergeHistory, projectHistory, toChatRow } from "./transcript.js";
import { applyUsage, effectiveContextWindow } from "./context-usage";
import { listModels } from "./providers";
import { agentDefaultFor, handleForModel, modelToAdopt } from "./model-handles";
import { isHelper } from "./helpers";
import { HelperAwareWebSocket, markHelpersUnobserved } from "./helper-feed";
import { observeRemoteHelpers, helperOwnership } from "./remote-helper-feed";
import { executionClient, executionTarget, listExecutionComputers, prepareRemoteExecution, prepareDesktopListenerExecution } from "./remote-execution";
import { getExecutionState, selectExecution, observeExecution, blockExecution, conversationTarget, markExecutionUnknown, recordDesktopExecution, recordSelectedExecution, acknowledgeExecutionMove, completeExecutionDelivery } from "./conversation-execution";
import { createExecutionObservationDiagnostics } from "./execution-observation-diagnostics";
import { writeLog } from "./log-file";
import { type NativeTeleportReceipt, parseNativeTeleportReceipt, validateNativeTeleportStatus } from "./native-teleport";
import { getMoveRecord, listMoveRecords, moveControls, moveInFlight, moveRevision, moveSettled, moveState, recordObservedMove } from "./teleport-moves";
import { CLOUD_PLACE_ID, THIS_PC_PLACE_ID, type MoveEnvironment, type ResolvedPlace, current, followMove, listPlaces, markAttached, markUnobserved, refusalFromRoutes, startMove } from "./teleport-move";
import { type DestinationApproval, type DestinationAttachment, type DestinationRecovery, attachToDestination } from "./teleport-destination";
import { APP_PLACE_ID, FOLLOW_PLACE_ID, type ChannelHost, appLocalChannelRefusal, boundChannelRoutes, destinationCapability, placeDeviceId, type PlacesDestination } from "./teleport-places";
import { resolveCloudDestination } from "./teleport-cloud";
import { connectedDesktopIdentity } from "./computer-listener";
import { CloudConversationRefusedError, currentDestinationContent, enqueueCurrentDestination, observeEnqueuedTurn } from "./cloud-conversation-queue";
import { messageContent, titleText } from "./attachments";
import { chatToMarkdown } from "./chat-tools";
import { resolvePdfs } from "./pdf";
import { QUESTION_TOOL_NAME, createQuestionTool } from "./question-tool";
import { connectorToolsFor } from "./connectors";
import { listMemory, writeMemoryFile } from "./memory";
import { GIF_TOOL_NAME, createGifTool, gifsAvailable } from "./gifs";
import { WEATHER_TOOL_NAME, createWeatherTool } from "./weather";
import { OBSIDIAN_READ_TOOLS, createObsidianTools } from "./obsidian";
import { createImageTool } from "./image-gen";
import { createAvatarTool } from "./avatar-tool";
import { CALENDAR_FREE_TOOLS, calendarAccess, createCalendarTools, startCalendar } from "./calendar";
import { assertFollowupScope, configureIntentions, createFollowupTools, FOLLOWUP_TOOL_NAMES, followupScope, intentionsConnectionId, intentionsStore, observeFollowupInput, rememberFollowupInput } from "./intentions/service";
import { decodeIntentionsPage, controllerPrompt, markControllerRows } from "./intentions/runtime-boundary";
import { isIntentionsStorageError, reportIntentionsStorageError } from "./intentions/storage-errors";
import { audienceRefusal, conversationAudience } from "./intentions/audience";
import Letta from "@letta-ai/letta-client";
import { BUSY_CHECK_MS, BUSY_ELSEWHERE_ACTIVITY, busyFromStatus, explainTurnError, isHandoffError } from "./busy-elsewhere";
import { rowsToRetire } from "./turn-retry";
import { type CloudLink, setCloudLink } from "./computer-access";
import type { ChatScope, CloudAccess } from "./cloud-sandbox";
import { forgetHelpers, hasRunningHelpers, lastHelperActivity, settleFromSnapshot } from "./helper-feed";
import { subagentSnapshot } from "./control";

/**
 * Everything that talks to Letta: the SDK client, agent and conversation
 * management, and the turns currently streaming.
 */

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (response: CanUseToolResponse) => void;
};

type Turn = {
  conversationId: string;
  session: LettaCodeSession;
  /** Separate Cloud execution client; the desktop client only manages state. */
  executionClient?: LettaAgentClient;
  executionObserver?: NodeJS.Timeout;
  executionConnectionId?: string;
  validateExecutionSource?: (initializedSource?: string) => Promise<void>;
  handoffBlocked?: boolean;
  submissionUnknown?: boolean;
  /** Ephemeral presentation hint for this owned session's resolved SDK submission, not a listener acknowledgement or authority grant. */
  desktopAcceptance?: {
    account: string | undefined;
    agentId: string;
    link: CloudLink;
    server: OwnedServer;
    generation: number;
    connectionId: string;
  };
  nativeTeleportPending?: boolean;
  accumulator: TranscriptAccumulator;
  /** Last version of each row sent to the renderer, for identity diffing. */
  sent: Map<string, TranscriptRow>;


  retired?: string[];
  approvals: Map<string, PendingApproval>;
  activity: string | null;
  flushTimer: NodeJS.Timeout | null;
  stopped: boolean;
  finished: boolean;
  /** Hearthside: usage reported so far in this turn. */
  usage: ChatUsage;
  /** Hearthside: Hearthside tools still running for this turn. */
  pendingTools: number;
  sessionClosed: boolean;
  /** Hearthside: when text pieces arrived, to see whether replies really stream. */
  stream: { startedAt: number; text: number; reasoning: number; first: number | null; last: number | null };
  closeTimer: NodeJS.Timeout | null;
};

/** Retain remote relay observers for helpers that outlive their parent reply. */
const remoteHelperSessions = new Set<Turn>();
const remoteHelperObservers = new Map<string, { owner: string; intent: string; retired: boolean; close: () => void }>();

// Admission bookkeeping changes revision without moving the observed runtime.
// Fence actual destination intent/unsafe ownership changes, not pending input IDs.
function helperObservationIntent(state: ConversationExecutionState): string {
  return JSON.stringify({ selected: state.selected, moveFrom: state.moveFrom,
    desktopConnectionId: state.desktopConnectionId, desktop: state.provenance === "desktop",
    unresolvedOwnership: state.status === "blocked" && !state.pendingDelivery });
}
const remoteHelperEvidence = new Map<string, { scope: string; revision: number }>();

function stopRemoteHelperObserver(chatId: string): void {
  const observer = remoteHelperObservers.get(chatId);
  // Retain observer identity through close: ownership revisions may already differ,
  // but the same account/feed must retire its known running helpers.
  if (observer) observer.retired = true;
  observer?.close();
  remoteHelperObservers.delete(chatId);
}

/** Hearthside: the last known context usage per conversation. */
const usageByConversation = new Map<string, ChatUsage>();
/** Context window per agent, refreshed at the start of each turn. */
const agentContextWindow = new Map<string, number | null>();
// Settings changes invalidate metadata requests already in flight.
const contextRevision = new Map<string, number>();
function reviseContext(id: string): void {
  contextRevision.set(id, (contextRevision.get(id) ?? 0) + 1);
}
function publishUsage(conversationId: string, patch: Partial<ChatUsage>): void {
  const turn = turns.get(conversationId);
  const known = turn?.usage ?? usageByConversation.get(conversationId);
  if (!known) return;
  const usage = { ...known, ...patch };
  if (turn) turn.usage = usage;
  usageByConversation.set(conversationId, usage);
  emit({ type: "turn.usage", conversationId, usage });
}

const ROW_FLUSH_MS = 40;
const STOP_GRACE_MS = 5_000;


const RESULT_GRACE_MS = 5_000;
/** The runtime gives up on a tool after 5 minutes; never hold a session longer than this. */
const BACKGROUND_CAP_MS = 6 * 60_000;
/** Hearthside: a turn with no word from the runtime for this long is given up on (a tester waited an hour). */
const STALL_MS = 10 * 60_000;
const TITLE_MAX_CHARS = 60;

const ACTIVITY: Record<string, string | null> = {
  SENDING_API_REQUEST: "Thinking",
  WAITING_FOR_API_RESPONSE: "Thinking",
  PROCESSING_API_RESPONSE: "Responding",
  RETRYING_API_REQUEST: "Retrying",
  WAITING_ON_APPROVAL: "Waiting for approval",
  EXECUTING_CLIENT_SIDE_TOOL: "Running tool",
  EXECUTING_COMMAND: "Running command",
  WAITING_ON_INPUT: null,
};

let emit: (event: AppEvent) => void = () => {};
let client: LettaAgentClient | null = null;
let server: OwnedServer | null = null;

const LETTA_CLOUD_API_URL = "https://api.letta.com";
let connecting: Promise<LettaAgentClient> | null = null;
let connectionAttempt: AbortController | null = null;
let connection: ConnectionState = { status: "connecting", backend: "local" };

type DestinationTurn = {
  account: string | undefined;
  activity: string;
  observer?: NodeJS.Timeout;
  controller: AbortController;
  acceptanceUnknown?: boolean;
};
const destinationTurns = new Map<string, DestinationTurn>();
const turns = new Map<string, Turn>();
const preparingTurns = new Map<string, AbortController>();
const intentionPreparations = new Set<AbortController>();

function cancelPreparingTurns(): void {
  for (const attempt of preparingTurns.values()) attempt.abort();
  preparingTurns.clear();
}
const conversations = new Map<string, ConversationSummary>();
// An old saved destination is not permission to pull a natively moved chat back.
// Routing consent/provenance lives in account-scoped execution metadata, not
// an in-memory selection consumed by the first send.

export function initRuntime(emitter: (event: AppEvent) => void): void {
  emit = emitter;
  connection = { status: "connecting", backend: getConnectionConfig().backend };
  void ensureClient().catch(() => {
    // The failure is already reflected in the connection state.
  });
}

// --- Connection -------------------------------------------------------------

function setConnection(state: ConnectionState): void {
  // Hearthside: record connection changes (and why) in the log file.
  if (state.status !== connection.status || state.status === "error") {
    console.log(`[hearthside] connection ${state.backend}: ${state.status}${state.status === "error" ? ` (${state.error})` : ""}`);
  }
  connection = state;
  emit({ type: "connection", state });
}

export function getConnection(): ConnectionState {
  return connection;
}




/** SDK client for a token-protected app server Hearthside owns. */
function clientFor(endpoint: RuntimeEndpoint): LettaAgentClient {
  return new LettaAgentClient({
    backend: "remote",
    url: endpoint.url,
    authToken: endpoint.token,
    // Hearthside: helpers' steps are read off the socket for the side panel (see helper-feed.ts).
    WebSocket: HelperAwareWebSocket as never,
  });
}

/**
 * While our server recovers from a crash, running turns end and the
 * connection shows "connecting"; once it listens again the client reattaches.
 */
/** How the channel service reaches this runtime's backend (see channel-gateway.ts). */
/** Hearthside: how the "reachable computer" listener reaches Letta Cloud (null when not on Cloud). */
let cloudLink: CloudLink | null = null;
const executionObservationDiagnostic = createExecutionObservationDiagnostics((line) => writeLog("info", line));
let listenerAccount: string | undefined;
let gatewayBackend: { env?: Record<string, string>; credentials?: { current: () => string; subscribe: (listener: (token: string) => void) => () => void } } = {};

function watchOwnedServer(owned: OwnedServer, config: ConnectionConfig, detail: string, providers: boolean): void {
  const activeRemoteConversationIds = () => [...turns.values()]
    .filter((turn) => turn.executionClient && !turn.finished)
    .map((turn) => turn.conversationId);
  owned.onLost((reason) => {
    if (server !== owned) return;
    cancelPreparingTurns();
    endConnectionLifetimes();
    for (const turn of [...turns.values()]) {
      if (turn.executionClient) continue;
      turn.stopped = false;
      finishTurn(turn, "The Letta runtime restarted. Send your message again.");
    }
    const previous = client;
    client = null;
    setControlTarget(null);
    setGatewayTarget(null, false);
    void previous?.close().catch(() => undefined);
    setConnection({ status: "connecting", backend: config.backend, activeRemoteConversationIds: activeRemoteConversationIds() });
    console.warn(`[hearthside] runtime lost: ${reason}`);
  });
  owned.onRecovered((endpoint) => {
    if (server !== owned) return;
    client = clientFor(endpoint);
    // A fresh runtime process: anything a lost command was still running died
    // with the old one, so no chat on *this* runtime is ambiguous any more.
    // Holds belonging to a server Hearthside doesn't own are left alone.
    clearQuarantineForNewRuntime(runtimeIdentityFor(config));
    setControlTarget({ url: endpoint.url, authToken: endpoint.token });
    setGatewayTarget(executionTarget() ? null : { url: endpoint.url, token: endpoint.token, ...gatewayBackend }, executionTarget() ? false : channelsUsed());
    setConnection({ status: "ready", backend: config.backend, detail, providers });
  });
  owned.onStuck((reason) => {
    if (server !== owned) return;
    // Nothing is restarting any more. Say so to everything that asks for the
    // connection, instead of "restarting, try again in a moment" for good.
    runtimeGaveUp = describeError(reason);
    setConnection({ status: "error", backend: config.backend, error: describeError(reason), activeRemoteConversationIds: activeRemoteConversationIds() });
  });
}

/** Connection failures the user can fix get a message that says how. */
function describeConnectionError(error: unknown, config: ConnectionConfig): string {
  const detail = describeError(error);
  if (config.backend === "remote" && /WebSocket|ECONNREFUSED|ENOTFOUND/i.test(detail)) {
    return `Could not reach the Letta server at ${config.serverUrl}. Check that it is running and that the URL is correct.`;
  }
  if (config.backend === "cloud" && /LETTA_API_KEY/.test(detail)) {
    return "Add your Letta API key in Settings to use Letta Cloud.";
  }
  return detail;
}

async function connect(signal: AbortSignal): Promise<LettaAgentClient> {
  const config = getConnectionConfig();
  const account = getSettings().connectionRevision;
  setConnection({ status: "connecting", backend: config.backend });

  let next: LettaAgentClient | null = null;
  let owned: OwnedServer | null = null;
  const cancelClient = () => { void next?.close().catch(() => undefined); };
  signal.addEventListener("abort", cancelClient, { once: true });
  try {
    let detail: string;
    if (config.backend === "remote") {
      if (!config.serverUrl) throw new Error("Add your Letta server URL in Settings.");
      next = new LettaAgentClient({
        backend: "remote",
        url: config.serverUrl,
        ...(config.serverToken ? { authToken: config.serverToken } : {}),
        // Node's built-in WebSocket cannot send the Authorization header.
        WebSocket: HelperAwareWebSocket as never,
      });
      detail = config.serverUrl;
    } else {
      const cloud = config.backend === "cloud";
      // Letta Cloud: prefer "Sign in with Letta" (OAuth, refreshed in the
      // background and pushed to the runtime), else an API key.
      const accessToken = cloud && config.lettaSignedIn ? await currentLettaAccessToken() : null;
      signal.throwIfAborted();
      // Signed in but the sign-in can't be renewed right now: say so. Starting
      // on a saved key instead would quietly connect as whoever that key belongs to.
      if (cloud && config.lettaSignedIn && !accessToken) {
        throw new Error("Hearthside couldn't renew your Letta sign-in just now. Check your internet connection, then press Reconnect.");
      }
      if (cloud && !accessToken && !config.apiKey) {
        throw new Error("Sign in with Letta or add an API key in Settings.");
      }
      let latestToken = accessToken ?? "";
      cloudLink = cloud ? { backend: {}, token: () => latestToken || config.apiKey || "", baseUrl: config.apiBaseUrl || LETTA_CLOUD_API_URL } : null;
      // Hearthside: the channel service must reach the same backend (local mode,
      // or Cloud with the same key or sign-in), else it assumes Cloud with no key.
      gatewayBackend = cloud
        ? {
            env: {
              LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
              LETTA_BASE_URL: config.apiBaseUrl || LETTA_CLOUD_API_URL,
              ...(accessToken ? {} : { LETTA_API_KEY: config.apiKey }),
            },
            ...(accessToken
              ? {
                  credentials: {
                    current: () => latestToken,
                    subscribe: (listener: (token: string) => void) => onLettaAccessToken(listener),
                  },
                }
              : {}),
          }
        : { env: { LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1" } };
      if (cloudLink) cloudLink.backend = gatewayBackend;
      // Hearthside owns this server: token-protected, sandboxed, and recovered
      // automatically if it crashes (see owned-server.ts).
      owned = await startOwnedServer({
        backend: cloud ? "api" : "local",
        // Hearthside: both connections keep their schedules in the same file in
        // the runtime home, and the runtime fires every one it finds unless told
        // which are its own. Without the scope a Cloud companion's schedule kept
        // firing on This computer against an agent that isn't there, and a local
        // one-off that came due during a visit to Cloud was used up there.
        env: cloud
          ? {
              ...(accessToken ? {} : { LETTA_API_KEY: config.apiKey }),
              LETTA_BASE_URL: config.apiBaseUrl || LETTA_CLOUD_API_URL,
              LETTA_CRON_SCHEDULER_SCOPE: "cloud",
            }
          : { LETTA_CRON_SCHEDULER_SCOPE: "local" },
        ...(accessToken
          ? {
              credentials: {
                current: () => latestToken,
                subscribe: (listener: (token: string) => void) =>
                  onLettaAccessToken((token) => {
                    latestToken = token;
                    listener(token);
                  }),
              },
            }
          : {}),
      }, signal);
      signal.throwIfAborted();
      // A runtime Hearthside just started cannot be running anything left
      // over — but only this runtime's holds are released by that. A command
      // lost on someone's Letta server is still running there, whichever
      // runtime is started here afterwards.
      clearQuarantineForNewRuntime(runtimeIdentityFor(config));
      next = clientFor(owned.endpoint);
      detail = cloud ? "Letta Cloud" : "This computer";
    }

    // A cheap request that proves the server is reachable and authenticated.
    await next.agents.list({ limit: 1 });
    signal.throwIfAborted();

    setControlTarget(
      owned
        ? { url: owned.endpoint.url, authToken: owned.endpoint.token }
        : {
            url: config.serverUrl,
            ...(config.serverToken ? { authToken: config.serverToken } : {}),
          },
    );
    // Hearthside: the channel service runs beside a runtime this app started.
    const desktopChannels = !executionTarget() ? owned : null;
    setGatewayTarget(desktopChannels ? { url: desktopChannels.endpoint.url, token: desktopChannels.endpoint.token, ...gatewayBackend } : null, desktopChannels ? channelsUsed() : false);
    // Hearthside: on Letta Cloud, keep this computer reachable when the person asked for it.
    if (account !== getSettings().connectionRevision) throw new Error("Account changed while connecting.");
    listenerAccount = owned && cloudLink ? account : undefined;
    setCloudLink(owned ? cloudLink : null);
    // Also refuses runtimes speaking a protocol this build does not understand.
    // Hearthside: Local manages providers through the runtime; Cloud through the Letta account.
    const providers = config.backend === "cloud" || (await serverBackend()) === "local";
    signal.throwIfAborted();

    if (owned) watchOwnedServer(owned, config, detail, providers);
    client = next;
    server = owned;
    setConnection({ status: "ready", backend: config.backend, detail, providers });
    // Moves outlive this process. Picking them back up is deliberately not
    // awaited: a destination that cannot be re-attached must not fail the
    // connection the person just made.
    void resumeMoveWatching().catch((error: unknown) => {
      console.warn(`[teleport] moves could not be resumed: ${describeError(error)}`);
    });
    return next;
  } catch (error) {
    if (!signal.aborted) {
      setControlTarget(null);
      setGatewayTarget(null, false);
    }
    owned?.close();
    await next?.close().catch(() => undefined);
    if (signal.aborted) throw error;
    setConnection({
      status: "error",
      backend: config.backend,
      error: describeConnectionError(error, config),
    });
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelClient);
  }
}

/**
 * Hearthside: set when the app is closing (quit or installing an update).
 * Anything that would connect, like the chat's background refresh, then fails
 * instead of starting a new runtime while the old one is being shut down.
 */
let closingApp = false;
let nativeRecoveryStop = false;
export function closeForQuit(): void {
  closingApp = true;
}

/** The shutdown did not finish, so the app is staying open: let it be used (and quit) again. */
export function reopenAfterFailedQuit(): void {
  closingApp = false;
}

/** Set when the owned runtime kept crashing and automatic recovery stopped; cleared by the next connection. */
let runtimeGaveUp: string | null = null;

function ensureClient(): Promise<LettaAgentClient> {
  if (nativeRecoveryStop) return Promise.reject(new Error("The local runtime is stopped briefly for verified recovery publication."));
  if (closingApp) return Promise.reject(new Error("Hearthside is closing."));
  if (client) return Promise.resolve(client);
  // Our server exists but is recovering from a crash: don't start a second one.
  if (server && runtimeGaveUp) return Promise.reject(new Error(`${runtimeGaveUp} Press Reconnect to start it again.`));
  if (server) return Promise.reject(new Error("The Letta runtime is restarting. Try again in a moment."));
  if (!connecting) {
    const attempt = new AbortController();
    connectionAttempt = attempt;
    const pending = connect(attempt.signal).finally(() => {
      if (connecting === pending) connecting = null;
    });
    connecting = pending;
  }
  return connecting;
}

/** Hearthside: stop the connection and show why (e.g. an expired sign-in). */
export async function failConnection(reason: string): Promise<void> {
  const backend = connection.backend;
  await disconnect();
  setConnection({ status: "error", backend, error: reason });
}

export async function disconnect(options: { preserveComputerAccess?: boolean; reason?: string } = {}): Promise<void> {
  runtimeGaveUp = null;
  for (const chatId of [...remoteHelperObservers.keys()]) stopRemoteHelperObserver(chatId);
  remoteHelperEvidence.clear();
  for (const entry of destinationTurns.values()) {
    if (entry.observer) clearInterval(entry.observer);
    entry.controller.abort(); // Cancel observation HTTP only, never the remote job.
  }
  destinationTurns.clear(); // Durable blocked delivery markers remain; no replay.
  // A watched move's destination is a session on the client being closed. The
  // conversation stays where it moved to; only the watching ends.
  releaseAllMoveDestinations("Hearthside disconnected from Letta, so it is no longer watching this conversation's destination.");
  for (const turn of [...remoteHelperSessions]) closeSession(turn);
  cancelPreparingTurns();
  connectionAttempt?.abort();
  connectionAttempt = null;
  connecting = null;
  setGatewayTarget(null, false);
  if (!options.preserveComputerAccess) {
    setCloudLink(null);
    listenerAccount = undefined;
  }
  cloudLink = null;
  for (const turn of [...turns.values()]) {
    // A reply cut off by a reconnect the person did not ask to stop it says
    // so. Ended as "stopped" it simply went quiet, with no way to tell a
    // changed setting had restarted the runtime underneath it.
    const cutOff = options.reason !== undefined && !turn.stopped && !turn.handoffBlocked && !turn.executionClient;
    if (!cutOff) turn.stopped = true;
    if (turn.handoffBlocked) {
      if (turn.executionObserver) clearInterval(turn.executionObserver);
      closeSession(turn);
      turns.delete(turn.conversationId);
    } else finishTurn(turn, cutOff ? options.reason : undefined);
    turn.stopped = true;
    // Explicit disconnect must not retain a newly finished parent's relay for
    // helpers or pending callbacks. This closes observation, not remote work.
    closeSession(turn);
  }
  for (const timer of helperWatches.values()) clearInterval(timer);
  helperWatches.clear();
  conversations.clear();
  usageByConversation.clear();
  lastReplies.clear();
  // Hearthside: a mod file chosen for the runtime that is going away must not
  // be confirmable against the next one, and a command waiting on a lifecycle
  // frame will never get one from a closed connection.
  forgetModImport();
  releaseCommandSlots();
  // Stop every follower pinned to the connection that is going away, before
  // the generation moves on.
  endConnectionLifetimes();
  setControlTarget(null);
  const previousClient = client;
  const previousServer = server;
  client = null;
  server = null;
  previousServer?.close();
  await previousClient?.close().catch(() => undefined);
}

export async function reconnect(): Promise<ConnectionState> {
  const config = getConnectionConfig();
  // A management transport restart is not an opt-out from Remote Access.
  // Account/backend/logout/disable boundaries still retire the listener promptly.
  const preserveComputerAccess = Boolean(listenerAccount && listenerAccount === getSettings().connectionRevision
    && config.backend === "cloud" && getSettings().reachableComputer === true && cloudLink
    && cloudLink.baseUrl === (config.apiBaseUrl || LETTA_CLOUD_API_URL));
  await disconnect({ preserveComputerAccess, reason: "Hearthside restarted its connection (a setting changed, or you pressed Reconnect), so this reply was stopped part-way. Send your message again." });
  await ensureClient().catch(() => undefined);
  return connection;
}

// --- Agents and models ------------------------------------------------------

/** Hearthside: agent names and latest replies, for notifications. */
const agentNames = new Map<string, string>();
const lastReplies = new Map<string, string>();

/**
 * Hearthside: the companion a chat belongs to, asking the runtime when this
 * app no longer remembers (its own record is dropped on every reconnect).
 * Null only when nobody can say.
 */
export async function conversationAgent(conversationId: string): Promise<string | null> {
  const known = agentIdFor(conversationId);
  if (known) return known;
  try {
    const record = await (await ensureClient()).conversations.retrieve(conversationId);
    return typeof record.agent_id === "string" && record.agent_id ? record.agent_id : null;
  } catch {
    return null;
  }
}

export function agentIdFor(conversationId: string): string | null {
  return mainChatAgent(conversationId) ?? conversations.get(conversationId)?.agentId ?? null;
}

export function agentNameFor(conversationId: string): string | null {
  const agentId = agentIdFor(conversationId);
  return agentId ? (agentNames.get(agentId) ?? null) : null;
}

export function lastReplyFor(conversationId: string): string | null {
  return lastReplies.get(conversationId) ?? null;
}

/**
 * Hearthside: the reasoning level Letta holds, read out of its model settings.
 * Those settings take a different shape for each provider Letta supports (and
 * not all of them offer every level), so this reads the one field by name and
 * keeps the value only when it is a level the SDK accepts. Anything else is
 * unknown — which is not Medium, and not a reason to overwrite what the server
 * holds.
 */
function storedEffort(settings: unknown): ReasoningEffort | null {
  const value = (settings as { reasoning?: { reasoning_effort?: unknown } } | null | undefined)?.reasoning?.reasoning_effort;
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : null;
}

function toAgentSummary(agent: LettaAgent): AgentSummary {
  if (agent.name) agentNames.set(agent.id, agent.name);
  return {
    id: agent.id,
    name: agent.name || "Untitled agent",
    description: agent.description ?? null,
    model: agent.model ?? agent.llm_config?.handle ?? null,
    effort: storedEffort(agent.model_settings),
  };
}

export async function listAgents(): Promise<AgentSummary[]> {
  const sdk = await ensureClient();
  // Helpers count towards a page, so one page of 100 could hide real
  // companions (and leave them out of the daily backup). Read on while pages come back full.
  const agents: LettaAgent[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    const batch: LettaAgent[] = await sdk.agents.list({ limit: 100, ...(agents.length ? { after: agents[agents.length - 1]!.id } : {}) });
    const fresh = batch.filter((agent) => !seen.has(agent.id));
    for (const agent of fresh) seen.add(agent.id);
    agents.push(...fresh);
    // A runtime that ignores the position answers with the same page again: stop there.
    if (batch.length < 100 || fresh.length === 0) break;
  }
  // Hearthside: helpers an agent made for a job live under that agent (More → Helpers), not in this list.
  return agents.filter((agent) => !isHelper(agent.tags)).map(toAgentSummary);
}

export async function createAgent(input: CreateAgentInput): Promise<AgentSummary> {
  const sdk = await ensureClient();
  const name = input.name.trim() || "My agent";
  // Hearthside: create with the model's handle (see model-handles.ts); a
  // reasoning tier from a connected provider isn't known at creation.
  const models = await listModels().catch(() => [] as ModelOption[]);
  const model = input.model ? (handleForModel(models, input.model) ?? input.model) : null;
  let agentId: string;
  // Whether the person picked no model at all. Only then may Hearthside pick
  // one for them; a pick the runtime turned down at creation is still a pick.
  const chose = Boolean(input.model);
  let withoutModel = !model;
  // On a busy computer creating can outlast the SDK's 30-second request limit
  // while the agent is in fact being made; then find it rather than fail.
  const before = new Set((await sdk.agents.list({ limit: 100 }).catch(() => [] as LettaAgent[])).map((agent) => agent.id));
  const create = async (options: { name: string; model?: string }): Promise<string> => {
    try {
      return await sdk.createAgent({
        ...options,
        ...(input.coreMemory ? { memory: input.coreMemory } : {}),
        ...(input.systemPrompt?.trim() ? { systemPrompt: input.systemPrompt } : {}),
      });
    } catch (error) {
      if (!describeError(error).startsWith("Timed out waiting for")) throw error;
      console.warn(`[agents] creating ${name} is slow; looking for it`);
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const made = (await sdk.agents.list({ limit: 100 }).catch(() => [] as LettaAgent[])).find((agent) => !before.has(agent.id) && agent.name === options.name);
        if (made) return made.id;
      }
      throw error;
    }
  };
  try {
    agentId = await create({ name, ...(model ? { model } : {}) });
  } catch (error) {
    // Rather than lose the companion over the model, create without one; it
    // can be chosen in the chat or in Agent settings.
    if (!model || !/unknown model/i.test(describeError(error))) throw error;
    console.warn(`[agents] model ${model} wasn't accepted when creating ${name}; created without one`);
    agentId = await create({ name });
    withoutModel = true;
  }
  setAgentId(agentId);
  const local = (await serverBackend().catch(() => null)) === "local";
  if (input.model && input.model !== model) {
    // The chosen tier as the agent's default, when the backend takes it. The
    // local store takes anything, so it gets the handle and the level instead.
    const fields = local ? localModelFields(models, input.model) : { model: input.model };
    if (fields) await sdk.agents.update(agentId, fields).catch((error: unknown) => {
      console.warn(`[agents] default model ${input.model} not applied: ${describeError(error)}`);
    });
  }
  if (local && model && !withoutModel) noteLocalModel(model);
  // Only an agent the person picked no model for: a choice is never replaced.
  if (local && withoutModel && !chose) await settleLocalModel(sdk, agentId, models).catch((error: unknown) => {
    console.warn(`[agents] could not check ${name}'s model: ${describeError(error)}`);
  });
  // Legacy explicit file imports only. New companion core seeds go through the
  // SDK above, which owns the memory format and keeps default harness instructions.
  // The agent already exists, so a
  // failed write says so plainly rather than looking like nothing happened.
  for (const file of input.memory ?? []) {
    try {
      await writeMemoryFile(agentId, file.path, file.content);
    } catch (error) {
      throw new Error(`${input.name.trim() || "The agent"} was created, but its memory file ${file.path} couldn't be written: ${describeError(error)}. You can add it in Memory → Files.`);
    }
  }
  return toAgentSummary(await sdk.agents.retrieve(agentId));
}

/**
 * Hearthside: a picker value as the local store must be given it — the handle
 * as the model and the reasoning level in the model settings (see
 * agentDefaultFor). Null when the value names no model in the catalog.
 */
function localModelFields(models: readonly ModelOption[], value: string): { model: string; modelSettings?: Record<string, unknown> } | null {
  const chosen = agentDefaultFor(models, value);
  if (!chosen) return null;
  return { model: chosen.model, ...(chosen.effort ? { modelSettings: { reasoning: { reasoning_effort: chosen.effort } } } : {}) };
}

/**
 * Hearthside: make sure a new local agent holds a model something connected
 * can serve. The local runtime gives an agent created without one its built-in
 * default (an OpenAI model) even when only another provider is connected, so
 * the companion's first message failed with "Provider is not configured".
 * With a model connected the agent is moved to it now; with none it is
 * remembered, and moved when the first one is (adoptConnectedModels).
 */
async function settleLocalModel(sdk: LettaAgentClient, agentId: string, models: readonly ModelOption[]): Promise<void> {
  const agent = await sdk.agents.retrieve(agentId);
  const current = agent.model ?? agent.llm_config?.handle ?? null;
  if (models.length === 0) {
    setAwaitingModel(agentId, true);
    return;
  }
  const adopt = modelToAdopt(models, current, lastLocalModel());
  if (adopt) {
    const updated = await sdk.agents.update(agentId, { model: adopt });
    reviseContext(agentId);
    console.log(`[agents] ${agent.name ?? agentId}: ${current ?? "no model"} isn't connected here; using ${adopt}`);
    // The window didn't ask for this, so it is told: otherwise its label went
    // on naming the old model while messages already used the new one.
    const summary = toAgentSummary({ ...updated, name: updated.name ?? agent.name });
    const main = conversations.get(mainChatId(agentId));
    if (main) conversations.set(main.id, { ...main, model: summary.model, effort: summary.effort ?? null });
    emit({ type: "agent.updated", agent: summary });
  }
  setAwaitingModel(agentId, false);
}

/**
 * Hearthside: give the agents that were made before any model was connected
 * the first one that now is. Called when the model list is read; only agents
 * recorded as waiting are touched, so a model the person chose is never
 * replaced here. Returns whether any agent changed.
 */
export async function adoptConnectedModels(models: readonly ModelOption[]): Promise<boolean> {
  const waiting = agentsAwaitingModel();
  if (waiting.length === 0 || models.length === 0 || !client) return false;
  if ((await serverBackend().catch(() => null)) !== "local") return false;
  const sdk = client;
  let changed = false;
  for (const agentId of waiting) {
    try {
      const before = (await sdk.agents.retrieve(agentId)).model ?? null;
      await settleLocalModel(sdk, agentId, models);
      if (modelToAdopt(models, before, lastLocalModel())) changed = true;
    } catch (error) {
      // An agent deleted since is no longer waiting; anything else is retried next time.
      if (/not found/i.test(describeError(error))) setAwaitingModel(agentId, false);
      else console.warn(`[agents] could not give ${agentId} a connected model: ${describeError(error)}`);
    }
  }
  return changed;
}

export async function getAgent(agentId: string): Promise<AgentDetails> {
  const sdk = await ensureClient();
  const agent = await sdk.agents.retrieve(agentId);
  // Hearthside: expose the current context window for Agent settings.
  const contextWindow = effectiveContextWindow(agent);
  return { ...toAgentSummary(agent), system: agent.system ?? null, contextWindow };
}

/** Explicit staged repair only: never invoked during load or ordinary saves. */
export async function restoreCompanionPrompt(agentId: string, expectedSystem: string, expectedReplacement: string, confirmed: boolean) {
  const sdk = await ensureClient();
  const backend = await serverBackend();
  if (backend !== "local" && backend !== "api") throw new Error("Cannot verify the backend for prompt repair.");
  const guard = async () => {
    assertRecoveryAdmission(agentId);
    if (executionTarget()) throw new Error("Select this computer before repairing instructions; this action will not silently run on another computer.");
    if (client !== sdk || connection.status !== "ready") throw new Error("The connection changed. Refresh before repairing instructions.");
    if (agentBusy(agentId) || !await runtimeIdle({ agent_id: agentId, conversation_id: "default" })) throw new Error("Pause this agent before repairing its instructions.");
    if (client !== sdk || connection.status !== "ready") throw new Error("The connection changed during the idle check.");
  };
  await guard();
  return repairCompanionPrompt(agentId, expectedSystem, expectedReplacement, confirmed, {
    readSystem: async id => { await guard(); return (await sdk.agents.retrieve(id)).system ?? null; },
    listMemory: async id => { await guard(); return listMemory(id); },
    writeMemoryFile: async (id, path, content) => { await guard(); await writeMemoryFile(id, path, content); },
    updateSystem: async (id, system) => {
      await guard();
      if ((await sdk.agents.retrieve(id)).system !== expectedSystem) throw new Error("The system instructions changed. Refresh before repairing.");
      await guard();
      await sdk.agents.update(id, { system });
      const saved = await sdk.agents.retrieve(id);
      if (saved.system !== system) throw new Error("The backend did not confirm the instruction change. Inspect the saved agent before retrying.");
      reviseContext(id);
    },
  });
}

export async function updateAgent(agentId: string, update: AgentUpdate): Promise<AgentSummary> {
  const sdk = await ensureClient();
  const name = update.name?.trim();
  const changesContext = Boolean(update.model) || update.contextWindowLimit !== undefined || update.system !== undefined;
  // Hearthside: the local store keeps any string as the model, so a picker
  // value (a reasoning-tier id) is turned into the handle and level first.
  let modelFields: { model: string; modelSettings?: Record<string, unknown> } | null = update.model ? { model: update.model } : null;
  if (update.model && (await serverBackend().catch(() => null)) === "local") {
    modelFields = localModelFields(await listModels().catch(() => [] as ModelOption[]), update.model);
    if (!modelFields) throw new Error("That model isn't available on this computer right now. Check its provider in Settings → Models, then pick it again.");
  }
  if (changesContext) reviseContext(agentId);
  const agent = await sdk.agents.update(agentId, {
    ...(name ? { name } : {}),
    ...(update.description !== undefined ? { description: update.description.trim() } : {}),
    ...(modelFields ?? {}),
    ...(update.system !== undefined ? { system: update.system } : {}),
    ...(update.contextWindowLimit !== undefined ? { contextWindowLimit: update.contextWindowLimit } : {}),
  });
  if (modelFields) {
    setAwaitingModel(agentId, false);
    if (getConnectionConfig().backend === "local") noteLocalModel(modelFields.model);
    // The main chat's cached entry repeats the agent's model; keep it in step.
    const main = conversations.get(mainChatId(agentId));
    if (main) conversations.set(main.id, { ...main, model: toAgentSummary(agent).model, effort: storedEffort(agent.model_settings) });
  }
  if (changesContext) {
    reviseContext(agentId);
    const window = effectiveContextWindow(agent);
    agentContextWindow.set(agentId, window);
    for (const conversation of conversations.values()) {
      if (conversation.agentId !== agentId) continue;
      publishUsage(conversation.id, { contextTokens: null, contextWindow: conversation.contextWindowLimit ?? window });
    }
  }
  return toAgentSummary(agent);
}

/** Permanently delete an agent, with its memory and conversations. */
export async function deleteAgent(agentId: string): Promise<void> {
  const sdk = await ensureClient();
  for (const conversation of [...conversations.values()]) {
    if (conversation.agentId !== agentId) continue;
    await stopBeforeRemoval(conversation.id);
    conversations.delete(conversation.id);
    forgetConversation(conversation.id);
    forgetHelpers(conversation.id);
    forgetReadings(conversation.id);
  }
  forgetHelpers(mainChatId(agentId));
  // Where its files are is worked out before it goes, from the connection it is on now.
  const local = getConnectionConfig().backend === "local" && (await serverBackend().catch(() => null)) === "local";
  await sdk.agents.delete(agentId);
  // Its Telegram and Discord bots would otherwise keep running with nobody to answer.
  if (channelsUsed()) {
    const bots = await stopBotsForAgent(agentId);
    for (const bot of bots.failed) console.warn(`[channels] could not switch off ${bot.accountId} for a deleted companion: ${bot.error}`);
  }
  setAwaitingModel(agentId, false);
  if (getSettings().agentId === agentId) setAgentId(null);
  if (local) removeLocalAgentFiles(agentId);
}

/**
 * Hearthside: remove what the local runtime leaves behind when it deletes an
 * agent. It removes the agent's record and its chats, and nothing else: the
 * memory repository — every memory file and its whole history — stayed on
 * disk under a companion the window had promised was gone, memory included.
 *
 * Only folders named exactly for this agent, directly inside the two places
 * that hold them, and never through a link: a folder that turns out to be a
 * link is unlinked, not followed.
 */
function removeLocalAgentFiles(agentId: string): void {
  if (!/^agent-[A-Za-z0-9_-]{1,120}$/.test(agentId)) return;
  const home = resolveRuntimeHome().home ?? homedir();
  const storage = process.env.LETTA_LOCAL_BACKEND_DIR ?? join(home, ".letta", "lc-local-backend");
  const left: string[] = [];
  for (const parent of [join(storage, "memfs"), join(home, ".letta", "hearthside-recovery")]) {
    const target = join(parent, agentId);
    try {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) unlinkSync(target);
      else rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      console.warn(`[agents] couldn't remove ${target}: ${describeError(error)}`);
      left.push(target);
    }
  }
  if (left.length > 0) throw new Error(`The companion was deleted, but some of its files couldn't be removed (they may be open in another program). You can delete them yourself: ${left.join(", ")}`);
}

// --- Conversations ----------------------------------------------------------

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Hearthside: a restored history part, recognised by the tags the converter wrote (backup/cloud-native.ts). */
function historyOf(conversation: LettaConversation): HistoryVolume | undefined {
  const tags = (conversation as { tags?: unknown }).tags;
  if (!Array.isArray(tags) || !tags.includes(HISTORY_TAG)) return undefined;
  const value = (name: string) => (tags.find((tag): tag is string => typeof tag === "string" && tag.startsWith(`${HISTORY_TAG}-${name}:`)) ?? "").slice(HISTORY_TAG.length + name.length + 2);
  const [firstAt, lastAt] = value("span").split("/");
  return { of: value("of") || "unknown", part: Number(value("part")) || 0, firstAt: firstAt || null, lastAt: lastAt || null };
}

function toConversationSummary(conversation: LettaConversation): ConversationSummary {
  const history = historyOf(conversation);
  const summary: ConversationSummary = {
    id: conversation.id,
    agentId: conversation.agent_id,
    title: conversation.summary?.trim() ?? "",
    updatedAt:
      timestamp(conversation.last_message_at) ||
      timestamp(conversation.updated_at) ||
      timestamp(conversation.created_at),
    model: conversation.model ?? null,
    effort: storedEffort(conversation.model_settings),
    cwd: getConversationCwd(conversation.id),
    contextWindowLimit: (conversation as { context_window_limit?: number | null }).context_window_limit ?? null,
    ...(history ? { history } : {}),
  };
  conversations.set(summary.id, summary);
  return summary;
}

export const HISTORY_READ_ONLY = "This is part of a chat's history, kept read-only. Use “Continue from here” to carry on in a new chat.";



export async function assertWritableConversation(conversationId: string): Promise<void> {
  if (mainChatAgent(conversationId)) return;

  if (isRecordedHistoryVolume(conversationId)) throw new Error(HISTORY_READ_ONLY);
  let summary = conversations.get(conversationId);
  if (!summary) {
    const sdk = await ensureClient();
    summary = toConversationSummary(await sdk.conversations.retrieve(conversationId));
  }
  if (summary.history) throw new Error(HISTORY_READ_ONLY);
}

/** Hearthside: a companion's read-only history parts, grouped by chat and oldest first. */
export async function listHistory(agentId: string): Promise<ConversationSummary[]> {
  const sdk = await ensureClient();
  const found: ConversationSummary[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await sdk.conversations.list({ agentId, archiveStatus: "all", limit: 100, order: "asc", ...(after ? { after } : {}) } as never);
    const fresh = batch.filter((conversation) => !seen.has(conversation.id));
    for (const conversation of fresh) {
      seen.add(conversation.id);
      if (historyOf(conversation)) found.push(toConversationSummary(conversation));
    }
    if (batch.length < 100 || fresh.length === 0) break;
    after = batch[batch.length - 1]!.id;
  }
  return found.sort((a, b) => a.history!.of.localeCompare(b.history!.of) || a.history!.part - b.history!.part);
}

// --- Main chat ----------------------------------------------------------------
// Hearthside: every Letta agent has a default conversation (its original
// history). Letta doesn't list it with the others, so it gets a stable id here
// and is shown pinned as "Main chat".

const MAIN_CHAT_PREFIX = "main:";
const MAIN_CHAT_TITLE = "Main chat";

export function mainChatId(agentId: string): string {
  return `${MAIN_CHAT_PREFIX}${agentId}`;
}

/** The agent id behind a main-chat id, or null for an ordinary conversation. */
export function mainChatAgent(conversationId: string): string | null {
  return conversationId.startsWith(MAIN_CHAT_PREFIX) ? conversationId.slice(MAIN_CHAT_PREFIX.length) : null;
}

type WireMessage = { date?: string; created_at?: string } & Record<string, unknown>;

async function listMainChatMessages(agentId: string, limit: number): Promise<WireMessage[]> {
  const reply = await request<{ type: string; messages?: WireMessage[] }>("conversation_messages_list", {
    conversation_id: "default",
    query: { agent_id: agentId, limit, order: "desc" },
  });
  return reply.messages ?? [];
}

// The main chat is the agent's own default conversation, so the agent's model
// and reasoning level are this chat's. Both are read from the agent itself,
// which the caller has already fetched. Without an agent to read (the send
// path, when this chat was never listed) whatever is already known stands —
// a summary rebuilt mid-send must not drop the level the chat is running at.
async function mainChatSummary(agentId: string, agent: LettaAgent | null): Promise<ConversationSummary> {
  const id = mainChatId(agentId);
  const known = conversations.get(id);
  const latest = (await listMainChatMessages(agentId, 1).catch(() => []))[0];
  const summary: ConversationSummary = {
    id,
    agentId,
    title: MAIN_CHAT_TITLE,
    updatedAt: timestamp(latest?.date) || timestamp(latest?.created_at),
    model: agent ? toAgentSummary(agent).model : (known?.model ?? null),
    effort: agent ? storedEffort(agent.model_settings) : (known?.effort ?? null),
    cwd: getConversationCwd(id),
    main: true,
  };
  conversations.set(id, summary);
  return summary;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}...` : line;
}

/**
 * Hearthside: an agent's conversations, all of them (up to 1,000). Letta lists
 * 100 at a time; agents that dream or use channels gather many, and a pinned
 * older chat used to fall off the end, even for search. The full list is
 * fetched at most every two minutes; in between, only the newest page is, and
 * merged with the rest (the chat list refreshes often while channels are used).
 */
const CONVERSATION_PAGE = 100;
const CONVERSATION_PAGES = 10;
const FULL_LIST_EVERY_MS = 2 * 60_000;
const conversationCache = new Map<string, { at: number; list: LettaConversation[] }>();

async function allConversations(sdk: LettaAgentClient, agentId: string): Promise<LettaConversation[]> {
  const cached = conversationCache.get(agentId);
  if (cached && Date.now() - cached.at < FULL_LIST_EVERY_MS) {
    const newest = await sdk.conversations.list({ agentId, limit: CONVERSATION_PAGE, order: "desc" });
    const seen = new Set(newest.map((conversation) => conversation.id));
    return [...newest, ...cached.list.filter((conversation) => !seen.has(conversation.id))];
  }
  const list: LettaConversation[] = [];
  let after: string | undefined;
  for (let page = 0; page < CONVERSATION_PAGES; page++) {
    const batch = await sdk.conversations.list({ agentId, limit: CONVERSATION_PAGE, order: "desc", ...(after ? { after } : {}) });
    const fresh = batch.filter((conversation) => !list.some((known) => known.id === conversation.id));
    list.push(...fresh);
    if (batch.length < CONVERSATION_PAGE || fresh.length === 0) break;
    after = batch[batch.length - 1]!.id;
  }
  conversationCache.set(agentId, { at: Date.now(), list });
  return list;
}

export async function listConversations(agentId: string): Promise<ConversationSummary[]> {
  const sdk = await ensureClient();
  const [list, agent] = await Promise.all([
    allConversations(sdk, agentId),
    sdk.agents.retrieve(agentId).catch(() => null),
  ]);
  const main = await mainChatSummary(agentId, agent);
  const listed = list.filter((conversation) => !conversation.archived && Boolean(conversation.summary || conversation.last_message_at));
  // Hearthside: every new agent starts with an untouched extra chat, and the
  // local backend gives it a last-message time anyway. Untitled chats (there
  // are few) are checked for actual messages; empty ones are left out.
  const kept = await Promise.all(
    listed.map(async (conversation) => {
      if (conversation.summary?.trim()) return conversation;
      const page = await sdk.conversations.listMessages(conversation.id, { limit: 5, order: "desc" }).catch(() => null);
      const hasMessages = page ? projectHistory(page.messages as Parameters<typeof projectHistory>[0]).length > 0 : true;
      return hasMessages ? conversation : null;
    }),
  );
  // Hearthside: mark chats that come from Telegram or Discord (only once channels are in use).
  const routes = channelsUsed() ? await listChannelRoutes(agentId).catch(() => []) : [];
  const channelOf = new Map(routes.map((route) => [route.conversationId, route.channelId]));
  // A Discord thread or channel gets its own chat, created by the channel service. On
  // this computer the runtime's list doesn't see chats made by another process until
  // it restarts, so fetch any routed chat the list is missing.
  const listedIds = new Set(list.map((conversation) => conversation.id));
  const missing = [...new Set(routes.map((route) => route.conversationId))].filter(
    (id) => id && id !== "default" && !id.startsWith("main:") && !listedIds.has(id),
  );
  const fetched = await Promise.all(missing.map((id) => sdk.conversations.retrieve(id).catch(() => null)));
  const routed = fetched.filter(
    (conversation): conversation is LettaConversation => conversation !== null && !conversation.archived && conversation.agent_id === agentId,
  );
  const others = [...kept, ...routed]
    .filter((conversation): conversation is LettaConversation => conversation !== null)
    .map(toConversationSummary)
    .map((summary) => (channelOf.has(summary.id) ? { ...summary, channel: channelOf.get(summary.id) } : summary))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const mainChannel = channelOf.get("default");
  return [mainChannel ? { ...main, channel: mainChannel } : main, ...others];
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  conversationCache.clear(); // Hearthside: the chat list changes.
  if (mainChatAgent(conversationId)) throw new Error("The main chat can't be renamed.");
  const sdk = await ensureClient();
  return toConversationSummary(
    await sdk.conversations.update(conversationId, { summary: title.trim() }),
  );
}

export async function archiveConversation(conversationId: string): Promise<void> {
  conversationCache.clear(); // Hearthside: the chat list changes.
  if (mainChatAgent(conversationId)) throw new Error("The main chat can't be archived.");
  const sdk = await ensureClient();
  await stopBeforeRemoval(conversationId);
  await sdk.conversations.update(conversationId, { archived: true });
  conversations.delete(conversationId);
  forgetConversation(conversationId);
  forgetHelpers(conversationId);
  forgetReadings(conversationId);
  // Hearthside: a channel chat that's archived is disconnected from its Telegram/Discord chat.
  if (channelsUsed()) await releaseArchivedChat(conversationId).catch(() => undefined);
}

/** Hearthside: an agent's archived chats, newest first. */
export async function listArchivedConversations(agentId: string): Promise<ConversationSummary[]> {
  const sdk = await ensureClient();
  // Local mode ignores archiveStatus and returns every chat, newest first, so
  // one page of 100 held only the archived chats among the newest 100 of all
  // of them. Page through, as the main list does.
  const list: LettaConversation[] = [];
  let after: string | undefined;
  for (let page = 0; page < CONVERSATION_PAGES; page++) {
    const batch = await sdk.conversations.list({ agentId, archiveStatus: "archived", limit: CONVERSATION_PAGE, order: "desc", ...(after ? { after } : {}) });
    const fresh = batch.filter((conversation) => !list.some((known) => known.id === conversation.id));
    list.push(...fresh);
    if (batch.length < CONVERSATION_PAGE || fresh.length === 0) break;
    after = batch[batch.length - 1]!.id;
  }
  return list
    // Local mode returns every chat, so check each one.
    .filter((conversation) => conversation.archived === true && !historyOf(conversation))
    .map(toConversationSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Hearthside: a chat the runtime has just made owes nothing to whatever was
 * kept under its id before. This computer numbers its chats and, once a
 * companion and its chats are deleted, hands the same numbers out again, so a
 * new chat could start with a deleted chat's working folder and helpers.
 */
function startsFresh(conversationId: string): void {
  forgetConversation(conversationId);
  forgetHelpers(conversationId);
  forgetReadings(conversationId);
}

/** What was last measured or said in a chat that is gone. This computer reuses chat ids, so a new chat would open with the old one's context reading. */
function forgetReadings(conversationId: string): void {
  usageByConversation.delete(conversationId);
  lastReplies.delete(conversationId);
  contextRevision.delete(conversationId);
}

/**
 * Stop this app's own work in a chat that is about to be archived or deleted.
 * `stopTurn` refuses when there is nothing here to stop, or when the work is
 * another computer's to stop; neither is a reason to keep the chat.
 */
async function stopBeforeRemoval(conversationId: string): Promise<void> {
  try {
    await stopTurn(conversationId);
  } catch {
    const turn = turns.get(conversationId);
    if (turn && !turn.finished && !turn.stopped) {
      // Still held here and Stop was refused: let go of it locally so nothing keeps streaming into a chat that is gone.
      finishTurn(turn);
    }
  }
}

/** Hearthside: a new chat continuing from this one's history. */
export async function forkConversation(conversationId: string): Promise<ConversationSummary> {
  await assertWritableConversation(conversationId);
  conversationCache.clear(); // Hearthside: the chat list changes.
  const sdk = await ensureClient();
  const mainAgent = mainChatAgent(conversationId);
  const source = conversations.get(conversationId);
  // The main chat is "default" for every agent, so the fork has to say whose.
  // The SDK's fork has no way to (it sends the chat id alone), and on This
  // computer that request failed with "Conversation default not found"; the
  // runtime's own command takes the agent beside it.
  const fork = mainAgent
    ? (await request<{ type: string; conversation: LettaConversation }>("conversation_fork", { conversation_id: "default", body: { agent_id: mainAgent } })).conversation
    : await sdk.conversations.fork(conversationId);
  if (!fork?.id) throw new Error("The chat couldn't be forked: the runtime returned no new chat.");
  startsFresh(fork.id);
  const baseTitle = mainAgent ? "Main chat" : source?.title || "Chat";
  // The runtime's own fork reply carries little more than the id, so a failed
  // rename reads the new chat rather than trusting that reply's shape.
  const titled = await sdk.conversations.update(fork.id, { summary: `${baseTitle} (fork)` }).catch(() => sdk.conversations.retrieve(fork.id));
  const conversation = toConversationSummary(titled);
  emit({ type: "conversation.updated", conversation });
  return conversation;
}

const EXPORT_PAGE = 1000;
const EXPORT_MAX_PAGES = 200;

/** Hearthside: a chat's full history as Markdown. */
export async function conversationMarkdown(conversationId: string): Promise<{ markdown: string; title: string }> {
  // Every page, oldest first. One page is the newest 1,000 stored messages
  // (thinking, tool calls and their results each count), so a long chat was
  // exported from somewhere in its middle with nothing to say the start was
  // missing. If the whole of it can't be read, the file says so at the top.
  const pages: ChatRow[][] = [];
  let before: string | undefined;
  let incomplete = false;
  for (let page = 0; ; page++) {
    const history = await loadHistory(conversationId, EXPORT_PAGE, before ? { before } : {});
    pages.unshift(history.rows);
    if (!history.hasMore) break;
    if (!history.nextBefore || history.nextBefore === before || page + 1 >= EXPORT_MAX_PAGES) { incomplete = true; break; }
    before = history.nextBefore;
  }
  const seen = new Set<string>();
  const rows = pages.flat().filter((row) => !seen.has(row.key) && Boolean(seen.add(row.key)));
  const agentId = agentIdFor(conversationId);
  const agentName = (agentId && agentNames.get(agentId)) || "Agent";
  const title = mainChatAgent(conversationId) ? "Main chat" : conversations.get(conversationId)?.title || "Chat";
  const note = incomplete ? "This export starts part-way through the chat: its earliest messages couldn't be read and are not included." : undefined;
  return { markdown: chatToMarkdown(title, agentName, rows, note), title };
}

/** Hearthside: bring an archived chat back into the list. */
export async function restoreConversation(conversationId: string): Promise<ConversationSummary> {
  conversationCache.clear(); // Hearthside: the chat list changes.
  if (mainChatAgent(conversationId)) throw new Error("The main chat is never archived.");
  const sdk = await ensureClient();
  const conversation = toConversationSummary(await sdk.conversations.update(conversationId, { archived: false }));
  emit({ type: "conversation.updated", conversation });
  return conversation;
}

/**
 * Hearthside: a cheap mark for "has anything new arrived in this chat?" (the id
 * and time of its newest message). Messages also arrive from outside this
 * window: a Telegram or Discord bot running elsewhere (e.g. on Railway), the
 * agent's scheduled time, the Letta website or app. The open chat compares
 * marks and reloads only when this one changes.
 */
export async function latestMessageMark(conversationId: string): Promise<string | null> {
  const sdk = await ensureClient();
  const mainAgent = mainChatAgent(conversationId);
  const newest = mainAgent
    ? (await listMainChatMessages(mainAgent, 1))[0]
    : ((await sdk.conversations.listMessages(conversationId, { limit: 1, order: "desc" })) as unknown as { messages: WireMessage[] }).messages[0];
  if (!newest) return null;
  const record = newest as unknown as { id?: unknown; date?: unknown; created_at?: unknown };
  return `${String(record.id ?? "")}@${String(record.date ?? record.created_at ?? "")}`;
}

/**
 * Latest meaningful human/companion text for a small recent-conversation list.
 * Ownership is checked in the main process; one failed or tool-only chat does
 * not hide previews that were available for the others.
 */
export async function listConversationPreviews(agentId: string, conversationIds: string[]): Promise<ConversationPreview[]> {
  const sdk = await ensureClient();
  const previews = await Promise.all(conversationIds.map(async (conversationId): Promise<ConversationPreview | null> => {
    if (await conversationAgent(conversationId) !== agentId) return null;
    try {
      const mainAgent = mainChatAgent(conversationId);
      const messages = mainAgent
        ? await listMainChatMessages(mainAgent, 8)
        : ((await sdk.conversations.listMessages(conversationId, { limit: 8, order: "desc" })) as unknown as { messages: WireMessage[] }).messages;
      const latest = [...projectHistory(messages as unknown as Parameters<typeof projectHistory>[0])]
        .reverse()
        .find((row) => (row.kind === "user" || row.kind === "assistant") && row.source !== "controller" && row.text.trim());
      if (!latest || (latest.kind !== "user" && latest.kind !== "assistant")) return null;
      const oneLine = latest.text.replace(/\s+/g, " ").trim();
      return {
        conversationId,
        kind: latest.kind,
        text: oneLine.length > 240 ? `${oneLine.slice(0, 239).trimEnd()}…` : oneLine,
        date: latest.date ?? null,
      };
    } catch {
      return null;
    }
  }));
  return previews.filter((preview): preview is ConversationPreview => preview !== null);
}

export async function loadHistory(conversationId: string, limit: number, options: { before?: string; around?: string } = {}): Promise<HistoryResult> {
  const sdk = await ensureClient();
  const mainAgent = mainChatAgent(conversationId);
  // The SDK's message list can't address the default conversation, so ask the runtime directly.
  type Page = { messages: Parameters<typeof projectHistory>[0]; hasMore?: boolean };
  const read = async (query: { limit: number; order: "asc" | "desc"; before?: string; after?: string }): Promise<Page> => {
    if (!mainAgent) return sdk.conversations.listMessages(conversationId, query) as Promise<Page>;
    const reply = await request<{ type: string; messages?: Page["messages"]; has_more?: boolean }>("conversation_messages_list", {
      conversation_id: "default", query: { agent_id: mainAgent, ...query },
    });
    return { messages: reply.messages ?? [], hasMore: reply.has_more };
  };
  // SDK 0.8.52 uses chronological cursors (before=older, after=newer), independent
  // of order. Its Cloud transport swaps REST cursor names; app-server does not.
  // Seek a newer boundary first so the exclusive `before` page includes the hit.
  let before = options.before;
  if (options.around) {
    const newer = await read({ limit: Math.max(1, Math.floor(limit / 2)), order: "asc", after: options.around });
    const boundary = newer.messages.at(-1)?.id;
    if (newer.messages.length && (typeof boundary !== "string" || !boundary)) throw new Error("History page did not include a message cursor.");
    before = typeof boundary === "string" ? boundary : undefined;
  }
  const fetchPage = (): Promise<Page> => read({ limit, order: "desc", ...(before ? { before } : {}) });
  // Hearthside: the runtime can be slow to answer while a run is busy in this
  // chat (or Letta Cloud is slow); one timeout gets one more try.
  const page = await fetchPage().catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for")) return fetchPage();
    throw error;
  });
  const projected = projectHistory(page.messages as Parameters<typeof projectHistory>[0]);
  const owner = mainAgent ?? conversations.get(conversationId)?.agentId;
  const history = owner ? markControllerRows(projected, followupScope(owner, conversationId)) : projected;
  // A single source ID can expand to multiple projected messages. Cursor and
  // focus metadata must refer to whole source groups, never projected row counts.
  const groups = new Map<string, Array<(typeof page.messages)[number]>>();
  for (const message of page.messages) {
    if (typeof message.id !== "string" || !message.id) continue;
    const group = groups.get(message.id) ?? [];
    group.push(message);
    groups.set(message.id, group);
  }
  const keys = new Set(history.map((row) => row.key));
  const messageKeys = Object.fromEntries([...groups].map(([id, group]) => [id, projectHistory(group).map((row) => row.key).filter((key) => keys.has(key))]));
  const oldest = [...groups.keys()].at(-1) ?? null;
  const hasMore = (page.hasMore ?? page.messages.length >= limit) && oldest !== null && oldest !== options.before;
  const turn = turns.get(conversationId);
  // A reply a slash command started, and work being watched at a move's
  // destination, are not in `turns`. The window replaces what it shows with
  // this answer every few seconds, so leaving them out took Stop and the
  // approval card away while the work was still waiting on an answer.
  const command = commandRuns.get(conversationId);
  const watched = destinationWatch(conversationId);
  const watchedRunning = Boolean(watched?.running);
  return {
    rows: !options.before && !options.around && turn ? mergeHistory(history, turn.accumulator.rows().map((row) => toChatRow(row))) : history,
    nextBefore: hasMore ? oldest : null,
    messageKeys,
    hasMore,

    running: Boolean(turn) || destinationTurns.has(conversationId) || preparingTurns.has(conversationId) || Boolean(command) || watchedRunning,
    activity: turn?.activity ?? destinationTurns.get(conversationId)?.activity ?? preparingActivity.get(conversationId) ?? (preparingTurns.has(conversationId) ? "Starting" : null)
      ?? (watchedRunning ? watched?.activity ?? null : null),
    approvals: turn ? [...turn.approvals.values()].map((pending) => pending.request)
      : command ? command.pending()
      : watchedRunning && watched ? [...watched.approvals.values()].map((pending) => pending.request) : [],
    usage: usageByConversation.get(conversationId) ?? null,
  };
}

/**
 * Hearthside: run one of the runtime's slash commands in a chat. Commands that
 * start an agent turn (doctor, init) reply once the turn has finished; the
 * window then reloads the chat to show it.
 */
export async function runCommand(conversationId: string, command: RuntimeCommand, args: string): Promise<CommandRunResult> {
  if ((command === "dream" && args.trim() && !/^(?:--instruction(?:s)?(?:=|\s)|-i\s|--\s)/.test(args.trim())) ||
      (command === "recompile" && args.trim())) {
    throw new Error(command === "dream"
      ? "/dream takes no plain-text focus. Where local reflection supports it, use --instruction <focus>; Cloud-managed reflection accepts no arguments. Nothing was sent."
      : "/recompile takes no arguments. Nothing was sent.");
  }
  const result = await runScopedCommand(conversationId, command, args, false);
  if (command === "compact" && result.success) publishUsage(conversationId, { contextTokens: null });
  if (command === "recompile" && result.success) publishUsage(conversationId, { contextTokens: null });
  return result;
}

const COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * Hearthside: the scope a command runs in, resolved the same way runCommand
 * does it — the main chat is the agent's "default" conversation, not its
 * synthetic id.
 */
function commandScopeFor(conversationId: string): { agentId: string; scope: CommandScope } {
  const mainAgent = mainChatAgent(conversationId);
  const agentId = mainAgent ?? conversations.get(conversationId)?.agentId;
  if (!agentId) throw new Error("Open the chat first.");
  return { agentId, scope: { agent_id: agentId, conversation_id: mainAgent ? "default" : conversationId } };
}

/**
 * Hearthside: which runtime a command slot or a hold belongs to.
 *
 * The same companion can be reached through a runtime on this computer, a
 * Letta Cloud account and a Letta server elsewhere, and a command Hearthside
 * lost track of is still running in exactly one of them. This identity is what
 * keeps those apart: it is stable across reconnects, because the same settings
 * give the same string, and it changes when the runtime does.
 */
function runtimeIdentityFor(config: ConnectionConfig): string {
  if (config.backend === "remote") return `remote ${config.serverUrl}`;
  if (config.backend === "cloud") return `cloud ${config.apiBaseUrl || LETTA_CLOUD_API_URL}`;
  return "local";
}
function runtimeIdentity(): string {
  return runtimeIdentityFor(getConnectionConfig());
}

/**
 * Hearthside: what a command is pinned to for its whole life — the runtime its
 * slot and any hold are keyed with, and the connection generation it was sent
 * on.
 *
 * The slot key has to be computed before the gate is taken, which is before
 * there is a connection. So the identity it was keyed with is carried along and
 * checked against the runtime the lease actually points at: a slot keyed for
 * one runtime must never end up paired with another runtime's socket, or the
 * command would run on one runtime while the hold for it sat on another.
 */
type CommandLease = {
  identity: string;
  epoch: number;
  /** ApiBackend recompile changes the Cloud conversation, not desktop files. */
  cloudRecompile?: { link: CloudLink; account: string | undefined };
};

/**
 * Hearthside: everything that has to be true for a command to run, checked
 * together and immediately before the send — never earlier, so nothing can go
 * stale while the request waits its turn.
 *
 * `client` is the connection this command will actually be sent on, so the
 * idle observation is made on that socket rather than on whichever one is
 * current by then. The lease is checked after every await: a command admitted
 * against one account must never reach the next one.
 *
 * The idle requirement is deliberately strict. A mod can mark a command
 * `runWhenBusy`, but the listener never consults that flag and the advertised
 * catalog does not carry it (docs/MODS.md), so there is no way to tell which
 * commands are safe mid-turn. Hearthside's own turn bookkeeping and the
 * runtime's idle observation both have to agree.
 */
function assertCommandStillOurs(conversationId: string, agentId: string, lease: CommandLease): void {
  if (controlGeneration() !== lease.epoch) {
    throw new Error("Hearthside reconnected, so nothing was sent. Try the command again.");
  }
  // The slot and any hold for this command are keyed with the runtime it was
  // meant for. If the connection now points somewhere else, this socket is not
  // the one that slot describes.
  if (runtimeIdentity() !== lease.identity) {
    throw new Error("Hearthside is connected to a different runtime now, so nothing was sent. Try the command again.");
  }
  // Selecting a computer mid-admission must not end with the command running
  // on this desktop instead.
  if (lease.cloudRecompile) {
    if (getConnectionConfig().backend !== "cloud" || cloudLink !== lease.cloudRecompile.link ||
        getSettings().connectionRevision !== lease.cloudRecompile.account) {
      throw new Error("The Cloud account changed before recompilation. Nothing was sent.");
    }
    const state = getExecutionState(conversationId);
    if (state.status === "blocked" || state.pendingDelivery || destinationTurns.has(conversationId)) {
      throw new Error("This conversation has unresolved execution or delivery. Recompilation was not sent.");
    }
  } else {
    assertConversationDesktopAccess(conversationId);
    if (executionTarget() && (getConnectionConfig().backend !== "cloud" || conversationTarget(conversationId).kind !== "desktop")) {
      throw new Error("Run this command on the selected computer. Hearthside won't run it on this desktop instead.");
    }
  }
  // Hearthside: a chat that runs in Cloud or on another computer keeps its commands there too.
  if (turns.has(conversationId) || turns.has(`${MAIN_CHAT_PREFIX}${agentId}`) || preparingTurns.has(conversationId)) {
    throw new Error("This chat is still working. Wait for it to finish first.");
  }
  // Fencing this companion for verified recovery, or any of the other reasons
  // a chat is held, counts whenever it becomes true — including while the
  // runtime is answering.
  assertRecoveryAdmission(agentId);
}

async function assertCommandAdmission(
  conversationId: string,
  agentId: string,
  scope: CommandScope,
  client: AppServerClient,
  lease: CommandLease,
): Promise<void> {
  assertCommandStillOurs(conversationId, agentId, lease);
  // This also subscribes the connection to the chat, so the frames the command
  // and its reply produce are delivered to the socket it was sent on.
  const idle = await observeRuntimeIdle(client, scope);
  assertCommandStillOurs(conversationId, agentId, lease);
  if (!idle) {
    throw new Error("The runtime is busy with this chat, or couldn't say that it isn't. Try again when the reply has finished.");
  }
  if (lease.cloudRecompile) {
    // The management app-server may be idle while Betty/Cloud is still working.
    // Require a fresh exact-scope Cloud read too; no runtime_start or attachment.
    const link = lease.cloudRecompile.link;
    const api = new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 });
    const raw = await api.get(`/v1/agents/${encodeURIComponent(scope.agent_id)}/runtime-status`, { query: { conversation_ids: scope.conversation_id } }) as {
      agent_id?: unknown; snapshot_at?: unknown; statuses?: Array<Record<string, unknown>>;
    };
    assertCommandStillOurs(conversationId, agentId, lease);
    const matches = Array.isArray(raw?.statuses) ? raw.statuses.filter(status => status?.conversation_id === scope.conversation_id) : [];
    const status = matches[0];
    if (raw?.agent_id !== scope.agent_id || matches.length !== 1 || !status || status.state !== "IDLE" ||
        status.has_conflicting_listeners || !Array.isArray(status.active_run_ids) || status.active_run_ids.length !== 0 ||
        (raw.snapshot_at !== undefined && (typeof raw.snapshot_at !== "number" || !Number.isFinite(raw.snapshot_at) || Math.abs(Date.now() - raw.snapshot_at) > 30_000))) {
      throw new Error("Letta has not confirmed this exact Cloud conversation is idle. Recompilation was not sent.");
    }
  }
}

/**
 * Hearthside: approvals raised by a reply a mod command started.
 *
 * Those turns run in the listener, not in one of Hearthside's SDK sessions, so
 * `turns` knows nothing about them and `respondApproval` would have had
 * nowhere to send the answer. Each running command registers itself here for
 * the chat it is in, and the answer goes back on the socket that command was
 * sent on.
 */
const commandRuns = new Map<string, CommandRunHandle>();

/**
 * Hearthside: an abort signal that lasts exactly as long as one control
 * connection. Anything that spans many awaits — following a reply for up to
 * ten minutes — stops the moment Hearthside re-points at another runtime,
 * instead of polling a new account about an old chat.
 */
let connectionAborts = new Map<number, AbortController>();
function connectionLifetime(epoch: number): AbortController {
  const existing = connectionAborts.get(epoch);
  if (existing) return existing;
  const controller = new AbortController();
  connectionAborts.set(epoch, controller);
  return controller;
}
function endConnectionLifetimes(): void {
  const previous = connectionAborts;
  connectionAborts = new Map();
  for (const controller of previous.values()) controller.abort();
}

/** True when this request belongs to a running mod command rather than a turn. */
function answerCommandApproval(conversationId: string, requestId: string, decision: ApprovalDecision): boolean {
  const run = commandRuns.get(conversationId);
  if (!run || !run.pending().some((request) => request.requestId === requestId)) return false;
  run.answer(requestId, decision);
  return true;
}

/**
 * Hearthside: the slash commands this chat can run. Hearthside's own built-ins
 * are always offered; the rest comes from what the runtime advertises for this
 * scope (DeviceStatus.mod_commands). When the runtime can't be asked, the
 * built-ins are still listed and `error` says why the mod commands are missing
 * — an empty list must not read as "this companion has no mod commands".
 */
export async function listChatCommands(conversationId: string): Promise<ChatCommandCatalog> {
  const mainAgent = mainChatAgent(conversationId);
  const agentId = mainAgent ?? conversations.get(conversationId)?.agentId;
  if (!agentId) throw new Error("Open the chat first.");
  const scope = { agent_id: agentId, conversation_id: mainAgent ? "default" : conversationId };
  const base = { agentId, conversationId };
  if (executionTarget()) {
    return { ...base, commands: [], error: "This chat runs on the selected computer, which has its own mods. Hearthside can't list them from here." };
  }
  try {
    const status = await deviceStatus(scope);
    const { mods } = readAdvertisedCommands(status);
    return {
      ...base,
      commands: mods.map((command) => ({
        id: command.id,
        description: command.description,
        argument: command.argument,
        source: "mod" as const,
      })),
      error: null,
    };
  } catch (error) {
    return { ...base, commands: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Hearthside: run a mod's slash command. The command must be one the runtime
 * advertises for this chat right now — a name typed in the box is never sent
 * on trust, and never sent as a message instead.
 *
 * The reply comes through the lifecycle adapter, because a valid mod command
 * gets no `execute_command_response` (docs/MODS.md).
 */
export async function runChatCommand(conversationId: string, commandId: string, args: string): Promise<CommandRunResult> {
  return runScopedCommand(conversationId, commandId, args, true);
}

/** Built-ins and mods share admission, approvals, and uncertain-outcome fencing. */
async function runScopedCommand(conversationId: string, commandId: string, args: string, mod: boolean): Promise<CommandRunResult> {
  const initialEpoch = controlGeneration();
  const initialIdentity = runtimeIdentity();
  const cloudRecompile = !mod && commandId === "recompile" && getConnectionConfig().backend === "cloud" && cloudLink
    ? { link: cloudLink, account: getSettings().connectionRevision } : undefined;
  await assertWritableConversation(conversationId);
  if (initialEpoch !== controlGeneration() || initialIdentity !== runtimeIdentity()) {
    throw new Error("Hearthside reconnected before command admission. Nothing was sent.");
  }
  const { agentId, scope } = commandScopeFor(conversationId);
  // Keyed before the gate is taken, so the runtime it names is checked again
  // once there is a connection (`assertCommandStillOurs`).
  const identity = runtimeIdentity();
  const slot = commandSlotKey(identity, scope);
  /**
   * The runtime and connection the command was actually sent on, once it has
   * been. Only that connection can say anything about how it ended.
   */
  let sentOn: CommandLease | null = null;
  let sentRequestId: string | undefined;
  return runGuardedCommand(slot, {
    admit: () => Promise.resolve(),
    dispatch: () =>
      // One connection for the whole run: admission, the send, the reply it
      // starts, and any approval answered during it. The lease is the client
      // and the generation it provably belongs to, taken together, so a
      // connection that was still opening when the target changed cannot be
      // used under the new target's generation.
      withControlClient(async ({ client, generation: epoch }) => {
        // Discover management capability on this control generation before
        // deciding which admission policy applies. Local/headless and mod
        // commands never inherit the Cloud management exception.
        const backend = commandId === "recompile" && !mod ? await serverBackend() : null;
        const lease: CommandLease = { identity, epoch, ...(backend === "api" && cloudRecompile ? { cloudRecompile } : {}) };
        const connection = connectionLifetime(epoch);
        await assertCommandAdmission(conversationId, agentId, scope, client, lease);
        // The catalog is read here, inside the slot and on this connection, so
        // a command that was unloaded or renamed meanwhile cannot still be sent.
        // Recompile is conversation management, not a supported slash id. The
        // pinned LocalBackend and ApiBackend implement it; HeadlessBackend does not.
        if (commandId === "recompile" && !mod && backend !== "local" && backend !== "api") {
          throw new Error("This runtime does not support prompt recompilation. Nothing was sent.");
        }
        const advertised = readAdvertisedCommands(await deviceStatus(scope));
        // The whole admission again, not just the generation: a computer can be
        // selected, a turn can start and this companion can be fenced for
        // recovery while the runtime is answering, and none of those moves the
        // generation. The send is the very next thing after this.
        await assertCommandAdmission(conversationId, agentId, scope, client, lease);
        if (epoch !== initialEpoch) throw new Error("Hearthside reconnected before dispatch. Nothing was sent.");
        if (mod ? !advertised.mods.some((command) => command.id === commandId)
          : commandId !== "recompile" && !advertised.supported.includes(commandId)) {
          throw new Error(`The runtime doesn't have a /${commandId} command for this chat. Nothing was sent.`);
        }
        // From here the command may have reached the runtime, and this is the
        // lease it reached it on.
        sentOn = lease;
        const result = await runModCommand(
          client as unknown as ObserverClient,
          {
            scope,
            commandId,
            args,
            recompile: !mod && commandId === "recompile",
            startsTurn: !mod && (commandId === "doctor" || commandId === "init"),
            commandTimeoutMs: mod ? undefined : COMMAND_TIMEOUT_MS,
            onDispatch: (requestId) => { sentOn = lease; sentRequestId = requestId; },
            signal: connection.signal,
            confirmIdle: () => (controlGeneration() === epoch ? observeRuntimeIdle(client, scope) : Promise.resolve(true)),
            pollMs: BUSY_CHECK_MS,
          },
          {
            onStart: (handle) => commandRuns.set(conversationId, handle),
            onApprovalRequested: (request) => {
              // The mapped literal, not a near-miss: the renderer matches this
              // exact label to drive its approval phase.
              emit({ type: "turn.activity", conversationId, activity: ACTIVITY.WAITING_ON_APPROVAL ?? null, phase: "approval" });
              emit({ type: "approval.requested", conversationId, request });
            },
            onApprovalResolved: (requestId) => emit({ type: "approval.resolved", conversationId, requestId }),
            onActivity: (activity) => emit({ type: "turn.activity", conversationId, activity }),
            onFinished: () => commandRuns.delete(conversationId),
          },
        );
        return { ...result, uncertain: false };
      }),
  }).catch((error: unknown) => {
    // A command whose outcome is unknown is reported, not thrown: the window
    // has to hold the chat's queue rather than letting a message go while that
    // command may still be running.
    if (error instanceof CommandUncertain) {
      if (sentOn) watchForStragglerEnd(slot, sentOn, scope, commandId, args, sentRequestId);
      return { output: describeError(error), success: false, startedTurn: false, turnFinished: false, uncertain: true };
    }
    throw error;
  });
}

/**
 * Hearthside: after a command's outcome became unknown, keep listening for its
 * end frame. That frame is the only per-chat evidence that it really finished,
 * and until it arrives the chat stays held (see mods/command-run.ts).
 *
 * It is only evidence when it comes from the connection the command was sent
 * on, which is why the watch is bound to that command's lease and not to
 * whichever connection is current by the time it failed. The end frame carries
 * no request id, so a frame for the same chat, command and argument line from
 * a different runtime looks exactly like the lost command's own — and would
 * release a hold that belongs to a runtime still running it.
 *
 * So when the lease has already gone — the ordinary case, because a dropped
 * connection is one of the two ways a command becomes uncertain — nothing is
 * attached at all. The hold then stays until the runtime it was sent to is
 * restarted (`clearQuarantineForNewRuntime`), which is the only other thing
 * that proves the command is no longer running.
 */
function watchForStragglerEnd(key: string, lease: CommandLease, scope: CommandScope, commandId: string, args: string, requestId?: string): void {
  const { epoch } = lease;
  if (controlGeneration() !== epoch || runtimeIdentity() !== lease.identity) return;
  const input = commandInputLine(commandId, args);
  const stop = observeControlFrames((frame) => {
    if (controlGeneration() !== epoch || runtimeIdentity() !== lease.identity) {
      stop();
      return;
    }
    if (requestId && frame.request_id === requestId &&
        (frame.type === "execute_command_response" || frame.type === "conversation_recompile_response")) {
      clearQuarantineOnEnd(key);
      stop();
      return;
    }
    if (frame.type !== "stream_delta") return;
    const runtime = frame.runtime as { agent_id?: unknown; conversation_id?: unknown } | undefined;
    if (runtime?.agent_id !== scope.agent_id || runtime.conversation_id !== scope.conversation_id) return;
    const delta = frame.delta as { message_type?: unknown; command_id?: unknown; input?: unknown } | undefined;
    if (delta?.message_type !== "slash_command_end" || delta.command_id !== commandId || delta.input !== input) return;
    if (clearQuarantineOnEnd(key)) {
      console.log(`[hearthside] /${commandId} finished after Hearthside stopped waiting; this chat can run commands again`);
    }
    stop();
  });
}

/**
 * Hearthside: the runtime's own `/reload` — settings, this computer's mods,
 * this companion's mods and its secrets. There is no per-file reload; this is
 * the whole scope, and it needs the chat to be idle because it replaces the
 * tools and commands a turn might be using.
 */
export async function reloadMods(conversationId: string): Promise<CommandRunResult> {
  return runCommand(conversationId, "reload", "");
}

/** Hearthside: give a chat its own context window limit, or go back to the agent's (null). */
export async function setConversationContextWindow(conversationId: string, limit: number | null): Promise<ConversationSummary> {
  if (mainChatAgent(conversationId)) throw new Error("The main chat uses the agent's context window. Change it in Agent settings.");
  const sdk = await ensureClient();
  reviseContext(conversationId);
  let updated = await sdk.conversations.update(conversationId, { contextWindowLimit: limit });
  // "Back to the agent's" has to end with the runtime actually using the
  // agent's window. Two things can stand in the way of simply clearing it:
  // a store that ignores a cleared limit and keeps the old number, and a chat
  // with a model of its own, whose settings carry that model's full window —
  // with the chat's limit gone the runtime falls through to that (a million
  // tokens, say), while this app would show the agent's. In both cases the
  // closest thing the chat can hold is the agent's own window, as a number.
  const ownModelWindow = typeof (updated.model_settings as { context_window_limit?: unknown } | null | undefined)?.context_window_limit === "number";
  if (limit === null && (typeof updated.context_window_limit === "number" || ownModelWindow)) {
    const agent = await sdk.agents.retrieve(updated.agent_id);
    const window = effectiveContextWindow(agent);
    if (window) updated = await sdk.conversations.update(conversationId, { contextWindowLimit: window });
  }
  const conversation = toConversationSummary(updated);
  reviseContext(conversationId);
  publishUsage(conversationId, { contextWindow: conversation.contextWindowLimit ?? agentContextWindow.get(conversation.agentId) ?? null });
  emit({ type: "conversation.updated", conversation });
  return conversation;
}

/** Hearthside: record usage from a usage_statistics event and tell the window. */
function recordUsage(turn: Turn, event: Record<string, unknown>): void {
  const usage = applyUsage(turn.usage, event);
  turn.usage = usage;
  usageByConversation.set(turn.conversationId, usage);
  emit({ type: "turn.usage", conversationId: turn.conversationId, usage });
}

// --- Turns ------------------------------------------------------------------

/**
 * The part of a turn the row, activity and approval plumbing actually touches.
 *
 * A conversation this app is *observing* at a move's destination has rows,
 * activity and approvals exactly like one it is running, but no session of its
 * own to send on. Widening these four helpers to the fields they already use
 * lets a destination reuse them verbatim instead of growing a parallel set that
 * would drift.
 */
type RowStream = Pick<Turn, "conversationId" | "accumulator" | "sent" | "flushTimer" | "activity" | "approvals" | "retired">;

function flushRows(turn: RowStream): void {
  if (turn.flushTimer) {
    clearTimeout(turn.flushTimer);
    turn.flushTimer = null;
  }
  // Rows keep their object identity when nothing changed, so an identity
  // comparison against the last sent version is an exact diff.
  const changed: ChatRow[] = [];
  for (const row of turn.accumulator.rows()) {
    if (turn.sent.get(row.key) === row) continue;
    turn.sent.set(row.key, row);
    changed.push(toChatRow(row));
  }
  if (changed.length > 0) {
    emit({ type: "turn.rows", conversationId: turn.conversationId, rows: changed });
  }
}

function scheduleFlush(turn: RowStream): void {
  turn.flushTimer ??= setTimeout(() => flushRows(turn), ROW_FLUSH_MS);
}

/**
 * The phase behind each known activity label.
 *
 * The chat has always shown one short sentence, and the renderer used to read
 * the phase back out of its wording. That breaks as soon as the sentence is a
 * policy explanation ("Waiting for the current destination…") rather than one
 * of these labels, so the phase travels alongside the text instead.
 */
const ACTIVITY_PHASE: Record<string, TurnActivityPhase> = {
  Starting: "starting",
  Thinking: "thinking",
  Responding: "writing",
  "Running tool": "tool",
  "Running command": "tool",
  "Waiting for approval": "approval",
  "Waiting for your answer": "question",
  Stopping: "stopping",
};

function activityPhase(activity: string | null): TurnActivityPhase | undefined {
  if (!activity) return undefined;
  return ACTIVITY_PHASE[activity] ?? (activity.startsWith("Retrying") ? "retry" : undefined);
}

function setActivity(turn: RowStream, activity: string | null, phase = activityPhase(activity)): void {
  if (turn.activity === activity) return;
  turn.activity = activity;
  emit({ type: "turn.activity", conversationId: turn.conversationId, activity, ...(phase ? { phase } : {}) });
}

function settleApprovals(turn: RowStream, message: string): void {
  for (const [requestId, pending] of turn.approvals) {
    pending.resolve({ behavior: "deny", message, interrupt: true });
    emit({ type: "approval.resolved", conversationId: turn.conversationId, requestId });
  }
  turn.approvals.clear();
}

function finishTurn(turn: Turn, error?: string): void {
  if (turn.finished || turn.handoffBlocked) return;
  if (turn.executionObserver) clearInterval(turn.executionObserver);
  turn.finished = true;
  // Hearthside: how the reply's text arrived (many pieces over time = streaming).
  const stream = turn.stream;
  if (stream.first !== null && stream.last !== null) {
    const seconds = (at: number) => ((at - stream.startedAt) / 1000).toFixed(1);
    console.log(`[stream] ${turn.conversationId}: ${stream.text} text and ${stream.reasoning} reasoning pieces; first at ${seconds(stream.first)}s, last at ${seconds(stream.last)}s, turn ended at ${seconds(Date.now())}s`);
  }
  // Hearthside: a turn that ends in an error is logged, so dropped connections can be traced.
  if (error && !turn.stopped) console.warn(`[turn] ${turn.conversationId} ended with an error: ${error.slice(0, 300)}`);

  if (error && isHandoffError(error)) void logHandoff(turn.conversationId);
  if (error) error = explainTurnError(error);
  flushRows(turn);
  // A retried attempt's rows go only after a good finish, and only those the retry didn't reproduce (turn-retry.ts).
  const retire = rowsToRetire(turn.retired ?? [], new Set(turn.sent.keys()), !error && !turn.stopped);
  turn.retired = [];
  if (retire.length > 0) emit({ type: "turn.rows.removed", conversationId: turn.conversationId, keys: retire });
  settleApprovals(turn, "The turn ended.");
  // Sessions hold a live connection to the runtime; the conversation itself is
  // durable, so the session is closed as soon as the turn is over, unless a
  // Hearthside tool is still running (see RESULT_GRACE_MS).
  if (turn.pendingTools > 0) {
    emit({ type: "turn.background", conversationId: turn.conversationId, tools: turn.pendingTools });
    turn.closeTimer = setTimeout(() => closeSession(turn), BACKGROUND_CAP_MS);
    turn.closeTimer.unref?.();
  } else if (turn.executionClient && hasRunningHelpers(turn.conversationId)) {
    remoteHelperSessions.add(turn);
    const until = Date.now() + BACKGROUND_CAP_MS;
    const check = () => {
      if (turn.sessionClosed) return;
      if (!hasRunningHelpers(turn.conversationId) || Date.now() >= until) {
        closeSession(turn);
        return;
      }
      turn.closeTimer = setTimeout(check, 2_000);
      turn.closeTimer.unref?.();
    };
    check();
  } else {
    closeSession(turn);
  }
  if (turns.get(turn.conversationId) === turn) turns.delete(turn.conversationId);
  publishOwnControls(turn.conversationId);
  if (!turn.executionClient) watchHelpers(turn.conversationId);
  const reply = [...turn.accumulator.rows()].reverse().find((row) => row.kind === "assistant" && row.text.trim());
  if (reply && reply.kind === "assistant") lastReplies.set(turn.conversationId, reply.text);
  emit({
    type: "turn.finished",
    conversationId: turn.conversationId,
    ...(error && !turn.stopped ? { error } : {}),
  });

  const conversation = conversations.get(turn.conversationId);
  if (conversation) {
    const updated = { ...conversation, updatedAt: Date.now() };
    conversations.set(updated.id, updated);
    emit({ type: "conversation.updated", conversation: updated });
  }
}

function closeSession(turn: Turn): void {
  if (turn.sessionClosed) return;
  turn.sessionClosed = true;
  remoteHelperSessions.delete(turn);
  if (turn.executionClient) markHelpersUnobserved(turn.conversationId);
  if (turn.closeTimer) clearTimeout(turn.closeTimer);
  if (turn.pendingTools > 0) console.warn(`[turn] ${turn.conversationId}: closing with ${turn.pendingTools} tool(s) still running`);
  try {
    turn.session.close();
  } catch {
    // Already closed.
  }
  void turn.executionClient?.close().catch(() => undefined);
}

/** Count a Hearthside tool as running for its turn while it executes. */
function trackTool(getTurn: () => Turn, tool: AnyAgentTool): AnyAgentTool {
  return {
    ...tool,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
      const turn = getTurn();
      turn.pendingTools += 1;
      try {
        return await tool.execute(...args);
      } finally {
        turn.pendingTools -= 1;
        if (turn.finished && !turn.sessionClosed) {
          emit({ type: "turn.background", conversationId: turn.conversationId, tools: turn.pendingTools });
          // Give the SDK a moment to send the result before the connection goes.
          if (turn.pendingTools === 0) {
            if (turn.closeTimer) clearTimeout(turn.closeTimer);
            turn.closeTimer = setTimeout(() => closeSession(turn), RESULT_GRACE_MS);
            turn.closeTimer.unref?.();
          }
        }
      }
    },
  };
}



export function sessionPermissionMode(mode: PermissionMode): { permissionMode?: PermissionMode } {
  return mode === "unrestricted" ? {} : { permissionMode: mode };
}

async function busyElsewhere(agentId: string, conversationId: string): Promise<boolean> {
  if (!cloudLink) return false;
  const client = new Letta({ apiKey: cloudLink.token(), baseURL: cloudLink.baseUrl, maxRetries: 0, timeout: 10_000 });
  const reply = (await client.get(`/v1/agents/${encodeURIComponent(agentId)}/runtime-status`, { query: { conversation_ids: conversationId } })) as { statuses?: Array<Record<string, unknown>> };
  const status = reply.statuses?.find(row => row.conversation_id === conversationId);
  // Unattributed work is still work. Never age it into permission to execute.
  if (status && (status.state !== "IDLE" || (Array.isArray(status.active_run_ids) && status.active_run_ids.length > 0))) return true;
  return busyFromStatus(status);
}

async function executionScope(conversationId: string): Promise<{ agentId: string; conversationId: string }> {
  const mainAgent = mainChatAgent(conversationId);
  if (mainAgent) return { agentId: mainAgent, conversationId: "default" };
  const cached = conversations.get(conversationId);
  if (cached) return { agentId: cached.agentId, conversationId };
  const sdk = await ensureClient();
  const conversation = toConversationSummary(await sdk.conversations.retrieve(conversationId));
  if (conversation.id !== conversationId) throw new Error("Letta returned a different conversation.");
  conversations.set(conversationId, conversation);
  return { agentId: conversation.agentId, conversationId };
}

function reconcileDesktopAcceptance(chatId: string, raw: unknown, scope: { agentId: string; conversationId: string }): void {
  const turn = turns.get(chatId);
  if (!turn?.desktopAcceptance) return;
  const reply = raw as { agent_id?: unknown; statuses?: Array<Record<string, unknown>> } | null;
  const matches = Array.isArray(reply?.statuses) ? reply.statuses.filter(status => status?.conversation_id === scope.conversationId) : [];
  const status = matches[0];
  const harness = status?.active_harness as { connection_id?: unknown; managed_sandbox?: unknown; type?: unknown; kind?: unknown } | null;
  // Contradictory/unattributed evidence retires this display exception, even if
  // activity is old. A later matching poll must never recreate send acceptance.
  if (getExecutionState(chatId).status === "blocked" || reply?.agent_id !== scope.agentId || matches.length !== 1 || status?.has_conflicting_listeners
    || !harness || harness.connection_id !== turn.desktopAcceptance.connectionId
    || harness.managed_sandbox === true || harness.type === "managed_sandbox" || harness.kind === "managed_sandbox") {
    turn.desktopAcceptance = undefined;
  }
}

function hasAcceptedDesktopTurn(state: ConversationExecutionState): boolean {
  const turn = turns.get(state.conversationId);
  const receipt = turn?.desktopAcceptance;
  if (!turn || !receipt) return false;
  if (state.status === "blocked" || state.pendingDelivery || receipt.account !== getSettings().connectionRevision || receipt.agentId !== agentIdFor(state.conversationId)
    || receipt.link !== cloudLink || receipt.server !== server || receipt.generation !== controlGeneration()) {
    turn.desktopAcceptance = undefined;
    return false;
  }
  return Boolean(!turn.executionClient && !turn.finished && !turn.stopped && !turn.sessionClosed
    && !turn.handoffBlocked && !turn.submissionUnknown && !turn.nativeTeleportPending
    && state.provenance === "desktop"
    && state.desktopConnectionId === receipt.connectionId && conversationTarget(state.conversationId).kind === "desktop"
    && (!state.observed || (state.observed.kind !== "cloud" && state.observed.connectionId === receipt.connectionId))
    && connection.status === "ready");
}

function withOwnerRouting(state: ConversationExecutionState, currentOwner: string | null | undefined = state.status === "confirmed" ? state.observed?.connectionId : null): ConversationExecutionState {
  // Cached observations are display history, not current execution authority.
  // In particular, fresh idle/null must override an old app-server observation.
  const owner = state.status === "confirmed" ? currentOwner : null;
  const explicitMove = state.moveFrom !== undefined && state.moveFrom.connectionId === (currentOwner ?? null);
  const uncertain = state.status === "blocked" || (state.status === "unknown" && Boolean(state.detail) && state.detail !== "Conversation is idle; no active harness.");
  const localOwner = !uncertain && state.provenance === "desktop" && (!owner || owner === state.desktopConnectionId);
  const selectedOwner = !uncertain && state.provenance === "selected" && Boolean(state.selectedConnectionId) && (!owner || owner === state.selectedConnectionId);
  const explicitFollow = state.selected.kind === "follow-owner" && state.provenance === "owner";
  // Resolved SDK submission on an attached turn needs no new destination prompt.
  // This also affects renderer admission hints; main-process send/move/access
  // checks stay independent. It is not an input_accepted acknowledgement.
  const acceptedDesktop = hasAcceptedDesktopTurn(state);
  const requiresDestination = Boolean(cloudLink && !localOwner && !selectedOwner && !explicitFollow && !explicitMove && !state.pendingDelivery && !acceptedDesktop);
  return { ...state, requiresDestination, followsOwner: destinationTurns.has(state.conversationId) || Boolean(state.pendingDelivery) || explicitFollow };
}

function deliveryDiagnosticDetail(result: Awaited<ReturnType<typeof observeEnqueuedTurn>>): string | undefined {
  const diagnostic = result.diagnostic;
  if (!diagnostic || !["super-run", "child-run", "reply"].includes(diagnostic.stage)
    || !["unavailable", "invalid-evidence", "not-terminal", "approval-required"].includes(diagnostic.reason)) return undefined;
  const prefix = result.state === "completed" ? "Delivery completed; optional reply unavailable" : "Delivery remains held; checking exact completion";
  return `${prefix} (${diagnostic.stage}: ${diagnostic.reason}).`;
}

function sameDeliveryReceipt(left: ConversationExecutionState["pendingDelivery"], right: ConversationExecutionState["pendingDelivery"]): boolean {
  return Boolean(left && right && left.agentId === right.agentId && left.conversationId === right.conversationId
    && left.clientMessageId === right.clientMessageId && left.superRunId === right.superRunId && left.workflowId === right.workflowId);
}

function executionEligibility(chatId: string, raw: unknown, scope: { agentId: string; conversationId: string }): Pick<ConversationExecutionState, "canFollowCurrentOwner" | "canMoveExecution"> {
  const denied = { canFollowCurrentOwner: false, canMoveExecution: false };
  const state = getExecutionState(chatId);
  const turn = turns.get(chatId);
  if (state.pendingDelivery || destinationTurns.has(chatId) || preparingTurns.has(chatId) || (turn && !turn.handoffBlocked)) return denied;
  const reply = raw as { agent_id?: unknown; snapshot_at?: unknown; statuses?: Array<Record<string, unknown>> } | null;
  if (reply?.agent_id !== scope.agentId || !Array.isArray(reply.statuses)) return denied;
  const matches = reply.statuses.filter(status => status?.conversation_id === scope.conversationId);
  const status = matches[0];
  if (matches.length !== 1 || !status || status.has_conflicting_listeners) return denied;
  if (reply.snapshot_at !== undefined && (typeof reply.snapshot_at !== "number" || !Number.isFinite(reply.snapshot_at) || Math.abs(Date.now() - reply.snapshot_at) > 30_000)) return denied;
  const idle = status.state === "IDLE" && Array.isArray(status.active_run_ids) && status.active_run_ids.length === 0;
  const harness = status.active_harness as { connection_id?: unknown } | null;
  const timestamp = reply.snapshot_at ?? status.last_activity_at;
  const freshOwner = typeof harness?.connection_id === "string" && Boolean(harness.connection_id.trim())
    && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp <= Date.now() + 5_000 && Date.now() - timestamp <= 120_000;
  return { canFollowCurrentOwner: freshOwner && !turn, canMoveExecution: idle };
}

/** Read-only ownership evidence; this must never initialize a hosted SDK session. */
export async function getConversationExecution(conversationId: string): Promise<ConversationExecutionState> {
  return executionView(conversationId, await readConversationExecution(conversationId));
}

async function readConversationExecution(conversationId: string): Promise<ConversationExecutionState> {
  const identity = getSettings().connectionRevision;
  const scope = await executionScope(conversationId);
  if (!cloudLink) {
    // Local backend: no owner to follow, and no Cloud status to consult. Moving
    // between local targets is allowed unless this chat has held or unresolved work.
    const state = getExecutionState(conversationId);
    const turn = turns.get(conversationId);
    const busy = Boolean(state.pendingDelivery) || destinationTurns.has(conversationId) || preparingTurns.has(conversationId) || Boolean(turn && !turn.handoffBlocked);
    return { ...state, canFollowCurrentOwner: false, canMoveExecution: !busy };
  }
  const link = cloudLink;
  const beforeRecovery = getExecutionState(conversationId);
  const pending = beforeRecovery.pendingDelivery;
  let recoveryDetail: string | undefined;
  let recoveryRevision: number | undefined;
  if (pending?.superRunId && !destinationTurns.has(conversationId) && pending.agentId === scope.agentId && pending.conversationId === scope.conversationId) {
    const result = await observeEnqueuedTurn({ access: link, ...pending, superRunId: pending.superRunId });
    if (identity !== getSettings().connectionRevision || cloudLink !== link) throw new Error("Connection changed during delivery recovery.");
    const current = getExecutionState(conversationId);
    if (current.revision === beforeRecovery.revision && sameDeliveryReceipt(current.pendingDelivery, pending)) {
      recoveryDetail = deliveryDiagnosticDetail(result);
      if (result.state === "completed" || result.state === "failed") {
        try { completeExecutionDelivery(conversationId); }
        catch { recoveryDetail = "The destination finished, but Hearthside could not save its completion. This input stays held while saving is retried."; }
      }
      recoveryRevision = getExecutionState(conversationId).revision;
    }
  }
  // Diagnostics are display-only: polling must not write receipt state to disk.
  const withRecoveryDetail = (state: ConversationExecutionState, expectedRevision = state.revision): ConversationExecutionState =>
    recoveryDetail && expectedRevision === recoveryRevision ? { ...state, detail: recoveryDetail } : state;
  const revision = getExecutionState(conversationId).revision;
  const evidenceScope = JSON.stringify([identity, link.baseUrl, scope.agentId, scope.conversationId]);
  const priorEvidence = remoteHelperEvidence.get(conversationId);
  if (priorEvidence && priorEvidence.scope !== evidenceScope) stopRemoteHelperObserver(conversationId);
  // Object identity fences overlapping requests even while admission remains blocked.
  const evidence = { scope: evidenceScope, revision: priorEvidence?.scope === evidenceScope ? priorEvidence.revision : -1 };
  remoteHelperEvidence.set(conversationId, evidence);
  try {
    const api = new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 });
    const response = await api.get(`/v1/agents/${encodeURIComponent(scope.agentId)}/runtime-status`, { query: { conversation_ids: scope.conversationId } });
    if (identity !== getSettings().connectionRevision || cloudLink !== link) throw new Error("The connection changed while checking execution.");
    if (!response || (response as { agent_id?: unknown }).agent_id !== scope.agentId) throw new Error("Runtime status belongs to a different agent.");
    const beforeObservation = getExecutionState(conversationId);
    const ownership = helperOwnership(response, scope, evidence.revision);
    const acceptedObservation = beforeObservation.revision === revision && remoteHelperEvidence.get(conversationId) === evidence && ownership !== undefined;
    if (acceptedObservation) reconcileDesktopAcceptance(conversationId, response, scope);
    const validated = acceptedObservation ? observeExecution(conversationId, response, scope.conversationId, revision) : beforeObservation;
    const state = { ...withRecoveryDetail(withOwnerRouting(validated, validated.status === "confirmed" ? validated.observed?.connectionId : null), beforeObservation.revision),
      ...(acceptedObservation ? executionEligibility(conversationId, response, scope) : { canFollowCurrentOwner: false, canMoveExecution: false }) };
    executionObservationDiagnostic(response, { ...scope, connectionRevision: identity }, state, acceptedObservation);
    // A superseded response cannot replace or retire the current observer.
    if (!acceptedObservation) {
      emit({ type: "conversation.execution", state: executionView(conversationId, state) });
      return state;
    }
    // Observe the verified destination, never the desktop's process-local snapshot.
    // No SDK session, sync, runtime_start or ownership mutation is involved.
    evidence.revision = ownership!.revision;
    const validatedOwner = ownership!.owner;
    const helperOwner = validatedOwner && !validatedOwner.startsWith("app-server") ? validatedOwner : null;
    const previous = remoteHelperObservers.get(conversationId);
    const sessionObservesHelpers = Boolean(turns.get(conversationId)?.executionClient) || [...remoteHelperSessions].some(turn => turn.conversationId === conversationId);
    if (previous && (previous.owner !== helperOwner || sessionObservesHelpers)) stopRemoteHelperObserver(conversationId);
    if (previous && previous.owner === helperOwner && !sessionObservesHelpers) previous.intent = helperObservationIntent(state);
    if (helperOwner && !remoteHelperObservers.has(conversationId) && !sessionObservesHelpers) {
      const observer = { owner: helperOwner, intent: helperObservationIntent(state), retired: false, close: () => {} };
      remoteHelperObservers.set(conversationId, observer);
      try {
        observer.close = observeRemoteHelpers({
          chatId: conversationId, ...scope, connectionId: helperOwner,
          baseUrl: link.baseUrl, token: link.token(),
          current: () => {
            const latest = getExecutionState(conversationId);
            return cloudLink === link && identity === getSettings().connectionRevision && remoteHelperObservers.get(conversationId) === observer
              && !observer.retired && helperObservationIntent(latest) === observer.intent;
          },
          canRetire: () => cloudLink === link && identity === getSettings().connectionRevision && remoteHelperObservers.get(conversationId) === observer,
          closed: () => { if (remoteHelperObservers.get(conversationId) === observer) remoteHelperObservers.delete(conversationId); },
        });
      } catch {
        stopRemoteHelperObserver(conversationId);
      }
    }
    emit({ type: "conversation.execution", state: executionView(conversationId, state) });
    return state;
  } catch (error) {
    if (identity !== getSettings().connectionRevision || cloudLink !== link) throw error;
    if (remoteHelperEvidence.get(conversationId) !== evidence || getExecutionState(conversationId).revision !== revision) return withOwnerRouting(getExecutionState(conversationId));
    stopRemoteHelperObserver(conversationId);
    const state = withRecoveryDetail(withOwnerRouting(markExecutionUnknown(conversationId, "Execution observation is temporarily unavailable. Refresh to verify the location.")), revision);
    executionObservationDiagnostic(undefined, { ...scope, connectionRevision: identity }, state, false);
    emit({ type: "conversation.execution", state: executionView(conversationId, state) });
    return state;
  }
}

async function admissionOwner(conversationId: string): Promise<string | null> {
  const link = cloudLink;
  const account = getSettings().connectionRevision;
  if (!link) throw new Error("Cloud ownership cannot be checked.");
  const scope = await executionScope(conversationId);
  const api = new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 });
  const raw = await api.get(`/v1/agents/${encodeURIComponent(scope.agentId)}/runtime-status`, { query: { conversation_ids: scope.conversationId } }) as { agent_id?: unknown; snapshot_at?: unknown; statuses?: Array<Record<string, unknown>> };
  if (cloudLink !== link || account !== getSettings().connectionRevision || raw?.agent_id !== scope.agentId || !Array.isArray(raw.statuses)) throw new Error("Cannot verify execution ownership; nothing was sent.");
  const matches = raw.statuses.filter(status => status?.conversation_id === scope.conversationId);
  const status = matches[0];
  const timestamp = raw.snapshot_at ?? status?.last_activity_at;
  if (matches.length !== 1 || !status || status.has_conflicting_listeners ||
      (raw.snapshot_at !== undefined && (typeof raw.snapshot_at !== "number" || !Number.isFinite(raw.snapshot_at) || Math.abs(Date.now() - raw.snapshot_at) > 120_000))) {
    throw new Error("Execution ownership is missing, conflicting or stale; nothing was sent.");
  }
  const harness = status.active_harness;
  if (harness == null && status.state === "IDLE" && Array.isArray(status.active_run_ids) && status.active_run_ids.length === 0) {
    // A fresh idle GET needs no recent activity: inactivity is the expected state.
    // Desktop provenance or explicit consent, not this absence, grants routing.
    return null;
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp > Date.now() + 5_000 || Date.now() - timestamp > 120_000) throw new Error("Execution ownership is stale; nothing was sent.");
  if (!harness || typeof harness !== "object" || typeof (harness as { connection_id?: unknown }).connection_id !== "string" || !(harness as { connection_id: string }).connection_id.trim()) {
    throw new Error("Execution ownership has no verified listener identity; nothing was sent.");
  }
  return (harness as { connection_id: string }).connection_id;
}

// Requests are ordered at entry, not by the completion of their network reads.
const executionSelections = new Map<string, symbol>();
export async function setConversationExecution(
  conversationId: string,
  target: ConversationExecutionTarget,
  options?: {
    /**
     * Refuse if Letta names any listener for this conversation.
     *
     * For a caller that decided what to do *because* the conversation was idle:
     * an owner appearing between that observation and this change means the
     * decision was made on facts that no longer hold, and the change must not
     * quietly stand in for a handoff nobody asked for.
     */
    requireUnowned?: boolean;
    /**
     * A caller's own precondition, re-proved at the last possible moment.
     *
     * Everything above re-reads Letta. A caller whose decision also rests on
     * facts Letta knows nothing about — which app serves a chat's Discord bot,
     * say — has no way to hold this change to them, and its own earlier check
     * was made several awaited network reads ago.
     *
     * Awaited last, so that nothing but synchronous fences stands between it
     * and the change being written: in-memory facts cannot move while
     * synchronous code runs, so what this proves is what gets committed.
     */
    assertStillValid?: () => Promise<void>;
  },
): Promise<ConversationExecutionState> {
  const request = Symbol();
  executionSelections.set(conversationId, request);
  const link = cloudLink;
  const follow = target.kind === "follow-owner";
  if (getExecutionState(conversationId).pendingDelivery) throw new Error("Delivery is unresolved. Reconcile the retained input IDs in Letta before changing destination; selection cannot acknowledge or replay it.");
  let selectedOwner: string | null = null;
  const identity = getSettings().connectionRevision;
  const heldTurn = turns.get(conversationId);
  const heldDestination = destinationTurns.get(conversationId);
  if (heldTurn?.submissionUnknown || heldDestination?.acceptanceUnknown) throw new Error("Delivery is unresolved; selection cannot acknowledge uncertain acceptance.");
  if ((heldDestination && !heldDestination.acceptanceUnknown) || (heldTurn && !heldTurn.handoffBlocked) || preparingTurns.has(conversationId)) throw new Error("Wait for this chat to finish before changing its destination.");
  const scope = await executionScope(conversationId);
  if (getConnectionConfig().backend !== "cloud" && target.kind !== "default" && target.kind !== "desktop") throw new Error("Cloud execution requires a Letta Cloud connection.");
  if (follow) {
    // Consent to native current-destination delivery is not permission to move
    // ownership. A busy verified owner is valid; source detachment still needs idle.
    selectedOwner = await admissionOwner(conversationId);
    if (!selectedOwner) throw new Error("No verified current destination. Choose a destination explicitly; nothing was sent.");
    if (heldTurn || heldDestination) throw new Error("Finish the held source before following its destination.");
  } else if (cloudLink) {
    const api = new Letta({ apiKey: cloudLink.token(), baseURL: cloudLink.baseUrl, maxRetries: 0, timeout: 10_000 });
    const response = await api.get(`/v1/agents/${encodeURIComponent(scope.agentId)}/runtime-status`, { query: { conversation_ids: scope.conversationId } }) as { agent_id?: string; snapshot_at?: unknown; statuses?: Array<Record<string, unknown>> };
    if (response.snapshot_at !== undefined && (typeof response.snapshot_at !== "number" || !Number.isFinite(response.snapshot_at) || Math.abs(Date.now() - response.snapshot_at) > 30_000)) throw new Error("Letta returned stale idle evidence.");
    const matches = response.statuses?.filter(status => status.conversation_id === scope.conversationId) ?? [];
    const status = matches[0];
    if (response.agent_id !== scope.agentId || matches.length !== 1 || status?.state !== "IDLE" || status.has_conflicting_listeners || !Array.isArray(status.active_run_ids) || status.active_run_ids.length !== 0) {
      throw new Error("Letta has not confirmed this exact conversation is idle. Its destination was not changed.");
    }
    const harness = status.active_harness as { connection_id?: unknown } | null;
    selectedOwner = typeof harness?.connection_id === "string" ? harness.connection_id : null;
    // A harness Letta names but this build cannot read is not an absence. Only
    // `active_harness` being null at all is evidence of nobody, so a caller that
    // needs "unowned" is refused on any harness, readable or not.
    if (options?.requireUnowned && (harness != null || selectedOwner !== null)) {
      throw new Error("This conversation has an active destination of its own. Nothing was changed or sent; check where it is running and choose again.");
    }
  }
  if (options?.requireUnowned && !cloudLink) throw new Error("Cannot verify this conversation is unowned without Letta Cloud; nothing was changed.");
  // The last await before the change, deliberately: see `assertStillValid`.
  await options?.assertStillValid?.();
  if (executionSelections.get(conversationId) !== request) throw new Error("This destination selection was superseded by a newer request.");
  if (getExecutionState(conversationId).pendingDelivery || heldTurn?.submissionUnknown || heldDestination?.acceptanceUnknown) throw new Error("Delivery is unresolved; its retained receipt cannot be cleared by selection.");
  if (cloudLink !== link || identity !== getSettings().connectionRevision || turns.get(conversationId) !== heldTurn || destinationTurns.get(conversationId) !== heldDestination || preparingTurns.has(conversationId)) throw new Error("This chat or connection changed while selecting its destination.");
  if (heldTurn) {
    if (!cloudLink) throw new Error("Cannot verify the destination is idle without Letta Cloud.");
    heldTurn.finished = true;
    if (heldTurn.executionObserver) clearInterval(heldTurn.executionObserver);
    // Closing the source transport is not an abort or a new turn on the target.
    heldTurn.approvals.clear();
    closeSession(heldTurn);
    turns.delete(conversationId);
    emit({ type: "turn.detached", conversationId });
  }
  if (heldDestination) {
    heldDestination.controller.abort();
    if (heldDestination.observer) clearInterval(heldDestination.observer);
    destinationTurns.delete(conversationId);
    emit({ type: "turn.detached", conversationId }); // Explicit acknowledgement, never auto-replay.
  }
  stopRemoteHelperObserver(conversationId);
  const selected = selectExecution(conversationId, target);
  const state = withOwnerRouting(follow ? selected : acknowledgeExecutionMove(conversationId, selectedOwner), selectedOwner);
  emit({ type: "conversation.execution", state: executionView(conversationId, state) });
  return state;
}

export function assertConversationDesktopAccess(conversationId: string | null): void {
  if (!conversationId) { if (executionTarget()) throw new Error("Open the chat before accessing its files."); return; }
  const state = getExecutionState(conversationId);
  if (state.observed?.kind === "cloud" || conversationTarget(conversationId).kind === "cloud") throw new Error("This file or command belongs to Cloud. Hearthside cannot yet pin downloads to its observed connection; use Letta's sandbox commands there. Nothing ran on this desktop.");
  // An unidentified computer observation is not proof that our owned desktop
  // app-server moved. Preserve explicit desktop operations unless ownership loss
  // is proven, or this conversation selected remote execution.
  // An actually attached owned session is local provenance, unlike an idle
  // chat's absent harness or saved desktop preference. Verified other-owner
  // evidence still invalidates that exception.
  const turn = turns.get(conversationId);
  const attachedDesktop = turn && !turn.executionClient && !turn.finished && !turn.stopped && !turn.handoffBlocked &&
    (!state.observed?.connectionId || state.observed.connectionId === "app-server");
  const establishedDesktop = state.provenance === "desktop" && (!state.moveFrom || state.moveFrom.connectionId === null || state.moveFrom.connectionId === state.desktopConnectionId);
  if ((cloudLink && !establishedDesktop && !attachedDesktop) || (withOwnerRouting(state).followsOwner && !attachedDesktop) || state.status === "blocked" || conversationTarget(conversationId).kind !== "desktop") {
    throw new Error("This chat is not confirmed on this desktop. Its files and commands will not run here.");
  }
}

/**
 * Hearthside: what a chat's sandbox links need: the Letta Cloud sign-in and the
 * chat's agent. Refused while a reply from here runs in that chat: asking Letta
 * for the chat's sandbox then could hand the reply over to it mid-way.
 */
export function sandboxLinkAccess(conversationId: string | null): { access: CloudAccess; scope: ChatScope } {
  if (conversationId) {
    const state = getExecutionState(conversationId);
    if (state.status !== "confirmed" || state.observed?.kind !== "cloud") throw new Error("This chat has no confirmed Cloud sandbox. Opening a link must not move it.");
    throw new Error("Hearthside cannot yet pin sandbox links to this conversation's observed Cloud connection. Use Letta's sandbox download or desktop command there; no new sandbox was started.");
  }
  if (!cloudLink) throw new Error("This only works for agents on Letta Cloud.");
  if (!conversationId) throw new Error("Open the chat the link is in first.");
  if (turns.has(conversationId) || preparingTurns.has(conversationId)) {
    throw new Error("Your companion is still replying in this chat. Try the link again when the reply has finished.");
  }
  const mainAgent = mainChatAgent(conversationId);
  const agentId = mainAgent ?? conversations.get(conversationId)?.agentId;
  if (!agentId) throw new Error("Open the chat the link is in first.");
  return { access: { token: cloudLink.token(), baseUrl: cloudLink.baseUrl }, scope: { agentId, conversationId: mainAgent ? "default" : conversationId } };
}

/**
 * Hearthside: helpers still shown as working when no reply from here is running get their status
 * from the runtime (a resync replays it). Hearthside hears helpers only while its own reply runs,
 * so one that finishes afterwards (a background memory helper) kept showing as working.
 */
export async function settleHelpers(chatId: string): Promise<void> {
  // A viewing-time sync can recover work on the owned app-server. Cloud chats
  // must remain wherever their native runtime put them, even without a cached
  // ownership observation. Live attached sessions still receive helper events.
  // Installed CLI sync can start recovered approval continuations even with
  // recover/auto flags false. No GET ownership check makes that passive.
  // Cloud viewing therefore uses cached/live helper events only, including for
  // idle desktop-provenance chats. Ordinary owned turns still report helpers.
  if (getConnectionConfig().backend === "cloud") {
    await getConversationExecution(chatId); // Read-only owner GET + passive scoped relay.
    return;
  }
  // A local sync would ask the wrong runtime to resume this remote chat.
  // Remote helper snapshots arrive on the retained hosted relay instead.
  if (conversationTarget(chatId).kind !== "desktop" || getExecutionState(chatId).observed?.kind === "cloud" || getExecutionState(chatId).status === "blocked") return;
  if (turns.has(chatId) || !hasRunningHelpers(chatId)) return;
  const mainAgent = mainChatAgent(chatId);
  const agentId = mainAgent ?? conversations.get(chatId)?.agentId;
  if (!agentId) return;
  const snapshot = await subagentSnapshot({ agent_id: agentId, conversation_id: mainAgent ? "default" : chatId });
  if (snapshot) settleFromSnapshot(chatId, snapshot);
}

const helperWatches = new Map<string, NodeJS.Timeout>();

/** After a reply ends with helpers still working: ask every 10 seconds, for up to an hour. */
function watchHelpers(chatId: string): void {
  if (helperWatches.has(chatId) || !hasRunningHelpers(chatId)) return;
  const until = Date.now() + 60 * 60_000;
  const timer = setInterval(() => {
    if (turns.has(chatId)) return;
    if (Date.now() > until || !hasRunningHelpers(chatId)) {
      clearInterval(timer);
      helperWatches.delete(chatId);
      return;
    }
    void settleHelpers(chatId).catch(() => undefined);
  }, 10_000);
  timer.unref?.();
  helperWatches.set(chatId, timer);
}

async function logHandoff(conversationId: string): Promise<void> {
  const agentId = mainChatAgent(conversationId) ?? conversations.get(conversationId)?.agentId;
  if (!cloudLink || !agentId) return;
  try {
    const client = new Letta({ apiKey: cloudLink.token(), baseURL: cloudLink.baseUrl, maxRetries: 0, timeout: 10_000 });
    const target = mainChatAgent(conversationId) ? "default" : conversationId;
    const reply = (await client.get(`/v1/agents/${encodeURIComponent(agentId)}/runtime-status`, { query: { conversation_ids: target } })) as { statuses?: Array<Record<string, unknown>> };
    const status = reply.statuses?.[0] ?? {};
    console.warn(`[turn] ${conversationId}: handed elsewhere; Letta says ${JSON.stringify({ state: status.state, runs: status.active_run_ids, loop: (status.loop_state as { status?: unknown } | null)?.status, conflicting: status.has_conflicting_listeners, last: status.last_activity_at })}`);
  } catch (error) {
    console.warn(`[turn] ${conversationId}: handed elsewhere; Letta's status couldn't be read (${describeError(error)})`);
  }
}

/** What a held message shows while it waits (see waitWhileBusyElsewhere). */
const preparingActivity = new Map<string, string>();

async function waitWhileBusyElsewhere(conversation: ConversationSummary, signal: AbortSignal): Promise<void> {
  signal.addEventListener("abort", () => preparingActivity.delete(conversation.id), { once: true });
  if (!cloudLink) return;
  const target = mainChatAgent(conversation.id) ? "default" : conversation.id;
  let waiting = false;
  for (;;) {
    signal.throwIfAborted();
    let busy: boolean;
    try {
      busy = await busyElsewhere(conversation.agentId, target);
    } catch {
      if (executionTarget()) {
        preparingActivity.delete(conversation.id);
        throw new Error("Couldn't check whether this chat is already running elsewhere. Nothing was sent to the selected computer; try again when Letta is reachable.");
      }
      // Letta can't say: send as before rather than hold the message.
      preparingActivity.delete(conversation.id);
      return;
    }
    if (!busy) {
      preparingActivity.delete(conversation.id);
      if (waiting) emit({ type: "turn.activity", conversationId: conversation.id, activity: "Starting" });
      return;
    }
    if (!waiting) {
      waiting = true;
      console.log(`[turn] ${conversation.id}: busy elsewhere, holding the message`);
    }
    preparingActivity.set(conversation.id, BUSY_ELSEWHERE_ACTIVITY);
    emit({ type: "turn.activity", conversationId: conversation.id, activity: BUSY_ELSEWHERE_ACTIVITY });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, BUSY_CHECK_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Not sent: you stopped it while this chat was busy somewhere else. It's back in the message box."));
      }, { once: true });
    });
  }
}

function blockHandoffControls(turn: Turn, detail: string, phase: TurnActivityPhase = "held"): void {
  if (turn.handoffBlocked || turn.finished) return;
  turn.handoffBlocked = true;
  if (turn.executionObserver) clearInterval(turn.executionObserver);
  const state = blockExecution(turn.conversationId, detail);
  emit({ type: "conversation.execution", state: executionView(turn.conversationId, state) });
  setActivity(turn, detail, phase);
  // Do not resolve approvals against an old owner, abort it, send a continuation,
  // or emit turn.finished (which would release the renderer's input queue).
}

/**
 * Ownership as Letta reported it moments ago, for one conversation.
 *
 * `owner: null` is a verified "nobody is running this". Absent (no
 * `FreshOwnership` at all) is the weaker case: nothing was read, so the cached
 * observation is the best that can be said.
 */
type FreshOwnership = {
  conversationId: string;
  /**
   * The verified listener, `null` for a verified "nobody", and `undefined` when
   * the read did not come back or could not be trusted. The last of those is
   * not the cache's cue to speak up: it means no place may claim the
   * conversation, and the action re-checks before doing anything.
   */
  owner: string | null | undefined;
};

/**
 * Whether a place may be shown as running this conversation *now*.
 *
 * Ownership decides whether anything is running at all; the stored observation
 * only supplies the identity — which device, or Cloud — of that same
 * connection. So:
 *
 * - Verified unowned: nothing is running anywhere, whatever was last seen. This
 *   is the repair. A conversation observed on a computer thirty seconds ago and
 *   idle on the server now was being offered as "already running here", which
 *   refused the one choice that would have unstranded it.
 * - Verified owner we can identify: that place is where it runs.
 * - Verified owner we cannot identify, or ownership we could not read at all: it
 *   may be running somewhere this app cannot name, so no place claims it. The
 *   action re-checks and refuses truthfully.
 * - Nothing read: a still-confirmed observation, demoted by `getExecutionState`
 *   once it ages out of the freshness window.
 */
function freshlyRunning(
  conversationId: string,
  state: ConversationExecutionState,
  fresh: FreshOwnership | undefined,
): ConversationExecutionState["observed"] {
  const cached = state.observed;
  if (!fresh || fresh.conversationId !== conversationId) return state.status === "confirmed" ? cached : null;
  if (!fresh.owner) return null;
  return cached && cached.connectionId === fresh.owner ? cached : null;
}

/**
 * The move orchestrator's view of this runtime.
 *
 * Kept to a factory so the orchestration itself stays in its own module: this
 * is only the wiring that knows about `cloudLink`, the conversation map and the
 * event emitter.
 *
 * `fresh` is ownership this caller has just read authoritatively. Passing it is
 * what lets `places` speak about now rather than about the last observation, and
 * passing the *same* environment on to `startMove` keeps its re-check on the
 * very fact the branch was chosen for.
 */
/**
 * Why this app cannot take a conversation's own turns, or null when it can.
 *
 * The decision itself is `appLocalChannelRefusal`; this is only the evidence
 * gathering, and it is deliberately the pessimistic kind. Each read can throw —
 * the bot records live in settings, the service status in the gateway module,
 * the bindings in the channel service — and a throw means this process does not
 * know who serves the chat's channel. That is a refusal, not a zero.
 * `hosts: null` is how "could not read" is said, so it can never be mistaken
 * for "no bot is bound", and an unreadable binding is `runtimeBinding: null`
 * rather than an assumed agreement.
 *
 * `routes` is null when the route list itself failed. Passing [] for that would
 * claim the chat has no channel, which is the one wrong answer that silently
 * lets the chat run here while Discord answers from somewhere else.
 *
 * The service is asked about this chat's own bots only when it is already
 * running. Every read through the gateway starts the channel service if it is
 * down (`gatewayRequest` sets `wanted`), and deciding where a chat runs must
 * never switch a bot on; a service that is not running is a refusal anyway.
 */
async function appLocalRefusal(
  identity: { agentId: string; scopedConversationId: string },
  conversationId: string,
  routes: Array<{ conversationId: string; enabled: boolean; channelId: string; accountId: string }> | null,
): Promise<string | null> {
  const bound = routes === null ? [] : boundChannelRoutes(routes, identity.scopedConversationId, conversationId);
  let hosts: ChannelHost[] | null = null;
  let service: "off" | "starting" | "running" | "failed" | "blocked" | "unknown" = "unknown";
  if (routes !== null && bound.length > 0) {
    try {
      service = channelServiceStatus().state;
    } catch {
      service = "unknown";
    }
    const answering = service === "running" ? await answeringBots(bound, identity.agentId) : new Map<string, AnsweringBot>();
    try {
      hosts = [...new Set(bound.map((route) => route.accountId))].map((accountId) => {
        const owner = botOwner(accountId);
        const reported = answering.get(accountId);
        return {
          channelId: bound.find((route) => route.accountId === accountId)?.channelId ?? "",
          accountId,
          agentId: owner.agentId,
          here: owner.here,
          transferPending: owner.transfer != null,
          hearthsideOwned: owner.hearthsideOwned,
          runtimeBinding: reported?.boundAgentId ?? null,
          answering: reported?.answering === true,
        };
      });
    } catch {
      hosts = null; // Unreadable bot records are not an absence of bots.
    }
  }
  return appLocalChannelRefusal({ routesKnown: routes !== null, bound, hosts, service, agentId: identity.agentId });
}

/** What the channel service itself says about one bot: who it routes to, and whether it routes. */
type AnsweringBot = { boundAgentId: string | null; answering: boolean };

/**
 * The channel service's own account list, for the bots this chat's routes name.
 *
 * `inventoryChannelAccounts` is the strict reader, the one built for a decision
 * rather than a screen: it refuses a reply it cannot read instead of
 * normalising the gaps into "no owner, no binding, not here". That is exactly
 * the difference that matters here, so a channel whose list does not come back
 * contributes no entries at all — and a bot with no entry cannot be proved to
 * answer for this companion, so it is refused rather than assumed.
 */
async function answeringBots(
  bound: Array<{ channelId: string; accountId: string }>,
  agentId: string,
): Promise<Map<string, AnsweringBot>> {
  const answering = new Map<string, AnsweringBot>();
  const channelIds = [...new Set(bound.map((route) => route.channelId))];
  const lists = await Promise.all(channelIds.map((channelId) =>
    inventoryChannelAccounts(channelId, agentId).then((accounts) => accounts, () => null)));
  for (const accounts of lists) {
    for (const account of accounts ?? []) {
      answering.set(account.accountId, {
        boundAgentId: account.boundAgentId,
        // Both, positively: an account the service has switched off answers
        // nothing, and one it has not enabled is not asked to.
        answering: account.running && account.enabled,
      });
    }
  }
  return answering;
}

/**
 * The scope a chat's channel routes are read under: its companion, and the
 * conversation id Hearthside's own routes are written against (a companion's
 * main chat is Letta's `default`). Shared by the picker and by the two
 * revalidations, so they cannot come to read different routes for one chat.
 */
function channelScope(conversationId: string): { agentId: string; scopedConversationId: string } | null {
  const agentId = agentIdFor(conversationId);
  if (!agentId) return null;
  return { agentId, scopedConversationId: mainChatAgent(conversationId) ? "default" : conversationId };
}

/**
 * A recorded, acknowledged "run in this app" choice — consent, never an
 * observation. The app-server is never *observed* as an owner, and the ordinary
 * desktop default carries no `moveFrom`, so this is what separates the explicit
 * choice from a chat that simply has never been placed anywhere.
 */
function choseThisApp(state: ConversationExecutionState): boolean {
  return state.selected.kind === "desktop" && state.moveFrom !== undefined;
}

/**
 * Re-prove, from scratch, that this app may host this chat's channel-bound
 * turns; throw its reason if it may not.
 *
 * Needed twice over, because the facts it reads are not Letta's and nothing
 * else re-reads them. The picker's check happened before the click; between
 * then and now a bot can be claimed, reassigned, switched off, moved to another
 * companion, or have a new route bound to it, and the channel service can stop.
 * `requireUnowned` and `admissionOwner` would all still pass: they speak about
 * who *runs* the conversation, and nobody does.
 *
 * Not a `DestinationRequired`: that reason exists so the person's held message
 * can go by itself once the missing destination is chosen, and this destination
 * is not missing — it is recorded, and no longer safe. Releasing on it would
 * re-send into the same refusal in a loop. The choice is left exactly as the
 * person made it; only the send stops, with the reason and the step that
 * changes it.
 */
async function assertAppLocalChannelHosting(conversationId: string): Promise<void> {
  // The same condition the conversation listing uses before it reads routes at
  // all. A route cannot exist before channels have been set up, and asking
  // would start the channel service (`gatewayRequest` sets `wanted`) — so a
  // chat in an app with no channels is left alone rather than proved about.
  if (!channelsUsed()) return;
  const identity = channelScope(conversationId);
  if (!identity) throw new Error("Hearthside couldn't tell which companion this chat belongs to, so it won't take its turns here. Nothing was sent.");
  const routes = await listChannelRoutes(identity.agentId).then((answer) => answer, () => null);
  const refusal = await appLocalRefusal(identity, conversationId, routes);
  if (refusal) throw new Error(refusal);
}

function moveEnvironment(fresh?: FreshOwnership): MoveEnvironment {
  const scopeFor = channelScope;
  return {
    scopeFor,
    transport: async () => {
      const link = cloudLink;
      if (!link) throw new Error("Moving a conversation while it runs needs Letta Cloud.");
      const api = new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 });
      return {
        post: (path, body) => api.post(path, { body }) as Promise<unknown>,
        get: (path) => api.get(path) as Promise<unknown>,
      };
    },
    places: async (conversationId) => {
      const identity = scopeFor(conversationId);
      const listener = connectedDesktopIdentity();
      const state = getExecutionState(conversationId);
      const observed = freshlyRunning(conversationId, state, fresh);
      const computers = await listExecutionComputers().catch(() => []);
      // The channel guard is Letta's, and the source re-checks it
      // authoritatively. Reading it here only buys a better message — except
      // for the app-local entry, whose own check is the only thing standing
      // between it and a chat whose channel is served elsewhere. So a failed
      // read is kept apart from an empty one rather than flattened into [].
      const routes = identity
        ? await listChannelRoutes(identity.agentId).then((answer) => answer, () => null)
        : [];
      return {
        computers,
        listener: listener && getSettings().reachableComputer === true
          ? { deviceId: listener.deviceId, name: computers.find((computer) => computer.deviceId === listener.deviceId)?.name ?? "This computer" }
          : null,
        observedConnectionId: observed?.connectionId ?? null,
        observedDeviceId: observed?.deviceId ?? null,
        observedIsCloud: observed?.kind === "cloud",
        destination: recordedDestination(state),
        backendIsCloud: getConnectionConfig().backend === "cloud",
        conversationIsNew: identity === null,
        channelRefusal: identity
          ? refusalFromRoutes(routes ?? [], identity.scopedConversationId, conversationId)
          : null,
        // Only a fresh authoritative read, and only a verified listener. The
        // stored observation can name a computer for a conversation that
        // finished moments ago, so offering to "continue where it's running" on
        // its word would be an offer to continue nothing. `undefined` — the read
        // did not come back — is not a live owner either.
        ownerIsLive: fresh?.conversationId === conversationId && typeof fresh.owner === "string",
        appLocalRefusal: identity ? await appLocalRefusal(identity, conversationId, routes) : "Send a message first; there's no conversation to run yet.",
        heldHere: turns.has(conversationId) || destinationTurns.has(conversationId) || preparingTurns.has(conversationId),
        // Consent, never an observation: the app-server is never *observed* as
        // an owner, so only a recorded, acknowledged choice can say this.
        appLocalSelected: choseThisApp(state) && !state.pendingDelivery && state.status !== "blocked",
        followSelected: state.selected.kind === "follow-owner" && state.provenance === "owner"
          && !state.pendingDelivery && state.status !== "blocked",
      };
    },
    resolvePlace: async (placeId, conversationId) => {
      const deviceId = placeDeviceId(placeId);
      if (placeId === THIS_PC_PLACE_ID) {
        const listener = connectedDesktopIdentity();
        if (!listener) throw new Error("This computer isn't registered with Letta as a destination.");
        return resolveComputerConnection(listener.deviceId);
      }
      if (placeId === CLOUD_PLACE_ID) return resolveCloudPlace(conversationId);
      if (!deviceId) throw new Error("That place cannot be resolved to a computer.");
      return resolveComputerConnection(deviceId);
    },
    observed: (conversationId) => {
      const observed = getExecutionState(conversationId).observed;
      return observed?.connectionId ? { connectionId: observed.connectionId, observedAt: observed.observedAt } : null;
    },
    publish: (state) => emit({ type: "conversation.move", state }),
  };
}

/**
 * What the renderer may show for Stop, and the live move, decided here.
 *
 * The renderer is given the answer rather than the ingredients: whether Stop
 * can be honoured depends on what this process can actually reach, which is not
 * something the UI can see.
 */
/**
 * The execution state as the renderer must always receive it.
 *
 * Every `conversation.execution` event goes through here, and so does the read
 * the renderer asks for. A state without `controls` is not a smaller answer: it
 * makes the renderer fall back to offering Stop, which is exactly wrong for a
 * conversation running on someone else's computer. Routing every emit through
 * one function is what stops the next emit site added here from quietly
 * reintroducing that.
 */
function executionView(conversationId: string, state = getExecutionState(conversationId)): ConversationExecutionState {
  return { ...state, ...executionControls(conversationId) };
}

/**
 * Hearthside: tell the window whether Stop can act on a turn this app's own
 * runtime is running, when there is no Letta Cloud to say so.
 *
 * `controls` is a snapshot taken when the state is read. On Cloud the ownership
 * observer re-publishes it around every turn; without Cloud nothing did, so the
 * window either had never been told (and, on a build that can move
 * conversations, treats silence as "can't promise Stop would reach it") or held
 * an idle snapshot saying "unavailable". Either way Stop was refused for every
 * turn on This computer, and the reason shown told the person to stop it "in
 * Letta". Publishing at the turn's start and end keeps the answer true.
 */
function publishOwnControls(conversationId: string): void {
  // The link is dropped before a disconnect ends the turns it was serving, so
  // it alone does not say "not Cloud": a Cloud turn ending then would be
  // published here with the next connection's empty state.
  if (cloudLink || getConnectionConfig().backend === "cloud") return;
  emit({ type: "conversation.execution", state: executionView(conversationId) });
}

function executionControls(conversationId: string): Pick<ConversationExecutionState, "controls" | "move"> {
  const record = getMoveRecord(conversationId);
  const move = current(moveEnvironment(), conversationId);
  if (!record || !move) {
    const turn = turns.get(conversationId);
    // Off Letta Cloud a message still being prepared (its session starting, or
    // a follow-up that runs entirely as a preparation) is stoppable too:
    // stopTurn aborts it. Reported as unavailable, Stop was dimmed with "can't
    // reach the runtime" for those seconds, or for a follow-up's whole turn.
    const preparing = !cloudLink && preparingTurns.has(conversationId);
    const stoppable = (Boolean(turn && !turn.handoffBlocked && !turn.stopped) || (preparing && !turn))
      && !destinationTurns.has(conversationId) && !getExecutionState(conversationId).pendingDelivery;
    return { controls: stoppable ? { stop: "available" } : { stop: "unavailable" } };
  }
  const turn = turns.get(conversationId);
  return {
    move,
    controls: moveControls(record.phase, {
      sourceAttached: Boolean(turn && !turn.handoffBlocked && !turn.stopped),
      // Holding the attachment is what makes Stop reach the destination. Whether
      // anything is running there right now is the turn's business, not this.
      destinationAttached: destinationWatch(conversationId) !== undefined,
    }, record.placeName, record.initiatedBy),
  };
}

/** Resolve a device to the connection lease it is online on, right now. */
async function resolveComputerConnection(deviceId: string): Promise<ResolvedPlace> {
  const client = await executionClient();
  try {
    const computer = await client.computers.get(deviceId);
    if (computer.deviceId !== deviceId || computer.status !== "online" || !computer.connectionId?.startsWith("conn-")) {
      throw new Error(`${computer.name || "That computer"} isn't online with a Letta listener, so nothing was moved.`);
    }
    // Checked here rather than when the places are listed, because this is the
    // last point before the request goes out and a destination whose attach
    // behaviour is unknown must be refused while the conversation is still here.
    const incapable = destinationCapability(computer);
    if (incapable) throw new Error(incapable);
    return { connectionId: computer.connectionId, name: computer.name, deviceId: computer.deviceId };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Leases held on Cloud sandboxes provisioned as move destinations.
 *
 * A sandbox is created with a short TTL on the assumption that its requester is
 * about to open a session in it. A teleport destination has no session until the
 * move lands, so the lease is held here across the move and released once it
 * settles — see `teleport-cloud.ts`. Releasing never terminates the sandbox: by
 * then the conversation is running in it.
 */
const cloudLeases = new Map<string, () => void>();

function releaseCloudLease(conversationId: string): void {
  const release = cloudLeases.get(conversationId);
  if (!release) return;
  cloudLeases.delete(conversationId);
  release();
}

/** Provision this conversation's Cloud sandbox and hold its lease for the move. */
async function resolveCloudPlace(conversationId: string): Promise<ResolvedPlace> {
  const env = moveEnvironment();
  const identity = env.scopeFor(conversationId);
  if (!identity) throw new Error("This conversation has no identity in Letta yet, so there is nothing to move.");
  const client = await executionClient();
  try {
    const destination = await resolveCloudDestination({
      transport: await env.transport(),
      // The app's own Cloud client resolves the device; a second one would be a
      // second set of credentials to keep right.
      resolveDevice: async (deviceId) => {
        const resolved = await client.computers.resolve({ deviceId });
        return { connectionId: resolved.connectionId };
      },
    }, { agentId: identity.agentId, conversationId: identity.scopedConversationId });
    releaseCloudLease(conversationId);
    cloudLeases.set(conversationId, destination.release);
    return { connectionId: destination.connectionId, name: destination.name, deviceId: destination.sandbox.deviceId };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listExecutionPlaces(conversationId: string): Promise<ExecutionPlace[]> {
  // The list is where a person reads which computer is running this
  // conversation, so it asks rather than repeating the last observation. A read
  // that fails or cannot be trusted leaves every place unclaimed instead of
  // falling back to the cache: the list must not be the thing that says an idle
  // chat is busy. `admissionOwner` carries the account and link fences, and the
  // list renders either way — only `moveConversation` acts on this.
  const fresh: FreshOwnership | undefined = cloudLink
    ? { conversationId, owner: await admissionOwner(conversationId).catch(() => undefined) }
    : undefined;
  return listPlaces(moveEnvironment(fresh), conversationId);
}

const MOVE_POLL_MS = 2_000;
const moveWatchers = new Map<string, { timer: NodeJS.Timeout; busy: boolean }>();
/**
 * A conversation this app is watching at a move's destination.
 *
 * It is not a `Turn`: there is no session to send on, no tools executing here
 * and no local message that started it. What it does have is the same rows,
 * activity and approvals a turn has, which is why it reuses that plumbing
 * through `RowStream` rather than reimplementing it.
 */
type DestinationWatch = RowStream & {
  attachment: DestinationAttachment;
  /** The Cloud client the attachment's session belongs to; closed with it. */
  client: LettaAgentClient;
  /** The account this watch was opened under. A change invalidates it. */
  account: string | undefined;
  /** Work is in progress at the destination and the renderer has been told. */
  running: boolean;
  stopped: boolean;
  stopTimer: NodeJS.Timeout | null;
  released: boolean;
};

/** Destination sessions this app holds, so Stop and approvals can reach them. */
const destinationAttachments = new Map<string, DestinationWatch>();

/**
 * The destination watch for a conversation, if it still belongs to this account.
 *
 * A watch that outlived its account must not be used: answering an approval or
 * a Stop through it would be acting on the destination with credentials the
 * person has since replaced. Reads are left to report the conversation as
 * running at its destination, which is true; the stale attachment itself is
 * let go by `releaseAllMoveDestinations` when the connection is torn down.
 */
function destinationWatch(conversationId: string): DestinationWatch | undefined {
  const watch = destinationAttachments.get(conversationId);
  return watch && watch.account === getSettings().connectionRevision ? watch : undefined;
}

function newWatch(input: Pick<DestinationWatch, "conversationId" | "attachment" | "client" | "account">): DestinationWatch {
  return {
    ...input,
    accumulator: createTranscriptAccumulator(),
    sent: new Map(),
    flushTimer: null,
    activity: null,
    approvals: new Map(),
    running: false,
    stopped: false,
    stopTimer: null,
    released: false,
  };
}

/**
 * The destination started working, so the renderer is told a turn is live.
 *
 * Nothing here was sent from this app, so there is no `otid` and no queue entry
 * to release; `turn.started` is what makes the chat show activity and offer
 * Stop at all.
 */
function beginDestinationTurn(watch: DestinationWatch): void {
  if (watch.running || watch.released) return;
  watch.running = true;
  watch.stopped = false;
  emit({ type: "turn.started", conversationId: watch.conversationId });
}

/**
 * The destination went idle, so the observed turn is over.
 *
 * An observer is **never** sent a terminal `result` — the SDK only completes a
 * turn it started itself — so `loop_status: WAITING_ON_INPUT` is the real
 * terminal signal and this is where it lands. A Stop's grace timer ends the
 * turn locally if the destination says nothing at all.
 */
function endDestinationTurn(watch: DestinationWatch, error?: string): void {
  if (watch.stopTimer) {
    clearTimeout(watch.stopTimer);
    watch.stopTimer = null;
  }
  if (!watch.running) return;
  watch.running = false;
  const stopped = watch.stopped;
  watch.stopped = false;
  flushRows(watch);
  const retire = rowsToRetire(watch.retired ?? [], new Set(watch.sent.keys()), !error && !stopped);
  watch.retired = [];
  if (retire.length > 0) emit({ type: "turn.rows.removed", conversationId: watch.conversationId, keys: retire });
  settleApprovals(watch, stopped ? "Stopped by the user." : "The turn ended.");
  setActivity(watch, null);
  const reply = [...watch.accumulator.rows()].reverse().find((row) => row.kind === "assistant" && row.text.trim());
  if (reply && reply.kind === "assistant") lastReplies.set(watch.conversationId, reply.text);
  emit({
    type: "turn.finished",
    conversationId: watch.conversationId,
    ...(error && !stopped ? { error } : {}),
  });
  emit({ type: "conversation.execution", state: executionView(watch.conversationId) });
}

/** Everything the destination's stream says, turned into the chat the person sees. */
function onDestinationMessage(watch: DestinationWatch, message: SDKMessage): void {
  if (watch.released) return;
  // Another account's conversation is not this one's to show. The attachment is
  // let go by the disconnect that follows; until then it simply goes quiet.
  if (watch.account !== getSettings().connectionRevision) return;
  switch (message.type) {
    case "loop_status": {
      if (!(message.status in ACTIVITY)) break;
      const activity = ACTIVITY[message.status] ?? null;
      if (activity === null) {
        // Idle. This is an observer's only terminal signal.
        endDestinationTurn(watch);
        break;
      }
      beginDestinationTurn(watch);
      // A Stop already told the person "Stopping"; the destination's own
      // activity must not overwrite that until it actually winds down.
      if (!watch.stopped) setActivity(watch, activity);
      break;
    }
    case "error":
      beginDestinationTurn(watch);
      endDestinationTurn(watch, describeError(message.errorDetail ?? message.message));
      break;
    case "result":
      // Not expected for an observer, but if the destination ever does send one
      // it is terminal and must not be ignored.
      beginDestinationTurn(watch);
      endDestinationTurn(watch, message.success ? undefined : describeError(message.errorDetail ?? message.error ?? "The turn failed."));
      break;
    case "retry":
      beginDestinationTurn(watch);
      watch.retired = [...(watch.retired ?? []), ...watch.sent.keys()];
      watch.accumulator.reset();
      watch.sent.clear();
      setActivity(watch, `Retrying (${message.attempt}/${message.maxAttempts})`);
      break;
    case "stream_event": {
      beginDestinationTurn(watch);
      const event = message.event as Record<string, unknown>;
      if ((event.message_type === "event_message" && event.event_type === "compaction") ||
          (event.message_type === "summary_message" && event.compaction_stats)) {
        publishUsage(watch.conversationId, { contextTokens: null });
      }
      if (event.message_type === "summary_message") {
        flushRows(watch);
        emit({ type: "turn.rows", conversationId: watch.conversationId, rows: [compactionRow(String(event.id ?? randomUUID()), event.summary)] });
      }
      watch.accumulator.apply(message);
      scheduleFlush(watch);
      break;
    }
    default:
      beginDestinationTurn(watch);
      watch.accumulator.apply(message);
      scheduleFlush(watch);
  }
}

/**
 * The destination is asking whether a tool may run.
 *
 * These arrive as control requests on the transport, independently of any turn
 * this app started, which is the whole reason an observer can answer them. The
 * answer goes back over the same socket, so the person keeps owning approvals
 * for a conversation that is no longer running on their computer.
 */
function onDestinationApproval(watch: DestinationWatch, approval: DestinationApproval): Promise<CanUseToolResponse> {
  return new Promise<CanUseToolResponse>((resolve) => {
    if (watch.released) {
      resolve({ behavior: "deny", message: "Hearthside stopped watching this conversation.", interrupt: true });
      return;
    }
    if (watch.stopped) {
      resolve({ behavior: "deny", message: "Stopped by the user.", interrupt: true });
      return;
    }
    if (watch.account !== getSettings().connectionRevision) {
      // The person this app would be asking is no longer signed in here, so
      // there is nobody to ask. Declining without `interrupt`: not answering is
      // not an instruction to stop the destination's work.
      resolve({ behavior: "deny", message: "The Letta account changed, so Hearthside could not ask about this tool." });
      return;
    }
    beginDestinationTurn(watch);
    const request: ApprovalRequest = {
      requestId: approval.context?.requestId ?? randomUUID(),
      toolCallId: approval.context?.toolCallId ?? null,
      toolName: approval.toolName,
      input: approval.toolInput,
      suggestions: approval.context?.permissionSuggestions ?? [],
    };
    watch.approvals.set(request.requestId, { request, resolve });
    // Make sure the tool call is on screen before asking about it.
    flushRows(watch);
    setActivity(watch, "Waiting for approval");
    emit({ type: "approval.requested", conversationId: watch.conversationId, request });
  });
}

function stopWatchingMove(conversationId: string): void {
  const entry = moveWatchers.get(conversationId);
  if (!entry) return;
  clearInterval(entry.timer);
  moveWatchers.delete(conversationId);
}

/**
 * Follow a move to its end, then attach to wherever it landed.
 *
 * A status read that fails tells us nothing, so the watcher keeps going rather
 * than concluding anything. It stops only on a settled phase, on the account
 * changing, or once the attach has been attempted.
 */
function watchMove(conversationId: string): void {
  if (moveWatchers.has(conversationId)) return;
  const identity = getSettings().connectionRevision;
  const entry = { timer: setInterval(() => void poll(), MOVE_POLL_MS), busy: false };
  moveWatchers.set(conversationId, entry);
  entry.timer.unref?.();

  async function poll(): Promise<void> {
    if (entry.busy) return;
    if (identity !== getSettings().connectionRevision) {
      stopWatchingMove(conversationId);
      releaseCloudLease(conversationId);
      return;
    }
    entry.busy = true;
    try {
      const state = await followMove(moveEnvironment(), conversationId);
      if (!state) { stopWatchingMove(conversationId); releaseCloudLease(conversationId); return; }
      if (state.phase === "connecting") {
        stopWatchingMove(conversationId);
        // The lease is still held here: the attach happens next, and it is the
        // destination session that takes over keeping the sandbox alive.
        await adoptMoveDestination(conversationId);
      } else if (state.phase === "failed" || state.phase === "attached" || state.phase === "unobserved") {
        stopWatchingMove(conversationId);
        releaseCloudLease(conversationId);
        // The move did not happen, so the turn still running here is not handing anything over.
        const source = turns.get(conversationId);
        if (state.phase === "failed" && source) source.nativeTeleportPending = false;
      }
    } catch {
      // No answer is not an answer. Keep watching; the record is unchanged.
    } finally {
      entry.busy = false;
    }
  }
}

/**
 * Let go of every destination this app is watching.
 *
 * The attachments are sessions on the client that is going away, so they cannot
 * survive a disconnect or an account change — but the conversations are still
 * at their destinations, so each becomes `unobserved`, never `failed`. That is
 * exactly what a restart would have read back, and `resumeMoveWatching` picks
 * them up again once there is a connection to do it with.
 */
function releaseAllMoveDestinations(reason: string): void {
  for (const conversationId of [...moveWatchers.keys()]) stopWatchingMove(conversationId);
  for (const conversationId of [...cloudLeases.keys()]) releaseCloudLease(conversationId);
  for (const conversationId of [...destinationAttachments.keys()]) endDestinationWatch(conversationId, reason);
}

/**
 * How old a move may be and still be re-attached to on startup.
 *
 * Not a claim that an older move stopped being true — a conversation moved last
 * week is still at its destination. It is a limit on cost: resuming means
 * opening a session per move, and doing that for every move an account has ever
 * made is work nobody asked for. An older move is still shown, with Stop and
 * approvals honestly reported as living at the destination.
 */
const MOVE_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Pick up the moves a restart or a reconnect left behind.
 *
 * Nothing about a move stops when this app does. A move that was in flight is
 * still in flight in Letta and its status can simply be read again; one that
 * was being watched reads back as `unobserved` with the conversation still
 * running at its destination, and can be attached to again. Both are resumed
 * here.
 *
 * Resuming is sequential and failures are swallowed by `adoptMoveDestination`:
 * a move that cannot be re-attached is left exactly where the restart left it.
 */
async function resumeMoveWatching(): Promise<void> {
  // A native move is a Letta Cloud control-plane operation; there is nothing to
  // resume against a local runtime.
  if (!cloudLink) return;
  const account = getSettings().connectionRevision;
  const now = Date.now();
  for (const record of listMoveRecords()) {
    if (account !== getSettings().connectionRevision) return;
    if (moveInFlight(record.phase) || record.phase === "connecting") {
      watchMove(record.conversationId);
      continue;
    }
    if (record.phase !== "unobserved") continue;
    if (destinationAttachments.has(record.conversationId)) continue;
    if (now - record.startedAt > MOVE_RESUME_MAX_AGE_MS) continue;
    await adoptMoveDestination(record.conversationId);
  }
}

/**
 * Record that the person's own choice of destination carries over to sending.
 *
 * They picked this place and Letta moved the conversation there, so the next
 * message belongs there too. Without this the conversation is reachable but not
 * *sendable*: `sendMessage` requires an explicit destination, finds the
 * observed owner is a connection nobody consented to, and refuses.
 *
 * Only for a move this app issued. An `agent` move was never the person's
 * choice, so it keeps prompting them — opening the app is not consent.
 */
function recordMoveConsent(record: StoredMoveRecord): void {
  if (record.initiatedBy !== "hearthside") return;
  const deviceId = placeDeviceId(record.placeId);
  // `selectExecution` clears `moveFrom`, so the target is chosen first and the
  // consent to take over from the destination's own connection comes after it.
  if (record.placeId === CLOUD_PLACE_ID) selectExecution(record.conversationId, { kind: "cloud" });
  else if (deviceId) selectExecution(record.conversationId, { kind: "computer", deviceId, name: record.placeName });
  else return;
  acknowledgeExecutionMove(record.conversationId, record.targetConnectionId);
}

/**
 * Take over a conversation that has finished moving.
 *
 * The attach is an observer's: it carries none of this app's settings to the
 * destination, because they are not this app's to set there (see
 * `teleport-socket.ts`). What it does carry is the watching — the destination's
 * stream, its device status and its tool approvals all land here, so the person
 * keeps seeing the work and keeps answering for it.
 *
 * Failing to attach does not mean the move failed: the conversation is at its
 * destination either way, so a failure is recorded as "moved, unobserved" and
 * the next send is still pointed at the destination.
 */
async function adoptMoveDestination(conversationId: string): Promise<void> {
  const env = moveEnvironment();
  const record = getMoveRecord(conversationId);
  if (!record) return;
  const account = getSettings().connectionRevision;
  // Wherever the conversation ended up, it is not here any more. Consent is
  // recorded before the attach is attempted, so a conversation this app cannot
  // watch is still one the person can send to.
  recordMoveConsent(record);
  let client: LettaAgentClient | null = null;
  let watch: DestinationWatch | null = null;
  /**
   * Work the destination sent before this app had anywhere to put it.
   *
   * Attaching is a round trip. The approval callback is live from the moment
   * the session is created, and the destination replays its state as part of
   * initialising, so rows can arrive and a tool can be asked about before
   * `attachToDestination` has even returned. Dropping those rows loses work out
   * of the person's chat, and answering that approval with a deny would
   * interrupt a destination this app has not finished adopting — on nobody's
   * instruction. Both are held here instead and delivered the moment the watch
   * exists, which is what makes the adoption atomic from the outside.
   */
  const held: Array<(watch: DestinationWatch | null) => void> = [];
  const deliver = (apply: (watch: DestinationWatch | null) => void): void => {
    if (watch) apply(watch);
    else held.push(apply);
  };
  /** Hand the held work to the watch, or to nothing if there will not be one. */
  const settleHeld = (ready: DestinationWatch | null): void => {
    for (const apply of held.splice(0, held.length)) apply(ready);
  };
  try {
    client = await executionClient();
    const owner = client;
    const attachment = await attachToDestination({
      openSession: (options) => owner.resumeSession(
        record.scopedConversationId === "default" ? record.agentId : record.scopedConversationId,
        { computer: { connectionId: record.targetConnectionId }, ...options },
      ),
      connectionId: record.targetConnectionId,
      sink: {
        onMessage: (message) => { deliver((ready) => { if (ready) onDestinationMessage(ready, message); }); },
        onApproval: (approval) => new Promise<CanUseToolResponse>((resolve) => {
          deliver((ready) => {
            if (!ready) {
              // The adoption was abandoned, so this app is not the thing that
              // should be answering. No `interrupt`: declining to answer must
              // not become an instruction to stop the destination's work.
              resolve({ behavior: "deny", message: "Hearthside could not take over watching this conversation, so it did not answer for you." });
              return;
            }
            onDestinationApproval(ready, approval).then(resolve, () => {
              resolve({ behavior: "deny", message: "Hearthside could not ask about this tool." });
            });
          });
        }),
        onDeviceStatus: (status) => {
          // The destination naming itself is the only first-hand evidence of
          // where the conversation runs; everything else is inference.
          const source = status.raw.current_connection_id;
          if (typeof source !== "string" || !source.startsWith("conn-")) return;
          observeExecution(conversationId, {
            statuses: [{
              conversation_id: record.scopedConversationId,
              last_activity_at: Date.now(),
              active_harness: {
                connection_id: source,
                managed_sandbox: record.placeId === CLOUD_PLACE_ID,
                device_id: record.targetDeviceId,
                connection_name: record.placeName,
              },
            }],
          }, record.scopedConversationId);
          emit({ type: "conversation.execution", state: executionView(conversationId) });
        },
        onEnded: (reason) => {
          // Only while this is still the watch for the chat. After a second
          // move, the first destination's stream ending used to tear down the
          // new move's watch, lease and approvals.
          if (watch && destinationAttachments.get(conversationId) !== watch) return;
          endDestinationWatch(conversationId, reason ?? "Hearthside stopped hearing from the destination.");
        },
      },
    });
    // The account may have changed while the attach was in flight, and the move
    // itself may have moved on to another destination. Adopting either would
    // watch the wrong thing with the wrong credentials, so the fence is checked
    // before anything held is delivered.
    const settled = getMoveRecord(conversationId);
    if (account !== getSettings().connectionRevision || settled?.targetConnectionId !== record.targetConnectionId) {
      attachment.close();
      await client.close().catch(() => undefined);
      settleHeld(null);
      markUnobserved(env, conversationId, account !== getSettings().connectionRevision
        ? "The Letta account changed while Hearthside was attaching, so it is not watching the destination."
        : "This conversation's destination changed while Hearthside was attaching, so it is not watching it.");
      emit({ type: "conversation.execution", state: executionView(conversationId) });
      return;
    }
    // A watch left from an earlier destination is let go here, quietly: the
    // move watcher and lease now belong to this move, so only its own session closes.
    const earlier = destinationAttachments.get(conversationId);
    if (earlier && !earlier.released) {
      earlier.released = true;
      if (earlier.flushTimer) clearTimeout(earlier.flushTimer);
      if (earlier.stopTimer) clearTimeout(earlier.stopTimer);
      settleApprovals(earlier, "This conversation moved on to another computer.");
      earlier.attachment.close();
      void earlier.client.close().catch(() => undefined);
    }
    watch = newWatch({ conversationId, attachment, client, account });
    destinationAttachments.set(conversationId, watch);
    markAttached(env, conversationId);
    // Now that there is somewhere for it to go, everything the destination said
    // while attaching lands — in the order it was said.
    settleHeld(watch);
    // Approvals the move handed over are carried explicitly, never by the
    // attach itself: the observer socket forces `recover_approvals: false` on
    // every frame precisely so this is a decision and not a side effect.
    const recovery: DestinationRecovery = await attachment.recoverApprovals().catch((error: unknown) => ({
      recovered: false, unsupported: false, detail: describeError(error),
    }));
    if (recovery.recovered || recovery.pendingApproval) beginDestinationTurn(watch);
    else if (recovery.unsupported && record.placeId !== CLOUD_PLACE_ID) {
      console.warn(`[teleport] ${conversationId}: the destination cannot replay a held approval${recovery.detail ? `: ${recovery.detail}` : ""}`);
    }
  } catch (error) {
    await client?.close().catch(() => undefined);
    settleHeld(null);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[teleport] ${conversationId}: moved, but could not be attached to: ${reason}`);
    markUnobserved(env, conversationId, reason);
  }
  emit({ type: "conversation.execution", state: executionView(conversationId) });
}

/**
 * A Stop the destination never confirmed.
 *
 * The grace timer running out is **not** the destination going idle, and it
 * must not be reported as one. A clean `turn.finished` would tell the person
 * their Stop landed, hand control back to the composer and clear the one bit of
 * information that actually matters here: nobody knows whether the work is
 * still running. So the attachment is let go instead and the move goes back to
 * `unobserved`, which is what makes Stop read "it is running on <place>; stop
 * it there, or in Letta" — and the turn ends carrying that as its error rather
 * than as a confirmed stop.
 *
 * The local source turn's timer does the opposite on purpose: that session is
 * this app's own, and giving up on it ends work it was itself running.
 */
function abandonUnconfirmedStop(conversationId: string): void {
  const watch = destinationAttachments.get(conversationId);
  if (!watch || watch.released) return;
  watch.stopTimer = null;
  // Clearing `stopped` is what keeps this from looking like a confirmed stop:
  // that flag is exactly what suppresses the reason on the way out.
  watch.stopped = false;
  const placeName = getMoveRecord(conversationId)?.placeName ?? "The destination";
  endDestinationWatch(conversationId, `${placeName} did not confirm that it stopped, so Hearthside is no longer watching it. The work may still be running there — stop it there, or in Letta.`);
}

/**
 * Stop watching a destination, without claiming the work there stopped.
 *
 * The conversation is still at its destination; only this app's view of it
 * ended. That is `unobserved`, never `failed`.
 */
function endDestinationWatch(conversationId: string, reason: string): void {
  const watch = destinationAttachments.get(conversationId);
  if (!watch || watch.released) return;
  endDestinationTurn(watch, reason);
  releaseMoveDestination(conversationId);
  markUnobserved(moveEnvironment(), conversationId, reason);
  emit({ type: "conversation.execution", state: executionView(conversationId) });
}

/** Release a destination session, without claiming the work there stopped. */
export function releaseMoveDestination(conversationId: string): void {
  stopWatchingMove(conversationId);
  releaseCloudLease(conversationId);
  const watch = destinationAttachments.get(conversationId);
  if (!watch) return;
  destinationAttachments.delete(conversationId);
  watch.released = true;
  if (watch.flushTimer) clearTimeout(watch.flushTimer);
  if (watch.stopTimer) clearTimeout(watch.stopTimer);
  settleApprovals(watch, "Hearthside stopped watching this conversation.");
  watch.attachment.close();
  void watch.client.close().catch(() => undefined);
}

/**
 * Where this conversation's next message goes, as the person picked it.
 *
 * Only an explicit choice counts, and only one that was acknowledged against
 * verified ownership. A saved global default, a follow-the-owner intent and a
 * last-seen observation are none of them a destination anybody chose.
 */
function recordedDestination(state: ConversationExecutionState): PlacesDestination | null {
  const acknowledged = state.moveFrom !== undefined
    || (state.provenance === "selected" && Boolean(state.selectedConnectionId));
  if (!acknowledged || state.pendingDelivery || state.status === "blocked") return null;
  switch (state.selected.kind) {
    case "cloud": return { kind: "cloud" };
    case "desktop-listener": return { kind: "this-pc" };
    case "computer": return { kind: "computer", deviceId: state.selected.deviceId };
    default: return null;
  }
}

/** The execution target a place stands for. Never resolved to a live lease here. */
function placeTarget(place: ExecutionPlace): ConversationExecutionTarget {
  // The non-moving entries are handled by their own branches and have their own
  // checks. Reaching here with one would mean a caller took the relocation path
  // with a place that relocates nothing, so it stops rather than guessing.
  if (place.id === APP_PLACE_ID || place.id === FOLLOW_PLACE_ID) throw new Error("That place isn't somewhere a conversation is moved to.");
  if (place.id === THIS_PC_PLACE_ID) return { kind: "desktop-listener" };
  if (place.id === CLOUD_PLACE_ID) return { kind: "cloud" };
  const deviceId = placeDeviceId(place.id);
  if (!deviceId) throw new Error("That place cannot be resolved to a computer.");
  return { kind: "computer", deviceId, name: place.name };
}

/**
 * Choose where a conversation runs. One picker, one click, two honest outcomes.
 *
 * What a choice *means* depends on what Letta says is true right now, which is
 * why fresh authoritative ownership is read here rather than inferred from the
 * cached observation the picker was drawn from:
 *
 * - A verified live owner is asked to hand the conversation over. That is the
 *   native move, unchanged.
 * - Nobody owns it, so there is nothing to hand over and nothing to interrupt.
 *   The choice is recorded as this conversation's verified next destination, and
 *   no teleport is requested at all. Letta would refuse one anyway — there is no
 *   active environment to hand off — and the conversation would stay stranded:
 *   the picker was the only destination control, and it only moved live work.
 * - Ownership that is unknown, stale or conflicting is neither of those. It
 *   rejects, because "we could not tell" must not be read as "idle".
 *
 * Channel-bound refusals are *not* relaxed for the idle case. Recording a
 * destination is what decides where the bound channel's conversation runs next,
 * so bypassing Letta's guard here would move the binding by the back door.
 */
export async function moveConversation(conversationId: string, placeId: string): Promise<ConversationDestinationOutcome> {
  // Awaited: a read-only history conversation must be refused here, and a
  // rejection left floating would surface as an unhandled one instead.
  await assertWritableConversation(conversationId);
  const held = getExecutionState(conversationId).pendingDelivery;
  if (held) throw new Error("Delivery is unresolved. Reconcile the retained input IDs in Letta before changing where this chat runs; choosing a place cannot acknowledge or replay it.");
  // Ownership first, and authoritatively: it decides both what this choice
  // means and which refusals apply. Reading it after the refusals would leave
  // the stranded case stranded — a conversation seen on a computer moments ago
  // and idle on the server now would still be refused as "already running
  // here", which is the one refusal that cannot be waited out.
  // Throws on missing, conflicting or stale evidence; null means verified idle.
  const owner = await admissionOwner(conversationId);
  const env = moveEnvironment({ conversationId, owner });
  // The same refusals `startMove` re-checks, read once against that ownership so
  // the idle branch is held to them too, and so the choice is matched to a place
  // Letta still offers.
  const offered = await listPlaces(env, conversationId);
  const place = offered.find((candidate) => candidate.id === placeId);
  if (!place) throw new Error("That place is no longer available. Refresh and choose again.");
  if (place.moveBlocked) throw new Error(place.moveBlocked);

  // The two entries that relocate nothing. Neither is a teleport, so neither
  // goes near `startMove`, and neither is chosen by whether the conversation
  // happens to be idle — the idle/live distinction is what separates *them*.
  if (place.kind === "follow") {
    // Continue where it already runs. The follow branch re-reads ownership
    // authoritatively and refuses when nobody is there, so an owner that
    // finished between drawing the list and this click cannot turn into consent
    // to a destination that no longer exists. Nothing is moved and nothing sent.
    const execution = await setConversationExecution(conversationId, { kind: "follow-owner" });
    return { kind: "destination", execution };
  }
  if (place.kind === "app") {
    // Run it here. `requireUnowned` covers the Letta half of the safety: it
    // re-reads idleness, refuses on any harness whether or not this build can
    // read it, and fences a superseded selection, an account change and an
    // unresolved delivery. An owner appearing after the picker was drawn stops
    // this rather than displacing it, and nothing is handed to Letta either way.
    //
    // `assertStillValid` covers the other half, which Letta knows nothing
    // about. The list above was drawn before the click and the ownership read
    // takes a network round trip, so between the two a bot can be reassigned or
    // switched off and a route can be added. Proving it again here is what
    // stops a stale picture being committed as consent.
    const execution = await setConversationExecution(conversationId, { kind: "desktop" }, {
      requireUnowned: true,
      assertStillValid: () => assertAppLocalChannelHosting(conversationId),
    });
    return { kind: "destination", execution };
  }

  if (owner === null) {
    // `setConversationExecution` re-reads idleness, fences a superseded
    // selection, an account change and an unresolved delivery, and refuses if an
    // owner has appeared in the meantime. Nothing is moved and nothing is sent.
    const execution = await setConversationExecution(conversationId, placeTarget(place), { requireUnowned: true });
    return { kind: "destination", execution };
  }
  const state = await startMove(env, conversationId, placeId);
  // Nothing has moved yet. The watcher carries it the rest of the way.
  if (state.phase !== "failed") watchMove(conversationId);
  return { kind: "moved", move: state };
}

/**
 * Remember where an agent-initiated move went, and publish it.
 *
 * Storage failures are swallowed: losing the note is worse than losing the
 * turn's own handling of the move, and the hold is already in place.
 */
function noteObservedMove(conversationId: string, scope: { agentId: string; conversationId: string }, receipt: NativeTeleportReceipt): void {
  try {
    const stored = recordObservedMove({
      conversationId, agentId: scope.agentId, scopedConversationId: scope.conversationId, receipt,
    });
    if (stored) emit({ type: "conversation.move", state: moveState(stored, getExecutionState(conversationId).observed, moveRevision()) });
  } catch (error) {
    console.warn(`[teleport] ${conversationId}: could not record the observed move: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectNativeTeleport(turn: Turn, content: string): Promise<void> {
  const link = cloudLink;
  const identity = getSettings().connectionRevision;
  const agentId = agentIdFor(turn.conversationId);
  if (!link || !agentId) return;
  const scope = { agentId, conversationId: mainChatAgent(turn.conversationId) ? "default" : turn.conversationId };
  const hint = parseNativeTeleportReceipt(content, scope, turn.executionConnectionId);
  if (!hint) return;
  const api = new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 });
  try {
    const raw = await api.get(`/v1/environments/runtimes/${encodeURIComponent(scope.agentId)}/${encodeURIComponent(scope.conversationId)}/teleports/${encodeURIComponent(hint.id)}`);
    if (turn.finished || turn.stopped || cloudLink !== link || getSettings().connectionRevision !== identity) return;
    const receipt = validateNativeTeleportStatus(raw, hint);
    const createdAt = (raw as { createdAt?: unknown } | null)?.createdAt;
    if (!receipt || receipt.status === "failed" || typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < turn.stream.startedAt || createdAt > Date.now() + 5_000) return;
    // Pending receipts are not ownership loss. Keep source approvals/results
    // flowing until the native boundary commits; blocking here deadlocks drain.
    if (receipt.status !== "completed") {
      turn.nativeTeleportPending = true;
      noteObservedMove(turn.conversationId, scope, receipt);
      // Follow it now, as a restart would. Without this the move line said
      // "moving" for the rest of the app's run whether it landed or failed,
      // with every place in the picker disabled.
      if (getMoveRecord(turn.conversationId)) watchMove(turn.conversationId);
      setActivity(turn, "Native handoff requested; the source is finishing accepted work.", "moving");
      return;
    }
    // The move finished. That is the opposite of a failure: the conversation is
    // at its destination whether or not Hearthside manages to attach, so this
    // is recorded as "moved, unobserved" and never as "stayed here".
    noteObservedMove(turn.conversationId, scope, receipt);
    blockHandoffControls(turn, "Native handoff reached its destination; the continued task may still be running. Hearthside cannot safely attach its approvals or Stop control. Queued messages are held.", "moving");
  } catch {
    // A receipt-shaped tool output is not authoritative proof of a handoff.
    // The independent ownership observer remains active.
  }
}

function observeTurnExecution(turn: Turn): void {
  // The owned app-server exposes only the non-unique "app-server" identity.
  // Do not manufacture a Cloud ownership baseline from an arbitrary first poll.
  if (!cloudLink || !turn.executionClient) return;
  if (!turn.executionConnectionId) {
    const state = markExecutionUnknown(turn.conversationId, "The hosted source did not provide a unique connection identity; automatic handoff observation is unavailable.");
    emit({ type: "conversation.execution", state: executionView(turn.conversationId, state) });
    return;
  }
  const identity = getSettings().connectionRevision;
  let checking = false;
  turn.executionObserver = setInterval(() => {
    if (checking || turn.finished || turn.handoffBlocked) return;
    if (identity !== getSettings().connectionRevision) { clearInterval(turn.executionObserver); return; }
    checking = true;
    void getConversationExecution(turn.conversationId).then((state) => {
      if (turn.finished || turn.stopped || identity !== getSettings().connectionRevision) return;
      if (state.status === "unknown" && state.detail?.startsWith("Execution observation is temporarily unavailable")) return;
      if (state.status !== "confirmed" || !state.observed?.connectionId) {
        // During the native handshake an intermediate absent harness is not
        // ownership loss. Keep accepted source work draining to its boundary.
        if (!turn.nativeTeleportPending) blockHandoffControls(turn, "Execution ownership cannot be confirmed. The native turn may still be running; queued messages and source controls are held until it can be checked in Letta.");
        return;
      }
      const observed = state.observed;
      if ((!turn.executionClient && observed.kind === "cloud") ||
          (turn.executionConnectionId && turn.executionConnectionId !== observed.connectionId)) {
        blockHandoffControls(turn, "This conversation moved to another runtime. Native continuation may still be running; Hearthside cannot safely own its approvals or Stop control. Use that runtime to continue or stop it. Queued messages are held.");
      }
    }).catch(() => undefined).finally(() => { checking = false; });
  }, 3_000);
  turn.executionObserver.unref?.();
}

async function runTurn(turn: Turn, message: SendMessage, otid: string, origin: "human" | "controller" = "human", submittedAt = new Date().toISOString()): Promise<void> {
  let failure: string | undefined;
  let sawResult = false;
  let submitted = false;
  let submissionAttempted = false;
  try {
    const recoveryAgent = agentIdFor(turn.conversationId) ?? mainChatAgent(turn.conversationId);
    if (!recoveryAgent) throw new Error("Cannot verify recovery admission for this conversation.");
    assertRecoveryAdmission(recoveryAgent);
    // A conversation left waiting on an approval (for example, the app quit
    // mid-turn) stays wedged until the runtime re-drives it through canUseTool.
    if (!turn.executionConnectionId && typeof turn.session.getDeviceStatus === "function") {
      const status = await turn.session.getDeviceStatus({ timeoutMs: 5_000 }).catch(() => null);
      const source = status?.raw.current_connection_id;
      if (typeof source === "string" && source && (!turn.executionClient || (source !== "app-server" && !source.startsWith("app-server-")))) turn.executionConnectionId = source;
    }
    await turn.validateExecutionSource?.(turn.executionConnectionId);
    if (!isManualOnlyRecovery(recoveryAgent)) await turn.session.recoverPendingApprovals({ timeoutMs: 5_000 }).catch(() => undefined);
    if (turn.stopped || turn.finished) return;
    // The runtime's real mode, sent ahead of the message on the same connection (see sessionPermissionMode).
    if (!isManualOnlyRecovery(recoveryAgent) && getPermissionMode() === "unrestricted") await turn.session.changeDeviceState({ permissionMode: "unrestricted" });
    // Stop can finish this exact turn while asynchronous session setup is pending.
    // Never let its continuation submit a message after the abort has been sent.
    if (turn.stopped || turn.finished) return;
    assertRecoveryAdmission(recoveryAgent);
    const owner = mainChatAgent(turn.conversationId) ?? conversations.get(turn.conversationId)?.agentId;
    // Captured when the person submitted, not now: this turn may have waited in
    // a queue, and an item's whole meaning hangs off the original moment.
    const inputAt = submittedAt;
    let intentionScope: ReturnType<typeof rememberFollowupInput> = null;
    try { if (owner && origin === "human") intentionScope = rememberFollowupInput(owner, turn.conversationId, otid, inputAt); }
    catch (error) {
      if (isIntentionsStorageError(error)) reportIntentionsStorageError(error, "record input marker");
      console.warn("[intentions] Input marker unavailable; the ordinary turn continues.");
    }
    if (!turn.executionConnectionId && typeof turn.session.getDeviceStatus === "function") {
      const status = await turn.session.getDeviceStatus({ timeoutMs: 5_000 }).catch(() => null);
      const source = status?.raw.current_connection_id;
      if (typeof source === "string" && source && (!turn.executionClient || (source !== "app-server" && !source.startsWith("app-server-")))) turn.executionConnectionId = source;
    }
    await turn.validateExecutionSource?.(turn.executionConnectionId);
    // Source validation (including lease/account checks) can also yield to Stop.
    // Keep this guard adjacent to send, with no intervening asynchronous work.
    if (turn.stopped || turn.finished) return;
    const desktopAcceptance = !turn.executionClient && server && cloudLink && turn.executionConnectionId ? {
      account: getSettings().connectionRevision, agentId: recoveryAgent, link: cloudLink, server,
      generation: controlGeneration(), connectionId: turn.executionConnectionId,
    } : undefined;
    // Open the session first. A runtime that won't start, a refused model or
    // a lost connection fails here, where it is certain nothing was sent;
    // inside `send` the same failure used to read as "maybe delivered" and
    // held the chat with nothing that could ever release it.
    if (cloudLink && typeof (turn.session as { ready?: unknown }).ready === "function") {
      await (turn.session as unknown as { ready(): Promise<unknown> }).ready();
      if (turn.stopped || turn.finished) return;
    }
    submissionAttempted = true;
    await turn.session.send(message, { otid });
    submitted = true;
    turn.desktopAcceptance = desktopAcceptance;
    if (!turn.executionClient) recordDesktopExecution(turn.conversationId, turn.executionConnectionId);
    else recordSelectedExecution(turn.conversationId, turn.executionConnectionId);
    observeTurnExecution(turn);
    if (intentionScope) {
      const text = typeof message === "string" ? message : message.filter(part => part.type === "text").map(part => "text" in part ? part.text : "").join("\n");
      void observeFollowupInput(intentionScope, { id: otid, otid, at: inputAt, text, role: "user" });
    }
    // Hearthside: a turn that never hears back leaves no other trace; this line is the trace.
    console.log(`[turn] ${turn.conversationId}: sent, waiting for the runtime`);

    // Hearthside: if nothing at all arrives for STALL_MS (and no Hearthside tool
    // is running), end the turn with a message and close the session, so the
    // chat isn't left showing "Thinking…" for an hour.
    let lastHeard = Date.now();
    const watchdog = setInterval(() => {

      if (turn.approvals.size > 0) lastHeard = Date.now();
      // A helper's steps reach the side panel, not this turn's stream, so a
      // helper working for longer than the limit looked like silence and the
      // turn was ended under it. Its latest step counts as hearing something.
      const helperAt = lastHelperActivity(turn.conversationId);
      if (helperAt !== null && helperAt > lastHeard) lastHeard = helperAt;
      if (turn.finished || turn.pendingTools > 0 || Date.now() - lastHeard < STALL_MS) return;
      clearInterval(watchdog);
      if (cloudLink) blockHandoffControls(turn, "The runtime stopped reporting this turn. Its completion and ownership are uncertain; queued messages are held. Check the conversation in Letta before continuing.");
      else finishTurn(turn, `No reply came back for ${STALL_MS / 60_000} minutes. The connection to the runtime may have dropped; send your message again.`);
    }, 30_000);
    watchdog.unref?.();
    try {
    for await (const message of turn.session.stream()) {
      lastHeard = Date.now();
      if (turn.finished) return;
      if (message.type === "tool_result" && !message.isError) await inspectNativeTeleport(turn, message.content);
      switch (message.type) {
        case "error":
          failure = describeError(message.errorDetail ?? message.message);
          break;
        case "result":
          sawResult = true;
          failure = message.success
            ? undefined
            : (failure ??
              describeError(message.errorDetail ?? message.error ?? "The turn failed."));
          break;
        case "retry": {
          // A retried turn re-streams from the top. The abandoned attempt's rows stay
          // until the reply finishes well (finishTurn, turn-retry.ts).
          failure = undefined;
          turn.retired = [...(turn.retired ?? []), ...turn.sent.keys()];
          turn.accumulator.reset();
          turn.sent.clear();
          setActivity(turn, `Retrying (${message.attempt}/${message.maxAttempts})`);
          break;
        }
        case "loop_status":
          if (message.status in ACTIVITY) setActivity(turn, ACTIVITY[message.status] ?? null);
          break;
        case "stream_event": {
          // Hearthside: usage and compactions, which the transcript doesn't carry.
          const event = message.event as Record<string, unknown>;
          if ((event.message_type === "event_message" && event.event_type === "compaction") ||
              (event.message_type === "summary_message" && event.compaction_stats)) {
            publishUsage(turn.conversationId, { contextTokens: null });
          }
          if (event.message_type === "usage_statistics") recordUsage(turn, event);
          else if (event.message_type === "summary_message") {
            flushRows(turn);
            emit({ type: "turn.rows", conversationId: turn.conversationId, rows: [compactionRow(String(event.id ?? randomUUID()), event.summary)] });
          }
          turn.accumulator.apply(message);
          scheduleFlush(turn);
          break;
        }
        default:
          if (message.type === "assistant" || message.type === "reasoning") {
            const now = Date.now();
            if (message.type === "assistant") turn.stream.text += 1;
            else turn.stream.reasoning += 1;
            turn.stream.first ??= now;
            turn.stream.last = now;
          }
          turn.accumulator.apply(message);
          scheduleFlush(turn);
      }
    }
    } finally {
      clearInterval(watchdog);
    }
  } catch (error) {
    failure = describeError(error);
    if (submissionAttempted && !submitted && cloudLink && !neverLeftTheSession(error)) {
      turn.submissionUnknown = true;
      try { blockHandoffControls(turn, "Delivery acceptance is uncertain. Keep the original input ID held; inspect it in Letta before resending."); }
      catch { /* blockHandoffControls sets the live hold before persisting it. */ }
      const agentId = agentIdFor(turn.conversationId);
      if (agentId) {
        try {
          const state = blockExecution(turn.conversationId, "SDK delivery acceptance is uncertain; do not replay this input.", {
            agentId, conversationId: mainChatAgent(turn.conversationId) ? "default" : turn.conversationId, clientMessageId: otid,
          });
          emit({ type: "conversation.execution", state: executionView(turn.conversationId, state) });
        } catch { /* The live uncertainty guard remains held if receipt persistence fails. */ }
      }
      // Keep the session and client alive: SDK close removes callback/MCP
      // resources and may detach repositories or stop sandbox refresh while
      // the accepted input still needs them. Uncertainty is not completion.
      // Explicit disconnect retains its existing teardown responsibility.
    }
  } finally {
    if (submitted && !sawResult && !turn.stopped && cloudLink) blockHandoffControls(turn, "The source stream ended without a terminal result. Native continuation or ownership is uncertain; queued messages and source controls are held.");
    if (failure && cloudLink && isHandoffError(failure)) blockHandoffControls(turn, "Letta reports that this conversation moved or has conflicting listeners. Continuation may still be running elsewhere; queued messages and source controls are held.");
    finishTurn(turn, failure);
  }
}

export async function sendMessage(input: SendMessageInput, origin: "human" | "controller" = "human"): Promise<ConversationSummary> {
  return sendMessageAttempt(input, origin, () => {});
}

/**
 * A send refused *only* because this conversation has no verified destination.
 *
 * Nothing was submitted anywhere, and choosing a destination is the whole of
 * what is missing. The reason travels as a type rather than as English so the
 * renderer can resume the person's own held message without matching words
 * against an error string — and so no other failure can ever look like this one.
 */
class DestinationRequired extends Error {}

/** Serializable proof only at the trusted send boundary, never inferred from an
 * Error message or from missing receipts after a transport/account failure. */
/**
 * A finished turn's session can stay open for minutes (a tool still running in
 * the background, a helper being followed), still subscribed to the chat. The
 * runtime offers every approval to every subscriber and takes the first
 * answer, so the old session's instant "the turn ended" beat the person to it
 * and denied the *next* message's tools. When a newer turn is live in the same
 * chat, the old session stays silent and leaves the question to that turn.
 */
function supersededBy(turn: Turn): boolean {
  if (turn.stopped || !turn.finished) return false;
  const live = turns.get(turn.conversationId);
  return Boolean(live && live !== turn && !live.finished && !live.stopped);
}

/** A send that definitely never left this app, whatever was latched on the way. */
class NeverSent extends Error {}

/**
 * The SDK's own refusals from before it transmits a turn. Past these, a failed
 * `send` may or may not have reached the runtime.
 */
function neverLeftTheSession(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /^Session is closed$|^Session is not initialized$|^Session transport disconnected before the turn was sent$/.test(text);
}

export async function sendMessageForIpc(input: SendMessageInput): Promise<SendMessageResult> {
  const account = getSettings().connectionRevision;
  const link = cloudLink;
  const chatId = input.conversationId;
  const unresolvedAtEntry = Boolean(chatId && (getExecutionState(chatId).pendingDelivery
    || turns.has(chatId) || destinationTurns.has(chatId) || preparingTurns.has(chatId)));
  let submissionPossible = false;
  try {
    return await sendMessageAttempt(input, "human", () => { submissionPossible = true; });
  } catch (error) {
    if (error instanceof NeverSent && !(chatId && getExecutionState(chatId).pendingDelivery)) {
      return { kind: "not-submitted", clientMessageId: input.otid, conversationId: input.conversationId, error: error.message };
    }
    if (submissionPossible || unresolvedAtEntry || account !== getSettings().connectionRevision || cloudLink !== link
      || (chatId && getExecutionState(chatId).pendingDelivery)) throw error;
    return {
      kind: "not-submitted", clientMessageId: input.otid, conversationId: input.conversationId, error: describeError(error),
      ...(error instanceof DestinationRequired ? { reason: "destination-required" as const } : {}),
    };
  }
}

async function sendMessageAttempt(input: SendMessageInput, origin: "human" | "controller", submissionPossible: () => void): Promise<ConversationSummary> {
  // When the person actually submitted. Everything after this can wait: a PDF
  // being read, a chat being busy on another computer, a model listing. An
  // appointment "tomorrow at nine" has to be read against the clock they spoke
  // against, not against whatever time the queue releases the turn.
  const submittedAt = new Date().toISOString();
  const recoveryAgent = input.agentId ?? (input.conversationId ? agentIdFor(input.conversationId) ?? mainChatAgent(input.conversationId) : null);
  if (recoveryAgent) assertRecoveryAdmission(recoveryAgent);
  // What a message is sent with is the model in use: remembered on This
  // computer so a companion created without one starts on it.
  // (Not a companion still waiting for one: what it holds is the runtime's placeholder.)
  if (getConnectionConfig().backend === "local" && !(recoveryAgent && agentsAwaitingModel().includes(recoveryAgent))) {
    noteLocalModel(input.model ?? (input.conversationId ? conversations.get(input.conversationId)?.model : null) ?? (recoveryAgent ? conversations.get(mainChatId(recoveryAgent))?.model : null));
  }
  let preparationKey = input.conversationId ?? `new:${randomUUID()}`;
  if (turns.has(preparationKey) || destinationTurns.has(preparationKey) || preparingTurns.has(preparationKey)) {
    throw new Error("This chat is still working. Stop it or wait for it to finish.");
  }
  const preparation = new AbortController();
  preparingTurns.set(preparationKey, preparation);
  if (input.conversationId) publishOwnControls(preparationKey);
  try {
    // A companion still waiting for a model is given one before its message
    // goes, whatever the window did or did not read after the provider was
    // connected: without it the message is sent to the runtime's built-in
    // default and fails with "Provider is not configured".
    if (recoveryAgent && agentsAwaitingModel().includes(recoveryAgent)) {
      await ensureClient();
      await adoptConnectedModels(await listModels(true).catch(() => [] as ModelOption[])).catch(() => false);
      preparation.signal.throwIfAborted();
    }
    return await prepareMessage(input, preparation.signal, (conversationId) => {
      if (preparationKey === conversationId) return;
      preparingTurns.delete(preparationKey);
      preparationKey = conversationId;
      if (turns.has(preparationKey) || destinationTurns.has(preparationKey) || preparingTurns.has(preparationKey)) {
        throw new Error("This chat is still working. Stop it or wait for it to finish.");
      }
      preparingTurns.set(preparationKey, preparation);
      publishOwnControls(preparationKey);
    }, origin, submittedAt, submissionPossible);
  } finally {
    if (preparingTurns.get(preparationKey) === preparation) preparingTurns.delete(preparationKey);
    // Whatever came of it — a turn now running, or nothing — say which.
    if (!preparationKey.startsWith("new:")) publishOwnControls(preparationKey);
  }
}

async function sendToCurrentDestination(conversation: ConversationSummary, input: SendMessageInput, content: SendMessage, signal: AbortSignal, submissionPossible: () => void): Promise<ConversationSummary> {
  const link = cloudLink;
  if (!link) throw new Error("Cloud is unavailable; nothing was sent.");
  // Definite content rejection must precede pending markers and turn.started so
  // the renderer retains the exact input instead of holding an unsubmitted job.
  currentDestinationContent(content);
  if (input.model || input.reasoningEffort) throw new Error("The current destination owns its model and reasoning configuration. Remove the override before sending; nothing was sent.");
  signal.throwIfAborted();
  const account = getSettings().connectionRevision;
  const scope = { agentId: conversation.agentId, conversationId: mainChatAgent(conversation.id) ? "default" : conversation.id };
  const entry: DestinationTurn = { account, controller: new AbortController(), activity: "Sending to the conversation's current destination" };
  destinationTurns.set(conversation.id, entry);
  conversations.set(conversation.id, conversation);
  const active = () => destinationTurns.get(conversation.id) === entry && account === getSettings().connectionRevision && cloudLink === link;
  const retireSupersededObserver = () => {
    if (entry.observer) clearInterval(entry.observer);
    entry.controller.abort();
    if (destinationTurns.get(conversation.id) === entry) destinationTurns.delete(conversation.id);
  };
  // Persist uncertainty before POST: a crash between acceptance and receipt must
  // never restore this input as a new send with a fresh OTID.
  let pendingState: ConversationExecutionState;
  try {
    pendingState = blockExecution(conversation.id, "A destination-owned input is pending. Do not replay it; destination approvals and Stop remain in Letta.", { ...scope, clientMessageId: input.otid });
  } catch (error) {
    destinationTurns.delete(conversation.id);
    throw error; // Persistence failed before POST; acceptance is not ambiguous.
  }
  emit({ type: "conversation.execution", state: executionView(conversation.id, { ...pendingState, followsOwner: true }) });
  emit({ type: "turn.started", conversationId: conversation.id });
  emit({ type: "turn.activity", conversationId: conversation.id, activity: entry.activity });
  let receipt: Awaited<ReturnType<typeof enqueueCurrentDestination>>;
  try {
    submissionPossible(); // Latch before POST; it remains true even if receipts disappear.
    receipt = await enqueueCurrentDestination({ access: link, ...scope, content, otid: input.otid, signal: AbortSignal.any([signal, entry.controller.signal]) });
  } catch (error) {
    if (error instanceof CloudConversationRefusedError) {
      // It plainly did not go, so there is nothing to hold or reconcile: put
      // the chat back as it was and hand the message back to be sent again.
      if (active()) {
        const state = getExecutionState(conversation.id);
        if (sameDeliveryReceipt(state.pendingDelivery, pendingState.pendingDelivery)) {
          try {
            const released = completeExecutionDelivery(conversation.id);
            emit({ type: "conversation.execution", state: executionView(conversation.id, { ...released, followsOwner: true }) });
          } catch { /* Saving failed: the hold stays, which is the safe side. */ throw new Error(describeError(error)); }
        }
        destinationTurns.delete(conversation.id);
        emit({ type: "turn.finished", conversationId: conversation.id });
      }
      throw new NeverSent(describeError(error));
    }
    if (active()) {
      entry.acceptanceUnknown = true;
      entry.activity = "Delivery acceptance is uncertain. Keep this input held; check its current destination in Letta. Do not resend it.";
      emit({ type: "turn.activity", conversationId: conversation.id, activity: entry.activity });
    }
    // Deliberately return success to the composer: the POST may have accepted
    // this exact input. Throwing would restore it and invite a duplicate send.
    return conversation;
  }
  if (!active()) return conversation;
  const beforeReceipt = getExecutionState(conversation.id);
  if (beforeReceipt.revision !== pendingState.revision || !sameDeliveryReceipt(beforeReceipt.pendingDelivery, pendingState.pendingDelivery)) {
    retireSupersededObserver();
    return conversation;
  }
  try {
    const state = blockExecution(conversation.id, "An accepted input is running at its current destination. Its exact delivery IDs are retained for recovery.", { ...scope, clientMessageId: receipt.clientMessageId, superRunId: receipt.superRunId, workflowId: receipt.workflowId });
    emit({ type: "conversation.execution", state: executionView(conversation.id, { ...state, followsOwner: true }) });
  } catch {
    // The POST already succeeded. Preserve the initial durable pending marker
    // and continue read-only observation; never turn this into a resend error.
  }
  // If receipt persistence failed, the original durable marker is still ours.
  // Fence against that exact snapshot while observing the accepted in-memory ID.
  const durableReceipt = getExecutionState(conversation.id).pendingDelivery;
  entry.activity = "Waiting for the current destination; approvals and Stop are available there";
  emit({ type: "turn.activity", conversationId: conversation.id, activity: entry.activity });
  let checking = false;
  const check = async () => {
    if (checking || !active()) return;
    checking = true;
    try {
      const before = getExecutionState(conversation.id);
      if (!sameDeliveryReceipt(before.pendingDelivery, durableReceipt)) { retireSupersededObserver(); return; }
      const result = await observeEnqueuedTurn({ access: link, ...scope, clientMessageId: receipt.clientMessageId, superRunId: receipt.superRunId, signal: entry.controller.signal });
      const current = () => {
        const state = getExecutionState(conversation.id);
        if (!sameDeliveryReceipt(state.pendingDelivery, durableReceipt)) { retireSupersededObserver(); return false; }
        return active() && state.revision === before.revision;
      };
      if (!current()) return;
      const diagnostic = deliveryDiagnosticDetail(result);
      if (diagnostic && entry.activity !== diagnostic) {
        entry.activity = diagnostic;
        emit({ type: "turn.activity", conversationId: conversation.id, activity: diagnostic });
      }
      // History is display-only; it never proves this accepted job completed.
      const history = await loadHistory(conversation.id, 100).catch(() => null);
      if (!current()) return;
      if (history) emit({ type: "turn.rows", conversationId: conversation.id, rows: history.rows });
      if (result.state !== "completed" && result.state !== "failed") return;
      let state: ConversationExecutionState;
      try {
        state = completeExecutionDelivery(conversation.id);
      } catch {
        // Keep the exact accepted job and its observer retryable. No resend is
        // permitted, and completion is not published before it is durable.
        const activity = "The destination finished, but Hearthside could not save its completion. This input stays held while saving is retried.";
        if (entry.activity !== activity) {
          entry.activity = activity;
          emit({ type: "turn.activity", conversationId: conversation.id, activity });
        }
        return;
      }
      if (entry.observer) clearInterval(entry.observer);
      destinationTurns.delete(conversation.id);
      emit({ type: "conversation.execution", state: executionView(conversation.id, { ...state, followsOwner: true }) });
      emit({ type: "turn.finished", conversationId: conversation.id, ...(result.state === "failed" ? { error: result.error ?? "The destination reported that this input failed." } : {}) });
      void getConversationExecution(conversation.id).catch(() => undefined);
    } catch {
      // Unknown/read failures hold the same accepted input. Never enqueue again.
    } finally { checking = false; }
  };
  entry.observer = setInterval(() => { void check(); }, 3_000);
  entry.observer.unref?.();
  void check();
  return conversation;
}

/**
 * A first message makes its chat before the checks that can still refuse to
 * send it (the chosen computer is offline, Letta's status can't be read). The
 * message goes back to the new-chat box, so each try used to leave another
 * empty chat in the sidebar, titled with the message. A chat made here for a
 * message that then provably never left is put away again.
 */
async function prepareMessage(input: SendMessageInput, signal: AbortSignal, reserve: (conversationId: string) => void, origin: "human" | "controller", submittedAt: string, submissionPossible: () => void): Promise<ConversationSummary> {
  let made: string | null = null;
  let mayHaveLeft = false;
  try {
    return await prepareNewOrExisting(input, signal, reserve, origin, submittedAt, () => { mayHaveLeft = true; submissionPossible(); }, (id) => { made = id; });
  } catch (error) {
    const orphan = made as string | null;
    if (orphan && !mayHaveLeft && !turns.has(orphan) && !destinationTurns.has(orphan) && !getExecutionState(orphan).pendingDelivery) {
      conversations.delete(orphan);
      forgetConversation(orphan);
      conversationCache.clear();
      await ensureClient().then((sdk) => sdk.conversations.update(orphan, { archived: true })).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareNewOrExisting(input: SendMessageInput, signal: AbortSignal, reserve: (conversationId: string) => void, origin: "human" | "controller", submittedAt: string, submissionPossible: () => void, madeChat: (conversationId: string) => void): Promise<ConversationSummary> {
  let remote: { client: LettaAgentClient; computer?: { connectionId: string } | { deviceId: string }; connectionId?: string; name: string; cwd?: string; sameMachine?: boolean; validateSource?: () => Promise<void> } | null = null;
  let remoteOwnedByTurn = false;
  let validateAdmissionOwner: ((initializedSource?: string) => Promise<void>) | undefined;
  const preparationAccount = getSettings().connectionRevision;
  const preparationLink = cloudLink;
  const assertPreparationAccount = () => {
    signal.throwIfAborted();
    if (preparationAccount !== getSettings().connectionRevision || (preparationLink && cloudLink !== preparationLink)) throw new Error("Account changed before execution admission.");
  };
  try {
  const intent = input.conversationId ? getExecutionState(input.conversationId) : null;
  if (input.conversationId && intent?.selected.kind === "follow-owner" && intent.provenance === "owner") {
    if (intent.pendingDelivery || intent.status === "blocked") throw new Error(intent.detail ?? "Delivery is unresolved; nothing was sent.");
    const link = cloudLink;
    const account = getSettings().connectionRevision;
    if (!link) throw new Error("Cloud is unavailable; nothing was sent.");
    const text = input.text.trim();
    const attachments = await resolvePdfs(input.attachments ?? []);
    currentDestinationContent(messageContent(text, attachments));
    if (input.model || input.reasoningEffort) throw new Error("The current destination owns its model and reasoning configuration. Remove the override before sending; nothing was sent.");
    const mainAgent = mainChatAgent(input.conversationId);
    const conversation = conversations.get(input.conversationId) ?? (mainAgent
      ? { id: input.conversationId, agentId: mainAgent, title: MAIN_CHAT_TITLE, updatedAt: Date.now(), model: null, effort: null, cwd: "", main: true }
      : toConversationSummary(await new Letta({ apiKey: link.token(), baseURL: link.baseUrl, maxRetries: 0, timeout: 10_000 }).get(`/v1/conversations/${encodeURIComponent(input.conversationId)}`) as LettaConversation));
    signal.throwIfAborted();
    if (cloudLink !== link || account !== getSettings().connectionRevision) throw new Error("Account changed before execution admission.");
    if (conversation.id !== input.conversationId) throw new Error("Letta returned a different conversation.");
    if (conversation.history || isRecordedHistoryVolume(conversation.id)) throw new Error(HISTORY_READ_ONLY);
    assertRecoveryAdmission(conversation.agentId);
    conversations.set(conversation.id, conversation);
    reserve(conversation.id);
    const owner = await admissionOwner(conversation.id);
    signal.throwIfAborted();
    const current = getExecutionState(conversation.id);
    if (cloudLink !== link || account !== getSettings().connectionRevision || current.revision !== intent.revision || current.pendingDelivery) throw new Error("Execution intent or account changed before delivery; nothing was sent.");
    if (!owner) throw new DestinationRequired("No verified current destination; nothing was enqueued. Choose where this chat runs and it will send there.");
    return await sendToCurrentDestination(conversation, input, messageContent(text, attachments), signal, submissionPossible);
  }
  const sdk = await ensureClient();
  signal.throwIfAborted();
  const text = input.text.trim();
  // PDFs become their text; a PDF that can't be read stops the send with a reason.
  const attachments = await resolvePdfs(input.attachments ?? []);
  signal.throwIfAborted();
  if (!text && attachments.length === 0) throw new Error("Message is empty.");
  const title = titleText(text, attachments);
  if (input.conversationId && turns.has(input.conversationId)) {
    throw new Error("This chat is still working. Stop it or wait for it to finish.");
  }

  let conversation: ConversationSummary;
  const mainAgent = input.conversationId ? mainChatAgent(input.conversationId) : null;
  if (mainAgent) {
    conversation = conversations.get(input.conversationId as string) ?? (await mainChatSummary(mainAgent, null));
  } else if (input.conversationId) {
    conversation =
      conversations.get(input.conversationId) ??
      toConversationSummary(await sdk.conversations.retrieve(input.conversationId));
    if (conversation.history || isRecordedHistoryVolume(conversation.id)) throw new Error(HISTORY_READ_ONLY);
    assertRecoveryAdmission(conversation.agentId);
    if (!conversation.title) {
      conversation = toConversationSummary(
        await sdk.conversations.update(conversation.id, { summary: titleFrom(title) }),
      );
    }
  } else {
    const created = await sdk.conversations.create({ agentId: input.agentId, summary: titleFrom(title) });
    madeChat(created.id);
    startsFresh(created.id);
    conversation = toConversationSummary(created);
  }

  signal.throwIfAborted();
  reserve(conversation.id);
  if (!input.conversationId) recordDesktopExecution(conversation.id);
  // Native follow already returned above. Session-owned work must wait.
  await waitWhileBusyElsewhere(conversation, signal);
  assertRecoveryAdmission(conversation.agentId);
  const execution = getExecutionState(conversation.id);
  if (execution.status === "blocked") throw new Error(execution.detail ?? "Execution ownership is uncertain. Nothing was sent.");
  let hasDestinationConsent = false;
  /** This send is admitted by an explicit "run in this app" choice and nothing else. */
  let appLocalConsent = false;
  if (cloudLink && input.conversationId) {
    const owner = await admissionOwner(conversation.id);
    signal.throwIfAborted();
    const current = getExecutionState(conversation.id);
    const explicitMove = current.moveFrom !== undefined && current.moveFrom.connectionId === owner;
    const localOwner = current.provenance === "desktop" && (owner === null || owner === current.desktopConnectionId);
    let selectedOwner = current.provenance === "selected" && Boolean(current.selectedConnectionId) && (owner === null || owner === current.selectedConnectionId);
    if (!selectedOwner && current.provenance === "selected" && current.selectedConnectionId) {
      // A saved lease is not a stable device identity. Resolve only the explicitly
      // selected device under this account; names and observed owners grant no consent.
      if (current.selected.kind === "computer") remote = await prepareRemoteExecution(signal, current.selected);
      else if (current.selected.kind === "desktop-listener") remote = await prepareDesktopListenerExecution(signal);
      assertPreparationAccount();
      selectedOwner = Boolean(remote?.connectionId && remote.connectionId === owner);
    }
    if (!localOwner && !selectedOwner && !explicitMove) {
      throw new DestinationRequired("Choose this conversation's next destination explicitly before sending. Ownership is not consent to change destination; nothing was enqueued or started.");
    }
    // An explicit "run in this app" is admitted above by nobody owning the
    // conversation — as `explicitMove` against a null owner, or as `localOwner`
    // once this app has run it. Both say "idle, and this app was chosen", which
    // is also exactly what a chat whose Discord bot has since moved to another
    // companion looks like: Letta has nothing to say about that either way. So
    // for that one choice the channel facts are re-proved here, before anything
    // is prepared, and again below immediately before the turn starts.
    appLocalConsent = choseThisApp(current);
    if (appLocalConsent) await assertAppLocalChannelHosting(conversation.id);
    hasDestinationConsent = true;
  }
  const destination = conversationTarget(conversation.id);
  if (destination.kind === "desktop-listener") {
    remote ??= await prepareDesktopListenerExecution(signal);
  } else if (destination.kind === "computer") {
    remote ??= await prepareRemoteExecution(signal, destination);
  } else if (destination.kind === "cloud") {
    const hosted = await executionClient();
    remote = { client: hosted, name: "Cloud", ...(execution.status === "confirmed" && execution.observed?.kind === "cloud" && execution.observed.connectionId ? { computer: { connectionId: execution.observed.connectionId }, connectionId: execution.observed.connectionId } : {}) };
  } else if (!hasDestinationConsent && execution.selected.kind === "default" && execution.observed?.kind === "cloud") {
    // Never reclaim a conversation moved by the native runtime on the desktop.
    throw new DestinationRequired("This conversation was observed in Cloud. Choose its destination explicitly before sending another message.");
  }
  signal.throwIfAborted();
  // A listener on this machine is not the owned Hearthside app-server: only
  // our ordinary local session may execute SDK callbacks against desktop files.
  const localTools = !remote;
  if (cloudLink) {
    const account = getSettings().connectionRevision;
    const owner = await admissionOwner(conversation.id);
    signal.throwIfAborted();
    const current = getExecutionState(conversation.id);
    const ownSource = remote ? remote.connectionId : current.desktopConnectionId;
    const explicitMove = current.moveFrom !== undefined && current.moveFrom.connectionId === owner;
    if (owner && owner !== ownSource && !explicitMove) {
      throw new Error("This conversation belongs to another runtime. Select its destination again explicitly before sending; opening the app does not move it.");
    }
    // Retain this exact acknowledgement across asynchronous preparation, but
    // never permit it to follow an owner that changed while we waited.
    validateAdmissionOwner = async (initializedSource) => {
      signal.throwIfAborted();
      if (account !== getSettings().connectionRevision) throw new Error("Account changed before execution admission.");
      const latestOwner = await admissionOwner(conversation.id);
      signal.throwIfAborted();
      if (account !== getSettings().connectionRevision ||
          (latestOwner && latestOwner !== (ownSource ?? initializedSource) && !(explicitMove && latestOwner === owner))) {
        throw new Error("Execution ownership changed before sending. Select the destination again; nothing was replayed.");
      }
    };
  }
  if (localTools) rememberCwd(conversation.id, input.cwd);
  // Which companion opens next time is the one the person last wrote to. A
  // message Hearthside sent on their behalf (a calendar reminder told to a
  // companion) is not that: it used to switch the app to whichever companion
  // the reminder was for, or save the id of one that no longer exists.
  if (origin === "human") setAgentId(conversation.agentId);
  if (input.model && input.model !== conversation.model) {
    reviseContext(conversation.id);
    agentContextWindow.delete(conversation.agentId);
    publishUsage(conversation.id, { contextTokens: null, contextWindow: conversation.contextWindowLimit ?? null });
  }
  conversation = {
    ...conversation,
    cwd: localTools ? input.cwd : remote?.cwd ?? "",
    updatedAt: Date.now(),
    // The session applies these as the conversation's own model settings, which
    // is where Letta will report them from on the next listing.
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
  };
  conversations.set(conversation.id, conversation);

  // Hearthside: on Letta Cloud a chat can be in use elsewhere at the same time (a Telegram or
  // Discord bot on another computer shares the main chat). Sending into the middle of that makes
  // two runtimes answer the same tool calls ("Invalid tool call IDs"), so wait until it's free.
  await waitWhileBusyElsewhere(conversation, signal);

  // Hearthside: the tools chosen from this agent's connectors (a connector that can't connect is skipped).
  const connectorTools = !localTools || isManualOnlyRecovery(conversation.agentId) ? [] : await connectorToolsFor(conversation.agentId, (message) => console.warn(`[connectors] ${message}`)).catch(() => []);
  assertPreparationAccount();
  await remote?.validateSource?.();
  await validateAdmissionOwner?.();
  // Last of the admission checks, and the closest to the turn: preparation has
  // waited on a busy chat, on connector tools and on Letta itself since the
  // consent check above, and a bot can be reassigned or stopped in any of that
  // time. Deliberately not inside `validateAdmissionOwner`, which is also
  // re-run mid-turn through `validateExecutionSource`: this must never abort a
  // turn that has already been submitted, only stop one that has not.
  if (appLocalConsent) await assertAppLocalChannelHosting(conversation.id);
  assertPreparationAccount();
  // Hearthside: follow-up tools only when intentions are on; storage trouble never
  // blocks a message. Built here, before the turn, because the automatic note
  // carries this turn's own snapshot clock and because the conversation's
  // audience is re-checked for every single turn rather than cached.
  const followupTools = !localTools || isManualOnlyRecovery(conversation.agentId)
    ? []
    : await createFollowupTools(conversation.agentId, conversation.id, submittedAt)
      .catch((error) => {
        if (isIntentionsStorageError(error)) reportIntentionsStorageError(error, "prepare follow-up tools");
        console.warn("[intentions] Follow-up tools unavailable; the ordinary turn continues.");
        return [];
      });
  signal.throwIfAborted();
  if (remote) stopRemoteHelperObserver(conversation.id);
  const turn: Turn = {
    conversationId: conversation.id,
    accumulator: createTranscriptAccumulator(),
    sent: new Map(),
    approvals: new Map(),
    activity: "Starting",
    flushTimer: null,
    stopped: false,
    finished: false,
    usage: {
      contextTokens: usageByConversation.get(conversation.id)?.contextTokens ?? null,
      contextWindow: conversation.contextWindowLimit ?? agentContextWindow.get(conversation.agentId) ?? null,
      promptTokens: 0,
      completionTokens: 0,
    },
    pendingTools: 0,
    sessionClosed: false,
    stream: { startedAt: Date.now(), text: 0, reasoning: 0, first: null, last: null },
    closeTimer: null,
    executionClient: remote?.client,
    executionConnectionId: remote?.connectionId,
    validateExecutionSource: async (initializedSource) => {
      assertPreparationAccount();
      await remote?.validateSource?.();
      await validateAdmissionOwner?.(initializedSource);
      assertPreparationAccount();
    },
    // An agent id (not a conversation id) resumes the agent's default conversation.
    session: (remote?.client ?? sdk).resumeSession(mainAgent ?? conversation.id, {
      // Omit cwd remotely: preserve the listener/session's own current folder,
      // including changes the agent made in an earlier turn.
      ...(remote ? { computer: remote.computer } : {}),
      ...(localTools ? { cwd: input.cwd } : {}),
      ...(isManualOnlyRecovery(conversation.agentId) ? { allowedTools: [] } : {}),

      ...sessionPermissionMode(getPermissionMode()),
      ...(input.model ? { model: input.model } : {}),
      // Hearthside: Letta keeps a chat's reasoning level in its model settings,
      // apart from the model, and the session takes it the same way. Sent only
      // when the person chose one: a model handle on its own would answer at
      // that model's default and reset the level the chat already holds.
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      // Hearthside: a question tool the agent can use (the SDK hides the runtime's own).
      tools: isManualOnlyRecovery(conversation.agentId) ? [] : [
        // These tools execute in the SDK process, not the selected computer.
        // Do not quietly grant remote turns this desktop's files/integrations.
        ...(localTools ? [
        ...followupTools,
        ...connectorTools,
        // Hearthside: GIFs (when this build has a KLIPY key and they're switched on).
        ...(gifsAvailable() && getSettings().gifs
          ? [createGifTool({ filter: () => getSettings().gifFilter, customerId: gifCustomerId })]
          : []),
        // Hearthside: weather (Open-Meteo, no key).
        ...(getSettings().weather ? [createWeatherTool({ home: () => getSettings().homeTown })] : []),
        // Hearthside: the person's Obsidian vault, when they've chosen one.
        ...(getSettings().obsidianVault ? createObsidianTools(() => getSettings().obsidianVault) : []),
        // Hearthside: the built-in calendar, for agents the person has allowed.
        ...(calendarAccess().includes(conversation.agentId) ? createCalendarTools(conversation.agentId) : []),
        // Hearthside: images through the person's signed-in Codex or Grok.
        ...(getSettings().imageEngine !== "off" ? [createImageTool(() => getSettings().imageEngine as "codex" | "grok", () => !turn.sessionClosed)] : []),
        // Hearthside: the agent may change its own picture (the person is asked first).
        createAvatarTool(conversation.agentId, (looks) => emit({ type: "looks.changed", looks })),
        ] : []),
        createQuestionTool(
          (toolCallId, input) =>
            new Promise<CanUseToolResponse>((resolve) => {
              if (turn.stopped || turn.finished) {
                resolve({ behavior: "deny", message: "The turn ended.", interrupt: true });
                return;
              }
              const request: ApprovalRequest = {
                requestId: randomUUID(),
                toolCallId,
                toolName: "AskUserQuestion",
                input,
                suggestions: [],
              };
              turn.approvals.set(request.requestId, { request, resolve });
              flushRows(turn);
              setActivity(turn, "Waiting for your answer");
              emit({ type: "approval.requested", conversationId: turn.conversationId, request });
            }),
        ),
      ].map((tool) => trackTool(() => turn, tool)),
      canUseTool: (toolName, toolInput, context) =>
        new Promise<CanUseToolResponse>((resolve) => {
          if (isManualOnlyRecovery(conversation.agentId)) {
            resolve({ behavior: "deny", message: "Tools are disabled for this manual-only recovery copy.", interrupt: true });
            return;
          }
          if (turn.stopped || turn.finished) {
            if (supersededBy(turn)) return; // The newer turn's own session answers this one.
            resolve({ behavior: "deny", message: "The turn ended.", interrupt: true });
            return;
          }
          // Asking a question, sending a GIF or checking the weather needs no permission.
          if (
            toolName === QUESTION_TOOL_NAME ||
            toolName === GIF_TOOL_NAME ||
            toolName === WEATHER_TOOL_NAME ||
            (FOLLOWUP_TOOL_NAMES as readonly string[]).includes(toolName) ||
            (OBSIDIAN_READ_TOOLS as readonly string[]).includes(toolName) ||
            (CALENDAR_FREE_TOOLS as readonly string[]).includes(toolName)
          ) {
            resolve({ behavior: "allow" });
            return;
          }
          const request: ApprovalRequest = {
            requestId: context?.requestId ?? randomUUID(),
            toolCallId: context?.toolCallId ?? null,
            toolName,
            input: toolInput,
            suggestions: context?.permissionSuggestions ?? [],
          };
          turn.approvals.set(request.requestId, { request, resolve });
          // Make sure the tool call is on screen before asking about it.
          flushRows(turn);
          emit({ type: "approval.requested", conversationId: turn.conversationId, request });
        }),
    }),
  };
  // A numeric generation survives turn cleanup without retaining the Turn.
  // Late metadata is still useful after completion, but not after a newer turn.
  reviseContext(conversation.id);
  turns.set(conversation.id, turn);
  usageByConversation.set(conversation.id, turn.usage);
  remoteOwnedByTurn = true;
  emit({ type: "turn.started", conversationId: conversation.id });
  publishOwnControls(conversation.id);
  // Hearthside: learn the agent's context window for the meter (in the background).
  if (!conversation.contextWindowLimit) {
    const agentRevision = contextRevision.get(conversation.agentId);
    const chatRevision = contextRevision.get(conversation.id);
    void (remote?.client ?? sdk).agents
      .retrieve(conversation.agentId)
      .then((agent) => {
        if (!conversations.has(conversation.id) ||
            contextRevision.get(conversation.agentId) !== agentRevision ||
            contextRevision.get(conversation.id) !== chatRevision ||
            conversations.get(conversation.id)?.contextWindowLimit != null) return;
        const window = effectiveContextWindow(agent);
        agentContextWindow.set(conversation.agentId, window);
        publishUsage(conversation.id, { contextWindow: window });
      })
      .catch(() => undefined);
  }
  submissionPossible(); // Background SDK work can send before this IPC request settles.
  void runTurn(turn, messageContent(text, attachments), input.otid, origin, submittedAt);

  return conversation;
  } finally {
    if (remote && !remoteOwnedByTurn) await remote.client.close();
  }
}

/** Changing the target cannot abandon an active/queued dispatch on another host. */
export function assertExecutionTargetIdle(): void {
  if (turns.size || destinationTurns.size || preparingTurns.size || remoteHelperSessions.size) {
    throw new Error("Stop or finish active replies and wait for their background helpers before changing the execution computer.");
  }
  // Hearthside: a mod command runs in the runtime's listener, not in one of
  // these sessions, so `turns` knows nothing about it. It was admitted on the
  // understanding that nothing was being run elsewhere, and it is still being
  // followed on this connection.
  if (commandsInFlight() > 0) {
    throw new Error("A mod command is running. Wait for it to finish before changing the execution computer.");
  }
}

/** Hearthside: is any chat with this agent replying right now? */
export function agentBusy(agentId: string): boolean {
  // A preparation can still be resolving its conversation identity. Be conservative.
  if (preparingTurns.size > 0) return true;
  for (const conversationId of [...turns.keys(), ...destinationTurns.keys()]) {
    if (conversations.get(conversationId)?.agentId === agentId || mainChatAgent(conversationId) === agentId) return true;
  }
  return false;
}
/**
 * Hearthside: refuse a change that restarts the runtime while a reply is being
 * written. The restart kills the runtime the reply is running in, so the reply
 * and whatever tool it was running were lost for a switch that could wait.
 */
export function assertNoReplyRunning(change: string): void {
  // A held turn (its outcome uncertain, Stop refused) is not being written and
  // may never end: counting it would lock these switches for good, the
  // detailed log among them, which is the diagnostic for exactly that state.
  const writing = [...turns.values()].some((turn) => !turn.handoffBlocked);
  if (writing || preparingTurns.size > 0) {
    throw new Error(`A reply is still being written, and ${change} restarts the runtime it is running in. Wait for it to finish, or stop it, then try again.`);
  }
}
export function recoveryHasActiveTurns(): boolean { return turns.size > 0 || destinationTurns.size > 0 || preparingTurns.size > 0; }

export async function stopTurn(conversationId: string): Promise<void> {
  // A move in flight is deliberately *not* refused here. Aborting the source is
  // how accepted work drains to its handoff boundary, and refusing deadlocks
  // that drain. What a pending move does change is what may be *promised*:
  // `executionControls` reports Stop as unavailable while the move is live,
  // because a source abort cannot guarantee the destination will not carry on.
  const watch = destinationWatch(conversationId);
  // A watch that is idle while a turn is running *here* (the person chose this
  // app again after a move) is not what Stop is for: the ordinary Stop below is.
  const here = turns.get(conversationId);
  const runningHere = Boolean(here && !here.finished && !here.handoffBlocked) || preparingTurns.has(conversationId);
  if (watch && !(runningHere && !watch.running)) {
    if (!watch.running) throw new Error("Nothing is running on this conversation's destination right now.");
    if (watch.stopped) return;
    watch.stopped = true;
    settleApprovals(watch, "Stopped by the user.");
    setActivity(watch, "Stopping");
    // Accepted by the destination is not "the work ended". An observer is never
    // sent a terminal `result`, so the turn ends when the destination reports
    // itself idle (`loop_status: WAITING_ON_INPUT`). If it never says so, this
    // timer does **not** declare the stop done — it gives up watching and says
    // the stop was never confirmed.
    watch.stopTimer = setTimeout(() => abandonUnconfirmedStop(conversationId), STOP_GRACE_MS);
    watch.stopTimer.unref?.();
    await watch.attachment.requestStop().catch(() => undefined);
    return;
  }
  // A move this app issued makes Stop unpromisable: `executionControls` reports
  // it unavailable because aborting the source cannot stop a destination that
  // may carry the work on. Attempting the abort anyway would contradict what
  // the person was just told, and can itself encourage the handoff. A move the
  // *agent* asked for is different: there the abort is how accepted work drains
  // to its boundary, and the source is still the only thing holding it.
  const inFlight = getMoveRecord(conversationId);
  if (inFlight && inFlight.initiatedBy === "hearthside" && !moveSettled(inFlight.phase)) {
    throw new Error(`This conversation is moving to ${inFlight.placeName}. Stop can't be relied on until it lands; stop it there, or in Letta.`);
  }
  // The move landed and there is no attachment to stop it through — it was
  // never made, it was let go, or it belongs to an account that has since
  // changed. The source session still held here is a leftover: the work is the
  // destination's now, aborting the leftover cannot stop it, and `at-destination`
  // is what the person was just shown. A turn started *after* the move is a
  // different thing entirely — that one is genuinely running here, and the
  // ordinary Stop below is its own.
  const startedSince = turns.get(conversationId);
  if (inFlight && !moveInFlight(inFlight.phase) && inFlight.phase !== "failed"
      && !(startedSince && startedSince.stream.startedAt > inFlight.startedAt)) {
    throw new Error(`This conversation is running on ${inFlight.placeName}. Stop it there, or in Letta.`);
  }
  if (destinationTurns.has(conversationId) || getExecutionState(conversationId).pendingDelivery) throw new Error("This input belongs to its current destination. Stop it in Letta; Hearthside will not abort an old source or replay it.");
  const preparation = preparingTurns.get(conversationId);
  preparation?.abort();
  preparingTurns.delete(conversationId);
  const turn = turns.get(conversationId);
  if (preparation && (intentionPreparations.has(preparation) || !turn)) {
    // Stopped before a turn existed (the session still starting, a file being
    // read). Nothing else will ever announce an end, and the window waits for
    // one before it lets the chat go: say it here.
    preparingActivity.delete(conversationId);
    emit({ type: "turn.finished", conversationId });
  }
  if (!turn || turn.stopped) return;
  if (turn.handoffBlocked) throw new Error("This turn may be continuing on another runtime. Hearthside cannot stop it through the old source; use its current runtime.");
  turn.stopped = true;
  settleApprovals(turn, "Stopped by the user.");
  setActivity(turn, "Stopping");
  // If the runtime does not wind the turn down promptly, end it locally.
  setTimeout(() => finishTurn(turn), STOP_GRACE_MS).unref();
  await turn.session.abort().catch(() => undefined);
}

export function respondApproval(
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision,
): void {
  // A conversation this app is watching at a move's destination keeps its
  // approvals here: they arrived as control requests on that attachment, and
  // answering them is the point of holding it.
  const watch = destinationWatch(conversationId);
  const watched = watch?.approvals.get(requestId);
  if (watch && watched) {
    watch.approvals.delete(requestId);
    watched.resolve(
      decision.behavior === "allow"
        ? {
            behavior: "allow",
            ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
            ...(decision.suggestionIds ? { updatedPermissions: decision.suggestionIds } : {}),
          }
        : { behavior: "deny", message: decision.message || "Denied by the user." },
    );
    emit({ type: "approval.resolved", conversationId, requestId });
    if (watch.approvals.size === 0 && watch.activity === "Waiting for approval") setActivity(watch, "Running tool");
    return;
  }
  if (destinationTurns.has(conversationId)) throw new Error("Answer this approval on the current destination in Letta.");
  // Hearthside: a reply a mod command started runs in the listener, not in one
  // of these sessions, so its approvals are answered on the control connection
  // that command was sent on (see mods/command-observer.ts).
  if (answerCommandApproval(conversationId, requestId, decision)) return;
  const turn = turns.get(conversationId);
  const pending = turn?.approvals.get(requestId);
  if (turn?.handoffBlocked) throw new Error("Execution ownership changed or is uncertain. Answer this approval on the current runtime, not the old source.");
  if (!turn || !pending) return;
  turn.approvals.delete(requestId);
  pending.resolve(
    decision.behavior === "allow"
      ? {
          behavior: "allow",
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          ...(decision.suggestionIds ? { updatedPermissions: decision.suggestionIds } : {}),
        }
      : { behavior: "deny", message: decision.message || "Denied by the user." },
  );
  emit({ type: "approval.resolved", conversationId, requestId });
}

/** Apply a permission mode change to turns that are already running. */
export function applyPermissionMode(): void {
  const permissionMode = getPermissionMode();
  for (const turn of turns.values()) {
    const agentId = agentIdFor(turn.conversationId) ?? mainChatAgent(turn.conversationId);
    if (!agentId || isManualOnlyRecovery(agentId) || turn.handoffBlocked) continue;
    void turn.session.changeDeviceState({ permissionMode }).catch(() => undefined);
  }
  // Hearthside: a channel reply is not one of these turns. The channel service
  // asks for the mode itself, from the bot's own account settings, so the choice
  // has to be written there too (see channel-permission.ts) — in both
  // directions: going back to "Ask first" is what takes YOLO away again.
  void applyChannelPermissionMode().catch((error: unknown) => console.warn(`[channels] permission mode: ${describeError(error)}`));
}

// Hearthside: Discord chat modes need to rename and archive chats, and hear about new channel chats.
setChatModeHelpers({
  archive: (conversationId) => archiveConversation(conversationId),
  rename: async (conversationId, title) => {
    await renameConversation(conversationId, title);
  },
  createChat: async (agentId, title) => {
    const sdk = await ensureClient();
    const created = await sdk.conversations.create({ agentId, summary: title });
    startsFresh(created.id);
    return created.id;
  },
  idle: async (conversationId, agentId) => {
    if (turns.has(conversationId) || turns.has(`main:${agentId}`) || preparingTurns.has(conversationId) || preparingTurns.has(`main:${agentId}`)) return false;
    return runtimeIdle({ agent_id: agentId, conversation_id: conversationId });
  },
});
setGatewayEventListener((event) => {
  onGatewayEvent(event);
  if (event.type === "hearthside_gateway_ready") {
    void (async () => {
      const failed = (what: string) => (error: unknown) => console.warn(`[channels] ${what}: ${describeError(error)}`);
      // The chosen permission mode comes first. A service that has just come up
      // (first start, a restart after a crash, a recovered lease, a new
      // connection) switches on every bot that was left enabled BEFORE it
      // reports ready, so one may already be listening under the mode its
      // account was last told — out of date if the person changed their mind
      // while it was down. This is the earliest the protocol lets us correct
      // that, and reconciliation below can take a while; a bot it switches on
      // is told the mode in the same call that switches it on.
      await applyChannelPermissionMode().catch(failed("permission mode"));
      // Hearthside: bots belong to a connection; start the ones for this one, park the rest.
      await reconcileBotOwners(listAgents).catch(failed("bot owners"));
      // Said again once the ownership picture has settled: a second chance if
      // the account list couldn't be read from a service that had only just
      // come up, and it now speaks only for the bots that stayed ours.
      await applyChannelPermissionMode().catch(failed("permission mode"));
    })();
  }
});

// Hearthside: calendar reminders. "Tell my agent" posts a labelled note into the
// agent's main chat, waiting (up to two minutes) if that chat is busy.
export function startCalendarReminders(): void {
  startCalendar({
  sendToAgent: async (agentId, text) => {
    assertRecoveryAutomationAdmission(agentId);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await sendMessage({ agentId, conversationId: `main:${agentId}`, text, otid: randomUUID(), cwd: homedir() }, "controller");
        return;
      } catch (error) {
        if (!/still working/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
    throw new Error("The agent's main chat stayed busy.");
  },
  });
}

// --- Backups -----------------------------------------------------------------

/** Recovery must never silently create a target on Cloud or a remote connection. */
export async function getLocalRecoveryClient(): Promise<Pick<LettaAgentClient, "createAgent">> {
  if (getConnectionConfig().backend !== "local") throw new Error("Recovery requires the local backend.");
  await ensureClient();
  const owned = server;
  if (getConnectionConfig().backend !== "local" || !owned) throw new Error("Connection changed during recovery preflight.");
  return {
    createAgent: async (options) => {
      if (getConnectionConfig().backend !== "local" || server !== owned) throw new Error("Connection changed before recovery creation.");
      // A dedicated client avoids the SDK's default global-agent pinning side effect.
      const recovery = new LettaAgentClient({ backend: "remote", url: owned.endpoint.url, authToken: owned.endpoint.token, pinGlobalAgent: false, WebSocket: HelperAwareWebSocket as never });
      try { return await recovery.createAgent(options); }
      finally { await recovery.close(); }
    },
  };
}

/** Stop only our owned local server, prove process exit, publish, then reconnect. */
export async function withLocalRecoveryRuntimeStopped(publish: () => Promise<void>): Promise<void> {
  if (nativeRecoveryStop || getConnectionConfig().backend !== "local") throw new Error("Native recovery requires an idle owned local runtime.");
  if (turns.size || destinationTurns.size || preparingTurns.size) throw new Error("Wait for active turns and queued preparations before native recovery.");
  await ensureClient();
  if (!server || getConnectionConfig().backend !== "local") throw new Error("The local recovery runtime changed.");
  nativeRecoveryStop = true;
  let exited = false;
  try {
    await disconnect();
    await runtimeStoppedStrict(15_000);
    exited = true;
    await publish();
  } finally {
    if (exited) {
      nativeRecoveryStop = false;
      if (!closingApp) await ensureClient();
    } else {
      // A timeout is not an exit receipt. Never start a second writer beside
      // a process whose termination is unconfirmed.
      void runtimeStoppedStrict(300_000).then(async () => {
        nativeRecoveryStop = false;
        if (!closingApp) await ensureClient();
      }).catch(() => setConnection({ status: "error", backend: "local", error: "The previous runtime has not been confirmed stopped. Recovery was not published; restart Hearthside after stopping that runtime." }));
    }
  }
}

/** Known credential fields are excluded, not arbitrary secrets in user-authored content. */
export function sanitizeBackupState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBackupState);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api_?key|access_?token|refresh_?token|token|password|secret|authorization|headers|environment_variables|env|tool_exec_environment_variables)$/i.test(key)).map(([key, item]) => [key, sanitizeBackupState(item)]));
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return "[invalid endpoint]"; }
  }
  return value;
}

/** Raw public SDK state, with an explicit configuration allowlist rather than UI summaries. */
export async function backupAgent(agentId: string): Promise<{ id: string; name: string; [key: string]: unknown }> {
  const agent = await (await ensureClient()).agents.retrieve(agentId);
  const fields = ["id", "name", "description", "system", "agent_type", "created_at", "updated_at", "llm_config", "embedding_config", "model", "model_settings", "compaction_settings", "context_window_limit", "message_ids", "memory", "blocks", "tools", "tool_rules", "tags", "enable_sleeptime", "multi_agent_group", "response_format"];
  return sanitizeBackupState(Object.fromEntries(fields.filter((key) => key in agent).map((key) => [key, (agent as unknown as Record<string, unknown>)[key]]))) as { id: string; name: string; [key: string]: unknown };
}

/** Hearthside: every conversation of an agent for a backup: the main chat, the listed ones and the archived ones. */
/** Every page of a conversation listing; a stalled cursor is an error, not completion. */
export async function everyConversation(page: (after?: string) => Promise<LettaConversation[]>, maxPages = 500): Promise<LettaConversation[]> {
  const list: LettaConversation[] = [];
  const ids = new Set<string>();
  let after: string | undefined;
  for (let n = 0; n <= maxPages; n++) {
    const context = { operation: "conversations.list" as const, page: n + 1, count: list.length, limit: CONVERSATION_PAGE };
    let batch: LettaConversation[];
    try { batch = await page(after); } catch (error) { throw backupSourceFailure(error, context); }
    if (!Array.isArray(batch)) throw new BackupSourceError(context, "invalid_response");
    if (n === maxPages && batch.length > 0) throw new BackupSourceError(context, "page_limit");
    const fresh = batch.filter((conversation) => !ids.has(conversation.id));
    for (const conversation of fresh) ids.add(conversation.id);
    list.push(...fresh);
    if (batch.some((item) => !item.id)) throw new BackupSourceError(context, "cursor_missing");
    if (batch.length > 0 && fresh.length === 0) throw new BackupSourceError(context, "cursor_repeated");
    if (batch.length < CONVERSATION_PAGE) return list;
    const next = batch[batch.length - 1]!.id;
    if (next === after) throw new BackupSourceError(context, "cursor_stalled");
    after = next;
  }
  throw new BackupSourceError({ operation: "conversations.list", count: list.length }, "page_limit");
}

/** One chat as a backup records it: ids, titles, archive state and the active-context window. */
export type BackupConversationRecord = { id: string; title: string; archived: boolean; main?: boolean; createdAt?: string | null; updatedAt?: string | null; context?: unknown };

/**
 * The main chat's record: its active-context window comes from the agent, which
 * is also the authoritative check that this agent is on this connection.
 */
export async function backupMainConversation(agentId: string): Promise<BackupConversationRecord> {
  const sdk = await ensureClient();
  const agent = await sdk.agents.retrieve(agentId);
  return { id: mainChatId(agentId), title: MAIN_CHAT_TITLE, archived: false, main: true, ...(Array.isArray(agent.message_ids) ? { context: sanitizeBackupState({ in_context_message_ids: agent.message_ids, model_settings: agent.model_settings, compaction_settings: agent.compaction_settings, source: "agent.message_ids" }) } : {}) };
}

/**
 * One page of an agent's chat listing, newest first. The caller decides how many
 * pages to walk: a backup walks them all (`everyConversation`), a bounded check
 * reads only as many as its limits allow.
 */
export async function backupConversationPage(agentId: string, options: { archived?: boolean; after?: string; limit?: number } = {}): Promise<LettaConversation[]> {
  const sdk = await ensureClient();
  const limit = Math.max(1, Math.min(CONVERSATION_PAGE, options.limit ?? CONVERSATION_PAGE));
  return sdk.conversations.list({ agentId, limit, order: "desc", ...(options.archived ? { archiveStatus: "archived" as const } : {}), ...(options.after ? { after: options.after } : {}) });
}

/** One chat's persisted record, including the active-context window a capture stores. */
export async function backupConversationRecord(conversationId: string): Promise<BackupConversationRecord> {
  const sdk = await ensureClient();
  const persisted = await sdk.conversations.retrieve(conversationId);
  return {
    id: conversationId,
    title: persisted.summary?.trim() || "Untitled chat",
    archived: persisted.archived === true,
    createdAt: typeof persisted.created_at === "string" ? persisted.created_at : null,
    updatedAt: typeof persisted.updated_at === "string" ? persisted.updated_at : null,
    ...(Array.isArray(persisted.in_context_message_ids) ? { context: sanitizeBackupState({ in_context_message_ids: persisted.in_context_message_ids, summary: persisted.summary, description: persisted.description, model: persisted.model, model_settings: persisted.model_settings, context_window_limit: persisted.context_window_limit, source: "conversation.retrieve" }) } : {}),
  };
}

export async function backupConversations(agentId: string): Promise<BackupConversationRecord[]> {
  const seen = new Map<string, BackupConversationRecord>();
  const main = await backupMainConversation(agentId);
  seen.set(main.id, main);

  const lists = await Promise.all([
    everyConversation((after) => backupConversationPage(agentId, { ...(after ? { after } : {}) })),
    everyConversation((after) => backupConversationPage(agentId, { archived: true, ...(after ? { after } : {}) })),
  ]).catch((error: unknown) => {
    throw backupSourceFailure(error, { operation: "conversations.list" });
  });
  for (const conversation of lists.flat()) {
    if (seen.has(conversation.id)) continue;
    seen.set(conversation.id, await backupConversationRecord(conversation.id));
  }
  return [...seen.values()];
}

/** Hearthside: one page of a conversation's raw messages, for a backup (the main chat goes through the runtime). */
export async function backupMessages(
  conversationId: string,
  options: { after?: string; before?: string; limit: number; order: "asc" | "desc" },
  /**
   * A caller's own deadline for this one read, for callers stricter than the
   * standing one. Honoured by the Cloud path (as an abort that covers the body)
   * and by the local main chat (as a reply timeout). The named-chat SDK path
   * accepts neither, so there a caller can stop waiting but cannot stop the read.
   */
  read: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ messages: unknown[]; hasMore?: boolean }> {
  const sdk = await ensureClient();
  const mainAgent = mainChatAgent(conversationId);
  // The listener trims projected message components to `limit`, which can cut
  // a shared-ID group. Cloud backups must read the untrimmed API page instead.
  if (getConnectionConfig().backend === "cloud") {
    // The deadline is passed only when there is one, so the call keeps its three-argument shape otherwise.
    return cloudBackupMessages(mainAgent ? "default" : conversationId, options, mainAgent ?? undefined, ...(read.signal ? [{ signal: read.signal }] : []));
  }
  if (mainAgent) {
    const reply = await request<{ type: string; messages?: WireMessage[]; has_more?: boolean }>("conversation_messages_list", {
      conversation_id: "default",
      query: { agent_id: mainAgent, limit: options.limit, order: options.order, ...(options.after ? { after: options.after } : {}), ...(options.before ? { before: options.before } : {}) },
    }, read.timeoutMs);
    if (!Array.isArray(reply.messages)) throw new BackupSourceError({ operation: "messages.list", chat: "main" }, "invalid_response");
    // The runtime's has_more probes older messages, even for ascending requests.
    // In ascending backup walks only an empty page proves completion; the collector
    // validates each cursor and bounds the walk, including one terminal probe.
    return { messages: reply.messages, ...(options.order === "asc" ? { hasMore: reply.messages.length > 0 } : typeof reply.has_more === "boolean" ? { hasMore: reply.has_more } : {}) };
  }
  const page = await sdk.conversations.listMessages(conversationId, { limit: options.limit, order: options.order, ...(options.after ? { after: options.after } : {}), ...(options.before ? { before: options.before } : {}) });
  if (!page || !Array.isArray(page.messages)) throw new BackupSourceError({ operation: "messages.list", chat: "named" }, "invalid_response");
  return { messages: page.messages as unknown[], ...(typeof page.hasMore === "boolean" ? { hasMore: page.hasMore } : {}) };
}

/**
 * Who can see a conversation, read from the bindings and routes that exist now.
 *
 * Deliberately NOT gated on `channelsUsed()`. That flag only records that a
 * channel was once set up from this app; a runtime configured somewhere else can
 * be hosting a bot for this companion while the flag is false, and skipping the
 * inventory on the strength of it would call that conversation private without
 * ever looking. So the inventory is always read, and anything unreadable or
 * malformed refuses: a bot that cannot be listed could be pointed here.
 */
async function intentionsAudience(agentId: string, conversationId: string) {
  return conversationAudience(agentId, conversationId, {
    accounts: () => audienceChannelBindings(agentId),
    routes: async () => {
      const found: Array<{ conversationId: string; accountId: string }> = [];
      // Deliberately not listChannelRoutes(): it swallows a channel's failure and
      // returns an empty list, which would read as "nothing points here".
      for (const channelId of ["telegram", "discord"]) {
        const reply = await gatewayRequest<{ type: string; routes?: Array<{ conversation_id?: unknown; account_id?: unknown }> }>("channel_routes_list", { channel_id: channelId, agent_id: agentId });
        if (!Array.isArray(reply.routes)) throw new Error("Cannot verify the conversation's audience.");
        for (const route of reply.routes) found.push({
          conversationId: typeof route.conversation_id === "string" ? route.conversation_id : "",
          accountId: typeof route.account_id === "string" ? route.account_id : "",
        });
      }
      return found;
    },
    isMainChat: id => mainChatAgent(id) !== null || id === "default" || id === "",
  });
}

/** The private in-app implementation; this does not install a hosted service or
 * activate Telegram/Discord routes. Cloud agent storage is not this scheduler. */
export function startIntentionsRuntime(): void {
  configureIntentions({
    validateConversation: async (agentId, conversationId) => {
      const identity = intentionsConnectionId();
      if (connection.status !== "ready") throw new Error("Connect before using intentions.");
      const sdk = await ensureClient();
      const main = mainChatAgent(conversationId);
      if (main) {
        if (main !== agentId) throw new Error("The conversation belongs to another agent.");
        await sdk.agents.retrieve(agentId);
      } else {
        const entry = toConversationSummary(await sdk.conversations.retrieve(conversationId));
        if (entry.agentId !== agentId) throw new Error("The conversation belongs to another agent.");
        // Hearthside: a follow-up is a send; never into a read-only history part.
        if (entry.history || isRecordedHistoryVolume(entry.id)) throw new Error(HISTORY_READ_ONLY);
      }
      const decision = await intentionsAudience(agentId, conversationId);
      if (decision.audience !== "private") throw new Error(audienceRefusal(decision));
      if (identity !== intentionsConnectionId() || connection.status !== "ready") throw new Error("Connection changed while checking intentions.");
    },
    capture: {
      /**
       * One bounded classification in its own agent-free conversation.
       *
       * `query()` is an async generator and is handed over as a stream; the
       * caller iterates it, bounds it with one wall clock covering creation and
       * streaming, interrupts before closing, and archives the conversation
       * afterwards. Retries are off: `maxRetries: 0` means no corrective extra
       * turns behind the person's back. Shell and action tools are off, though
       * the SDK still installs its own structured-output sink, which is how the
       * answer comes back at all.
       *
       * The client is captured here and used for this job's cleanup too. A check
       * can outlive the connection that started it: resolving the client again at
       * archive time would use whatever account is current by then, archiving
       * against the wrong backend and handing it a private conversation id.
       */
      start: job => {
        if (connection.status !== "ready" || !client) throw new Error("Not connected.");
        const sdk = client;
        const stream = sdk.query({
          prompt: job.prompt,
          options: {
            model: job.model,
            system: job.system,
            name: job.name,
            parentAgentId: job.parentAgentId,
            isSubagent: false,
            outputFormat: { type: "json_schema", schema: job.schema, maxRetries: 0 },
            permissionMode: "strict",
            skillSources: [],
            tools: [],
            allowedTools: [],
            canUseTool: () => ({ behavior: "deny", message: "This classification cannot use tools.", interrupt: true }),
          },
        });
        return {
          stream,
          conversationId: () => stream.conversationId,
          interrupt: () => stream.interrupt(),
          close: () => stream.close(),
          archive: async conversationId => {
            await sdk.conversations.update(conversationId, { archived: true });
          },
        };
      },
      // Only reached by a handle without its own archive; every handle this
      // transport returns has one, so a job never archives on a later account.
      archive: async conversationId => {
        const sdk = await ensureClient();
        await sdk.conversations.update(conversationId, { archived: true });
      },
      unsupported: error => {
        const text = error instanceof Error ? error.message : String(error);
        if (/not connected/i.test(text)) return "Short-term memory needs a live connection before it can read anything.";
        if (/not supported|unsupported|unknown (?:method|command)|404/i.test(text)) return "This connection does not support the separate classification conversation short-term memory needs.";
        return null;
      },
    },
    isBusy: scope => agentBusy(scope.agentId) || preparingTurns.has(scope.conversationId),
    readPage: async (scope, options) => {
      const page = await backupMessages(scope.conversationId, options);
      return { messages: decodeIntentionsPage(page.messages, scope, intentionsStore()), hasMore: page.hasMore };
    },
    reconcile: async (scope, otid) => {
      const page = await backupMessages(scope.conversationId, { limit: 100, order: "desc" });
      const rows = projectHistory(page.messages as Parameters<typeof projectHistory>[0]);
      // A persisted input proves acceptance, not delivery. No "next assistant"
      // heuristic: concurrent turns could otherwise acknowledge the wrong reply.
      return { state: rows.some(row => row.kind === "user" && row.otid === otid) ? "present" : "unknown" };
    },
    invoke: async claim => {
      // This controller has only an owned-app-server execution path. It cannot
      // infer permission to reclaim a Cloud conversation from opening the app
      // or from an old proactive opt-in. Defer until routed follow-ups exist.
      const scope = claim.followup.scope, id = scope.conversationId;
      const verifyLocalOwnership = async () => {
        if (!cloudLink) return;
        const state = await getConversationExecution(id);
        if (state.provenance !== "desktop" || state.followsOwner || state.status === "blocked" || conversationTarget(id).kind !== "desktop") throw new Error("Follow-up held: this conversation is not owned by the desktop.");
        const owner = await admissionOwner(id);
        if (owner !== null && owner !== state.desktopConnectionId) throw new Error("Follow-up held: execution ownership changed.");
      };
      await verifyLocalOwnership();
      await assertFollowupScope(scope);
      // A remote execution computer runs the turn without this desktop's tools,
      // so a follow-up sent there would arrive with no way to read or close the
      // item it is about. Refuse rather than send something half-wired.
      if (executionTarget()) throw new Error("Timed follow-ups run on this computer only. They are paused while replies are set to run on another computer.");
      if (agentBusy(scope.agentId) || preparingTurns.has(id)) throw new Error("Conversation is busy.");
      const reservation = new AbortController();
      preparingTurns.set(id, reservation);
      publishOwnControls(id);
      intentionPreparations.add(reservation);
      preparingActivity.set(id, "Following up on an intention");
      let session: LettaCodeSession | null = null;
      let failure: string | undefined;
      const deadline = setTimeout(() => reservation.abort(), 120_000);
      deadline.unref?.();
      reservation.signal.addEventListener("abort", () => {
        if (session) {
          const stopping = session;
          // Give the abort frame a chance to reach the runtime before closing its
          // transport; still bound cleanup if the server never acknowledges it.
          const grace = setTimeout(() => stopping.close(), STOP_GRACE_MS);
          grace.unref?.();
          void stopping.abort().catch(() => undefined).finally(() => { clearTimeout(grace); stopping.close(); });
        }
      }, { once: true });
      emit({ type: "turn.started", conversationId: id });
      try {
        const sdk = await ensureClient();
        if (!await runtimeIdle({ agent_id: scope.agentId, conversation_id: mainChatAgent(id) ? "default" : id })) throw new Error("Cannot confirm the runtime is idle.");
        await assertFollowupScope(scope);
        reservation.signal.throwIfAborted();
        const store = intentionsStore(), current = store.get(scope, claim.followup.id), policy = store.getPolicy(scope);
        if (!current || current.revision !== claim.followup.revision || !policy.enabled || !policy.proactive) throw new Error("Follow-up was changed or disabled before sending.");
        await verifyLocalOwnership();
        session = sdk.resumeSession(mainChatAgent(id) ?? id, {
          permissionMode: "strict", allowedTools: [], tools: [],
          canUseTool: () => ({ behavior: "deny", message: "This opt-in follow-up turn cannot use tools or other channels." }),
        });
        const text = controllerPrompt(claim);
        await session.send(text, { otid: claim.otid });
        const accumulator = createTranscriptAccumulator();
        let success = false, runId: string | undefined;
        for await (const event of session.stream()) {
          reservation.signal.throwIfAborted();
          if (scope.connectionId !== intentionsConnectionId()) { reservation.abort(); throw new Error("Account changed during follow-up."); }
          const live = store.get(scope, claim.followup.id), livePolicy = store.getPolicy(scope);
          if (!live || live.revision !== claim.followup.revision || !livePolicy.enabled || !livePolicy.proactive ||
              livePolicy.topicExclusions.some(topic => `${live.summary} ${live.action}`.toLowerCase().includes(topic.toLowerCase()))) {
            reservation.abort(); reservation.signal.throwIfAborted();
          }
          if (event.type === "result") { success = event.success; runId = event.runIds?.[0]; }
          accumulator.apply(event);
          const rows = markControllerRows(accumulator.rows().map(row => toChatRow(row)), scope);
          if (rows.length) emit({ type: "turn.rows", conversationId: id, rows });
        }
        reservation.signal.throwIfAborted();
        if (!success) throw new Error("No successful terminal result; delivery remains uncertain.");
        const reply = [...accumulator.rows()].reverse().find(row => row.kind === "assistant" && row.text.trim());
        if (reply && reply.kind === "assistant") lastReplies.set(id, reply.text);
        return { runId, delivered: Boolean(reply), deliveryId: reply ? `transcript:${reply.key}` : undefined };
      } catch (error) {
        failure = describeError(error);
        throw error;
      } finally {
        clearTimeout(deadline);
        if (!reservation.signal.aborted) session?.close();
        intentionPreparations.delete(reservation);
        if (preparingTurns.get(id) === reservation) {
          preparingTurns.delete(id);
          preparingActivity.delete(id);
          publishOwnControls(id);
          if (scope.connectionId === intentionsConnectionId()) emit({ type: "turn.finished", conversationId: id, ...(failure ? { error: failure } : {}) });
        }
      }
    },
  });
}
