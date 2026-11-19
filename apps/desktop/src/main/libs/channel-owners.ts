import type { AgentSummary } from "@hearthside/ipc-contract";
import { gatewayRequest as request } from "./channel-gateway";
import { type ChannelBotRecord, channelBot, channelBots, connectionKey, connectionLabel, setChannelBot } from "./settings";
import { channelPermissionPatch } from "./channel-permission";
import { withBot, withoutBotContext } from "./channel-locks";




const SHOWN = ["telegram", "discord"];
type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

export type BotDecision = "start" | "park" | "leave";

/**
 * What to do with a bot on the current connection.
 *
 * A bot runs only when it belongs to this connection AND a companion owns it
 * here. Anything else is held: parked when it is enabled or running, otherwise
 * left as it is. An unclaimed bot is never recorded as wanted, so nothing can
 * switch it back on by itself before someone claims it.
 */
export function decideBot(record: ChannelBotRecord | null, current: string, enabled: boolean, running: boolean): { decision: BotDecision; record: ChannelBotRecord } {
  // Copied, never the caller's object: `channelBot()` hands back a live
  // reference into the memoised settings, so changing it here would also change
  // what the caller compares against and the change would never be saved.
  const known: ChannelBotRecord = record ? { ...record } : { connection: null, owner: "hearthside", wanted: false };
  const here = known.connection === current;
  if (!here || !known.agentId) {
    // Known elsewhere: still wanted there, so it runs again on that connection.
    // Unclaimed: not wanted anywhere until a person says whose it is.
    const wanted = known.agentId ? known.wanted || enabled : false;
    return { decision: enabled || running ? "park" : "leave", record: { ...known, wanted } };
  }
  return { decision: known.wanted && !running ? "start" : "leave", record: known };
}

/**
 * The agent a bot is bound to, as the runtime reports it. Telegram nests it
 * (`config.binding.agent_id`); Discord keeps it flat (`config.agent_id`). Both
 * shapes are read here — `backup/channel-inventory.ts` has the same reading as
 * `channelBinding`, kept separate because recovery must throw on a missing
 * config rather than treat it as "no owner".
 *
 * This is a suggestion, never an owner. For Telegram the runtime fills an
 * absent account binding from the bot's FIRST ENABLED ROUTE
 * (`toAccountSnapshot` at pin 0.34.8), so on a bot from before this change it
 * can report whichever companion happens to have a chat on it — including one
 * left there by approving from the wrong page. Only a person may turn it into
 * an owner.
 */
export function boundAgentId(account: Wire): string {
  const config = account.config as Wire | undefined;
  const nested = (config?.binding ?? account.binding) as Wire | undefined;
  if (nested && typeof nested === "object") return str(nested.agent_id);
  return str(config?.agent_id ?? account.agent_id);
}

/** Who owns a bot, and whether that is recorded or still only the runtime's binding. */
export type BotOwner = {
  accountId: string;
  /** The recorded owner; null when this bot has not been claimed yet. */
  agentId: string | null;
  connection: string | null;
  /** The bot belongs to the connection Hearthside is on, so it may run here. */
  here: boolean;
  /**
   * The record is one Hearthside wrote for itself.
   *
   * `here` is a connection match and nothing more, so on its own it cannot tell
   * this app's own bot from a record another Letta app left in the same file for
   * the same connection. Anything that has to prove *this* app serves a bot needs
   * both, which is why `channel-permission.ts` has always asked for the pair.
   */
  hearthsideOwned: boolean;
  /** A move to another companion that did not finish, so the bot is held. */
  transfer: NonNullable<ChannelBotRecord["transfer"]> | null;
};

export function botOwner(accountId: string): BotOwner {
  const record = channelBot(accountId);
  return {
    accountId,
    agentId: record?.agentId ?? null,
    connection: record?.connection ?? null,
    here: record !== null && record.connection === connectionKey(),
    hearthsideOwned: record?.owner === "hearthside",
    transfer: record?.transfer ?? null,
  };
}

/** Bots this companion owns on the current connection, ready to be acted on. */
export function botsOwnedBy(agentId: string): string[] {
  if (!agentId) return [];
  const current = connectionKey();
  return Object.entries(channelBots())
    .filter(([, record]) => record.connection === current && record.agentId === agentId && !record.transfer)
    .map(([accountId]) => accountId);
}

