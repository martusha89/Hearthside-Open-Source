import type { ChannelAccess, ChannelAccount, ChannelBotReassign, ChannelField, ChannelInfo, ChannelPairing, ChannelRoute, DmPolicy } from "@hearthside/ipc-contract";
import { gatewayRequest as request } from "./channel-gateway";
import { type ChannelBotRecord, channelBot, channelBots, channelChatMode, channelJustMe, channelTokenFingerprint, connectionKey, connectionLabel, declinePairingCode, declinedPairings, forgetChannelBot, forgetDiscordAccount, forgetDiscordChatTargets, markChannelsUsed, setChannelBot, setChannelChatModeSetting, setChannelJustMe } from "./settings";
import { applyChatMode, discordChannelLabel, prepareDiscordLabels } from "./channel-chat-mode";
import { channelPermissionConfig, channelPermissionPatch, takesChannelPermissionMode } from "./channel-permission";
import { withBot } from "./channel-locks";
import { assertBotOwnedBy, botOwner, botsOwnedBy, boundAgentId, elsewhereMessage, setBotOwner, unfinishedMoveMessage } from "./channel-owners";
import { revokeApprovals } from "./channel-approvals";
import type { AudienceAccount } from "./intentions/audience";

/**
 * Hearthside: Telegram and Discord through the runtime's channels. A channel
 * account is one bot (its token and settings), linked to an agent and started
 * in the runtime. People who message the bot get a pairing code that you
 * approve here; each approved chat becomes a conversation with the agent.
 *
 * Each bot belongs to one companion (docs/AGENT-OWNED-BOTS.md). Listing is
 * scoped to the companion asking, and every change is checked against the
 * recorded owner here in the main process — the renderer decides what to show,
 * this decides what may be changed. Approving a pairing binds the chat to the
 * bot's OWN companion, never to whichever one happens to be selected.
 *
 * One change at a time per bot (channel-locks.ts). Every change here is an
 * owner check, then runtime calls, then a record written, so the check and the
 * effect are separated by awaits; each change takes its bot's queue for the
 * whole operation, and checks the owner again inside it, right before the
 * effect. A check made before an await is never what a change acts on.
 *
 * Slack is left out on purpose.
 */

/** Shown for now (Slack left out on purpose; WhatsApp, Signal and webhooks later). */
const SHOWN = ["telegram", "discord"];

let onChannelsUsed: (() => void) | null = null;
/** Hearthside: told when the first channel is set up (so the window can start following channel chats). */
export function setOnChannelsUsed(listener: () => void): void {
  onChannelsUsed = listener;
}

/** Built-in channels don't describe their settings; these are the ones that matter. */
const BUILT_IN_FIELDS: Record<string, ChannelField[]> = {
  telegram: [
    { key: "token", label: "Bot token", description: "From @BotFather in Telegram (send /newbot).", type: "secret", required: true, placeholder: "123456:ABC-DEF…", options: [], scope: "account" },
    { key: "transcribe_voice", label: "Transcribe voice messages", description: "", type: "boolean", required: false, placeholder: "", options: [], scope: "account" },
  ],
  discord: [
    { key: "token", label: "Bot token", description: "From the Discord Developer Portal, under Bot, then Reset Token.", type: "secret", required: true, placeholder: "", options: [], scope: "account" },
    { key: "transcribe_voice", label: "Transcribe voice messages", description: "", type: "boolean", required: false, placeholder: "", options: [], scope: "account" },
  ],
};

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

function toField(field: Wire): ChannelField {
  return {
    key: str(field.key),
    label: str(field.label) || str(field.key),
    description: str(field.description),
    type: (str(field.type) || "text") as ChannelField["type"],
    required: field.required === true,
    placeholder: str(field.placeholder),
    options: Array.isArray(field.options) ? (field.options as Wire[]).map((option) => ({ value: str(option.value), label: str(option.label) })) : [],
    scope: str(field.scope) === "app" ? "app" : "account",
  };
}

function toAccount(account: Wire, viewer = ""): ChannelAccount {
  const dmPolicy = (str(account.dm_policy) || "pairing") as DmPolicy;
  const accountId = str(account.account_id);
  // Hearthside: which connection the bot belongs to (a bot not yet placed counts as elsewhere).
  const record = channelBot(accountId);
  const connection = record ? record.connection : null;
  const here = record !== null && connection === connectionKey();
  // Hearthside: whose bot this is. The recorded owner is what counts; the
  // runtime's binding is only a suggestion for a bot from before this change.
  const ownerAgentId = record?.agentId ?? null;
  const bound = boundAgentId(account) || null;
  const config = account.config && typeof account.config === "object" && !Array.isArray(account.config) ? account.config as Wire : {};
  const rawParticipation = config.hearthside_companion_policy;
  const participation = rawParticipation && typeof rawParticipation === "object" && !Array.isArray(rawParticipation) ? rawParticipation as Wire : {};
  const validParticipation = participation.version === 1 && typeof participation.ambient === "boolean" && typeof participation.mentions === "boolean";
  return {
    connection,
    connectionLabel: here ? null : connectionLabel(connection),
    here,
    ownerAgentId,
    boundAgentId: bound,
    // The owner is the PAIR (connection, companion), so "mine" is only true for
    // a bot on this connection. The same companion's bots belonging to another
    // connection are shown apart, as theirs but not changeable from here.
    mine: ownerAgentId !== null && ownerAgentId === viewer && here,
    elsewhere: ownerAgentId !== null && ownerAgentId === viewer && !here,
    unclaimed: ownerAgentId === null,
    // Nothing is claimed by being on screen, so a bot is only claimable where it
    // can actually run: here, or not yet placed on any connection.
    claimable: ownerAgentId === null && (connection === null || here),
    // Hearthside's record and what actually routes messages disagree. Startup
    // holds such a bot rather than guessing which one is right.
    conflict: ownerAgentId !== null && bound !== null && bound !== ownerAgentId,
    unfinishedMove: record?.transfer ? { fromAgentId: record.transfer.fromAgentId, toAgentId: record.transfer.toAgentId } : null,
    access: dmPolicy === "open" ? "open" : dmPolicy === "allowlist" || channelJustMe(accountId) ? "just-me" : "pairing",
    chatMode: channelChatMode(accountId),
    channelId: str(account.channel_id),
    accountId: str(account.account_id),
    name: str(account.display_name) || str(account.account_id),
    enabled: account.enabled === true,
    configured: account.configured === true,
    running: account.running === true,
    dmPolicy: (str(account.dm_policy) || "pairing") as DmPolicy,
    allowedUsers: Array.isArray(account.allowed_users) ? (account.allowed_users as string[]) : [],
    companionParticipation: { version: 1, ambient: validParticipation && participation.ambient === true,
      mentions: validParticipation ? participation.mentions === true : config.allow_bots === "mentions", reactions: true,
      mode: validParticipation ? "native" : "legacy" },
  };
}

