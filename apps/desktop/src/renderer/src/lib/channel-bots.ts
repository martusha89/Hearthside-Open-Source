import type { ChannelAccount, ChannelPairing } from "@hearthside/ipc-contract";



export type ChannelBotGroups = {
  /** This companion's, on this connection: the ones it can change. */
  mine: ChannelAccount[];
  /** Nobody's yet — from before bots belonged to companions. Held off until claimed. */
  unclaimed: ChannelAccount[];
  /** This companion's, but set up for another connection, so not changeable here. */
  elsewhere: ChannelAccount[];
  /** Other companions': shown so they can be recognised and moved, not changed. */
  others: ChannelAccount[];
};

export function groupChannelBots(accounts: ChannelAccount[] | null, viewer: string): ChannelBotGroups {
  const groups: ChannelBotGroups = { mine: [], unclaimed: [], elsewhere: [], others: [] };
  if (!accounts || !viewer) return groups;
  for (const account of accounts) {
    if (account.unclaimed) groups.unclaimed.push(account);
    else if (account.ownerAgentId !== viewer) groups.others.push(account);
    else if (account.here) groups.mine.push(account);
    else groups.elsewhere.push(account);
  }
  return groups;
}

/**
 * The approval requests that really are this companion's to answer: ones waiting
 * on a bot it owns here. A request belongs to the bot it arrived at, so it is
 * only ever offered to that bot's owner — checked in the main process, and
 * checked again against what is on screen so a late reply can't put one
 * companion's requests under another's name.
 */
export function pairingsForOwnBots(pairings: ChannelPairing[], mine: ChannelAccount[]): ChannelPairing[] {
  const owned = new Set(mine.map((account) => account.accountId));
  return pairings.filter((pairing) => owned.has(pairing.accountId));
}

/**
 * Whether the channel service has just come up, going by the state the window
 * last saw and the one it sees now. That is the moment to ask for the bots
 * again: whatever the page was showing was fetched (or failed to be fetched)
 * while the service was starting, stopped or blocked.
 *
 * Only a change counts. A service that was already running when the page opened
 * has just been asked by the page opening.
 */
export function channelServiceCameUp(previous: string | null, next: string | null): boolean {
  return next === "running" && previous !== "running";
}
