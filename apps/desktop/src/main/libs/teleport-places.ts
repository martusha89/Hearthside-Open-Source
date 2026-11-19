import type { ExecutionComputer, ExecutionPlace } from "@hearthside/ipc-contract";

export const CLOUD_PLACE_ID = "cloud";
export const THIS_PC_PLACE_ID = "this-pc";
export const COMPUTER_PLACE_PREFIX = "computer:";
/** Hearthside itself runs the next message. Not a destination Letta knows about. */
export const APP_PLACE_ID = "app";
/** Keep the conversation where it is already running. Nothing is moved. */
export const FOLLOW_PLACE_ID = "follow";

export function computerPlaceId(deviceId: string): string {
  return `${COMPUTER_PLACE_PREFIX}${deviceId}`;
}

/** The device ID behind a place ID, or null when the place is not a computer. */
export function placeDeviceId(placeId: string): string | null {
  return placeId.startsWith(COMPUTER_PLACE_PREFIX) ? placeId.slice(COMPUTER_PLACE_PREFIX.length) || null : null;
}

/** The explicitly chosen, verified destination of a conversation's next message. */
export type PlacesDestination = { kind: "this-pc" | "cloud" | "computer"; deviceId?: string };

export type PlacesInput = {
  computers: ExecutionComputer[];
  /** This computer's registered listener, when Remote Access is opted in and online. */
  listener: { deviceId: string; name: string } | null;
  /**
   * Fresh connection ID the conversation is observed running on, if any.
   *
   * The caller owes this freshness: only a verified current observation belongs
   * here. A cached one would make an idle conversation look busy, which is the
   * one thing the picker must never say — see `ExecutionPlace.current`.
   */
  observedConnectionId: string | null;
  /** Device ID the observed connection belongs to, when known. */
  observedDeviceId: string | null;
  /** Whether a Cloud sandbox is where this conversation currently runs. */
  observedIsCloud: boolean;
  /** Where the next message goes, when this conversation has recorded one. */
  destination: PlacesDestination | null;
  backendIsCloud: boolean;
  /** An unsaved conversation has no identity to move. */
  conversationIsNew: boolean;
  /**
   * Letta refuses to move a conversation that an enabled outbound channel route
   * is bound to, because the channel cannot follow it. Verbatim reason, or null.
   */
  channelRefusal: string | null;
  /**
   * Whether Letta names a verified live listener for this conversation now.
   *
   * Freshly read, like `observedConnectionId`, and independent of it: an owner
   * can be verified live without this app being able to say *which* computer it
   * is. That is precisely when "continue where it's running" is the only honest
   * offer, so it is driven from this rather than from a named place.
   */
  ownerIsLive: boolean;
  /**
   * Why this app cannot host the conversation's turns itself, or null when it
   * can. Channel compatibility belongs here: see `appLocalChannelRefusal`.
   */
  appLocalRefusal: string | null;
  /** Work this app is still holding for the chat, which continuing must wait for. */
  heldHere: boolean;
  /** Whether this conversation's recorded, consented destination is this app. */
  appLocalSelected: boolean;
  /** Whether this conversation has consented to continue wherever it runs. */
  followSelected: boolean;
};

/**
 * The places a conversation can be moved to, each carrying its own refusal.
 *
 * Refusals are returned rather than filtered out. A place that silently
 * disappears tells the person nothing; a place that says "Discord is connected
 * to this chat, so it can't move" tells them what to change. Letta's own
 * channel guard is re-checked authoritatively on the source, so this is a
 * courtesy ahead of the request, never a substitute for it — and never a way
 * around it.
 *
 * `current` and `selectedDestination` are kept apart deliberately. The first is
 * verified evidence that work is happening at a place; the second is only where
 * the next message is addressed. An idle conversation has the second and not the
 * first, and that is the ordinary state of a chat between messages.
 *
 * Two of the entries move nothing, and the channel refusal does not reach them:
 * continuing a conversation where it already runs, and running it in this app.
 * Neither asks a channel to follow the chat anywhere, which is the whole of what
 * Letta's guard is about — so each is held to its own check instead (a verified
 * live owner; a channel whose bot this app actually serves), and the guard stays
 * exactly where it was for Cloud and for every other computer. Without them a
 * channel-bound chat had no selectable entry at all, and the composer refused
 * every send for want of the destination the picker would not let anyone choose.
 */