export async function listChannels(): Promise<ChannelInfo[]> {
  const reply = await request<{ type: string; channels?: Wire[] }>("channels_list", {});
  return (reply.channels ?? [])
    .filter((channel) => SHOWN.includes(str(channel.channel_id)))
    .sort((a, b) => SHOWN.indexOf(str(a.channel_id)) - SHOWN.indexOf(str(b.channel_id)))
    .map((channel) => ({
      id: str(channel.channel_id),
      name: str(channel.display_name) || str(channel.channel_id),
      configured: channel.configured === true,
      running: channel.running === true,
      pendingPairings: typeof channel.pending_pairings_count === "number" ? channel.pending_pairings_count : 0,
      approvedUsers: typeof channel.approved_users_count === "number" ? channel.approved_users_count : 0,
      routes: typeof channel.routes_count === "number" ? channel.routes_count : 0,
      fields: Array.isArray((channel.config_schema as Wire | null)?.fields) && ((channel.config_schema as Wire).fields as Wire[]).length > 0
        ? ((channel.config_schema as Wire).fields as Wire[]).map(toField)
        : (BUILT_IN_FIELDS[str(channel.channel_id)] ?? []),
    }));
}

/**
 * The bots on this channel, as they look to one companion. Every bot is
 * returned, each saying whose it is, so the window can show this companion's
 * bots, the ones still waiting to be assigned, and (plainly named, read-only)
 * the ones belonging to other companions. Nothing may be changed on the
 * strength of being listed: each mutation re-checks the owner.
 *
 * The runtime has no per-agent account filter (`channel_accounts_list` takes a
 * channel only), so the scoping happens here, from the owner each bot records.
 */
export async function listChannelAccounts(channelId: string, agentId = ""): Promise<ChannelAccount[]> {
  const reply = await request<{ type: string; accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
  return (reply.accounts ?? []).map((account) => toAccount(account, agentId));
}

/**
 * The same inventory, for a privacy decision rather than a screen.
 *
 * A window can treat a missing list as "nothing to show". A check that decides
 * whether a conversation is private cannot: an unreadable or malformed reply
 * must not look like "this companion has no bots". This refuses instead, and
 * the caller turns that refusal into an unknown audience.
 */
export async function inventoryChannelAccounts(channelId: string, agentId = ""): Promise<ChannelAccount[]> {
  const reply = await request<{ type: string; accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
  const unreadable = () => new Error(`The ${channelId} bot list could not be read.`);
  if (!Array.isArray(reply.accounts)) throw unreadable();
  for (const account of reply.accounts) assertReadableAccount(account, unreadable);
  return reply.accounts.map((account) => toAccount(account, agentId));
}

/**
 * Every channel's bindings, in the three fields a privacy decision needs.
 *
 * Kept here, next to the inventory it reads, so the privacy decision and the
 * normalisation it depends on cannot drift apart: a caller that wants the
 * audience gets the strict reader, the raw check and this mapping together.
 * Any channel that cannot be read refuses for all of them.
 */
export async function audienceChannelBindings(agentId: string, channelIds: string[] = ["telegram", "discord"]): Promise<AudienceAccount[]> {
  const lists = await Promise.all(channelIds.map(channelId => inventoryChannelAccounts(channelId, agentId)));
  return lists.flat().map(account => ({ ownerAgentId: account.ownerAgentId, boundAgentId: account.boundAgentId, here: account.here }));
}

/**
 * The raw check that has to happen before `toAccount` normalises anything.
 *
 * `toAccount` is built for a screen: whatever it cannot read becomes "no id, no
 * binding, not here", which is indistinguishable from a bot that could never
 * make a conversation shared. For a privacy decision that silence is the
 * dangerous answer, so an entry whose identity or binding cannot be read stops
 * the inventory here. Configuration is required to be present and readable for
 * the same reason `channelBinding` requires it during recovery: an absent
 * config is an unknown binding, not an absent one.
 */
function assertReadableAccount(account: Wire, unreadable: () => Error): void {
  const object = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!object(account)) throw unreadable();
  if (typeof account.account_id !== "string" || account.account_id.trim() === "") throw unreadable();
  for (const key of ["display_name", "name", "dm_policy"]) {
    if (account[key] !== undefined && account[key] !== null && typeof account[key] !== "string") throw unreadable();
  }
  if (!object(account.config)) throw unreadable();
  const config = account.config as Wire;
  const binding = config.binding ?? account.binding;
  if (binding !== undefined && binding !== null && !object(binding)) throw unreadable();
  const source = object(binding) ? binding as Wire : null;
  for (const value of [source?.agent_id, config.agent_id, account.agent_id]) {
    if (value !== undefined && value !== null && typeof value !== "string") throw unreadable();
  }
  // A binding that names nothing readable is unknown, not unbound.
  if (source && typeof source.agent_id !== "string") throw unreadable();
}

/**
 * Tokens with a setup in flight. Until `setupChannel` saves a fingerprint there
 * is nothing to compare against, so two setups started at once — two windows,
 * or an impatient second press — would both get through. A token is held here
 * from the check until the setup finishes or fails.
 */
const claimingTokens = new Set<string>();

/**
 * Hearthside: the same bot account must not be added twice — two accounts on
 * one token means two pollers, which Telegram answers with a 409 conflict and
 * Discord with a second gateway session. Compared on the way in, from the token
 * just typed, because the runtime's wire data carries no token to compare with
 * (only `has_token`). The token is never stored: see channelTokenFingerprint.
 *
 * What this does NOT cover, said plainly rather than papered over: a bot set up
 * before this change has no fingerprint, so re-adding that bot's token can't be
 * spotted here — the token was never kept and can't be worked out from the
 * runtime. Telegram and Discord are what finally refuse the second poller, with
 * a 409 or a dropped gateway session. See docs/AGENT-OWNED-BOTS.md.
 */
function assertTokenNotInUse(token: string, accounts: ChannelAccount[]): string {
  const fingerprint = channelTokenFingerprint(token);
  const records = channelBots();
  const clash = accounts.find((account) => records[account.accountId]?.tokenFingerprint === fingerprint);
  if (clash) {
    if (clash.mine) {
      throw new Error(`That's the same bot as "${clash.name}", which already answers for this companion. One bot can only be in one place, so there's nothing to add.`);
    }
    const clashConnection = records[clash.accountId]?.connection ?? null;
    if (clashConnection !== null && clashConnection !== connectionKey()) {
      throw new Error(`That's the same bot as "${clash.name}". ${elsewhereMessage(clashConnection)}`);
    }
    if (clash.unclaimed) {
      throw new Error(`That's the same bot as "${clash.name}", which is already set up here but isn't assigned to a companion yet. Claim that one for this companion instead of adding it again.`);
    }
    throw new Error(`That's the same bot as "${clash.name}", which is already set up here for another companion. One bot can only answer for one companion, so add a different bot, or move that one to this companion.`);
  }
  if (claimingTokens.has(fingerprint)) {
    throw new Error("That bot is being set up already. Give it a moment, then look in Channels before adding it again.");
  }
  return fingerprint;
}

/** Create a bot account, link it to the agent and start it. */
export async function setupChannel(input: {
  channelId: string;
  agentId: string;
  name: string;
  access: ChannelAccess;
  config: Record<string, unknown>;
  companionParticipation?: { version: 1; ambient: boolean; mentions: boolean };
}): Promise<ChannelAccount> {
  if (!input.agentId) throw new Error("No companion was named for this bot.");
  const token = typeof input.config.token === "string" ? input.config.token.trim() : "";
  // Checked, then held: nothing has saved a fingerprint yet, so without the hold
  // two setups started at once would both pass the check.
  // Listed as this companion sees them, so a clash can be described as theirs,
  // someone else's, or nobody's yet.
  const fingerprint = token ? assertTokenNotInUse(token, await listChannelAccounts(input.channelId, input.agentId)) : "";
  if (fingerprint) claimingTokens.add(fingerprint);
  try {
    // "Just me" starts as pairing; the first approval locks it to that person.
    const dmPolicy: DmPolicy = input.access === "open" ? "open" : "pairing";
    // A new bot states the chosen permission mode from the start, so its first
    // reply doesn't ask about everything in YOLO (see channel-permission.ts).
    const config = input.channelId === "discord"
      ? { ...input.config, hearthside_companion_policy: input.companionParticipation ?? { version: 1, ambient: true, mentions: true }, ...channelPermissionConfig(input.channelId) }
      : { ...input.config, ...channelPermissionConfig(input.channelId) };
    const created = await request<{ type: string; account?: Wire | null }>("channel_account_create", {
      channel_id: input.channelId,
      account: { display_name: input.name.trim() || undefined, enabled: true, dm_policy: dmPolicy, config },
    });
    const accountId = str(created.account?.account_id);
    if (!accountId) throw new Error("The runtime didn't create the account.");
    // The bot exists from here on, so the rest of the setup takes its queue:
    // startup reconciliation and the Discord maintenance pass both act on bots
    // the runtime lists, and this one is listed before it is finished.
    return await withBot(accountId, async () => {
      // From now on the channel service starts with Hearthside.
      markChannelsUsed();
      if (input.access === "just-me") setChannelJustMe(accountId, true);
      setChannelBot(accountId, {
        connection: connectionKey(),
        owner: "hearthside",
        wanted: true,
        agentId: input.agentId,
        ...(fingerprint ? { tokenFingerprint: fingerprint } : {}),
      });
      onChannelsUsed?.();
      try {
        await request<Wire>("channel_account_bind", {
          channel_id: input.channelId,
          account_id: accountId,
          runtime: { agent_id: input.agentId, conversation_id: "default" },
        });
        const started = await request<{ type: string; account?: Wire | null }>("channel_account_start", { channel_id: input.channelId, account_id: accountId });
        return toAccount(started.account ?? created.account ?? {}, input.agentId);
      } catch (error) {
        // Don't leave a half-set-up bot behind.
        await request<Wire>("channel_account_delete", { channel_id: input.channelId, account_id: accountId }).catch(() => undefined);
        forgetChannelBot(accountId);
        throw new Error(friendlyChannelError(input.channelId, error));
      }
    });
  } finally {
    if (fingerprint) claimingTokens.delete(fingerprint);
  }
}

/** Plain words for the errors people actually hit when connecting a bot. */
export function friendlyChannelError(channelId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const app = channelId === "discord" ? "Discord" : channelId === "telegram" ? "Telegram" : channelId;
  if (/401|unauthori[sz]ed|invalid token|TokenInvalid/i.test(message)) {
    return channelId === "telegram"
      ? "Telegram didn't accept that token. Check it with @BotFather (send /mytoken or /newbot)."
      : `${app} didn't accept that token. Copy it again from the Developer Portal (Bot → Reset Token).`;
  }
  if (/disallowed intents|privileged intent/i.test(message)) {
    return "Discord needs Message Content Intent turned on: Developer Portal → your app → Bot → Privileged Gateway Intents.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) return `Couldn't reach ${app}. Check the internet connection and try again.`;
  return message;
}

export async function setChannelAccountRunning(channelId: string, accountId: string, running: boolean, agentId: string): Promise<ChannelAccount> {
  // Refused at once if it isn't this companion's bot, then checked again inside
  // the bot's own queue: the same two checks everything here makes.
  assertBotOwnedBy(accountId, agentId, running ? "be started" : "be stopped");
  return withBot(accountId, async () => {
    assertBotOwnedBy(accountId, agentId, running ? "be started" : "be stopped");
    const record = channelBot(accountId);
    if (running && record && record.connection !== null && record.connection !== connectionKey()) {
      throw new Error(elsewhereMessage(record.connection));
    }
    setChannelBot(accountId, { ...record, connection: record?.connection ?? connectionKey(), owner: "hearthside", wanted: running, agentId });
    // A bot that was held off — parked, or just claimed — is switched off in the
    // runtime's own record too, and the runtime won't poll a disabled account.
    // Switching it on here means on, the same way start-up does it.
    // Switching it on restates the chosen permission mode in the same call, so a
    // bot that was parked, claimed or set up under an older choice doesn't start
    // answering under it (see channel-permission.ts).
    if (running) await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: true, ...channelPermissionPatch(channelId) } });
    const reply = await request<{ type: string; account?: Wire | null }>(running ? "channel_account_start" : "channel_account_stop", {
      channel_id: channelId,
      account_id: accountId,
    });
    return toAccount(reply.account ?? {}, agentId);
  });
}

