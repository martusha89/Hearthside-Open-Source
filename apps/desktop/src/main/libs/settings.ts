// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { app, safeStorage } from "electron";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AppSettings,
  ConversationExecutionState,
  ConversationMovePhase,
  BackendKind,
  GifFilter,
  PermissionMode,
  SettingsUpdate,
  TextSize,
  ThemePreference,
} from "@hearthside/ipc-contract";
import { type LettaOAuthCredential, parseCredential } from "./letta-oauth";
import { gifsAvailable, newCustomerId } from "./gifs";
import { protectedStorageMessage, protectedStorageProblem } from "./protected-storage";

/**
 * App settings, persisted as JSON in the user data directory.
 *
 * Environment variables (LETTA_BACKEND, LETTA_API_KEY, LETTA_BASE_URL,
 * LETTA_SERVER_URL, LETTA_SERVER_TOKEN or LETTA_APP_SERVER_TOKEN) act as defaults for anything the user
 * has not set in the Settings dialog, so a `.env` file keeps working in
 * development.
 */

type StoredSettings = {
  executionComputer?: AppSettings["executionComputer"];
  connectionRevision?: string;
  /**
   * Hearthside: one revision per kind of connection. A single shared one was
   * replaced whenever anything about any connection changed, so a visit to
   * Letta Cloud (or an expired Cloud sign-in) while on This computer gave the
   * local store a new identity too: its pins, stars, follow-ups and the window's
   * loaded chats all belonged to the old one. `connectionRevision` above keeps
   * mirroring the active entry for older builds.
   */
  connectionRevisions?: Partial<Record<BackendKind, string>>;
  /** Hearthside: see localFollowupIdentity. */
  localFollowupIdentity?: { revision: string; home: string | null; id: string };
  conversationExecution?: { scope: string; states: Record<string, ConversationExecutionState> };
  /**
   * The same two stores for the connection kinds that are not the one in use,
   * while their accounts are unchanged. Going Cloud → This computer → Cloud on
   * one account used to empty the Cloud chats' destinations, held deliveries
   * and move records the moment anything read them from the other side.
   */
  setAside?: Record<string, { states?: Record<string, ConversationExecutionState>; records?: Record<string, StoredMoveRecord> }>;
  /** Native moves. Deliberately not merged into conversationExecution: a move
   * carries an idempotency key that must never reach the renderer, and a held
   * pendingDelivery must survive every move outcome untouched. */
  conversationMoves?: { scope: string; records: Record<string, StoredMoveRecord> };
  backend?: BackendKind;
  serverUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  serverToken?: string;
  permissionMode?: PermissionMode;
  agentIds?: Partial<Record<BackendKind, string>>;
  recentCwds?: string[];
  conversationCwds?: Record<string, string>;
  /** Hearthside: local agents created before any model was connected (see runtime.ts settleLocalModel). */
  awaitingModel?: string[];
  /** Hearthside: the model last used on This computer, as it was chosen (a handle or a picker's tier id). */
  lastLocalModel?: string;
  // Hearthside display preferences.
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
  /** Mods are turned off for every runtime Hearthside starts (LETTA_DISABLE_MODS). */
  modsOff?: boolean;
  /** Bots in "just me" mode, waiting for their first approval (account ids). */
  channelJustMe?: string[];
  /** Where each Discord bot's server messages go (account id → mode). */
  channelChatModes?: Record<string, "main" | "server" | "channel">;
  /** Discord channels a bot was turned off in (account id → channel ids). */
  discordMutedChannels?: Record<string, string[]>;
  /** "accountId:serverId" → the chat that server's messages go to. */
  discordServerChats?: Record<string, string>;
  /** Original per-channel conversations, retained across explicit mode changes. */
  discordChannelChats?: Record<string, string>;
  /** Original runtime policy, saved before applying Hearthside's mute overlay. */
  discordListeningBaselines?: Record<string, DiscordAllowedChannels>;
  /** Pairing codes the person declined (hidden; they expire on their own). */
  declinedPairings?: string[];
  /** A channel has been set up, so the channel service starts with the app. */
  channelsUsed?: boolean;
  /** Which companion and connection each bot belongs to, and whether it should run (account id → record). */
  channelBots?: Record<string, ChannelBotRecord>;
  /** Hearthside: what a check of each local provider connection found (see provider-check.ts). */
  providerChecks?: Record<string, "verified" | "unchecked" | "unreachable">;
  /** Per-install salt for bot token fingerprints, so no bare digest of a token is kept. */
  channelTokenSalt?: string;
  /** Backups: the folder, what goes in, and when (see libs/backup). */
  backup?: BackupSettings;
  /** The "still running in the tray" hint has been shown once. */
  trayHintShown?: boolean;
  gifs?: boolean;
  gifFilter?: GifFilter;
  weather?: boolean;
  homeTown?: string;
  obsidianVault?: string;
  imageEngine?: "off" | "codex" | "grok";
  /** Anonymous id KLIPY asks for (per install, not per person). */
  gifCustomerId?: string;
  /** Hearthside: "Sign in with Letta" OAuth credential, encrypted JSON. */
  lettaOAuth?: string;
  /** Hearthside: connectors (MCP servers) run from this computer; env/headers encrypted JSON. */
  connectors?: Array<Omit<StoredConnector, "env" | "headers" | "oauth"> & { env?: string; headers?: string; oauth?: string }>;
  /** Hearthside: in-progress / completed connector sign-in state, encrypted per key. */
  connectorOAuthStore?: Record<string, string>;
};