export function executionPlaces(input: PlacesInput): ExecutionPlace[] {
  const blanket = blanketRefusal(input);
  const places: ExecutionPlace[] = [];
  const destination = input.destination;

  // Nothing at all can be placed: there is no conversation yet, or this backend
  // does not have the concept. Neither non-moving entry means anything then.
  const placeable = input.backendIsCloud && !input.conversationIsNew;

  // Continuing is offered only while something really is running. Offering it
  // against an idle chat would be an affordance for work that does not exist.
  if (placeable && input.ownerIsLive) {
    places.push(place({
      id: FOLLOW_PLACE_ID,
      kind: "follow",
      name: "Continue where it's running",
      online: true,
      // Choosing this is an action, not a location; the location is whichever
      // place says `current`, when this app can name it at all.
      current: false,
      selectedDestination: input.followSelected,
      blanket: null,
      refusal: input.heldHere
        ? "This chat is still working here. Wait for it to finish, then choose again."
        : null,
    }));
  }

  if (placeable) {
    places.push(place({
      id: APP_PLACE_ID,
      kind: "app",
      name: "Run in this app",
      online: true,
      // The desktop app-server is never *observed* as a location: its connection
      // identity is the non-unique string "app-server". Consent is what this
      // entry reflects, which is `selectedDestination`.
      current: false,
      selectedDestination: input.appLocalSelected,
      blanket: null,
      refusal: input.ownerIsLive
        ? "This conversation is running somewhere right now. Continue it there, or wait until it finishes."
        : input.appLocalRefusal,
    }));
  }

  // This computer, meaning its registered listener. The desktop app itself can
  // never be a destination: its connection identity is the non-unique string
  // "app-server", and a move is addressed by registered connection ID.
  const listener = input.listener;
  places.push(place({
    id: THIS_PC_PLACE_ID,
    kind: "this-pc",
    name: listener?.name ?? "This computer",
    online: listener !== null,
    current: listener !== null && input.observedDeviceId === listener.deviceId,
    selectedDestination: destination !== null && listener !== null
      && (destination.kind === "this-pc" || (destination.kind === "computer" && destination.deviceId === listener.deviceId)),
    blanket,
    refusal: listener === null
      ? "This computer isn't registered with Letta as a destination. Turn on Remote Access for it first."
      : null,
  }));

  places.push(place({
    id: CLOUD_PLACE_ID,
    kind: "cloud",
    name: "Letta Cloud",
    online: true,
    current: input.observedIsCloud,
    selectedDestination: destination?.kind === "cloud",
    blanket,
    refusal: null,
  }));

  for (const computer of input.computers) {
    // The listener is already offered as "this computer"; offering it twice
    // under its device name invites moving a conversation to where it is.
    if (listener && computer.deviceId === listener.deviceId) continue;
    places.push(place({
      id: computerPlaceId(computer.deviceId),
      kind: "computer",
      name: computer.name,
      online: computer.status === "online",
      current: input.observedDeviceId === computer.deviceId,
      selectedDestination: destination?.kind === "computer" && destination.deviceId === computer.deviceId,
      blanket,
      refusal: computer.status === "online"
        ? null
        : `${computer.name} is offline. Start its Letta listener, then move the conversation.`,
    }));
  }

  return places;
}

/** A reason no place at all can accept this conversation. */
function blanketRefusal(input: PlacesInput): string | null {
  if (input.channelRefusal) return input.channelRefusal;
  if (!input.backendIsCloud) return "Moving a conversation while it runs needs Letta Cloud.";
  if (input.conversationIsNew) return "Send a message first; there's no conversation to move yet.";
  return null;
}