/**
 * The gate every channel mutation goes through in the main process. The
 * renderer decides what to show; this decides what may be changed, so a
 * request naming another companion's bot is refused however it was made.
 *
 * The connection is checked as well as the companion. The same agent id can
 * exist on two backends, and a bot recorded for Letta Cloud must not be
 * changed from a local session that happens to have an agent of that id.
 */
export function assertBotOwnedBy(accountId: string, agentId: string, action = "change"): void {
  if (!agentId) throw new Error("No companion was named for this change.");
  const owner = botOwner(accountId);
  if (!owner.agentId) {
    throw new Error("This bot isn't assigned to a companion yet. Claim it first, then you can change it.");
  }
  // Said before "belongs to someone else": during an unfinished move the bot is
  // recorded against the companion it was going to, so the companion it came
  // from would otherwise be told it was never theirs.
  if (owner.transfer) throw new Error(unfinishedMoveMessage());
  // A bot from another connection belongs to a companion that isn't in this
  // list at all, so "open that companion's channels" sent the person nowhere.
  // Say where it lives first.
  if (!owner.here && owner.connection !== null) throw new Error(elsewhereMessage(owner.connection));
  if (owner.agentId !== agentId) {
    throw new Error(`This bot belongs to another companion, so it can't ${action} from here. Open that companion's channels to change it, or reassign the bot.`);
  }
  if (!owner.here) throw new Error(elsewhereMessage(owner.connection));
}

/** Plain words for a bot that can't run because its connection isn't the current one. */
export function elsewhereMessage(connection: string | null): string {
  const there = connectionLabel(connection);
  const here = connectionLabel(connectionKey());
  // One bot answers in one place. Without the second sentence this was a dead
  // end: every way of bringing the bot over was refused with no way named.
  return `This bot is set up for ${there}; it runs when Hearthside is connected there. To use it on ${here} instead, connect to ${there}, remove the bot from its companion's channels, then come back and add it here.`;
}

/** Plain words for a bot whose move to another companion stopped half way. */
export function unfinishedMoveMessage(): string {
  return "This bot was being moved to another companion and the move didn't finish, so it's switched off. Finish the move, or undo it, before changing anything else here.";
}

/**
 * Record a companion as a bot's owner, keeping the rest of the record.
 *
 * The connection is part of the owner, so it is always written: spreading the
 * existing record last used to let a stale `connection` (including null)
 * survive a claim, which is how an owner could end up recorded against no
 * connection at all. Pass `connection` in `extra` to set it deliberately — the
 * recovery handover does, because it restores a snapshot rather than claiming
 * something here.
 */
export function setBotOwner(accountId: string, agentId: string, extra: Partial<ChannelBotRecord> = {}): void {
  const record = channelBot(accountId);
  setChannelBot(accountId, {
    owner: "hearthside",
    wanted: record?.wanted ?? false,
    ...record,
    connection: connectionKey(),
    ...extra,
    agentId,
  });
}

/** Why a bot is being held, for the log. */
function describeHold(record: ChannelBotRecord, current: string, reason: HoldReason): string {
  if (reason === "transfer") return "was being moved to another companion and the move didn't finish";
  if (reason === "mismatch") return "is bound in the runtime to a companion that isn't its recorded owner";
  if (reason === "owner-missing") return "is owned by a companion that isn't on this connection";
  if (record.connection !== current) return `is for ${record.connection ?? "another connection"}`;
  return "isn't assigned to a companion yet";
}

type HoldReason = "transfer" | "mismatch" | "owner-missing" | "none";

/**
 * Run once the channel service is up: start what belongs here, hold the rest.
 *
 * Nothing is claimed here. A bot with no recorded companion stays unclaimed and
 * off, however the runtime has it bound — the binding is offered to the person
 * as a suggestion in Channels (see `boundAgentId`, which on Telegram can report
 * an agent taken from a stray route), and only a person's claim makes an owner.
 *
 * A claimed bot is also checked against the runtime: if the runtime has it
 * bound to someone else, Hearthside's record and what actually routes messages
 * disagree, so the bot is held and the disagreement logged rather than started
 * on a guess. The same goes for a bot whose owner isn't on this connection, and
 * for one whose move to another companion didn't finish — and holding wins over
 * any other decision, so such a bot is never left running.
 */
