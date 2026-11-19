import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelChatMode } from "@hearthside/ipc-contract";
import { gatewayRequest as request } from "./channel-gateway";
import { resolveRuntimeHome } from "../runtime/paths";
import {
  channelBot, channelChatMode, channelChatModes, connectionKey, discordMutedChannels, discordServerChats,
  forgetDiscordServerChat, setDiscordChannelMuted, setDiscordServerChat,
  discordChannelChats, setDiscordChannelChat, discordListeningBaseline,
  setDiscordListeningBaseline, type DiscordAllowedChannels,
} from "./settings";
import { assertBotOwnedBy } from "./channel-owners";
import { withBot } from "./channel-locks";

/** Pre-route known guild channels; never silently move a runtime-created chat.
 * Explicit mode changes affect future messages only. Source history stays intact.
 */
type Wire = Record<string, unknown>;
type Route = { accountId: string; chatId: string; chatType: string; agentId: string; conversationId: string };
type ServerChannel = { id: string; name: string; serverId: string; serverName: string; type: number };
const str = (value: unknown) => typeof value === "string" ? value : "";
let idle: ((conversationId: string, agentId: string) => Promise<boolean>) | null = null;
let createChat: ((agentId: string, title: string) => Promise<string>) | null = null;

export function setChatModeHelpers(helpers: {
  // Retained for caller compatibility; routing NEVER archives or renames source chats.
  archive?: (id: string) => Promise<void>;
  rename?: (id: string, title: string) => Promise<void>;
  /** Fresh runtime idle observation, not inferred from age or message history. */
  idle: (id: string, agentId: string) => Promise<boolean>;
  createChat: (agentId: string, title: string) => Promise<string>;
}): void {
  idle = helpers.idle;
  createChat = helpers.createChat;
}

function botAccount(accountId: string): { token: string; agentId: string } | null {
  const { home } = resolveRuntimeHome();
  const path = join(home ?? homedir(), ".letta", "channels", "discord", "accounts.json");
  if (!existsSync(path)) return null;
  let data: { accounts?: Array<{ accountId?: string; token?: string; agentId?: string }> };
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as typeof data;
  } catch {
    return null; // Mid-write by the runtime; next check reads it.
  }
  const account = data.accounts?.find((item) => item.accountId === accountId);
  return account?.token ? { token: account.token, agentId: account.agentId ?? "" } : null;
}

async function discordGet<T>(accountId: string, path: string): Promise<T> {
  const account = botAccount(accountId);
  if (!account) throw new Error("Discord bot credentials are unavailable");
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${account.token}` }, signal: AbortSignal.timeout(10_000),
  });
  // The status travels with the error: "this channel is gone" (404) and "the
  // bot can't see it any more" (403) are answers, not failures to reach Discord.
  if (!response.ok) throw Object.assign(new Error(`Discord answered ${response.status}`), { discordStatus: response.status });
  return await response.json() as T;
}

/** Discord's own word that a channel no longer exists, or that this bot is no longer let into it. */
function channelIsGone(error: unknown): boolean {
  const status = (error as { discordStatus?: unknown } | null)?.discordStatus;
  return status === 404 || status === 403;
}

const labels = new Map<string, string>();
const channelCache = new Map<string, { at: number; channels: ServerChannel[] }>();
const CHANNELS_TTL_MS = 5 * 60_000;
const TALKABLE = new Set([0, 2, 5, 13]);
export function discordChannelLabel(chatId: string): string | null { return labels.get(chatId) ?? null; }

/** After Discord refuses or can't be reached, wait this long before asking again. */
const FAILURE_BACKOFF_MS = 3 * 60_000;
const lastFailure = new Map<string, { at: number; error: unknown }>();

async function serverChannels(accountId: string): Promise<ServerChannel[]> {
  const cached = channelCache.get(accountId);
  if (cached && Date.now() - cached.at < CHANNELS_TTL_MS) return cached.channels;
  // Don't ask Discord every 5 seconds while it refuses (a bad token, no internet).
  const failed = lastFailure.get(accountId);
  if (failed && Date.now() - failed.at < FAILURE_BACKOFF_MS) throw failed.error;
  try {
    const channels = await listServerChannels(accountId);
    lastFailure.delete(accountId);
    return channels;
  } catch (error) {
    lastFailure.set(accountId, { at: Date.now(), error });
    throw error;
  }
}

async function listServerChannels(accountId: string): Promise<ServerChannel[]> {
  const guilds = await discordGet<Array<{ id: string; name: string }>>(accountId, "/users/@me/guilds");
  const channels: ServerChannel[] = [];
  // Discord returns at most 200 guilds here. Refuse a potentially incomplete mute
  // expansion rather than claiming to preserve a wildcard across a truncated list.
  if (guilds.length >= 200) throw new Error("Too many Discord servers to safely enumerate channel policy");
  for (const guild of guilds) {
    const list = await discordGet<Array<{ id: string; type: number; name?: string }>>(accountId, `/guilds/${guild.id}/channels`);
    for (const channel of list) {
      // Forum/media parents also gate their threads, but have no route of their own.
      if (!TALKABLE.has(channel.type) && channel.type !== 15 && channel.type !== 16) continue;
      channels.push({ id: channel.id, name: channel.name ?? channel.id, serverId: guild.id, serverName: guild.name, type: channel.type });
      labels.set(channel.id, `#${channel.name ?? channel.id} · ${guild.name}`);
    }
  }
  channelCache.set(accountId, { at: Date.now(), channels });
  return channels;
}