function place(input: {
  id: string; kind: ExecutionPlace["kind"]; name: string; online: boolean; current: boolean;
  selectedDestination: boolean; blanket: string | null; refusal: string | null;
}): ExecutionPlace {
  const moveBlocked = input.blanket
    ?? input.refusal
    ?? (input.current ? "This conversation is already running here." : null);
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    online: input.online,
    current: input.current,
    // Choosing the recorded destination again is allowed: it re-checks that the
    // conversation is still unowned and still goes there. It is not a refusal.
    ...(input.selectedDestination ? { selectedDestination: true } : {}),
    ...(moveBlocked ? { moveBlocked } : {}),
  };
}

/**
 * The oldest listener Hearthside has read the inbound-teleport handler in.
 *
 * Not a guess: this is the version whose shipped listener bundle was read
 * directly for `expectInboundTeleport`, for the `preserve_skill_sources`
 * branch an observer attach depends on, and for the omission behaviour of
 * `mode`, `cwd` and `execution_settings`. Anything older may well work, and is
 * refused anyway — the point of the gate is that a move is only started
 * against a destination whose behaviour is known, and refusing beforehand
 * leaves the destination untouched.
 */
export const MIN_TELEPORT_LETTA_CODE = "0.34.10";

function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] | null => {
    const core = value.trim().split(/[-+]/, 1)[0] ?? "";
    const parts = core.split(".");
    if (parts.length !== 3) return null;
    const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    return numbers.some(Number.isNaN) ? null : numbers;
  };
  const left = parse(version);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Whether a computer's listener can be a native teleport destination.
 *
 * Returns the refusal to show, or null when it can. A version that is missing
 * or cannot be read is refused: "we could not tell" has to mean no here,
 * because the alternative is asking Letta to hand a live conversation to a
 * listener that may answer the attach by rewriting its own configuration.
 */
export function destinationCapability(computer: { name: string; metadata?: { lettaCodeVersion?: string } }): string | null {
  const version = computer.metadata?.lettaCodeVersion;
  const name = computer.name || "That computer";
  if (typeof version !== "string" || !version.trim()) {
    return `${name} doesn't report which version of Letta it runs, so Hearthside can't tell whether a conversation can be moved to it safely. Nothing was moved. Update its Letta listener and try again.`;
  }
  if (!versionAtLeast(version, MIN_TELEPORT_LETTA_CODE)) {
    return `${name} runs Letta ${version.trim()}, which is older than the ${MIN_TELEPORT_LETTA_CODE} Hearthside needs to move a conversation there safely. Nothing was moved. Update its Letta listener and try again.`;
  }
  return null;
}

/**
 * The refusal for a conversation an enabled channel route is bound to.
 *
 * Mirrors Letta's own guard, which blocks the move because a message channel
 * cannot follow a conversation to another computer. Hearthside's main chats are
 * exactly the conversations most likely to have a Discord or Telegram route, so
 * this is the common case rather than an edge one.
 */
export function channelBoundRefusal(routes: RouteBinding[], scopedConversationId: string, conversationId: string): string | null {
  const bound = boundChannelRoutes(routes, scopedConversationId, conversationId);
  if (bound.length === 0) return null;
  return `${channelList(bound.map((route) => route.channelId))} is connected to this chat, and can't follow it to another computer. Disconnect it first, or keep this chat here.`;
}

/** As much of a channel route as deciding where a conversation runs depends on. */
export type RouteBinding = { conversationId: string; enabled: boolean; channelId: string; accountId?: string };

/**
 * The enabled routes bound to one conversation, by the single definition of
 * "bound" that both channel checks use.
 *
 * Shared on purpose. Letta's move guard and this app's hosting check have to
 * agree about which routes apply, or a route could block relocation while the
 * app-local check never looks at it — exactly the gap that would let a chat run
 * here while its bot answers elsewhere. An empty `conversationId` counts only
 * against the `default` chat, which is the scope Hearthside's own routes use;
 * matching it against any other chat would bind every conversation at once.
 */
