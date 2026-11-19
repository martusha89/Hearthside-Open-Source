import type { ChannelGatewayDelivery } from "@letta-ai/letta-code/gateway-core";
import { gatewayRequest as request, gatewayWanted } from "./channel-gateway";
import { withBot } from "./channel-locks";
import { channelBot, channelBots, connectionKey, getPermissionMode } from "./settings";




/** Channels whose account takes a permission mode at the pinned runtime. */
const MODE_CHANNELS = ["discord"];

/**
 * The modes a channel reply can run at, taken from the pinned runtime's own
 * delivery type rather than written out again here: a pin that narrows or
 * renames them stops compiling instead of sending something it refuses.
 */
export type ChannelPermissionMode = NonNullable<ChannelGatewayDelivery["defaultPermissionMode"]>;

/**
 * The only modes a channel account accepts. Hearthside's own `PermissionMode`
 * also has "strict", which the runtime refuses here — a patch naming it fails
 * the whole account update and leaves the previous mode in place, so it must
 * never be sent.
 */
const CHANNEL_MODES: ChannelPermissionMode[] = ["standard", "acceptEdits", "unrestricted"];

/**
 * Hearthside's chosen mode as a channel account states it, failing closed.
 *
 * Anything that is not exactly one of the three — "strict", a mode a later
 * Hearthside adds, or a settings file someone edited by hand — becomes
 * "standard", which asks. Unrestricted is only ever the result of that exact
 * choice being read back.
 */
export function channelPermissionMode(mode: unknown): ChannelPermissionMode {
  return CHANNEL_MODES.find((known) => known === mode) ?? "standard";
}

export function takesChannelPermissionMode(channelId: string): boolean {
  return MODE_CHANNELS.includes(channelId);
}

/**
 * The account settings that state the current mode, for a channel that takes
 * one. Empty for every other channel, so nothing unsupported is ever sent.
 *
 * Merged into the account settings of a bot Hearthside is about to have answer
 * here (set up, started, moved), so a bot never starts answering under a mode
 * left behind by an earlier choice or an earlier owner.
 */
export function channelPermissionConfig(channelId: string): Record<string, unknown> {
  if (!takesChannelPermissionMode(channelId)) return {};
  return { default_permission_mode: channelPermissionMode(getPermissionMode()) };
}

/**
 * The same thing as a piece of an account PATCH, for the calls that switch a
 * bot on to answer here. Empty for a channel that takes no mode, so such a
 * patch carries no `config` at all.
 */
export function channelPermissionPatch(channelId: string): { config?: Record<string, unknown> } {
  const config = channelPermissionConfig(channelId);
  return Object.keys(config).length > 0 ? { config } : {};
}

type Wire = Record<string, unknown>;



function ownedHere(accountId: string, account: Wire): boolean {
  const record = channelBot(accountId);
  if (!record || record.owner !== "hearthside") return false;
  if (record.connection !== connectionKey() || !record.agentId || record.transfer) return false;
  return record.wanted || answeringFor(account, record.agentId);
}

/**
 * The service reports this bot as answering Discord, bound to `agentId`.
 *
 * `running` is the live adapter's own answer and the flat `config.agent_id` is
 * how a Discord account states its binding — both pinned against the runtime in
 * channel-permission-contract.test.ts, so a pin that moves them fails there
 * instead of quietly making this always false. Read here rather than through
 * `boundAgentId` because channel-owners.ts imports this module; Discord is the
 * only channel that takes a mode and it keeps its binding flat.
 */
function answeringFor(account: Wire, agentId: string): boolean {
  if (account.running !== true) return false;
  const config = account.config && typeof account.config === "object" && !Array.isArray(account.config) ? account.config as Wire : {};
  return typeof config.agent_id === "string" && config.agent_id === agentId;
}

/**
 * This bot as the service reports it now, for deciding on one it doesn't want.
 *
 * The listed snapshot was taken before this bot's queue came free, and what
 * happened in that queue is exactly what matters: a move that re-bound it, a
 * claim, someone switching it off. Reconciliation re-reads for the same reason.
 * Asked only for a bot our record doesn't want, so the ordinary pass makes no
 * extra call; an answer that doesn't name this bot exactly once changes nothing.
 */
async function answeringAccount(channelId: string, accountId: string): Promise<Wire | null> {
  const reply = await request<{ accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
  const matches = (reply.accounts ?? []).filter((item) => Boolean(item) && typeof item === "object" && item.account_id === accountId);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Tell the channel service the mode the person has chosen, for every bot of
 * ours that answers here.
 *
 * Called when the choice changes and when the channel service comes up (a
 * restart, a reconnect, a recovered lease), so a service that missed a change
 * is told as soon as it can hear it.
 *
 * Fails closed by doing nothing it cannot do safely: the service is never
 * started just to say this, an account list that cannot be read changes
 * nothing, and one bot refusing the change does not stop the others.
 *
 * The mode is read at the moment of each write, never snapshotted here. Two of
 * these can be in flight at once — someone chooses YOLO and goes back to "Ask
 * first" while the first account list is still being read — and the queues mean
 * the writes can happen in the other order. Whichever runs last then writes the
 * choice that is current, so the two agree instead of the older call reinstating
 * YOLO after it was taken away.
 */
export async function applyChannelPermissionMode(): Promise<void> {
  // Never start the channel service for this. Nothing is answering channel
  // messages while it is down, and the gateway-ready listener says it again.
  if (!gatewayWanted()) return;
  const current = connectionKey();
  const known = channelBots();
  for (const channelId of MODE_CHANNELS) {
    // Which accounts are on this channel is the service's to say: Hearthside's
    // own records are keyed by account alone and don't name the channel. An
    // unreadable list is not "no bots": nothing is changed and it is said.
    let accounts: Array<Record<string, unknown>>;
    try {
      const reply = await request<{ accounts?: Array<Record<string, unknown>> }>("channel_accounts_list", { channel_id: channelId });
      if (!Array.isArray(reply.accounts)) throw new Error("the runtime didn't list the accounts");
      accounts = reply.accounts;
    } catch (error) {
      console.warn(`[channels] couldn't read which ${channelId} bots are here, so none was told the permission mode: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const account of accounts) {
      const accountId = typeof account.account_id === "string" ? account.account_id : "";
      if (!accountId || !known[accountId]) continue;
      try {
        // One bot at a time, in the queue its other changes use: a claim or a
        // move must not have the mode written into the middle of it, and the
        // checks have to hold at the moment of the write — including the choice
        // itself, which may have changed while this waited for the queue.
        await withBot(accountId, async () => {
          if (connectionKey() !== current || !gatewayWanted()) return;
          // A bot our record doesn't want is governed only on what the service
          // says about it NOW, so that one is read again inside its queue.
          const observed = channelBot(accountId)?.wanted === true ? account : await answeringAccount(channelId, accountId);
          if (!observed || connectionKey() !== current || !ownedHere(accountId, observed) || !gatewayWanted()) return;
          await request("channel_account_update", {
            channel_id: channelId,
            account_id: accountId,
            patch: channelPermissionPatch(channelId),
          });
        });
      } catch (error) {
        console.warn(`[channels] ${channelId} bot ${accountId} wasn't told the permission mode: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