/** A connector run from this computer, with its secrets decrypted. Never sent to the window. */
export type StoredConnector = {
  id: string;
  name: string;
  kind: "command" | "url";
  command?: string;
  args?: string[];
  url?: string;
  /** Web connectors: Streamable HTTP (default) or the older SSE. */
  transport?: "http" | "sse";
  env?: Record<string, string>;
  headers?: Record<string, string>;
  agentIds: string[];
  /** A built-in preset this came from (e.g. "elevenlabs"). */
  preset?: string;
  /** Browser sign-in (OAuth) for web connectors. */
  oauth?: ConnectorOAuth;
  /** Tools given to the agent (undefined: chosen on first connect). */
  enabledTools?: string[];
  defaultVoice?: { id: string; name: string };
  voiceModel?: string;
  /** Which version of Hearthside's default tool choice enabledTools came from. */
  defaultsVersion?: number;
};

export type ConnectorOAuth = {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret?: string;
  /** Epoch ms, when known. */
  expiresAt?: number;


  issuer?: string;
  tokenEndpoint?: string;
  resource?: string;
};

export type ConnectionConfig = {
  executionComputer?: AppSettings["executionComputer"];
  backend: BackendKind;
  serverUrl: string;
  serverToken: string;
  apiKey: string;
  apiBaseUrl: string;
  /** Signed in with Letta (OAuth). The credential itself is read via getLettaCredential(). */
  lettaSignedIn: boolean;
};

const BACKENDS: BackendKind[] = ["local", "cloud", "remote"];
const PERMISSION_MODES: PermissionMode[] = ["standard", "acceptEdits", "unrestricted", "strict"];
const MAX_RECENT_CWDS = 8;
const MAX_CONVERSATION_CWDS = 500;

let cache: StoredSettings | null = null;

export function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function load(): StoredSettings {
  if (cache) return cache;
  let contents: string;
  try {
    contents = readFileSync(settingsPath(), "utf8");
  } catch (error) {
    // Only absence means a new profile. Never cache defaults after a read failure:
    // every mutation starts here, and must fail rather than overwrite unread settings.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    cache = {};
    return cache;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The settings file must contain a JSON object; nothing was saved.");
  }
  // Failed reads/parses leave the cache empty, so repairing the file allows a retry.
  cache = parsed as StoredSettings;
  return cache;
}

function save(next: StoredSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    // Same-directory rename replaces atomically. Never delete the old file first,
    // even on platforms that refuse replacement: it may be the only valid copy.
    // Exclusive creation also prevents following an existing temporary symlink.
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, JSON.stringify(next, null, 2));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    cache = next;
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch { /* Best effort; do not mask the save error. */ }
    }
  }
}



export class SecretStorageUnavailableError extends Error {}

/** Secrets are encrypted with the OS keychain. There is no plaintext fallback. */
function encodeSecret(value: string): string {
  const problem = protectedStorageProblem();
  if (problem) throw new SecretStorageUnavailableError(protectedStorageMessage(problem, "this secret"));
  try {
    return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  } catch {
    throw new SecretStorageUnavailableError("This computer's protected storage refused to encrypt this secret, so nothing was saved. It is never written in the clear.");
  }
}

/** What the settings file holds for a secret. `unreadable` is not absence. */
export type StoredSecretState = "absent" | "encrypted" | "legacy-plaintext" | "unreadable";

export function storedSecretState(stored: string | undefined): StoredSecretState {
  if (!stored) return "absent";
  if (stored.startsWith("raw:")) return "legacy-plaintext";
  if (!stored.startsWith("enc:")) return "unreadable";
  try {
    safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    return "encrypted";
  } catch {
    return "unreadable";
  }
}

function decodeSecret(stored: string | undefined): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    }
    // Legacy: secrets written before the plaintext fallback was removed stay readable,
    // so an upgrade doesn't sign the person out. They are never rewritten here, and
    // any change to the value is stored encrypted; migration stays a deliberate step.
    if (stored.startsWith("raw:")) return stored.slice(4);
  } catch {
    // Undecryptable (e.g. a keychain reset). Readers get "", but this is not the same
    // as unset: storedSecretState() reports `unreadable` so callers can say so.
  }
  return "";
}

/** Hearthside: encrypt a secret for storage elsewhere (e.g. a calendar link). */
export function sealSecret(value: string): string {
  return encodeSecret(value);
}