export function boundChannelRoutes<Route extends RouteBinding>(routes: Route[], scopedConversationId: string, conversationId: string): Route[] {
  return routes.filter((route) => route.enabled
    && (route.conversationId === scopedConversationId || route.conversationId === conversationId
      || (route.conversationId === "" && scopedConversationId === "default")));
}

/** One bot behind a channel route bound to the conversation, and who runs it. */
export type ChannelHost = {
  channelId: string;
  accountId: string;
  /** The companion the bot is assigned to, or null when it is unclaimed. */
  agentId: string | null;
  /** Whether the bot is recorded against the connection Hearthside is on now. */
  here: boolean;
  /** Whether a move of the bot to another companion is part way through. */
  transferPending: boolean;
  /**
   * Whether the record is Hearthside's own rather than another app's.
   *
   * `here` only says the record names this connection. Hearthside's bot file can
   * hold records it did not write, and a record it did not write is no evidence
   * about what this app serves — see `BotOwner.hearthsideOwned`.
   */
  hearthsideOwned: boolean;
  /**
   * The companion the channel service itself reports this bot bound to, or null
   * when it does not report one that can be read.
   *
   * In Channels this is only ever a suggestion (`boundAgentId`), because a
   * binding must never become an owner by itself. Here it is required to AGREE
   * with the recorded owner, because the binding is what actually routes an
   * inbound message: a record saying "ours" while the service routes to someone
   * else is the disagreement start-up holds a bot under, not a licence to run
   * the chat's turns here.
   */
  runtimeBinding: string | null;
  /**
   * Whether the channel service reports this exact bot enabled and answering.
   *
   * The service being up says the process is running, not that this chat's bot
   * is connected to anything — a parked or stopped bot sits inside a healthy
   * service and routes nothing.
   */
  answering: boolean;
};

/**
 * Why this app cannot host a channel-bound conversation's turns, or null.
 *
 * Not the same question as Letta's move guard, and not answered by the same
 * evidence. Letta refuses a *relocation* because a channel cannot follow a
 * conversation to another computer. Running the chat in this app relocates
 * nothing — but that is not on its own a reason it is safe, because a chat
 * whose bot is answered somewhere else would have its replies produced here and
 * its messages arriving there. So this asks the narrower question the move guard
 * never had to: is the gateway that serves this chat's channel *this* app?
 *
 * Hearthside's own channel gateway runs beside this process and the bot records
 * say which connection and companion each bot belongs to, so the question has a
 * real answer rather than an assumption. Every way of not knowing is a refusal:
 * an unread route list, unreadable bot records, a service that is not up, or a
 * bot that belongs to another companion or another connection. None of the
 * refusals asks anyone to disconnect the channel.
 *
 * The answer has to be POSITIVE, which takes two kinds of evidence and not one.
 * Hearthside's record says whose a bot is and on which connection — but a record
 * is a statement of intent, and "on this connection" is not "written by this
 * app". What actually routes an inbound message is the channel service's own
 * per-account binding. So a bot clears this only when Hearthside's own record
 * claims it for this companion on this connection AND the service reports that
 * same bot answering, bound to that same companion. Anything less — a record
 * this app did not write, a binding naming someone else, a binding that cannot
 * be read, a bot that is not answering — is a refusal, because none of them can
 * be told apart from "this chat's messages are answered somewhere else".
 */