/**
 * The recovery handover's own way to switch a bot off and on again.
 *
 * Not a way round the owner check: it isn't in the IPC contract, so nothing in
 * the window can reach it, and a handover is only allowed when both agents are
 * on this one connection (cutover-runtime's `assertOwned`). It exists because a
 * handover also covers bots set up before bots belonged to companions, which
 * have no companion recorded — there the owner check has nothing to check and
 * would refuse part-way through a handover, leaving it half done.
 *
 * Whose the bot is stays exactly as it was. Switching a bot off for a handover
 * must not quietly make it someone's; an unclaimed bot is still unclaimed
 * afterwards, and startup still holds it until a person claims it.
 *
 * It takes the bot's queue like everything else. Recovery's admission gate
 * holds the window's own changes while a handover runs, but the Discord
 * maintenance pass and startup reconciliation aren't window requests and don't
 * pass through it.
 */
export async function setRecoveryBotRunning(channelId: string, accountId: string, running: boolean): Promise<void> {
  await withBot(accountId, async () => {
    const record = channelBot(accountId);
    if (record && record.connection !== null && record.connection !== connectionKey()) throw new Error(elsewhereMessage(record.connection));
    if (record?.transfer) throw new Error(unfinishedMoveMessage());
    setChannelBot(accountId, { ...record, connection: record?.connection ?? connectionKey(), owner: "hearthside", wanted: running });
    await request<Wire>(running ? "channel_account_start" : "channel_account_stop", { channel_id: channelId, account_id: accountId });
  });
}

