import type { FollowupScope } from '@hearthside/ipc-contract'

/**
 * Who can see a conversation, decided from the bindings and routes that exist
 * now — not from the historical "channels have been used here" flag.
 *
 * The flag was wrong in both directions. It blocked intentions in the main chat
 * of a companion that has no bot at all, merely because some other companion
 * once set one up; and for named conversations it trusted the current route
 * list, which cannot see a bound account that has not been pointed anywhere
 * yet. A bot bound to a companion can be paired to that companion's default
 * conversation later, without Hearthside being asked again.
 *
 * So:
 *
 * - The main (default) chat is SHARED as soon as any channel account is bound
 *   to this companion — by the owner Hearthside recorded, or by the binding the
 *   runtime itself reports. No route needs to exist yet.
 * - A named conversation is SHARED when any of this companion's routes points at
 *   it. Main aliases (`default`, `main:<agentId>`) count as the main chat.
 * - Anything unreadable is UNKNOWN, and unknown refuses. A route whose target
 *   cannot be read could be pointing anywhere, so it makes the main chat shared
 *   AND leaves named conversations unknown.
 *
 * Reads are injected so this is testable without the gateway, and so the caller
 * decides which failures are "unreadable".
 */

export type Audience = FollowupScope['audience'] | 'unknown'

export interface AudienceAccount {
  /** The companion Hearthside recorded as the owner; null when unclaimed. */
  ownerAgentId: string | null
  /**
   * The agent this runtime reports the account bound to.
   *
   * For ownership questions this is only a hint. For privacy it is decisive: the
   * inventory came from the runtime this app is talking to, so a bot it says is
   * bound to this companion can deliver messages to that companion here — even
   * when Hearthside has no ownership record for it and therefore calls it
   * unclaimed and `here: false`.
   */
  boundAgentId: string | null
  /** Belongs to the connection Hearthside is on, so it can run here. */
  here: boolean
}

export interface AudienceRoute {
  /** The conversation the route points at; empty/unknown is treated as unreadable. */
  conversationId: string
  accountId: string
}

export interface AudienceReaders {
  /** Every channel account the runtime knows, across channels. Rejects when unreadable. */
  accounts(): Promise<AudienceAccount[]>
  /** Every route for this companion, across channels. Rejects when unreadable. */
  routes(agentId: string): Promise<AudienceRoute[]>
  /** True when this id addresses the companion's main/default conversation. */
  isMainChat(conversationId: string): boolean
}

export interface AudienceDecision {
  audience: Audience
  /** Plain words for the panel and for the error a refusal raises. */
  reason: string
}

const MAIN_ALIASES = new Set(['default', ''])

/** A bot entry that cannot be read is not evidence of privacy; it refuses. */
const nullableId = (value: unknown): value is string | null => value === null || typeof value === 'string'
function validAccount(account: unknown): account is AudienceAccount {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return false
  const candidate = account as Partial<AudienceAccount>
  return nullableId(candidate.ownerAgentId) && nullableId(candidate.boundAgentId) && typeof candidate.here === 'boolean'
}

/** Does this route target the companion's main chat, whatever spelling it uses? */
function targetsMain(conversationId: string, agentId: string): boolean {
  return MAIN_ALIASES.has(conversationId) || conversationId === `main:${agentId}`
}

export async function conversationAudience(agentId: string, conversationId: string, io: AudienceReaders): Promise<AudienceDecision> {
  if (typeof agentId !== 'string' || !agentId || typeof conversationId !== 'string' || !conversationId) {
    return { audience: 'unknown', reason: 'The companion or conversation was not named.' }
  }

  let accounts: AudienceAccount[]
  try {
    accounts = await io.accounts()
  } catch {
    return { audience: 'unknown', reason: 'The list of channel bots could not be read, so this conversation\'s audience is unknown. Short-term memory stays off until it can be checked.' }
  }
  if (!Array.isArray(accounts) || !accounts.every(validAccount)) {
    return { audience: 'unknown', reason: 'The list of channel bots could not be read.' }
  }

  let routes: AudienceRoute[]
  try {
    routes = await io.routes(agentId)
  } catch {
    return { audience: 'unknown', reason: 'This companion\'s channel chats could not be read, so this conversation\'s audience is unknown. Short-term memory stays off until it can be checked.' }
  }
  if (!Array.isArray(routes)) {
    return { audience: 'unknown', reason: 'This companion\'s channel chats could not be read.' }
  }

  // A bot counts against this companion's privacy when the runtime says it is
  // bound to it — claimed or not, recorded here or not — or when Hearthside
  // recorded it as this companion's bot on this connection.
  const bound = accounts.filter(account => account.boundAgentId === agentId || (account.ownerAgentId === agentId && account.here))
  const unreadableRoute = routes.some(route => !route || typeof route.conversationId !== 'string' || route.conversationId === '')

  if (io.isMainChat(conversationId)) {
    if (bound.length) {
      return { audience: 'shared', reason: 'This companion has a Telegram or Discord bot, and its main chat is where channel messages can arrive. Use a separate chat for short-term memory.' }
    }
    if (unreadableRoute || routes.some(route => targetsMain(route.conversationId, agentId))) {
      return { audience: 'shared', reason: 'A channel chat points at this companion\'s main chat, so it is not private.' }
    }
    return { audience: 'private', reason: 'No channel bot is bound to this companion, so its main chat is private to this desktop.' }
  }

  if (unreadableRoute) {
    return { audience: 'unknown', reason: 'A channel chat does not say which conversation it uses, so this one cannot be shown to be private.' }
  }
  if (routes.some(route => route.conversationId === conversationId)) {
    return { audience: 'shared', reason: 'This conversation receives Telegram or Discord messages.' }
  }
  return { audience: 'private', reason: 'This conversation is private to this desktop app.' }
}

/** The refusal text used wherever a non-private scope is rejected. */
export function audienceRefusal(decision: AudienceDecision): string {
  return `Short-term memory needs a private desktop conversation. ${decision.reason}`
}