export function appLocalChannelRefusal(input: {
  /** Whether the bound-route read actually answered. A failed read is not "none". */
  routesKnown: boolean;
  /** The enabled routes bound to this conversation. Empty means no channel at all. */
  bound: Array<{ channelId: string; accountId: string }>;
  /** Null when the hosting evidence could not be read; never an empty stand-in. */
  hosts: ChannelHost[] | null;
  /** This app's own channel service state. */
  service: "off" | "starting" | "running" | "failed" | "blocked" | "unknown";
  /** The companion that owns the conversation. */
  agentId: string;
}): string | null {
  if (!input.routesKnown) {
    return "Hearthside couldn't check which message channels this chat is connected to, so it won't decide where the chat runs. Nothing was changed. Try again in a moment.";
  }
  if (input.bound.length === 0) return null;
  const list = channelList(input.bound.map((route) => route.channelId));
  if (!input.hosts) {
    return `Hearthside couldn't check whether ${list}'s bot for this chat runs here, so it won't take the chat's turns. Nothing was changed. Try again in a moment.`;
  }
  for (const route of input.bound) {
    const host = input.hosts.find((candidate) => candidate.accountId === route.accountId);
    const name = friendlyChannel(route.channelId);
    if (!host) {
      return `Hearthside couldn't tell which companion runs ${name}'s bot for this chat, so it won't take the chat's turns. Nothing was changed. Open Channels to check that bot, then choose again.`;
    }
    if (host.transferPending) {
      return `${name}'s bot for this chat is part way through moving to another companion, so it isn't answering. Nothing was changed. Finish or undo that move in Channels, then choose again.`;
    }
    if (!host.agentId) {
      return `${name}'s bot for this chat isn't assigned to a companion, so Hearthside can't tell whether this app serves it. Nothing was changed. Claim that bot in Channels, then choose again.`;
    }
    if (host.agentId !== input.agentId) {
      return `${name}'s bot for this chat belongs to another companion, so this app isn't what answers its messages. Nothing was changed. Open that companion to change where its chat runs.`;
    }
    if (!host.here) {
      return `${name}'s bot for this chat is set up for another Hearthside connection, so this app isn't what answers its messages. Nothing was changed. Use the computer that runs that bot, or carry on in ${name}.`;
    }
    if (!host.hearthsideOwned) {
      return `Hearthside didn't record ${name}'s bot for this chat as its own, so it can't say this app is what answers its messages. Nothing was changed. Open Channels to check that bot, then choose again.`;
    }
  }
  if (input.service === "running") {
    // The service is up, so it can be asked about this chat's own bot. Only its
    // answer can make the record true: the record is what this app intends, the
    // binding is what reaches Discord.
    for (const route of input.bound) {
      const host = input.hosts.find((candidate) => candidate.accountId === route.accountId)!;
      const name = friendlyChannel(route.channelId);
      if (host.runtimeBinding !== null && host.runtimeBinding !== input.agentId) {
        return `${name}'s bot for this chat is answering for another companion, which disagrees with what Hearthside recorded for it — so this app isn't reliably what answers its messages. Nothing was changed. Open Channels to sort that bot out, then choose again.`;
      }
      // Before the switched-off message, because a bot the service never
      // reported looks switched off and isn't: "turn it on in Channels" would
      // be the wrong step for a list that simply didn't come back.
      if (host.runtimeBinding === null) {
        return `Hearthside couldn't confirm which companion ${name}'s bot for this chat is answering for, so it won't take the chat's turns. Nothing was changed. Try again in a moment.`;
      }
      if (!host.answering) {
        return `${name}'s bot for this chat isn't answering right now, so replies made here wouldn't reach ${name}. Nothing was changed. Switch that bot on in Channels, then choose again.`;
      }
    }
    return null;
  }
  if (input.service === "unknown") {
    return `Hearthside couldn't check whether ${list}'s bot for this chat is running here, so it won't take the chat's turns. Nothing was changed. Try again in a moment.`;
  }
  if (input.service === "starting") {
    return `${list}'s bot for this chat is still starting up in Hearthside. Nothing was changed. Try again in a moment.`;
  }
  return `${list} is connected to this chat, and its bot isn't running in Hearthside right now — so replies made here wouldn't reach ${list}. Nothing was changed. Start it in Channels, then choose again.`;
}

function channelList(channelIds: string[]): string {
  const names = [...new Set(channelIds.map(friendlyChannel))].sort();
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function friendlyChannel(channelId: string): string {
  switch (channelId) {
    case "discord": return "Discord";
    case "telegram": return "Telegram";
    case "slack": return "Slack";
    default: return channelId || "A message channel";
  }
}