export async function removeChannelAccount(channelId: string, accountId: string, agentId: string): Promise<void> {
  assertBotOwnedBy(accountId, agentId, "be removed");
  await withBot(accountId, async () => {
    assertBotOwnedBy(accountId, agentId, "be removed");
    await request<Wire>("channel_account_stop", { channel_id: channelId, account_id: accountId }).catch(() => undefined);
    await request<Wire>("channel_account_delete", { channel_id: channelId, account_id: accountId });
    forgetChannelBot(accountId);
    if (channelId === "discord") forgetDiscordAccount(accountId);
  });
}

/**
 * Who is waiting to be approved on this companion's bots.
 *
 * A pairing belongs to the bot it arrived at, so it is only offered to that
 * bot's owner. Approving from another companion's page used to bind the chat to
 * whoever was selected, which is how a bot ended up answering for the wrong
 * companion.
 *
 * Asked bot by bot, not as one global list: `channel_pairings_list` takes an
 * `account_id` (pin 0.34.8, `ChannelPairingsListCommand`) and the runtime
 * filters on it, so the runtime says which bot a request arrived at. The reply
 * is checked against the bot that was asked for as well, so a request the
 * runtime can't tie to this bot is never shown here. Nothing is guessed from
 * "this companion only has one bot": that guess goes wrong as soon as a request
 * arrives at a bot with no account of its own.
 */
export async function listPairings(channelId: string, agentId = ""): Promise<ChannelPairing[]> {
  if (!agentId) return [];
  const current = connectionKey();
  // The owner is the pair (connection, companion): a bot recorded for another
  // connection isn't running here, so its requests aren't this window's to approve.
  const mine = Object.entries(channelBots())
    .filter(([, record]) => record.connection === current && record.agentId === agentId && !record.transfer)
    .map(([accountId]) => accountId);
  if (mine.length === 0) return [];
  const declined = new Set(declinedPairings());
  const perAccount = await Promise.all(
    mine.map(async (accountId) => {
      const reply = await request<{ type: string; pending?: Wire[] }>("channel_pairings_list", { channel_id: channelId, account_id: accountId });
      return (reply.pending ?? [])
        // Attribution is the runtime's, and checked here too: an older runtime
        // that ignored the filter must not make one bot's requests look like another's.
        .filter((pairing) => str(pairing.account_id) === accountId && !declined.has(str(pairing.code)))
        .map((pairing) => ({
          channelId,
          accountId,
          code: str(pairing.code),
          senderId: str(pairing.sender_id),
          senderName: str(pairing.sender_name) || str(pairing.sender_id),
          chatId: str(pairing.chat_id),
          expiresAt: str(pairing.expires_at) || null,
        }));
    }),
  );
  return perAccount.flat();
}

/**
 * Let this person talk to the companion that owns the bot, in that companion's
 * main chat. The chat is bound to the BOT'S owner, taken from the record, not to
 * the companion whose page the approval came from.
 *
 * The code must still be waiting on the named bot: both are sent to the runtime,
 * which matches on both as well (`consumePairingCode` at pin 0.34.8 filters by
 * account and refuses an ambiguous code). An approval that can't be matched is
 * refused rather than bound to the bot that happened to be asked about.
 *
 * The chat always starts in the owner's main chat. Conversations belong to one
 * companion, so a conversation id from anywhere else would point this chat into
 * someone else's history.
 *
 * The owner is read ONCE, before the requests are fetched, and that is the
 * companion the chat is bound to — and it is checked again, unchanged, right
 * before the bind. Authorising against the record as it was and binding the
 * record as it has become is how an approval a person was entitled to press
 * could hand a new chat to a companion the bot had meanwhile been moved to.
 * Taking the bot's queue keeps Hearthside's own changes out of that gap; the
 * re-check is what refuses anything else.
 */
export async function approvePairing(input: { channelId: string; accountId: string; code: string; agentId: string }): Promise<void> {
  if (!input.accountId) throw new Error("Which bot that request arrived at wasn't named, so it can't be approved. Reopen Channels and try again.");
  assertBotOwnedBy(input.accountId, input.agentId, "be paired");
  await withBot(input.accountId, async () => {
    assertBotOwnedBy(input.accountId, input.agentId, "be paired");
    const owner = channelBot(input.accountId)?.agentId ?? "";
    const pending = (await listPairings(input.channelId, input.agentId)).find((pairing) => pairing.code === input.code && pairing.accountId === input.accountId);
    if (!pending) {
      throw new Error("That request isn't waiting on this bot any more — it may have expired, or been approved already. Reopen Channels to see who's waiting.");
    }
    assertBotOwnedBy(input.accountId, input.agentId, "be paired");
    if ((channelBot(input.accountId)?.agentId ?? "") !== owner) {
      throw new Error("This bot changed companion while that request was being approved, so nothing was approved. Reopen Channels to see who's waiting now.");
    }
    await request<Wire>("channel_pairing_bind", {
      channel_id: input.channelId,
      account_id: input.accountId,
      code: input.code,
      runtime: { agent_id: owner, conversation_id: "default" },
    });
    // "Just me": the first person approved becomes the only one allowed; others are turned away.
    if (pending.senderId && channelJustMe(input.accountId)) {
      const accounts = await listChannelAccounts(input.channelId, input.agentId);
      const current = accounts.find((account) => account.accountId === input.accountId);
      // Already holding this bot's queue, so this runs straight through.
      await setChannelAccess(input.channelId, input.accountId, "just-me", [...new Set([...(current?.allowedUsers ?? []), pending.senderId])], input.agentId);
    }
  });
}

/**
 * Who may message a bot. "just-me" uses the runtime's allowlist (others are turned away).
 *
 * Narrowing access also takes back approvals. The runtime lets through anyone
 * whose pairing code was ever approved on this bot, whatever the policy or the
 * allowed-person list says afterwards, so changing those alone left everyone
 * who had been approved able to carry on (see channel-approvals.ts):
 *
 *  - "Just me" keeps only the people on the allowed list. Anyone else who was
 *    approved earlier has to ask again, and is turned away once the bot is
 *    locked to one person.
 *  - Taking a person off the allowed list takes back their approval too.
 *
 * For "Just me", the desired list fully describes the revocation even on
 * retry, so narrow the policy first. For individually removed people the old
 * list is the only durable record of their ids: keep it until revocation has
 * synced, so resubmitting the same change can finish after a gateway error.
 */