export function openSecret(stored: string | undefined): string {
  return decodeSecret(stored);
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getConnectionConfig(): ConnectionConfig {
  const stored = load();
  const apiKey = decodeSecret(stored.apiKey) || env("LETTA_API_KEY");
  const envBackend = env("LETTA_BACKEND").toLowerCase() as BackendKind;
  const backend =
    stored.backend ??
    (BACKENDS.includes(envBackend) ? envBackend : apiKey ? "cloud" : "local");
  return {
    backend,
    executionComputer: backend === "cloud" ? stored.executionComputer ?? null : null,
    apiKey,
    serverUrl: stored.serverUrl ?? env("LETTA_SERVER_URL"),
    serverToken:
      decodeSecret(stored.serverToken) ||
      env("LETTA_SERVER_TOKEN") ||
      env("LETTA_APP_SERVER_TOKEN"),
    apiBaseUrl: stored.apiBaseUrl ?? env("LETTA_BASE_URL"),
    lettaSignedIn: getLettaCredential() !== null,
  };
}

/** Hearthside: the stored "Sign in with Letta" credential, if any. */
export function getLettaCredential(): LettaOAuthCredential | null {
  const stored = load().lettaOAuth;
  return stored ? parseCredential(decodeSecret(stored)) : null;
}

/**
 * The revision of one kind of connection. Until the per-kind entries exist
 * (they are written the first time something about a connection changes) the
 * single stored revision answers for whichever connection is in use, exactly
 * as before.
 */
function revisionOf(stored: StoredSettings, backend: BackendKind): string {
  if (!stored.connectionRevisions) return stored.connectionRevision ?? "initial";
  return stored.connectionRevisions[backend] ?? `unset:${backend}`;
}

/**
 * Give `backends` a new identity and leave the others as they are. The first
 * call hands the old shared revision to the connection in use, so nothing it
 * was scoping (chat organisation, follow-ups) is lost by the change of format.
 */
function withNewRevisions(stored: StoredSettings, active: BackendKind, backends: readonly BackendKind[], previous: BackendKind = active): StoredSettings {
  const revisions: Partial<Record<BackendKind, string>> = { ...(stored.connectionRevisions ?? { [previous]: stored.connectionRevision ?? "initial" }) };
  for (const backend of backends) revisions[backend] = randomUUID();
  // A kind that has no entry yet already answers as `unset:<kind>` (revisionOf).
  // It keeps that answer: giving it a fresh one here would change the identity
  // of a connection nothing about which had changed, on some unrelated save.
  revisions[active] ??= `unset:${active}`;
  return { ...stored, connectionRevisions: revisions, connectionRevision: revisions[active] };
}

/** Save (or clear, with null) the "Sign in with Letta" credential, encrypted. */
export function saveLettaCredential(credential: LettaOAuthCredential | null, newSession = false): void {
  let next: StoredSettings = { ...load() };
  // Only Letta Cloud's identity depends on the sign-in: This computer and a
  // self-hosted server are the same stores whoever is signed in to Letta.
  if (newSession || Boolean(credential) !== Boolean(next.lettaOAuth)) next = withNewRevisions(next, getConnectionConfig().backend, ["cloud"]);
  if (credential) next.lettaOAuth = encodeSecret(JSON.stringify(credential));
  else delete next.lettaOAuth;
  save(next);
}

export function getSettings(): AppSettings {
  const stored = load();
  const config = getConnectionConfig();
  return {
    backend: config.backend,
    executionComputer: stored.executionComputer ?? null,
    serverUrl: config.serverUrl,
    apiBaseUrl: config.apiBaseUrl,
    hasApiKey: config.apiKey.length > 0,
    hasLettaSignIn: config.lettaSignedIn,
    hasServerToken: config.serverToken.length > 0,
    connectionRevision: revisionOf(stored, config.backend),
    permissionMode: stored.permissionMode ?? "standard",
    agentId: stored.agentIds?.[config.backend] ?? null,
    recentCwds: stored.recentCwds ?? [],
    defaultCwd: homedir(),
    theme: stored.theme ?? "system",
    textSize: stored.textSize ?? "medium",
    showReasoning: stored.showReasoning ?? true,
    closeToTray: stored.closeToTray ?? true,
    reachableComputer: stored.reachableComputer ?? false,
    computerName: stored.computerName ?? "",
    favouriteAgents: stored.favouriteAgents ?? [],
    showUsage: stored.showUsage ?? true,
    showCompactions: stored.showCompactions ?? true,
    notifications: stored.notifications ?? true,
    startAtLogin: stored.startAtLogin ?? false,
    // People who used Hearthside before the welcome existed (a saved backend) skip it.
    // HEARTHSIDE_SOURCE_SKIP_WELCOME lets automated tests start on a fresh profile without it.
    useRealLettaHome: stored.useRealLettaHome ?? false,
    channelsUsed: stored.channelsUsed === true,
    gifsAvailable: gifsAvailable(),
    gifs: stored.gifs ?? true,
    gifFilter: stored.gifFilter ?? "medium",
    weather: stored.weather ?? true,
    homeTown: stored.homeTown ?? "",
    obsidianVault: stored.obsidianVault ?? "",
    imageEngine: stored.imageEngine ?? "off",
    welcomed: stored.welcomed ?? (stored.backend !== undefined || process.env.HEARTHSIDE_SOURCE_SKIP_WELCOME === "1"),
    // Hearthside: the tour shows once on a new install; existing installs can start it from Settings.
    toured: stored.toured ?? (stored.backend !== undefined || process.env.HEARTHSIDE_SOURCE_SKIP_WELCOME === "1"),
    runtimeDebugLog: stored.runtimeDebugLog === true,
    modsOff: stored.modsOff === true,
  };
}

/** Apply an update and report whether the backend connection must be rebuilt. */
export function updateSettings(update: SettingsUpdate): { connectionChanged: boolean } {
  const beforeConfig = getConnectionConfig();
  const before = JSON.stringify(beforeConfig);
  const next: StoredSettings = { ...load() };
  const previousHome = next.useRealLettaHome ?? false;

  if (update.backend && BACKENDS.includes(update.backend)) next.backend = update.backend;
  if (update.executionComputer !== undefined) {
    next.executionComputer = update.executionComputer
      ? { deviceId: update.executionComputer.deviceId, name: update.executionComputer.name }
      : null;
  }
  if (update.serverUrl !== undefined) next.serverUrl = update.serverUrl.trim();
  if (update.apiBaseUrl !== undefined) next.apiBaseUrl = update.apiBaseUrl.trim();
  if (update.apiKey !== undefined) {
    next.apiKey = update.apiKey ? encodeSecret(update.apiKey.trim()) : undefined;
  }
  if (update.serverToken !== undefined) {
    next.serverToken = update.serverToken ? encodeSecret(update.serverToken.trim()) : undefined;
  }
  if (update.permissionMode && PERMISSION_MODES.includes(update.permissionMode)) {
    next.permissionMode = update.permissionMode;
  }
  if (update.theme) next.theme = update.theme;
  if (update.textSize) next.textSize = update.textSize;
  if (update.showReasoning !== undefined) next.showReasoning = update.showReasoning;
  if (update.closeToTray !== undefined) next.closeToTray = update.closeToTray;
  if (update.reachableComputer !== undefined) next.reachableComputer = update.reachableComputer;
  if (update.computerName !== undefined) next.computerName = update.computerName.trim().slice(0, 80);
  if (update.showUsage !== undefined) next.showUsage = update.showUsage;
  if (update.showCompactions !== undefined) next.showCompactions = update.showCompactions;
  if (update.notifications !== undefined) next.notifications = update.notifications;
  if (update.startAtLogin !== undefined) next.startAtLogin = update.startAtLogin;
  if (update.welcomed !== undefined) next.welcomed = update.welcomed;
  if (update.toured !== undefined) next.toured = update.toured;
  // Finishing the welcome fixes the connection the person chose. One that was
  // only ever the derived default (This computer, with nothing saved) was
  // worked out again at every launch from the environment, so a Letta key or
  // LETTA_BACKEND appearing there later silently opened the app on Letta Cloud
  // with the local companions apparently gone. The tour's own "not yet seen"
  // is kept as it was, since it too was read off the backend being unsaved.
  if (update.welcomed === true && next.backend === undefined) {
    if (next.toured === undefined) next.toured = process.env.HEARTHSIDE_SOURCE_SKIP_WELCOME === "1";
    next.backend = beforeConfig.backend;
  }
  if (update.runtimeDebugLog !== undefined) next.runtimeDebugLog = update.runtimeDebugLog;
  if (update.useRealLettaHome !== undefined) next.useRealLettaHome = update.useRealLettaHome;
  if (update.modsOff !== undefined) next.modsOff = update.modsOff;
  if (update.gifs !== undefined) next.gifs = update.gifs;
  if (update.gifFilter) next.gifFilter = update.gifFilter;
  if (update.weather !== undefined) next.weather = update.weather;
  if (update.homeTown !== undefined) next.homeTown = update.homeTown.trim();
  if (update.obsidianVault !== undefined) next.obsidianVault = update.obsidianVault.trim();
  if (update.imageEngine) next.imageEngine = update.imageEngine;
  if (update.favouriteAgents !== undefined) next.favouriteAgents = [...new Set(update.favouriteAgents)];
  save(next);

  if (update.agentId !== undefined) setAgentId(update.agentId);
  const afterConfig = getConnectionConfig();
  const connectionChanged = before !== JSON.stringify(afterConfig);
  // Tool host changes reconnect, but do not replace the Cloud account or its drafts.
  const identityChanged = JSON.stringify({ ...beforeConfig, executionComputer: undefined }) !==
    JSON.stringify({ ...afterConfig, executionComputer: undefined });
  const homeChanged = update.useRealLettaHome !== undefined && update.useRealLettaHome !== previousHome;
  if (identityChanged || homeChanged) {
    // Each kind of connection keeps its own identity: only the ones whose own
    // details changed get a new one. Switching between them is not a change to
    // either (each already differs), so coming back to This computer finds the
    // same local store under the same identity. The runtime home holds every
    // owned runtime's state, so moving it renews them all.
    const changed: BackendKind[] = homeChanged ? [...BACKENDS] : [];
    if (beforeConfig.apiKey !== afterConfig.apiKey || beforeConfig.apiBaseUrl !== afterConfig.apiBaseUrl || beforeConfig.lettaSignedIn !== afterConfig.lettaSignedIn) changed.push("cloud");
    if (beforeConfig.serverUrl !== afterConfig.serverUrl || beforeConfig.serverToken !== afterConfig.serverToken) changed.push("remote");
    save(withNewRevisions(load(), afterConfig.backend, changed, beforeConfig.backend));
  }
  return { connectionChanged };
}

export function setAgentId(agentId: string | null): void {
  const stored = load();
  const backend = getConnectionConfig().backend;
  const agentIds = { ...stored.agentIds };
  if (agentId) agentIds[backend] = agentId;
  else delete agentIds[backend];
  save({ ...stored, agentIds });
}

/** Hearthside: true the first time only, so the tray hint shows once. */
export function takeTrayHint(): boolean {
  const stored = load();
  if (stored.trayHintShown) return false;
  save({ ...stored, trayHintShown: true });
  return true;
}

export function channelJustMe(accountId: string): boolean {
  return (load().channelJustMe ?? []).includes(accountId);
}

export function setChannelJustMe(accountId: string, on: boolean): void {
  const stored = load();
  const list = new Set(stored.channelJustMe ?? []);
  if (on) list.add(accountId);
  else list.delete(accountId);
  save({ ...stored, channelJustMe: [...list] });
}

export function channelChatModes(): Record<string, "main" | "server" | "channel"> {
  return load().channelChatModes ?? {};
}

export function channelChatMode(accountId: string): "main" | "server" | "channel" {
  return load().channelChatModes?.[accountId] ?? "channel";
}

export function setChannelChatModeSetting(accountId: string, mode: "main" | "server" | "channel"): void {
  const stored = load();
  save({ ...stored, channelChatModes: { ...stored.channelChatModes, [accountId]: mode } });
}

export type DiscordAllowedChannels = string[] | Record<string, "open" | "mention-only">;

export function discordListeningBaseline(accountId: string): DiscordAllowedChannels | undefined {
  return load().discordListeningBaselines?.[accountId];
}

export function setDiscordListeningBaseline(accountId: string, policy: DiscordAllowedChannels | undefined): void {
  const stored = load();
  const baselines = { ...stored.discordListeningBaselines };
  if (policy === undefined) delete baselines[accountId];
  else baselines[accountId] = policy;
  save({ ...stored, discordListeningBaselines: baselines });
}

export function discordChannelChats(): Record<string, string> {
  return load().discordChannelChats ?? {};
}

export function setDiscordChannelChat(key: string, conversationId: string): void {
  const stored = load();
  const chats = { ...stored.discordChannelChats };
  if (conversationId) chats[key] = conversationId;
  else delete chats[key];
  save({ ...stored, discordChannelChats: chats });
}

export function discordServerChats(): Record<string, string> {
  return load().discordServerChats ?? {};
}

export function setDiscordServerChat(key: string, conversationId: string): void {
  const stored = load();
  save({ ...stored, discordServerChats: { ...stored.discordServerChats, [key]: conversationId } });
}

export function discordMutedChannels(accountId?: string): string[] {
  const all = load().discordMutedChannels ?? {};
  return accountId ? (all[accountId] ?? []) : Object.keys(all).filter((key) => (all[key] ?? []).length > 0);
}

export function setDiscordChannelMuted(accountId: string, chatId: string, muted: boolean): void {
  const stored = load();
  const current = new Set(stored.discordMutedChannels?.[accountId] ?? []);
  if (muted) current.add(chatId);
  else current.delete(chatId);
  save({ ...stored, discordMutedChannels: { ...stored.discordMutedChannels, [accountId]: [...current] } });
}

/** A removed Discord bot: drop its chat mode, muted channels, baseline and chats. */
export function forgetDiscordAccount(accountId: string): void {
  const stored = load();
  const without = <T>(record: Record<string, T> | undefined) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => key !== accountId));
  const notMine = (record: Record<string, string> | undefined) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !key.startsWith(`${accountId}:`)));
  save({
    ...stored,
    channelChatModes: without(stored.channelChatModes),
    discordMutedChannels: without(stored.discordMutedChannels),
    discordListeningBaselines: without(stored.discordListeningBaselines),
    discordServerChats: notMine(stored.discordServerChats),
    discordChannelChats: notMine(stored.discordChannelChats),
  });
}