export async function reconcileBotOwners(listAgents: () => Promise<AgentSummary[]>): Promise<void> {
  const current = connectionKey();
  // This pass decides afresh what starts, so anything still waiting to be
  // tried again from an earlier one is dropped rather than run alongside it.
  cancelStartRetries();
  // Null means the companions could not be listed at all. A connection that is
  // briefly unreachable must not be read as "every companion was deleted", so
  // on failure no bot is held for a missing owner and no record is rewritten.
  let agents: Set<string> | null = null;
  let listingFailed = false;
  const knownAgents = async (): Promise<Set<string> | null> => {
    if (agents === null && !listingFailed) {
      try {
        agents = new Set((await listAgents()).map((agent: AgentSummary) => agent.id));
      } catch (error) {
        listingFailed = true;
        console.warn(`[channels] couldn't list companions, so no bot is held for a missing owner: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return agents;
  };
  for (const channelId of SHOWN) {
    const reply = await request<{ accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId }).catch(() => ({ accounts: [] as Wire[] }));
    for (const account of reply.accounts ?? []) {
      const accountId = str(account.account_id);
      if (!accountId) continue;
      // One bot at a time, in the queue every other change to it uses: start-up
      // overlaps with whatever the window is already doing (a claim, a move) and
      // with the Discord maintenance pass, neither of which it should interleave
      // with. Held for one bot only, so the rest of start-up isn't delayed.
      await withBot(accountId, async () => {
        if (connectionKey() !== current) return;
        // The discovery snapshot can predate a move that held this queue.
        // Decide from the binding that exists after that move, not before it.
        const fresh = await request<{ accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
        const matches = fresh.accounts?.filter((item) => str(item.account_id) === accountId);
        if (connectionKey() !== current || matches?.length !== 1) return;
        await reconcileOneBot(channelId, matches[0]!, accountId, current, knownAgents);
      });
    }
  }
}

/** One bot's share of the work above, inside that bot's own queue. */
async function reconcileOneBot(
  channelId: string,
  account: Wire,
  accountId: string,
  current: string,
  knownAgents: () => Promise<Set<string> | null>,
): Promise<void> {
  const stored = channelBot(accountId);
  const enabled = account.enabled === true;
  const running = account.running === true;
  const { decision, record: next } = decideBot(stored, current, enabled, running);
  const bound = boundAgentId(account);
  // Only a POSITIVE disagreement counts. A bot the runtime reports with no
  // binding at all routes nowhere, which is no risk to another companion,
  // and treating "not reported" as a disagreement would hold every bot.
  const mismatch = Boolean(next.agentId) && bound !== "" && bound !== next.agentId;
  const known = next.connection === current && next.agentId ? await knownAgents() : null;
  const ownerMissing = known !== null && !known.has(next.agentId ?? "");
  const reason: HoldReason = next.transfer ? "transfer" : mismatch ? "mismatch" : ownerMissing ? "owner-missing" : "none";
  if (reason !== "none") next.wanted = false;
  // Holding overrides the decision, including "leave": a bot in one of these
  // states must not be left running while Hearthside works out what it is.
  const effective: BotDecision = reason === "none" ? decision : enabled || running ? "park" : "leave";
  if (connectionKey() !== current) return;
  if (!stored || next.connection !== stored.connection || next.wanted !== stored.wanted || next.agentId !== stored.agentId) setChannelBot(accountId, next);
  const name = str(account.display_name) || accountId;
  try {
    if (effective === "park") {
      console.log(`[channels] ${channelId} bot ${name} ${describeHold(next, current, reason)}; parked here`);
      await request<Wire>("channel_account_stop", { channel_id: channelId, account_id: accountId }).catch(() => undefined);
      await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: false } });
    } else if (effective === "start") {
      // The chosen permission mode is stated BEFORE the bot is switched on, in
      // the same call that switches it on, because the account's own stored mode
      // is what a channel reply runs at (see channel-permission.ts). The service
      // may still be holding the mode from before the person last changed it —
      // they changed it while it was down — so it is restated even when the
      // account is already enabled.
      //
      // Not caught: if the mode can't be stated, the bot stays off rather than
      // starting to answer under the mode it had before. It is still recorded as
      // wanted, so it starts the next time this runs.
      const patch: Wire = { ...(enabled ? {} : { enabled: true }), ...channelPermissionPatch(channelId) };
      if (Object.keys(patch).length > 0) await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch });
      await request<Wire>("channel_account_start", { channel_id: channelId, account_id: accountId });
    } else if (reason !== "none") {
      console.log(`[channels] ${channelId} bot ${name} ${describeHold(next, current, reason)}; already off`);
    }
  } catch (error) {
    console.warn(`[channels] couldn't ${effective} ${channelId} bot ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
    // A wanted bot that didn't start is tried again (see scheduleStartRetry).
    if (effective === "start") scheduleStartRetry(channelId, accountId, current, 0, error);
  }
}

// --- Trying a wanted bot again ------------------------------------------------
//
// Start-up used to try each wanted bot exactly once. Hearthside often starts at
// login, before the network is up, and Telegram or Discord can simply be
// unreachable for a minute: the one attempt failed, the runtime switched the
// account off as it does after any failed start, and the bot stayed off for the
// whole session while the service line read "running". Only pressing Start, or
// restarting Hearthside, brought it back.
//
// So a failed start is tried again, with growing gaps, for as long as the bot is
// still wanted here. Every attempt goes through the bot's own queue and reads
// its record again first, so a bot that has meanwhile been stopped, moved,
// removed or parked is left alone. A refused token is not retried: trying again
// can't fix it, and the person has to.

const START_RETRY_MS = [30_000, 60_000, 120_000, 300_000];
const startRetries = new Map<string, NodeJS.Timeout>();

/** Drop every start that is waiting to be tried again. */
export function cancelStartRetries(): void {
  for (const timer of startRetries.values()) clearTimeout(timer);
  startRetries.clear();
}

/** A failure that trying again cannot fix: the bot's own credentials or setup were refused. */
function startCannotSucceed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /401|unauthori[sz]ed|invalid token|TokenInvalid|disallowed intents|privileged intent|missing a (bot )?token|not configured|was not found/i.test(message);
}

function scheduleStartRetry(channelId: string, accountId: string, current: string, attempt: number, error: unknown): void {
  const pending = startRetries.get(accountId);
  if (pending) clearTimeout(pending);
  startRetries.delete(accountId);
  if (startCannotSucceed(error)) return;
  const delay = START_RETRY_MS[Math.min(attempt, START_RETRY_MS.length - 1)]!;
  const timer = setTimeout(() => {
    if (startRetries.get(accountId) !== timer) return;
    startRetries.delete(accountId);
    // A timer is nobody's nested operation: it waits its turn like any other caller.
    void withoutBotContext(() => retryStart(channelId, accountId, current)).catch((failure: unknown) => {
      console.warn(`[channels] couldn't start ${channelId} bot ${accountId}, will try again: ${failure instanceof Error ? failure.message : String(failure)}`);
      scheduleStartRetry(channelId, accountId, current, attempt + 1, failure);
    });
  }, delay);
  // Waiting to retry a bot must not keep Hearthside from closing.
  timer.unref?.();
  startRetries.set(accountId, timer);
}

/** One more attempt at starting a wanted bot. Resolves when it is running or no longer this pass's to start. */
async function retryStart(channelId: string, accountId: string, current: string): Promise<void> {
  await withBot(accountId, async () => {
    // Everything that made this bot startable is read again: the attempt was
    // decided on a record from before the wait.
    const record = channelBot(accountId);
    if (connectionKey() !== current || !record || record.connection !== current || !record.agentId || !record.wanted || record.transfer) return;
    const fresh = await request<{ accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
    const matches = (fresh.accounts ?? []).filter((item) => str(item.account_id) === accountId);
    // Removed meanwhile, or already running (the person pressed Start): nothing to do.
    if (matches.length !== 1 || matches[0]!.running === true) return;
    // The same disagreement start-up holds a bot for: never start on a guess.
    const bound = boundAgentId(matches[0]!);
    if (bound !== "" && bound !== record.agentId) return;
    if (connectionKey() !== current) return;
    // Switched on with the chosen permission mode stated in the same call, as
    // at start-up: the failed attempt left the account switched off.
    await request<Wire>("channel_account_update", { channel_id: channelId, account_id: accountId, patch: { enabled: true, ...channelPermissionPatch(channelId) } });
    await request<Wire>("channel_account_start", { channel_id: channelId, account_id: accountId });
    console.log(`[channels] ${channelId} bot ${accountId} started on a later attempt`);
  });
}