export async function setChannelAccess(channelId: string, accountId: string, access: ChannelAccess, allowedUsers: string[], agentId: string): Promise<ChannelAccount> {
  assertBotOwnedBy(accountId, agentId, "have its access changed");
  return withBot(accountId, async () => {
    assertBotOwnedBy(accountId, agentId, "have its access changed");
    const locked = access === "just-me" && allowedUsers.length > 0;
    const dmPolicy: DmPolicy = access === "open" ? "open" : locked ? "allowlist" : "pairing";
    // Who was allowed until now, so that anyone this change removes can have
    // their approval taken back as well. Read before the change, in the queue.
    const before = (await listChannelAccounts(channelId, agentId)).find((account) => account.accountId === accountId);
    const removed = new Set((before?.allowedUsers ?? []).filter((user) => !allowedUsers.includes(user)));
    if (access !== "just-me" && removed.size > 0) {
      await revokeApprovals(channelId, accountId, (senderId) => removed.has(senderId));
    }
    const reply = await request<{ type: string; account?: Wire | null }>("channel_account_update", {
      channel_id: channelId,
      account_id: accountId,
      patch: { dm_policy: dmPolicy, allowed_users: allowedUsers },
    });
    // Still waiting for the first person: stay in pairing and lock on approval.
    setChannelJustMe(accountId, access === "just-me");
    if (access === "just-me") {
      try {
        await revokeApprovals(channelId, accountId, (senderId) => !allowedUsers.includes(senderId));
      } catch (error) {
        throw new Error(`The new setting was saved, but people approved earlier can still message this bot. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return toAccount(reply.account ?? {}, agentId);
  });
}

export async function setDiscordCompanionParticipation(accountId: string, policy: { version: 1; ambient: boolean; mentions: boolean }, agentId: string): Promise<ChannelAccount> {
  assertBotOwnedBy(accountId, agentId, "have its Discord companion participation changed");
  return withBot(accountId, async () => {
    assertBotOwnedBy(accountId, agentId, "have its Discord companion participation changed");
    const reply = await request<{ type: string; account?: Wire | null }>("channel_account_update", {
      channel_id: "discord", account_id: accountId, patch: { config: { hearthside_companion_policy: policy } },
    });
    return toAccount(reply.account ?? {}, agentId);
  });
}

export async function setChannelChatMode(accountId: string, mode: "main" | "server" | "channel", agentId: string): Promise<void> {
  assertBotOwnedBy(accountId, agentId, "have its chats moved");
  await withBot(accountId, async () => {
    assertBotOwnedBy(accountId, agentId, "have its chats moved");
    // Inside this bot's queue, so the five-second maintenance pass can't be
    // half way through applying the old mode while this changes it.
    await applyChatMode(accountId, { reconcile: true, mode });
    setChannelChatModeSetting(accountId, mode);
  });
}

export function declinePairing(code: string): void {
  declinePairingCode(code);
}

export async function listChannelRoutes(agentId: string): Promise<ChannelRoute[]> {
  // The runtime lists one channel at a time (Telegram when none is named).
  const replies = await Promise.all(
    SHOWN.map((channelId) => request<{ type: string; routes?: Wire[] }>("channel_routes_list", { channel_id: channelId, agent_id: agentId }).catch(() => ({ type: "", routes: [] as Wire[] }))),
  );
  const wires = replies.flatMap((reply) => reply.routes ?? []);
  await prepareDiscordLabels([...new Set(wires.filter((route) => str(route.channel_id) === "discord").map((route) => str(route.account_id)))]);
  return wires.map((route) => {
    const label = str(route.channel_id) === "discord" ? discordChannelLabel(str(route.chat_id)) : null;
    return {
      channelId: str(route.channel_id),
      accountId: str(route.account_id),
      chatId: str(route.chat_id),
      // Routes Hearthside makes in advance carry no type; a known server channel is a channel.
      chatType: str(route.chat_type) === "channel" || label ? ("channel" as const) : ("direct" as const),
      threadId: str(route.thread_id) || null,
      conversationId: str(route.conversation_id),
      enabled: route.enabled !== false,
      label,
    };
  });
}

/**
 * The chats connected to one bot, or nothing at all.
 *
 * Deliberately not forgiving: a failed read used to come back as an empty list,
 * which reads exactly like "this bot has no chats" and would let a move rebind a
 * bot while leaving its real chats pointing at the old companion. Anything that
 * changes routes asks through here and stops if the answer isn't an answer.
 */
async function accountRoutes(channelId: string, accountId: string): Promise<Wire[]> {
  const reply = await request<{ routes?: Wire[] }>("channel_routes_list", { channel_id: channelId, account_id: accountId }).catch((error: unknown) => {
    throw new Error(`Couldn't read which chats this bot has, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!Array.isArray(reply.routes)) throw new Error("Couldn't read which chats this bot has, so nothing was changed. Try again in a moment.");
  if (reply.routes.some((route) => !route || typeof route !== "object" || !str(route.account_id).trim() || !str(route.chat_id).trim() || !str(route.agent_id).trim())) {
    throw new Error("The runtime returned an incomplete chat route, so this bot cannot be changed safely. Refresh its chats and try again.");
  }
  return reply.routes.filter((route) => str(route.account_id) === accountId);
}

/**
 * Disconnect one chat. A companion may always disconnect a chat that comes to
 * IT, even on a bot owned by someone else: before bots belonged to companions,
 * approving from the wrong page could leave exactly that — a chat on one
 * companion's bot routed to another. Removing it stops messages reaching the
 * asking companion and touches no one else's route. Anything that is neither
 * this companion's chat nor this companion's bot is refused.
 *
 * Which bot is required. The runtime can remove a chat by id alone, across every
 * bot, and there is nothing to check an owner against in that call — so it is
 * never made.
 *
 * A bot recorded for another connection is left alone altogether. Agent ids
 * aren't comparable across backends, so a chat on such a bot that names this
 * companion's id is just as likely to be the other connection's companion, and
 * disconnecting it would take away someone else's chat.
 */
export async function removeChannelRoute(channelId: string, accountId: string, chatId: string, agentId: string): Promise<void> {
  if (!agentId) throw new Error("No companion was named for this change.");
  if (!accountId) throw new Error("Which bot that chat is on wasn't named, so it can't be disconnected. Reopen Channels and try again.");
  await withBot(accountId, async () => {
    const owner = botOwner(accountId);
    if (owner.connection !== null && !owner.here) throw new Error(elsewhereMessage(owner.connection));
    const ownBot = owner.agentId === agentId && owner.here && !owner.transfer;
    if (!ownBot) {
      // Not this companion's bot to change, so the chat itself has to be this
      // companion's. Read first: no inventory, no removal.
      const route = (await accountRoutes(channelId, accountId)).find((item) => str(item.chat_id) === chatId);
      if (!route) throw new Error("That chat is no longer connected. Reopen Channels to see what is.");
      if (str(route.agent_id) !== agentId) assertBotOwnedBy(accountId, agentId, "have its chats disconnected");
      // Read again after the inventory: whose bot this is decides whether the
      // chat's own agent was enough to allow this, so it has to still hold.
      const now = botOwner(accountId);
      if (now.agentId !== owner.agentId || now.connection !== owner.connection || Boolean(now.transfer) !== Boolean(owner.transfer)) {
        throw new Error("This bot changed while that chat was being disconnected, so nothing was disconnected. Reopen Channels to see what it has now.");
      }
    }
    await request<Wire>("channel_route_remove", { channel_id: channelId, account_id: accountId, chat_id: chatId }).catch((error: unknown) => {
      if (isSeveralRoutesError(error)) throw new Error(SEVERAL_TOPICS_DISCONNECT);
      throw error;
    });
    if (ownBot) await forgetDisconnectedPerson(channelId, accountId, chatId, agentId);
  });
}

/**
 * The runtime keeps one route per topic of a Telegram group, but its commands
 * for changing or removing a route name the chat only (pin 0.34.36:
 * `channel_route_update` and `channel_route_remove` carry no topic), and it
 * refuses them outright when a chat has more than one. Nothing Hearthside can
 * send gets round that, so it is said plainly instead of passed on as
 * "has multiple routes … Specify account_id", which the person can't act on.
 */
const isSeveralRoutesError = (error: unknown) => /multiple routes for chat/i.test(error instanceof Error ? error.message : String(error));
const SEVERAL_TOPICS_DISCONNECT =
  "This group uses topics, and the bot has answered in more than one of them. Letta can't disconnect a group like that one topic at a time yet, so it is still connected. To stop the bot answering there, remove it from the group in Telegram.";

/** Chats that have more than one route on this bot (a Telegram group with several topics in use). */
function chatsWithSeveralRoutes(routes: Wire[]): string[] {
  const seen = new Map<string, number>();
  for (const route of routes) seen.set(str(route.chat_id), (seen.get(str(route.chat_id)) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([chatId]) => chatId);
}

/**
 * Refuse a move that could not be finished, before anything is touched.
 *
 * Moving a bot re-points each of its chats, and the runtime refuses that for a
 * chat with several routes (see isSeveralRoutesError). Found half way through,
 * that left the bot held in an unfinished move that could be neither finished
 * nor undone — both do the same re-pointing — with Start and Remove refused
 * too. So it is looked for first, while the bot is still whole.
 */
function assertChatsCanMove(routes: Wire[]): void {
  const stuck = chatsWithSeveralRoutes(routes);
  if (stuck.length === 0) return;
  throw new Error(
    `This bot is in ${stuck.length === 1 ? "a Telegram group" : `${stuck.length} Telegram groups`} that ${stuck.length === 1 ? "uses" : "use"} topics, and it has answered in more than one topic there. Letta can't hand a group like that to another companion yet, so the bot hasn't been moved and nothing has changed. To use this bot with the other companion, remove it here and add it again from that companion's Channels page (its chats start afresh there), or set up a separate bot for them.`,
  );
}

/**
 * After a Telegram direct chat is disconnected: let that person ask again.
 *
 * Disconnecting removed the chat but left the person approved. On Telegram an
 * approved person with no chat is not offered a new pairing code and is not
 * connected either — they are told the chat "isn't connected to a Letta agent
 * yet", for good, and the only way back was removing the whole bot. Taking
 * their approval back as well (and their place on the allowed list, which
 * would otherwise let them straight past pairing into the same dead end) means
 * their next message gets a pairing code, which shows up here to approve.
 *
 * Only for Telegram direct chats, where the chat's id IS the person's id, so
 * the right person can be named. A group's id is negative and is left alone;
 * a Discord direct chat has an id of its own that says nothing about who is in
 * it, so there is nobody to name there and that chat is only disconnected.
 */
async function forgetDisconnectedPerson(channelId: string, accountId: string, chatId: string, agentId: string): Promise<void> {
  if (channelId !== "telegram" || !/^\d+$/.test(chatId)) return;
  try {
    const account = (await listChannelAccounts(channelId, agentId)).find((item) => item.accountId === accountId);
    if (account?.allowedUsers.includes(chatId)) {
      // Goes through the same door as the × beside an allowed person, which
      // also takes back their approval. Already in this bot's queue.
      await setChannelAccess(channelId, accountId, account.access, account.allowedUsers.filter((user) => user !== chatId), agentId);
    } else {
      await revokeApprovals(channelId, accountId, (senderId) => senderId === chatId);
    }
  } catch (error) {
    throw new Error(`That chat is disconnected, but the person in it is still approved, so they can't ask to be connected again yet. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Switch off every bot a companion owns on this connection — for when the
 * companion itself is being deleted.
 *
 * Deleting a companion used to leave its bots polling: they kept taking
 * messages for a companion that no longer existed until the channel service
 * next started, when start-up noticed the missing owner and held them. This
 * does that holding straight away.
 *
 * Each bot is recorded as not wanted BEFORE the runtime is asked to stop it,
 * so nothing (start-up, the retry after a failed start) switches it back on if
 * the stop itself fails. The bots are not removed and stay recorded as that
 * companion's: tokens and chats are the person's to remove, and a record with
 * a missing owner is exactly what start-up already knows how to hold.
 *
 * Never throws: deleting a companion must not fail because a bot couldn't be
 * reached. What couldn't be stopped comes back in `failed`, for the log.
 */
export async function stopBotsForAgent(agentId: string): Promise<{ stopped: string[]; failed: Array<{ accountId: string; error: string }> }> {
  const stopped: string[] = [];
  const failed: Array<{ accountId: string; error: string }> = [];
  for (const accountId of botsOwnedBy(agentId)) {
    try {
      await withBot(accountId, async () => {
        // Read again inside the queue: a move may have given the bot to another
        // companion while this waited, and that companion is not being deleted.
        const record = channelBot(accountId);
        if (!record || record.agentId !== agentId || record.connection !== connectionKey() || record.transfer) return;
        setChannelBot(accountId, { ...record, wanted: false });
        const channelId = await channelOfBot(accountId);
        if (!channelId) return;
        await request<Wire>("channel_account_stop", { channel_id: channelId, account_id: accountId });
        // Off in the runtime's own record too, so a restart doesn't bring it back.
        await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: false } });
        stopped.push(accountId);
      });
    } catch (error) {
      failed.push({ accountId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { stopped, failed };
}

/** Which channel a bot is on. The record doesn't say, so the runtime is asked. */
async function channelOfBot(accountId: string): Promise<string | null> {
  for (const channelId of SHOWN) {
    const reply = await request<{ accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
    if ((reply.accounts ?? []).some((account) => str(account.account_id) === accountId)) return channelId;
  }
  return null;
}

/** The checks a claim makes on the record, made again inside the bot's queue. */
function assertClaimable(accountId: string, agentId: string): void {
  const record = channelBot(accountId);
  if (record?.transfer) throw new Error(unfinishedMoveMessage());
  if (record?.connection && record.connection !== connectionKey()) throw new Error(elsewhereMessage(record.connection));
  if (record?.agentId && record.agentId !== agentId) {
    throw new Error("This bot already belongs to another companion. Reassign it instead, so its existing chats move with it.");
  }
}

/**
 * Hearthside: take on a bot that predates bots belonging to companions, or one
 * whose owner could not be worked out. Claiming is always something a person
 * does for a named companion; nothing is assigned by being on screen.
 *
 * Claiming doesn't start the bot, here or at the next start-up: the bot is
 * switched off first, and "off" is written down as part of the claim. A bot from
 * before this change can be recorded as wanted — that is what it was — and
 * keeping that through a claim would have start-up switch it on by itself.
 *
 * A claim is deliberately only allowed where it is the whole truth: the bot must
 * answer as nobody, or already as the companion claiming it. If the runtime
 * sends its messages to another companion, or any of its chats do, claiming here
 * would leave one bot answering as two — the chats it has going to one
 * companion, everything new going to another — which is the thing this feature
 * exists to make impossible. That is refused with what to do instead: claim it
 * for the companion it answers as now and then move it (a move carries its chats
 * over), or disconnect those chats first, from the page of the companion they
 * reach. Moving is the path that handles chats; claiming never moves one, so a
 * chat that already belongs to the claiming companion keeps the conversation it
 * is in, with its history.
 */
export async function claimChannelBot(channelId: string, accountId: string, agentId: string): Promise<ChannelAccount> {
  if (!agentId) throw new Error("No companion was named for this bot.");
  if (!accountId) throw new Error("Which bot to claim wasn't named. Reopen Channels and try again.");
  assertClaimable(accountId, agentId);
  return withBot(accountId, async () => {
    assertClaimable(accountId, agentId);
    const accounts = await listChannelAccounts(channelId, agentId);
    const account = accounts.find((item) => item.accountId === accountId);
    if (!account) throw new Error("That bot is no longer set up here.");
    // Where the runtime sends this bot's messages now. A claim may agree with it
    // or replace nothing at all; it may not take a bot off another companion.
    if (account.boundAgentId && account.boundAgentId !== agentId) {
      throw new Error(
        "This bot's messages go to another companion, so claiming it here would split it in two: its chats would stay with that companion while anything new came here. Claim it for the companion it answers as now, then move it to this one — moving brings its chats with it.",
      );
    }
    // Fail-closed inventory: a chat going somewhere else is the same split, and a
    // read that didn't answer must never be read as "this bot has no chats".
    const routes = await accountRoutes(channelId, accountId);
    const elsewhereChats = routes.filter((route) => str(route.agent_id) && str(route.agent_id) !== agentId);
    if (elsewhereChats.length > 0) {
      const others = new Set(elsewhereChats.map((route) => str(route.agent_id)));
      throw new Error(
        `This bot already has ${elsewhereChats.length === 1 ? "a chat" : `${elsewhereChats.length} chats`} going to ${others.size === 1 ? "another companion" : "other companions"}, so claiming it here would leave ${elsewhereChats.length === 1 ? "that chat" : "those chats"} answering as someone else. Claim it for the companion ${elsewhereChats.length === 1 ? "that chat belongs" : "those chats belong"} to and then move it here, which brings ${elsewhereChats.length === 1 ? "the chat" : "the chats"} along — or disconnect ${elsewhereChats.length === 1 ? "it" : "them"} first, from the Channels page of the companion ${elsewhereChats.length === 1 ? "it reaches" : "they reach"}.`,
      );
    }
    // Nothing has been changed yet, so this is the last point at which the record
    // decides. The queue keeps Hearthside's own changes out; this refuses the rest.
    assertClaimable(accountId, agentId);
    // Held off durably BEFORE the runtime is touched: a claim that fails from
    // here on leaves the bot unclaimed and switched off, which start-up holds,
    // rather than half claimed and answering.
    const record = channelBot(accountId);
    setChannelBot(accountId, { ...record, connection: connectionKey(), owner: "hearthside", wanted: false });
    await stopBeforeOwnerChange(channelId, accountId, "claimed");
    // The runtime routes inbound messages by the account's own binding, so bind it
    // too: a claim that only Hearthside knew about would not change where replies go.
    await request<Wire>("channel_account_bind", {
      channel_id: channelId,
      account_id: accountId,
      runtime: { agent_id: agentId, conversation_id: "default" },
    });
    setBotOwner(accountId, agentId, { connection: connectionKey(), wanted: false, transfer: null });
    return (await listChannelAccounts(channelId, agentId)).find((item) => item.accountId === accountId) ?? account;
  });
}

/**
 * What moving a bot to another companion would do, so the person can say yes to
 * the real thing: who it leaves, how many chats come with it, and how many of
 * those start again in the new companion's main chat.
 *
 * The owner and the connection come back with it, and confirming sends them
 * back here (see reassignChannelBot), so a confirmation is always about the bot
 * as the person saw it.
 *
 * Taken in the bot's queue so it describes a settled bot rather than one with a
 * change in flight; the move that confirms it holds the same queue throughout,
 * and asks again through here.
 */
export async function previewChannelBotReassign(channelId: string, accountId: string, toAgentId: string): Promise<ChannelBotReassign> {
  if (!toAgentId) throw new Error("No companion was named for this bot.");
  return withBot(accountId, async () => {
    const record = channelBot(accountId);
    if (record?.transfer) throw new Error(unfinishedMoveMessage());
    const from = record?.agentId ?? "";
    if (!from) throw new Error("This bot isn't assigned to a companion yet, so there's nothing to move. Claim it for a companion instead.");
    if (from === toAgentId) throw new Error("That bot already belongs to this companion.");
    if (record && record.connection !== connectionKey()) throw new Error(elsewhereMessage(record.connection));
    const routes = await accountRoutes(channelId, accountId);
    assertChatsCanMove(routes);
    return {
      channelId,
      accountId,
      fromAgentId: from,
      toAgentId,
      connection: connectionKey(),
      movingRoutes: routes.length,
      // Conversations belong to one companion, so a chat sitting in one of the old
      // owner's conversations can't simply be handed over: it is re-pointed at the
      // new owner's main chat, and the window says so before anything changes.
      resetChats: routes.filter((route) => str(route.conversation_id) !== "default").length,
      running: record?.wanted === true,
    };
  });
}

/** The unfinished-move marker, written before the runtime is touched. */
type Transfer = NonNullable<ChannelBotRecord["transfer"]>;

/**
 * Hold the bot off, durably, and say where its move had got to. Written before
 * each runtime step, so a crash, a quit or a failed step leaves a record of an
 * unfinished move rather than a bot that looks settled and isn't: nothing starts
 * it, every other change on it is refused, and it can be finished or undone.
 */
function markTransfer(accountId: string, holder: string, transfer: Transfer): void {
  const record = channelBot(accountId);
  setChannelBot(accountId, { ...record, connection: connectionKey(), owner: "hearthside", wanted: false, agentId: holder, transfer });
}

/**
 * Switch a bot off before its owner changes, and make sure it really is off.
 *
 * Fails closed: a stop that errors, or a bot the runtime still reports as
 * running, stops the change before anything else has happened. A live bot
 * half way through would mean messages still going to the companion it is
 * leaving — or, on a claim, still going wherever it was going before.
 */
async function stopBeforeOwnerChange(channelId: string, accountId: string, what: "moved" | "claimed" = "moved"): Promise<void> {
  const refuse = (error: unknown): never => {
    throw new Error(`The bot couldn't be switched off, so it hasn't been ${what}: ${error instanceof Error ? error.message : String(error)}. Try again in a moment.`);
  };
  await request<Wire>("channel_account_stop", { channel_id: channelId, account_id: accountId }).catch(refuse);
  // Off in the runtime's own record too, so a restart part-way through doesn't
  // put it back to work for the companion it is leaving.
  await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: false } }).catch(refuse);
  const after = (await listChannelAccounts(channelId, "")).find((account) => account.accountId === accountId);
  if (!after) throw new Error("That bot is no longer set up here. Reopen Channels to see what is.");
  if (after.running) throw new Error(`The bot is still answering, so it hasn't been ${what}. Try again in a moment.`);
}

/**
 * Point a bot, and every chat on it, at one companion.
 *
 * Chats are re-pointed at that companion's main chat. Conversations belong to
 * one companion (the runtime lists a conversation for its own agent only), so
 * keeping a chat's old conversation id would leave it pointing into someone
 * else's history: present in the channel's routes, absent from the companion's
 * chats, and opening to the wrong companion's messages. The chat keeps working;
 * what was said before stays where it was said.
 *
 * Which conversation each Discord chat was pointed at is forgotten here as part
 * of the move, while the bot is still held and this bot's queue is still taken
 * (so the five-second maintenance pass sees the move finished, never half of
 * it). Those ids are the old owner's conversations, and the maintenance pass
 * re-applies the stored chat mode from them — it would have re-pointed these
 * chats straight back into the companion the bot had just left.
 */
async function pointBotAt(channelId: string, accountId: string, target: string, transfer: Transfer): Promise<void> {
  await request<Wire>("channel_account_bind", {
    channel_id: channelId,
    account_id: accountId,
    runtime: { agent_id: target, conversation_id: "default" },
  });
  // The binding is what routes messages, so the record follows it at once —
  // still held, because the chats have not moved yet.
  markTransfer(accountId, target, { ...transfer, stage: "routes" });
  forgetDiscordChatTargets(accountId);
  for (const route of await accountRoutes(channelId, accountId)) {
    await request<Wire>("channel_route_update", {
      channel_id: channelId,
      account_id: accountId,
      chat_id: str(route.chat_id),
      runtime: { agent_id: target, conversation_id: "default" },
    });
  }
}

/**
 * Move a bot to another companion: stop it, rebind the account, move its
 * existing chats with it, then record the new owner. Deliberate chats are
 * carried over rather than orphaned.
 *
 * `fromAgentId` and `connection` are what the preview showed. They are checked
 * against the record before anything is touched, so a confirmation that has
 * gone stale — another window moved the bot, a recovery handover changed it,
 * Hearthside connected somewhere else — is refused instead of being applied to
 * whatever the bot happens to be now.
 *
 * The whole move is one turn of this bot's queue: stop, rebind, chats, record,
 * start. Nothing else about this bot happens in the middle of it.
 */
export async function reassignChannelBot(input: { channelId: string; accountId: string; fromAgentId: string; toAgentId: string; connection: string }): Promise<ChannelAccount> {
  const { channelId, accountId, toAgentId } = input;
  return withBot(accountId, async () => {
    const preview = await previewChannelBotReassign(channelId, accountId, toAgentId);
    if (preview.fromAgentId !== input.fromAgentId || preview.connection !== input.connection) {
      throw new Error("This bot has changed since you were shown that: it belongs to someone else now, or Hearthside is connected somewhere else. Reopen Channels and look again before moving it.");
    }
    await stopBeforeOwnerChange(channelId, accountId);
    // Looked at again now the bot is off and can't gain a chat: a second topic
    // used between the preview and the stop would strand the move half way.
    assertChatsCanMove(await accountRoutes(channelId, accountId));
    const transfer: Transfer = { fromAgentId: preview.fromAgentId, toAgentId, stage: "bind", startedAt: new Date().toISOString() };
    // Held before the runtime is touched, not after.
    markTransfer(accountId, preview.fromAgentId, transfer);
    await pointBotAt(channelId, accountId, toAgentId, transfer);
    setBotOwner(accountId, toAgentId, { connection: input.connection, wanted: preview.running, transfer: null });
    if (preview.running) {
      // Switched back on with the chosen permission mode stated in the same
      // call, before it can answer for its new companion. Failing to switch it
      // on is forgiven (it is usually enabled already, and starting says so),
      // but failing to state the mode is not: the bot is left off rather than
      // answering under the mode it had before (see channel-permission.ts).
      await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: true, ...channelPermissionPatch(channelId) } }).catch((error: unknown) => {
        if (!takesChannelPermissionMode(channelId)) return;
        throw new Error(`The bot now belongs to the other companion, but it wasn't switched back on: Hearthside couldn't tell it which permission mode to answer under, so it was left off rather than answering under the one it had before. ${friendlyChannelError(channelId, error)}`);
      });
      try {
        await request<Wire>("channel_account_start", { channel_id: channelId, account_id: accountId });
      } catch (error) {
        // The move itself is done and recorded; only starting failed. Say so, and
        // leave it wanted so it starts with Hearthside next time.
        throw new Error(`The bot now belongs to the other companion, but it didn't start again: ${friendlyChannelError(channelId, error)}`);
      }
    }
    const moved = (await listChannelAccounts(channelId, toAgentId)).find((item) => item.accountId === accountId);
    if (!moved) throw new Error("The bot moved, but the runtime no longer lists it. Reopen Channels to see where it is.");
    return moved;
  });
}

/**
 * Put right a move that didn't finish — the only way a held bot gets out of that
 * state, since nothing finishes it on its own.
 *
 * "finish" completes it for the companion it was going to; "undo" puts it back
 * with the one it came from. Both do the same work (rebind, re-point the chats)
 * towards one companion or the other, and both leave the bot switched off: the
 * person decides when it answers again, once they can see where it ended up.
 * Which two companions are involved comes from the record, not from the caller.
 *
 * Undoing puts the bot and its chats back with the companion it came from, but
 * each chat lands in that companion's MAIN chat: the move had already pointed
 * them there, and which conversation each one sat in before is not kept. Nothing
 * said in those conversations is lost; the chats simply carry on in the main one.
 * Said in the window before a move, as "chats that start again" (resetChats).
 */
export async function resumeChannelBotMove(channelId: string, accountId: string, action: "finish" | "undo"): Promise<ChannelAccount> {
  return withBot(accountId, async () => {
    const record = channelBot(accountId);
    const transfer = record?.transfer ?? null;
    if (!record || !transfer) throw new Error("There's no unfinished move on this bot.");
    if (record.connection !== connectionKey()) throw new Error(elsewhereMessage(record.connection));
    if (action === "undo" && !transfer.fromAgentId) {
      throw new Error("This bot didn't belong to a companion before the move, so there's nothing to put it back to. Finish the move instead; you can reassign it afterwards.");
    }
    const target = action === "finish" ? transfer.toAgentId : (transfer.fromAgentId ?? "");
    if (!target) throw new Error("That unfinished move doesn't say which companion to put the bot with. Reassign it from Channels instead.");
    await stopBeforeOwnerChange(channelId, accountId);
    await pointBotAt(channelId, accountId, target, transfer);
    setBotOwner(accountId, target, { connection: connectionKey(), wanted: false, transfer: null });
    const settled = (await listChannelAccounts(channelId, target)).find((item) => item.accountId === accountId);
    if (!settled) throw new Error("That was sorted out, but the runtime no longer lists the bot. Reopen Channels to see where it is.");
    return settled;
  });
}