/**
 * A bot that has just changed companion: forget which conversations its Discord
 * chats were pointed at, and record that everything is in the main chat now.
 *
 * Those conversation ids belong to the companion the bot is leaving. Keeping
 * them would undo the move quietly: the five-second maintenance pass re-applies
 * the stored chat mode from these maps, so the new owner's chats would be
 * re-pointed straight back into the old companion's history. The mode is set to
 * "main" rather than removed because that is what a move actually leaves — every
 * chat in the new companion's main chat (see pointBotAt in channels.ts) — and a
 * mode that disagreed with the routes would be re-applied on top of them.
 *
 * Muting is left alone: which channels a bot has been switched off in is about
 * that bot, not about whose it is.
 */
export function forgetDiscordChatTargets(accountId: string): void {
  const stored = load();
  const notMine = (record: Record<string, string> | undefined) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !key.startsWith(`${accountId}:`)));
  save({
    ...stored,
    channelChatModes: { ...stored.channelChatModes, [accountId]: "main" },
    discordServerChats: notMine(stored.discordServerChats),
    discordChannelChats: notMine(stored.discordChannelChats),
  });
}

export function forgetDiscordServerChat(key: string): void {
  const stored = load();
  const chats = { ...stored.discordServerChats };
  delete chats[key];
  save({ ...stored, discordServerChats: chats });
}