async function serverOf(accountId: string, chatId: string, channels: ServerChannel[]): Promise<{ id: string; name: string } | null> {
  const known = channels.find((channel) => channel.id === chatId);
  if (known) return { id: known.serverId, name: known.serverName };
  const channel = await discordGet<{ guild_id?: string }>(accountId, `/channels/${chatId}`);
  if (!channel.guild_id) return null; // An untyped DM is not a guild route.
  const guild = await discordGet<{ name?: string }>(accountId, `/guilds/${channel.guild_id}`);
  return { id: channel.guild_id, name: guild.name ?? "Discord server" };
}

async function allDiscordRoutes(accountId: string): Promise<Route[]> {
  const reply = await request<{ routes?: Wire[] }>("channel_routes_list", { channel_id: "discord", account_id: accountId });
  return (reply.routes ?? []).filter((route) => str(route.account_id) === accountId).map((route) => ({
    accountId, chatId: str(route.chat_id), chatType: str(route.chat_type),
    agentId: str(route.agent_id), conversationId: str(route.conversation_id),
  }));
}

async function pointRoute(route: Route, conversationId: string): Promise<void> {
  await request("channel_route_update", {
    channel_id: "discord", account_id: route.accountId, chat_id: route.chatId,
    runtime: { agent_id: route.agentId, conversation_id: conversationId },
  });
}

/**
 * Serialize user actions with maintenance on the SAME bot, through the queue
 * every other change to a bot goes through (channel-locks.ts), so a move or a
 * claim can't run half way through a mode change and a mode change can't
 * re-point chats a move has just carried to another companion. Two bots don't
 * wait for each other: their routes, modes and chats are separate.
 *
 * The rejecting task still goes back to its caller; the queue's own tail always
 * settles, so one failure cannot poison later work.
 */
export function applyChatMode(accountId: string, options: { reconcile?: boolean; mode?: ChannelChatMode } = {}): Promise<void> {
  return withBot(accountId, () => apply(accountId, options.reconcile === true, options.mode));
}

async function serverChat(accountId: string, agentId: string, server: { id: string; name: string }): Promise<string> {
  const key = `${accountId}:${server.id}`;
  const known = discordServerChats()[key];
  // Older reconciliation could incorrectly adopt the main chat as a server chat.
  if (known && known !== "default") return known;
  if (!createChat || !agentId) throw new Error("Cannot create a Discord server chat yet");
  const id = await createChat(agentId, `Discord: ${server.name}`);
  setDiscordServerChat(key, id);
  return id;
}