export function declinedPairings(): string[] {
  return load().declinedPairings ?? [];
}

export function declinePairingCode(code: string): void {
  const stored = load();
  save({ ...stored, declinedPairings: [...new Set([...(stored.declinedPairings ?? []), code])].slice(-200) });
}

/**
 * Hearthside: a bot belongs to one companion on one connection (see
 * channel-owners.ts). `owner` is who polls its token; only "hearthside" for now.
 *
 * The durable owner is the PAIR (connection, agentId): agent ids aren't
 * comparable across backends, so the agent alone can't say whose bot this is.
 * `agentId` is optional because records written before bots were owned per
 * companion have none — absent or null means "not claimed yet", and an
 * unclaimed bot stays off until someone claims it.
 */
export type ChannelBotRecord = {
  connection: string | null;
  owner: "hearthside";
  wanted: boolean;
  /** The companion that owns this bot on `connection`; null/absent when unclaimed. */
  agentId?: string | null;
  /** Salted HMAC of the bot token, so the same bot can't be added twice. Never the token. */
  tokenFingerprint?: string;
  /**
   * A move to another companion that did not finish. Written BEFORE the runtime
   * is touched, so a crash or a failed step leaves a record of it: the bot is
   * held off, nothing restarts it, and it can only be finished or undone. Both
   * ends are kept because by the "routes" stage `agentId` is already the new
   * owner, and undoing needs the old one.
   */
  transfer?: {
    fromAgentId: string | null;
    toAgentId: string;
    /** "bind": the account may or may not be rebound. "routes": rebound, chats part-moved. */
    stage: "bind" | "routes";
    startedAt: string;
  } | null;
};

/** A short name for the current connection: "local", "cloud" or "remote:<url>" (a custom Cloud address counts as its own). */
export function connectionKey(): string {
  const config = getConnectionConfig();
  if (config.backend === "local") return "local";
  if (config.backend === "remote") return `remote:${config.serverUrl}`;
  return config.apiBaseUrl ? `cloud:${config.apiBaseUrl}` : "cloud";
}

export function connectionLabel(key: string | null): string {
  if (key === null) return "another connection";
  if (key === "local") return "This computer";
  if (key.startsWith("cloud")) return "Letta Cloud";
  return "your own server";
}

export function channelBot(accountId: string): ChannelBotRecord | null {
  return load().channelBots?.[accountId] ?? null;
}

/** Every bot record Hearthside knows (account id → record), for owner lookups. */
export function channelBots(): Record<string, ChannelBotRecord> {
  return { ...load().channelBots };
}

/**
 * A fingerprint of a bot token, used only to notice the same bot being added
 * twice. HMAC with a per-install salt, so what is kept is not a bare digest of
 * a credential. The token itself is never stored.
 */
export function channelTokenFingerprint(token: string): string {
  const stored = load();
  let salt = stored.channelTokenSalt;
  if (!salt) {
    salt = randomBytes(32).toString("hex");
    save({ ...stored, channelTokenSalt: salt });
  }
  return createHmac("sha256", salt).update(token.trim()).digest("hex").slice(0, 32);
}

export function setChannelBot(accountId: string, record: ChannelBotRecord): void {
  const stored = load();
  save({ ...stored, channelBots: { ...stored.channelBots, [accountId]: record } });
}

export function forgetChannelBot(accountId: string): void {
  const stored = load();
  const channelBots = { ...stored.channelBots };
  delete channelBots[accountId];
  save({ ...stored, channelBots });
}

/** Hearthside: backup settings (the key itself is kept separately, see backup/keys.ts). */
export type BackupSettings = {
  folder: string | null;
  includePictures: boolean;
  daily: boolean;
  /** "HH:MM" local time for the daily backup. */
  dailyAt: string;
  keepDays: number;
  /** Last successful backup per agent (ISO). */
  lastRun: Record<string, string>;
  /** Hearthside: the newest backup per agent that checked out in full: the next one builds on it. */
  verified?: Record<string, string>;
  /** Hearthside: the last failed backup per agent, until one succeeds. */
  lastError?: Record<string, { at: string; message: string }>;
  /**
   * Hearthside: when the daily run last *attempted* a companion (ISO), written by that run and
   * nothing else. It is kept apart from `lastError` because that record is shared with
   * "Back up now": one manual attempt would otherwise consume the day's automatic one, and a
   * later manual failure would overwrite whether the automatic attempt had happened at all.
   */
  lastAutoAttempt?: Record<string, string>;
  /** Hearthside: when each companion last had a full (re-read everything) backup that verified. */
  lastFull?: Record<string, string>;
};

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { folder: null, includePictures: true, daily: false, dailyAt: "03:00", keepDays: 30, lastRun: {}, verified: {}, lastError: {}, lastAutoAttempt: {}, lastFull: {} };

export function backupSettings(): BackupSettings {
  const stored = load().backup;
  return { ...DEFAULT_BACKUP_SETTINGS, ...(stored ?? {}), lastRun: { ...(stored?.lastRun ?? {}) }, verified: { ...(stored?.verified ?? {}) }, lastError: { ...(stored?.lastError ?? {}) }, lastAutoAttempt: { ...(stored?.lastAutoAttempt ?? {}) }, lastFull: { ...(stored?.lastFull ?? {}) } };
}

export function updateBackupSettings(update: Partial<BackupSettings>): BackupSettings {
  const stored = load();
  const next = { ...backupSettings(), ...update };
  save({ ...stored, backup: next });
  return next;
}

export function channelsUsed(): boolean {
  return load().channelsUsed === true;
}

export function markChannelsUsed(): void {
  const stored = load();
  if (!stored.channelsUsed) save({ ...stored, channelsUsed: true });
}

function decodeMap(stored: string | undefined): Record<string, string> | undefined {
  if (!stored) return undefined;
  try {
    return JSON.parse(decodeSecret(stored)) as Record<string, string>;
  } catch {
    return undefined;
  }
}

export function loadConnectors(): StoredConnector[] {
  return (load().connectors ?? []).map(({ env, headers, oauth, ...rest }) => {
    let parsedOAuth: ConnectorOAuth | undefined;
    try {
      parsedOAuth = oauth ? (JSON.parse(decodeSecret(oauth)) as ConnectorOAuth) : undefined;
    } catch {
      parsedOAuth = undefined;
    }
    return {
      ...rest,
      ...(decodeMap(env) ? { env: decodeMap(env) } : {}),
      ...(decodeMap(headers) ? { headers: decodeMap(headers) } : {}),
      ...(parsedOAuth?.accessToken ? { oauth: parsedOAuth } : {}),
    };
  });
}