async function apply(accountId: string, reconcile: boolean, requestedMode?: ChannelChatMode): Promise<void> {
  const mode: ChannelChatMode = requestedMode ?? channelChatMode(accountId);
  if (mode === "channel" && !reconcile) return;
  const channels = await serverChannels(accountId);
  const routes = await allDiscordRoutes(accountId);
  const muted = new Set(discordMutedChannels(accountId));
  const plan: Array<{ route: Route; target: string }> = [];
  if (reconcile) {
    const serverIds = new Set(Object.values(discordServerChats()));
    for (const route of routes) {
      if (muted.has(route.chatId) || (route.chatType && route.chatType !== "channel")) continue;
      const server = await serverOf(accountId, route.chatId, channels);
      if (!server) continue;
      const key = `${accountId}:${route.chatId}`;
      const shared = route.conversationId === "default" || serverIds.has(route.conversationId) ||
        routes.some((other) => other !== route && other.agentId === route.agentId && other.conversationId === route.conversationId);
      if (!shared && !discordChannelChats()[key]) setDiscordChannelChat(key, route.conversationId);
      let target: string;
      if (mode === "main") target = "default";
      else if (mode === "server") target = await serverChat(accountId, route.agentId, server);
      else {
        target = discordChannelChats()[key] ?? "";
        if (!target) {
          if (!createChat) throw new Error("Cannot create a Discord channel chat yet");
          target = await createChat(route.agentId, `Discord: ${discordChannelLabel(route.chatId) ?? route.chatId}`);
          setDiscordChannelChat(key, target);
        }
      }
      if (target !== route.conversationId) plan.push({ route, target });
    }
    // Check ALL sources and destinations before changing ANY routes. A long run
    // is still busy. Unknown state is never permission to interrupt it.
    for (const { route, target } of plan) {
      if (!(await idle?.(route.conversationId, route.agentId)) || !(await idle?.(target, route.agentId))) {
        throw new Error("Discord chats are busy or their idle state is unknown. Wait for replies to finish, then retry the mode change.");
      }
    }
  }
  // No history exists for these routes yet. Unseen threads are NOT included and
  // keep their own runtime-created conversations even after their first reply.
  if (mode !== "channel") {
    const account = botAccount(accountId);
    if (!account?.agentId) throw new Error("Discord bot agent is unavailable");
    const routed = new Set(routes.map((route) => route.chatId));
    for (const channel of channels) {
      if (!TALKABLE.has(channel.type) || routed.has(channel.id) || muted.has(channel.id)) continue;
      const target = mode === "main" ? "default" : await serverChat(accountId, account.agentId, { id: channel.serverId, name: channel.serverName });
      plan.push({ route: { accountId, chatId: channel.id, chatType: "channel", agentId: account.agentId, conversationId: "" }, target });
    }
  }
  const changed: Route[] = [];
  try {
    for (const { route, target } of plan) {
      await pointRoute(route, target);
      changed.push(route);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const route of changed.reverse()) {
      try {
        if (route.conversationId) await pointRoute(route, route.conversationId);
        else await request("channel_route_remove", { channel_id: "discord", account_id: accountId, chat_id: route.chatId });
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Discord mode change and route rollback failed; inspect routes before retrying");
    throw error;
  }
}

let watcher: NodeJS.Timeout | null = null;
// The same failure repeats every 5 seconds; log it once until it changes.
const lastWarning = new Map<string, string>();
function background(key: string, task: Promise<void>): void {
  void task.then(
    () => lastWarning.delete(key),
    (error: unknown) => {
      const text = String(error);
      if (lastWarning.get(key) === text) return;
      lastWarning.set(key, text);
      console.warn(`[channels] ${text}`);
    },
  );
}
function maintainBot(accountId: string, work: () => Promise<void>): Promise<void> {
  return withBot(accountId, async () => {
    // Checked after queue admission: a move/recovery may have held or rebound
    // the bot while maintenance waited. Recovery switches wanted off first.
    const record = channelBot(accountId);
    if (!record?.agentId || record.connection !== connectionKey() || record.transfer || !record.wanted) return;
    if (!botAccount(accountId)) return;
    await work();
  });
}
function maintain(): void {
  for (const accountId of Object.keys(channelChatModes())) background(`mode:${accountId}`, maintainBot(accountId, () => apply(accountId, false)));
  for (const accountId of discordMutedChannels()) background(`mute:${accountId}`, maintainBot(accountId, () => syncListening(accountId)));
}
function watch(): void {
  if (watcher) return;
  watcher = setInterval(maintain, 5_000);
  watcher.unref?.();
}
export function onGatewayEvent(event: Wire): void {
  if (event.type === "hearthside_gateway_ready") {
    channelCache.clear();
    lastFailure.clear();
    maintain();
    watch();
  }
}

/** Runtime 0.34.8 supports no deny entry: [] AND {} allow every guild channel.
 * Snowflake '0' cannot identify a Discord channel, so this nonempty map denies all.
 * A wildcard must be expanded while muted; newly discovered channels are added
 * by maintenance. Original policy is restored unless explicit runtime open grants
 * have been incorporated into the baseline while the overlay was active.
 */
function muteOverlay(baseline: DiscordAllowedChannels, muted: Set<string>, channels: ServerChannel[]): DiscordAllowedChannels {
  const entries: Record<string, "open" | "mention-only"> = Array.isArray(baseline)
    ? Object.fromEntries(baseline.filter((id) => id !== "*").map((id) => [id, "mention-only"])) : { ...baseline };
  // '*' is a wildcard only in the object form, never in a legacy array.
  const fallback = Array.isArray(baseline) ? (baseline.length ? undefined : "mention-only")
    : (!Object.keys(baseline).length ? "mention-only" : baseline["*"]);
  delete entries["*"];
  if (fallback) for (const channel of channels) entries[channel.id] ??= fallback;
  for (const id of muted) delete entries[id];
  return Object.keys(entries).length ? entries : { "0": "mention-only" };
}

/** Runtime/UI edits can make an unmuted channel open while our saved baseline
 * still says mention-only. Carry those explicit grants into the durable baseline,
 * not the expanded overlay (which would lose wildcard semantics). Mutes win.
 */
function preserveRuntimeOpen(baseline: DiscordAllowedChannels, current: DiscordAllowedChannels, muted: Set<string>): DiscordAllowedChannels {
  if (Array.isArray(current)) return baseline;
  const entries: Record<string, "open" | "mention-only"> = Array.isArray(baseline)
    ? (baseline.length ? Object.fromEntries(baseline.filter((id) => id !== "*").map((id) => [id, "mention-only"])) : { "*": "mention-only" })
    : (Object.keys(baseline).length ? { ...baseline } : { "*": "mention-only" });
  let changed = false;
  for (const [id, mode] of Object.entries(current)) {
    // A wildcard is not an explicit channel grant; never revive a muted channel.
    if (id === "*" || id === "0" || muted.has(id) || mode !== "open") continue;
    if ((entries[id] ?? entries["*"]) === "open") continue;
    entries[id] = "open";
    changed = true;
  }
  return changed ? entries : baseline;
}

async function readAllowed(accountId: string): Promise<DiscordAllowedChannels> {
  const reply = await request<{ config?: { config?: { allowed_channels?: DiscordAllowedChannels } } }>("channel_get_config", { channel_id: "discord", account_id: accountId });
  if (!reply.config?.config) throw new Error("Discord account config is unavailable");
  return reply.config.config.allowed_channels ?? [];
}
async function writeAllowed(accountId: string, allowed: DiscordAllowedChannels): Promise<void> {
  await request("channel_account_update", { channel_id: "discord", account_id: accountId, patch: { config: { allowed_channels: allowed } } });
}
async function syncListening(accountId: string): Promise<void> {
  const muted = new Set(discordMutedChannels(accountId));
  if (!muted.size) return;
  const current = await readAllowed(accountId);
  const saved = discordListeningBaseline(accountId);
  const baseline = preserveRuntimeOpen(saved ?? current, current, muted);
  const allowed = muteOverlay(baseline, muted, await serverChannels(accountId));
  if (saved !== baseline) setDiscordListeningBaseline(accountId, baseline);
  // Observe actual runtime state on every pass: a cached write is not evidence
  // that a later runtime edit left the mute overlay intact.
  if (JSON.stringify(current) !== JSON.stringify(allowed)) await writeAllowed(accountId, allowed);
}

/** Guild parent channels only: the runtime gates threads by their PARENT id.
 * Keep the route so unmuting resumes the same history, with no routing side effects.
 */
export function setDiscordChannelListening(accountId: string, chatId: string, on: boolean, agentId: string): Promise<void> {
  assertBotOwnedBy(accountId, agentId, "be turned off in a channel");
  return withBot(accountId, async () => {
    // Checked again inside the queue: the first check was made before every
    // await this does, so it is not what the change may act on.
    assertBotOwnedBy(accountId, agentId, "be turned off in a channel");
    const wasMuted = discordMutedChannels(accountId).includes(chatId);
    if (wasMuted === !on) return;
    if (!on) {
      let channel: { guild_id?: string; type?: number };
      try {
        channel = await discordGet<{ guild_id?: string; type?: number }>(accountId, `/channels/${chatId}`);
      } catch (error) {
        if (!channelIsGone(error)) throw error;
        // The channel was deleted, or the bot was removed from the server or
        // can no longer see the channel. There is nothing left to switch off —
        // no message from there can reach the bot — but asking Discord about it
        // failed every time, so the chat sat in the list with a "Turn off" that
        // could never work. Disconnect it instead: the row goes, and what was
        // said in its conversation stays where it is. Any other answer (a bad
        // token, Discord unreachable) is still an error and changes nothing.
        await request("channel_route_remove", { channel_id: "discord", account_id: accountId, chat_id: chatId });
        setDiscordChannelChat(`${accountId}:${chatId}`, "");
        return;
      }
      if (!channel.guild_id || !TALKABLE.has(channel.type ?? -1)) {
        throw new Error("Only server channels can be turned off individually. Threads follow their parent channel's listening policy.");
      }
    }
    const beforeBaseline = discordListeningBaseline(accountId);
    const beforePolicy = await readAllowed(accountId);
    const muted = new Set(discordMutedChannels(accountId));
    const baseline = preserveRuntimeOpen(beforeBaseline ?? beforePolicy, beforePolicy, muted);
    if (on) muted.delete(chatId); else muted.add(chatId);
    const allowed = muted.size ? muteOverlay(baseline, muted, await serverChannels(accountId)) : baseline;
    // Persist the baseline before touching the gateway; failed commands restore it.
    setDiscordListeningBaseline(accountId, baseline);
    let wrotePolicy = false;
    try {
      await writeAllowed(accountId, allowed);
      wrotePolicy = true;
      setDiscordChannelMuted(accountId, chatId, !on);
      if (!muted.size) setDiscordListeningBaseline(accountId, undefined);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        // A timeout can follow a persisted gateway update. Inspect the actual
        // policy rather than assuming a rejected Promise means nothing changed.
        if (wrotePolicy || JSON.stringify(await readAllowed(accountId)) !== JSON.stringify(beforePolicy)) {
          await writeAllowed(accountId, beforePolicy);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try {
        setDiscordChannelMuted(accountId, chatId, wasMuted);
        // Keep the durable original if compensation cannot be confirmed.
        if (!rollbackErrors.length) setDiscordListeningBaseline(accountId, beforeBaseline);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Discord listening change and rollback failed");
      throw error;
    }
    watch();
  });
}

/**
 * The server channels a Discord bot has been switched off in.
 *
 * Only for a bot the asking companion owns on this connection; for anything else
 * the answer is an empty list, which means "nothing for you to see here", NOT
 * "this bot isn't switched off anywhere". The window only asks about a
 * companion's own bots, and a chat of this companion's sitting on another
 * companion's bot is shown as that — on someone else's bot — rather than as a
 * chat known to be listening. See docs/AGENT-OWNED-BOTS.md.
 */
export async function listMutedChannels(accountId: string, agentId: string): Promise<Array<{ accountId: string; chatId: string; label: string | null }>> {
  const record = channelBot(accountId);
  if (!agentId || record?.agentId !== agentId || record.connection !== connectionKey() || record.transfer) return [];
  const muted = discordMutedChannels(accountId);
  if (muted.length) await serverChannels(accountId).catch(() => []);
  return muted.map((chatId) => ({ accountId, chatId, label: discordChannelLabel(chatId) }));
}
export async function prepareDiscordLabels(accountIds: string[]): Promise<void> {
  await Promise.all(accountIds.map((accountId) => serverChannels(accountId).catch(() => [])));
}

/** Explicit user archiving releases mappings; mode changes never call this. */
export async function releaseArchivedChat(conversationId: string): Promise<void> {
  for (const channelId of ["discord", "telegram"]) {
    const reply = await request<{ routes?: Wire[] }>("channel_routes_list", { channel_id: channelId });
    for (const route of reply.routes ?? []) {
      if (str(route.conversation_id) !== conversationId) continue;
      await request("channel_route_remove", { channel_id: channelId, account_id: str(route.account_id) || undefined, chat_id: str(route.chat_id) });
    }
  }
  for (const [key, chat] of Object.entries(discordServerChats())) if (chat === conversationId) forgetDiscordServerChat(key);
  for (const [key, chat] of Object.entries(discordChannelChats())) if (chat === conversationId) setDiscordChannelChat(key, "");
}