export function saveConnectors(connectors: StoredConnector[]): void {
  const stored = load();
  // What is on disk for each connector, as it is: the list given here was read
  // through loadConnectors, which shows a secret that could not be decrypted as
  // absent. Written back as it stood, one toggle while the keychain was locked
  // (or after it was reset) replaced every connector's keys, headers and
  // sign-in with nothing, and they were gone when the keychain came back.
  // "Unreadable is not absence": such a blob is carried over untouched.
  const before = new Map((stored.connectors ?? []).map((connector) => [connector.id, connector]));
  const keep = (blob: string | undefined): string | undefined => (storedSecretState(blob) === "unreadable" ? blob : undefined);
  save({
    ...stored,
    connectors: connectors.map(({ env, headers, oauth, ...rest }) => {
      const previous = before.get(rest.id);
      const oauthBlob = oauth ? encodeSecret(JSON.stringify(oauth)) : keep(previous?.oauth);
      const envBlob = env && Object.keys(env).length ? encodeSecret(JSON.stringify(env)) : keep(previous?.env);
      const headersBlob = headers && Object.keys(headers).length ? encodeSecret(JSON.stringify(headers)) : keep(previous?.headers);
      return {
        ...rest,
        ...(oauthBlob ? { oauth: oauthBlob } : {}),
        ...(envBlob ? { env: envBlob } : {}),
        ...(headersBlob ? { headers: headersBlob } : {}),
      };
    }),
  });
}

/** Explicit sign-out is a deletion, even when the OS cannot decrypt the saved
 * sign-in. Operate on the stored fields directly, without re-encoding anything. */
export function clearConnectorSignIn(id: string, legacyKey?: string): void {
  const stored = load();
  const connector = stored.connectors?.find((entry) => entry.id === id);
  if (connector) delete connector.oauth;
  if (legacyKey && stored.connectorOAuthStore) delete stored.connectorOAuthStore[legacyKey];
  save(stored);
}

export function getConnectorOAuthValue(key: string): string | null {
  const stored = load().connectorOAuthStore?.[key];
  return stored ? decodeSecret(stored) || null : null;
}

export function setConnectorOAuthValue(key: string, value: string | null): void {
  const stored = load();
  const store = { ...stored.connectorOAuthStore };
  if (value === null) delete store[key];
  else store[key] = encodeSecret(value);
  save({ ...stored, connectorOAuthStore: store });
}

/** The anonymous per-install id KLIPY asks for. */
export function gifCustomerId(): string {
  const stored = load();
  if (stored.gifCustomerId) return stored.gifCustomerId;
  const id = newCustomerId();
  save({ ...stored, gifCustomerId: id });
  return id;
}

export function getPermissionMode(): PermissionMode {
  return load().permissionMode ?? "standard";
}

/** Only non-secret connection identity scopes execution preferences. Old accounts
 * are discarded, rather than resurrected when another account signs in. */
export function loadConversationExecution(scope: string): Record<string, ConversationExecutionState> {
  const stored = load();
  if (stored.conversationExecution?.scope === scope) return stored.conversationExecution.states;
  const states = stored.setAside?.[scope]?.states ?? {};
  if (stored.conversationExecution || stored.setAside?.[scope]?.states) {
    save({ ...stored, conversationExecution: { scope, states }, setAside: setAsideAfter(stored, scope, "states", stored.conversationExecution?.scope, stored.conversationExecution?.states) });
  }
  return states;
}

/**
 * What stays set aside once `scope` becomes the one in use: its own entry
 * comes out, the one being replaced goes in, and anything belonging to an
 * account that is no longer the current one for any connection kind is dropped
 * (an old account's records are discarded, never brought back by a later sign-in).
 */
function setAsideAfter<K extends "states" | "records">(
  stored: StoredSettings, scope: string, key: K, leavingScope: string | undefined,
  leaving: NonNullable<StoredSettings["setAside"]>[string][K] | undefined,
): StoredSettings["setAside"] {
  const current = new Set(Object.values(stored.connectionRevisions ?? {}));
  const next: NonNullable<StoredSettings["setAside"]> = {};
  for (const [id, entry] of Object.entries(stored.setAside ?? {})) {
    if (!current.has(id)) continue;
    const kept = id === scope ? { ...entry, [key]: undefined } : entry;
    if (kept.states || kept.records) next[id] = kept;
  }
  if (leavingScope && leavingScope !== scope && current.has(leavingScope) && leaving && Object.keys(leaving).length) {
    next[leavingScope] = { ...next[leavingScope], [key]: leaving };
  }
  return Object.keys(next).length ? next : undefined;
}

export function saveConversationExecution(scope: string, states: Record<string, ConversationExecutionState>): void {
  if ((getSettings().connectionRevision ?? "initial") !== scope) return;
  save({ ...load(), conversationExecution: { scope, states } });
}

/**
 * One native move, as persisted. The idempotency key is written **before** the
 * request goes out, so a move whose acceptance is never learned can still only
 * ever be reconciled — re-sending the same key cannot start a second move.
 */
export type StoredMoveRecord = {
  conversationId: string;
  agentId: string;
  /** The conversation ID as Letta scopes it ("default" for a main chat). */
  scopedConversationId: string;
  /**
   * Who asked for the move. An `agent` move was requested by the agent itself
   * through its own CLI, so Hearthside holds no idempotency key for it and must
   * never re-request it — it can only be watched.
   */
  initiatedBy: "hearthside" | "agent";
  /** Empty only for an `agent` move, which this app never issued. */
  idempotencyKey: string;
  targetConnectionId: string;
  /**
   * The destination's device, stored rather than derived from `placeId`.
   *
   * A move's status receipt is validated against it, and "Letta Cloud" is a
   * place whose device only exists once its sandbox has been provisioned, so
   * the place ID cannot be where this lives.
   */
  targetDeviceId: string;
  /** From the acceptance receipt; Letta names the source, the request does not. */
  sourceConnectionId: string | null;
  placeId: string;
  placeName: string;
  /** Null until an acceptance receipt arrives; without it there is nothing to read. */
  teleportId: string | null;
  phase: ConversationMovePhase;
  location: "source" | "destination" | "unknown";
  error?: string;
  startedAt: number;
};

export function loadConversationMoves(scope: string): Record<string, StoredMoveRecord> {
  const stored = load();
  if (stored.conversationMoves?.scope === scope) return stored.conversationMoves.records;
  const records = stored.setAside?.[scope]?.records ?? {};
  if (stored.conversationMoves || stored.setAside?.[scope]?.records) {
    save({ ...stored, conversationMoves: { scope, records }, setAside: setAsideAfter(stored, scope, "records", stored.conversationMoves?.scope, stored.conversationMoves?.records) });
  }
  return records;
}

export function saveConversationMoves(scope: string, records: Record<string, StoredMoveRecord>): void {
  if ((getSettings().connectionRevision ?? "initial") !== scope) return;
  save({ ...load(), conversationMoves: { scope, records } });
}

/**
 * Hearthside: which store of agents and provider connections is in use. Agent
 * ids and saved keys belong to one store: the sandbox home and the person's
 * real Letta home hold different ones, as does each server. What is remembered
 * about them is filed under this, so a key checked in one home is not shown as
 * checked in the other, and a companion waiting for a model in one is not
 * forgotten because the other has never heard of it.
 */
function storeScope(): string {
  return `${connectionKey()}|${load().useRealLettaHome ? "real" : "sandbox"}`;
}
const scoped = (id: string): string => `${storeScope()}\n${id}`;

/** Hearthside: what the last check of a local provider connection found; null when it was never checked. */
export function providerCheck(providerId: string): "verified" | "unchecked" | "unreachable" | null {
  const checks = load().providerChecks;
  const key = scoped(providerId);
  return checks && Object.hasOwn(checks, key) ? checks[key]! : null;
}

export function setProviderCheck(providerId: string, check: "verified" | "unchecked" | "unreachable" | null): void {
  const stored = load();
  const key = scoped(providerId);
  if (check === (stored.providerChecks && Object.hasOwn(stored.providerChecks, key) ? stored.providerChecks[key]! : null)) return;
  const providerChecks = { ...stored.providerChecks };
  if (check === null) delete providerChecks[key];
  else providerChecks[key] = check;
  save({ ...stored, providerChecks });
}

/**
 * Hearthside: local agents made while no model provider was connected. They
 * hold the runtime's placeholder model, not one the person chose, so the first
 * model that is connected can be given to them without overriding a choice.
 */
/** Hearthside: the model last used on This computer, for a companion created without one. */
export function lastLocalModel(): string | null {
  return load().lastLocalModel ?? null;
}

export function noteLocalModel(model: string | null | undefined): void {
  if (!model) return;
  const stored = load();
  if (stored.lastLocalModel === model) return;
  save({ ...stored, lastLocalModel: model });
}

/** The waiting companions of the store in use (entries are filed per store; see storeScope). */
export function agentsAwaitingModel(): string[] {
  const prefix = scoped("");
  return (load().awaitingModel ?? []).filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
}

export function setAwaitingModel(agentId: string, awaiting: boolean): void {
  const stored = load();
  const current = stored.awaitingModel ?? [];
  const entry = scoped(agentId);
  if (current.includes(entry) === awaiting) return;
  const awaitingModel = awaiting ? [...current, entry].slice(-200) : current.filter((item) => item !== entry);
  save({ ...stored, awaitingModel });
}

/**
 * Hearthside: the identity follow-ups on This computer are stored under, kept
 * once it has been worked out. It used to be recomputed from details that have
 * nothing to do with the local store (the Letta API key, whether Letta is
 * signed in), so changing those while on This computer left every local
 * follow-up under an identity nothing asked for again. `derive` is only used
 * the first time for a given local revision and runtime home.
 */
export function localFollowupIdentity(home: string | null, derive: () => string): string {
  const stored = load();
  const revision = revisionOf(stored, "local");
  const kept = stored.localFollowupIdentity;
  if (kept && kept.revision === revision && kept.home === home) return kept.id;
  const id = derive();
  save({ ...stored, localFollowupIdentity: { revision, home, id } });
  return id;
}

export function getConversationCwd(conversationId: string): string | null {
  return load().conversationCwds?.[conversationId] ?? null;
}

/** Remember the working directory a conversation ran in. */
export function rememberCwd(conversationId: string, cwd: string): void {
  const stored = load();
  if (stored.conversationCwds?.[conversationId] === cwd && stored.recentCwds?.[0] === cwd) return;

  const recentCwds = [cwd, ...(stored.recentCwds ?? []).filter((item) => item !== cwd)].slice(
    0,
    MAX_RECENT_CWDS,
  );
  const entries = Object.entries({ ...stored.conversationCwds, [conversationId]: cwd });
  const conversationCwds = Object.fromEntries(entries.slice(-MAX_CONVERSATION_CWDS));
  save({ ...stored, recentCwds, conversationCwds });
}

export function forgetConversation(conversationId: string): void {
  const stored = load();
  if (!stored.conversationCwds?.[conversationId]) return;
  const conversationCwds = { ...stored.conversationCwds };
  delete conversationCwds[conversationId];
  save({ ...stored, conversationCwds });
}

/** Hearthside: the window follows this; "system" tracks the OS setting. */
export function getThemePreference(): ThemePreference {
  return load().theme ?? "system";
}
