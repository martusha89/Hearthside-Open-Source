import { createHash, randomUUID } from "node:crypto";
import type {
  GptResetOutcome,
  GptResetRequest,
  GptUsageFailure,
  GptUsageReset,
  GptUsageResets,
  GptUsageSnapshot,
  GptUsageView,
  GptUsageWindow,
  ProviderSummary,
} from "@hearthside/ipc-contract";
import { type ControlLease, controlGeneration, requestAllowingFailure, requestAllowingFailureOn, withControlClient } from "./control.js";
import { cloudOutcome, cloudSpendAuth, consumeCloudReset, readCloudResets, readCloudUsage } from "./gpt-usage-cloud";
import {
  CHATGPT_PROVIDER_IDS,
  CHATGPT_PROVIDER_NAMES,
  chatGptConnectionEra,
  gptUsageReadings,
  readingScope,
  recordGptUsageReading,
  retireReadingScope,
} from "./gpt-usage-readings";
import { listProviders } from "./providers";
import { getConnectionConfig, getSettings } from "./settings";

/**
 * Hearthside: what a ChatGPT Plus/Pro plan has left, and the manual usage
 * resets ChatGPT has granted it.
 *
 * Everything here comes from the runtime's own ChatGPT commands
 * (`chatgpt_usage_read`, `chatgpt_rate_limit_reset_credits_list`,
 * `chatgpt_rate_limit_reset_credit_consume`), which read ChatGPT's usage
 * endpoint with the person's own sign-in — on this computer, or through their
 * Letta Cloud account. Hearthside never estimates a percentage or infers an
 * allowance from the tokens a chat has spent: a figure the plan doesn't report
 * is shown as not reported.
 *
 * Spending a reset is a one-way action on the person's real plan, so it
 * happens only through `useGptReset`, with the confirmation word and the exact
 * reset they were shown.
 */

/**
 * Wire shapes from the app server protocol (protocol_v2 in @letta-ai/letta-code).
 * Exported as types so the Cloud reader can answer in the same shapes and share
 * `readSnapshot`/`readResets` below (see gpt-usage-cloud.ts).
 */
export type WireWindow = {
  label?: unknown;
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

export type WireSnapshot = {
  providerName?: unknown;
  fetchedAt?: unknown;
  summary?: unknown;
  planType?: unknown;
  limitReached?: unknown;
  rateLimitReachedType?: unknown;
  primary?: WireWindow | null;
  secondary?: WireWindow | null;
  additional?: WireWindow[];
  individualLimit?: { limit?: unknown; used?: unknown; remainingPercent?: unknown; resetsAt?: unknown } | null;
};

export type WireCredit = {
  id?: unknown;
  resetType?: unknown;
  status?: unknown;
  grantedAt?: unknown;
  expiresAt?: unknown;
  title?: unknown;
  description?: unknown;
};

export type WireCredits = { providerName?: unknown; fetchedAt?: unknown; availableCount?: unknown; credits?: WireCredit[] };

type WireError = { code?: unknown; message?: unknown; retryAfterMs?: unknown };

type WireReply = {
  type: string;
  request_id?: string;
  success?: boolean;
  usage?: WireSnapshot;
  credits?: WireCredits;
  outcome?: unknown;
  refreshed_usage?: WireSnapshot;
  refreshed_credits?: WireCredits;
  refresh_error?: WireError;
  error?: unknown;
};

/**
 * A reading can take a while: the runtime refreshes the OAuth token and calls
 * ChatGPT, which it gives 15 seconds of its own.
 */
const READ_TIMEOUT_MS = 25_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Seconds since the epoch, as the runtime reports resets, into an ISO date-time. */
function isoFromSeconds(value: unknown): string | null {
  const seconds = finite(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromText(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function usageWindow(wire: WireWindow | null | undefined, fallbackLabel: string): GptUsageWindow | null {
  if (!wire || typeof wire !== "object") return null;
  const usedPercent = finite(wire.usedPercent);
  const windowMinutes = finite(wire.windowDurationMins);
  const resetsAt = isoFromSeconds(wire.resetsAt);
  // The runtime drops a window that reports none of the three; so does this.
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;
  return {
    label: text(wire.label) ?? fallbackLabel,
    usedPercent: usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: windowMinutes !== null && windowMinutes > 0 ? windowMinutes : null,
    resetsAt,
  };
}

/** One reading of a plan, as reported. Returns null when the frame carries no usage. */
export function readSnapshot(wire: WireSnapshot | undefined, providerName: string): GptUsageSnapshot | null {
  if (!wire || typeof wire !== "object") return null;
  const windows = [
    usageWindow(wire.primary, "primary"),
    usageWindow(wire.secondary, "secondary"),
    ...(Array.isArray(wire.additional) ? wire.additional.map((entry, index) => usageWindow(entry, `limit ${index + 1}`)) : []),
  ].filter((entry): entry is GptUsageWindow => !!entry);
  const spend = wire.individualLimit;
  const spendResetsAt = isoFromSeconds(spend?.resetsAt);
  const spendRemaining = finite(spend?.remainingPercent);
  return {
    providerName: text(wire.providerName) ?? providerName,
    fetchedAt: isoFromText(wire.fetchedAt) ?? new Date().toISOString(),
    planType: text(wire.planType),
    limitReached: flag(wire.limitReached),
    limitReachedType: text(wire.rateLimitReachedType),
    windows,
    spendLimit:
      spend && text(spend.limit) && text(spend.used) && spendRemaining !== null && spendResetsAt
        ? { limit: text(spend.limit)!, used: text(spend.used)!, remainingPercent: spendRemaining, resetsAt: spendResetsAt }
        : null,
    summary: text(wire.summary) ?? "",
  };
}

function credit(wire: WireCredit): GptUsageReset | null {
  const id = text(wire.id);
  const resetType = text(wire.resetType);
  const status = text(wire.status);
  const grantedAt = isoFromText(wire.grantedAt);
  // The runtime treats a credit missing any of these as an invalid payload.
  if (!id || !resetType || !status || !grantedAt) return null;
  return {
    id,
    resetType,
    status,
    grantedAt,
    expiresAt: isoFromText(wire.expiresAt),
    title: text(wire.title),
    description: text(wire.description),
  };
}

export function readResets(wire: WireCredits | undefined): GptUsageResets | null {
  if (!wire || typeof wire !== "object") return null;
  const availableCount = finite(wire.availableCount);
  if (availableCount === null || !Number.isInteger(availableCount) || availableCount < 0) return null;
  const credits = (Array.isArray(wire.credits) ? wire.credits : []).map(credit).filter((entry): entry is GptUsageReset => !!entry);
  return { availableCount, credits, fetchedAt: isoFromText(wire.fetchedAt) ?? new Date().toISOString() };
}

/**
 * The resets that can actually be spent now, soonest to expire first — the
 * runtime's own rule (`spendableResetCredits`), so what Hearthside offers is
 * what ChatGPT would accept.
 */
export function spendableResets(resets: GptUsageResets, now = Date.now()): GptUsageReset[] {
  return resets.credits
    .filter((reset) => reset.status === "available")
    .filter((reset) => !reset.expiresAt || Date.parse(reset.expiresAt) > now)
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));
}

function failure(wire: unknown, fallback: string): GptUsageFailure {
  const error = (typeof wire === "object" && wire ? wire : {}) as WireError;
  return {
    code: text(error.code) ?? "unknown",
    message: text(error.message) ?? fallback,
    retryAfterMs: finite(error.retryAfterMs),
  };
}

/** The ChatGPT subscription connection in the provider list, if one is connected. */
export function findChatGptConnection(providers: readonly ProviderSummary[]): { providerName: string } | null {
  for (const provider of providers) {
    const named = provider.connections.find((connection) => CHATGPT_PROVIDER_NAMES.includes(connection.name));
    if (named) return { providerName: named.name };
  }
  const entry = providers.find((provider) => CHATGPT_PROVIDER_IDS.includes(provider.id) && provider.connections.length > 0);
  const connection = entry?.connections[0];
  return connection ? { providerName: connection.name } : null;
}

type Target = "local" | "cloud";

/** Which sign-in the runtime should read: the Letta account's, or this machine's. */
function usageTarget(): Target {
  return getConnectionConfig().backend === "cloud" ? "cloud" : "local";
}

/**
 * Whose plan a reading is about, as far as Hearthside can honestly tell.
 *
 * "chatgpt-plus-pro" is a name, not an identity: the same name belongs to a
 * different plan on Letta Cloud than on this computer, and to a different one
 * again after someone signs in as somebody else. ChatGPT's usage reply carries
 * no account identifier at all, and the provider list carries only that name,
 * so there is no account identity to be had here. What there is, is four
 * discriminators, and everything is scoped by all four:
 *
 * - `target` — which sign-in is being read, this machine's or the Letta
 *   account's;
 * - `account` — the Letta connection it is being read through (the settings'
 *   connection revision, replaced whenever that connection's identity changes);
 * - `era` — how many times a ChatGPT provider has been connected or
 *   disconnected through this app (see `chatGptConnectionEra`), which is what
 *   separates one ChatGPT sign-in from the next under the same name;
 * - `generation` — the runtime socket, which moves on every reconnect.
 *
 * The limit of this is worth being plain about: a ChatGPT credential replaced
 * where this app never sees it happen — with `letta` on the command line, or by
 * somebody else on a self-hosted server Hearthside is only a client of — leaves
 * all four unchanged, and the graph would carry on as if it were the same plan.
 * Hearthside cannot detect that, and claims no more than it can.
 */
type Scope = { target: Target; account: string; era: number; generation: number };

function currentScope(): Scope {
  return {
    target: usageTarget(),
    account: getSettings().connectionRevision ?? "initial",
    era: chatGptConnectionEra(),
    generation: controlGeneration(),
  };
}

/** Non-secret identifiers, mixed and hashed so nothing identifying is handed out. */
function digest(purpose: string, ...parts: string[]): string {
  return createHash("sha256").update([purpose, ...parts].join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * The handle for one plan as read on one connection. The renderer gets it with
 * the figures and gives it back to spend a reset, which is how a view opened
 * before a sign-in change is stopped from acting on the plan connected after
 * it. It changes on reconnect, so a stale press is refused rather than guessed
 * at — the cost is pressing Try again, and the alternative is spending a
 * stranger's reset.
 */
function viewToken(scope: Scope, providerName: string): string {
  return digest("gpt-usage-view-v1", scope.target, scope.account, providerName, String(scope.era), String(scope.generation));
}

/**
 * Where this plan's kept readings live. Deliberately without the generation: a
 * reconnect to the same account continues the same graph, while another account,
 * another target, or a ChatGPT connection signed out and in again gets its own.
 */
function readingsKey(scope: Scope, providerName: string): string {
  return digest("gpt-usage-readings-v1", scope.target, scope.account, providerName, String(scope.era));
}

/** The press has to belong to the connection it was made on, every time it is checked. */
function heldScope(request: GptResetRequest): Scope {
  const scope = currentScope();
  if (viewToken(scope, request.providerName) !== request.token) {
    throw new Error("That usage view belongs to a connection that is no longer this one, so nothing was spent. Reopen usage and try again.");
  }
  return scope;
}

const CONNECTION_CHANGED: GptUsageFailure = {
  code: "connection_changed",
  message: "The connection changed while this was being read, so nothing from the one before it is shown. Try again.",
  retryAfterMs: null,
};

function sameScope(a: Scope, b: Scope): boolean {
  return a.target === b.target && a.account === b.account && a.era === b.era && a.generation === b.generation;
}

function whereText(target: Target): string {
  if (target === "cloud") return "connected to your Letta Cloud account";
  return getConnectionConfig().backend === "remote"
    ? "connected on the server Hearthside is using"
    : "connected on this computer";
}

/** One command to the runtime, answered either way. */
type Dispatch = (type: string, body: Record<string, unknown>) => Promise<WireReply | GptUsageFailure>;

function unanswered(error: unknown): GptUsageFailure {
  const message = error instanceof Error ? error.message : String(error);
  // A runtime that doesn't know the command never answers, so the wait ends
  // here rather than in a spinner. Say which, instead of guessing a cause.
  return {
    code: "no_response",
    message: /timed out/i.test(message)
      ? "The Letta runtime didn't answer the ChatGPT usage request. This Hearthside build runs letta-code 0.34.36, which supports it; an older runtime doesn't."
      : message,
    retryAfterMs: null,
  };
}

const send: Dispatch = async (type, body) => {
  try {
    return await requestAllowingFailure<WireReply>(type, body, READ_TIMEOUT_MS);
  } catch (error) {
    return unanswered(error);
  }
};

/**
 * The same, pinned to one socket: the command goes out on the connection the
 * lease was taken on or not at all. Used for the spend, where "which socket"
 * decides whose plan is charged (see `useGptReset`).
 */
const sendOn =
  (lease: ControlLease): Dispatch =>
  async (type, body) => {
    try {
      return await requestAllowingFailureOn<WireReply>(lease, type, body, READ_TIMEOUT_MS);
    } catch (error) {
      return unanswered(error);
    }
  };

function isFailure(reply: WireReply | GptUsageFailure): reply is GptUsageFailure {
  return !("type" in reply);
}

type Address = { target: "local" | "api"; provider_name?: string };

/** The command fields that say whose plan to read. */
function addressOf(target: Target, providerName: string | null): Address {
  return {
    target: target === "cloud" ? "api" : "local",
    // Cloud needs the name; locally the runtime finds its own ChatGPT record.
    ...(providerName ? { provider_name: providerName } : {}),
  };
}

/**
 * A Cloud plan is read from Letta's own API with this app's sign-in, not
 * through the runtime: the runtime's cloud reader cannot see the sign-in
 * Hearthside hands it, so every such read answered "Sign in with Letta to read
 * ChatGPT usage" however signed in the account was. gpt-usage-cloud.ts has the
 * whole account of it. Local and self-hosted targets still go through the
 * runtime, which is the only thing holding those ChatGPT credentials.
 */
async function readUsage(
  target: Target,
  providerName: string | null,
  refresh: boolean,
): Promise<{ usage: GptUsageSnapshot } | { error: GptUsageFailure }> {
  const fallbackName = providerName ?? "chatgpt-plus-pro";
  if (target === "cloud") {
    const answer = await readCloudUsage(fallbackName, refresh);
    if ("error" in answer) return answer;
    const usage = readSnapshot(answer.usage, fallbackName);
    return usage ? { usage } : { error: { code: "bad_response", message: "Letta Cloud reported no usage for this plan.", retryAfterMs: null } };
  }
  const reply = await send("chatgpt_usage_read", { ...addressOf(target, providerName), force_refresh: refresh });
  if (isFailure(reply)) return { error: reply };
  if (reply.success === false) return { error: failure(reply.error, "ChatGPT usage couldn't be read.") };
  const usage = readSnapshot(reply.usage, fallbackName);
  return usage ? { usage } : { error: { code: "bad_response", message: "The runtime reported no usage for this plan.", retryAfterMs: null } };
}

async function readCredits(
  target: Target,
  providerName: string | null,
  refresh: boolean,
  dispatch: Dispatch = send,
): Promise<{ resets: GptUsageResets } | { error: GptUsageFailure }> {
  if (target === "cloud") {
    const answer = await readCloudResets(providerName ?? "chatgpt-plus-pro", refresh);
    if ("error" in answer) return answer;
    const resets = readResets(answer.resets);
    return resets ? { resets } : { error: { code: "bad_response", message: "Letta Cloud reported no resets for this plan.", retryAfterMs: null } };
  }
  const reply = await dispatch("chatgpt_rate_limit_reset_credits_list", {
    ...addressOf(target, providerName),
    force_refresh: refresh,
  });
  if (isFailure(reply)) return { error: reply };
  if (reply.success === false) return { error: failure(reply.error, "ChatGPT resets couldn't be read.") };
  const resets = readResets(reply.credits);
  return resets
    ? { resets }
    : { error: { code: "bad_response", message: "The runtime reported no resets for this plan.", retryAfterMs: null } };
}

/**
 * The whole picture for the window: the plan's current windows, its resets, and
 * the readings this computer has kept. Usage and resets are read together and
 * each keeps its own outcome, so one being unavailable never hides the other.
 */
export async function getGptUsage(refresh = false): Promise<GptUsageView> {
  const opened = currentScope();
  const target = opened.target;
  const where = whereText(target);
  /** A view that reports no figures, for every answer that has none to report. */
  const nothing = (overrides: Partial<GptUsageView> = {}): GptUsageView => ({
    source: { target, providerName: null, where },
    connected: false,
    token: null,
    usage: null,
    usageError: null,
    resets: null,
    resetsError: null,
    readings: [],
    ...overrides,
  });

  let providers: readonly ProviderSummary[];
  try {
    providers = await listProviders();
  } catch (error) {
    // The provider list is how Hearthside knows a plan is connected at all;
    // without it, say so rather than report "not connected".
    return nothing({
      usageError: {
        code: "providers_unavailable",
        message: error instanceof Error ? error.message : "Hearthside couldn't check which plans are connected.",
        retryAfterMs: null,
      },
    });
  }
  // Signing in elsewhere, or switching backend, while this was in flight: the
  // answer is about a connection that is no longer the one on screen, so it is
  // dropped rather than shown as if it were the new one's.
  if (!sameScope(opened, currentScope())) return nothing({ usageError: CONNECTION_CHANGED });

  const connection = findChatGptConnection(providers);
  if (!connection) {
    // No plan is connected now, so whatever is read here next belongs to
    // another sign-in. Readings kept for this connection are set aside rather
    // than continued into it.
    for (const name of CHATGPT_PROVIDER_NAMES) retireReadingScope(readingsKey(opened, name));
    return nothing();
  }

  const [usage, resets] = await Promise.all([
    readUsage(target, connection.providerName, refresh),
    readCredits(target, connection.providerName, refresh),
  ]);
  if (!sameScope(opened, currentScope())) return nothing({ usageError: CONNECTION_CHANGED });

  const scope = readingScope(readingsKey(opened, connection.providerName));
  if ("usage" in usage) recordGptUsageReading(scope, usage.usage);
  return {
    source: { target, providerName: connection.providerName, where },
    connected: true,
    token: viewToken(opened, connection.providerName),
    usage: "usage" in usage ? usage.usage : null,
    usageError: "error" in usage ? usage.error : null,
    resets: "resets" in resets ? resets.resets : null,
    resetsError: "error" in resets ? resets.error : null,
    readings: gptUsageReadings(scope),
  };
}

const OUTCOMES: Record<GptResetOutcome["outcome"], { tone: GptResetOutcome["tone"]; message: string }> = {
  reset: { tone: "success", message: "The reset was applied to your ChatGPT plan. Send your message again to carry on." },
  already_redeemed: { tone: "success", message: "This reset had already been applied, so nothing more was spent." },
  nothing_to_reset: { tone: "info", message: "Your plan isn't rate limited right now, so no reset was spent." },
  no_credit: { tone: "warning", message: "ChatGPT says there are no resets left on this plan." },
};

function outcomeOf(value: unknown): GptResetOutcome["outcome"] | null {
  return typeof value === "string" && Object.hasOwn(OUTCOMES, value) ? (value as GptResetOutcome["outcome"]) : null;
}

/**
 * One spend at a time per plan on a connection, so two windows can't spend two
 * resets for one decision. Keyed by the account scope rather than the socket:
 * a reconnect in the middle of a spend must not let a second one start.
 */
const spending = new Set<string>();

/**
 * The state after a spend, and what to say about it — shared by both targets,
 * so a reset spent on Letta Cloud is reported exactly as one spent through the
 * runtime. The reading belongs to the plan that was just reset, so it is kept
 * under that connection's scope whatever has happened since, and a refresh that
 * failed is said rather than guessed at.
 */
function afterSpend(input: {
  target: Target;
  providerName: string;
  opened: Scope;
  held: string;
  outcome: GptResetOutcome["outcome"];
  usage: GptUsageSnapshot | null;
  resets: GptUsageResets | null;
  refreshFailed: GptUsageFailure | null;
  /** The resets read just before the spend, shown when fresh ones couldn't be had. */
  before: GptUsageResets;
}): GptResetOutcome {
  const scope = readingScope(input.held);
  if (input.usage) recordGptUsageReading(scope, input.usage);
  const spent = input.outcome === "reset" || input.outcome === "already_redeemed";
  const view: GptUsageView = {
    source: { target: input.target, providerName: input.providerName, where: whereText(input.target) },
    connected: true,
    token: viewToken(input.opened, input.providerName),
    usage: input.usage,
    usageError: input.usage ? null : input.refreshFailed,
    // After a spend the resets from before it are stale, so they are not shown
    // as if they still stood; an outcome that spent nothing leaves them true.
    resets: input.resets ?? (spent ? null : input.before),
    resetsError: input.resets ? null : input.refreshFailed,
    readings: gptUsageReadings(scope),
  };
  const described = OUTCOMES[input.outcome];
  return {
    outcome: input.outcome,
    tone: described.tone,
    message: input.refreshFailed ? `${described.message} (Fresh figures couldn't be read: ${input.refreshFailed.message})` : described.message,
    view,
  };
}

/**
 * Spend one reset on a Letta Cloud account, through Letta's own API.
 *
 * The runtime's socket is not what decides whose plan is charged here: the
 * Letta sign-in is. So that sign-in is resolved first and carried to the
 * request by hand, and the view's handle is checked one last time with nothing
 * awaited between the check and the send — the same property the leased socket
 * gives the runtime path below, held by the same means.
 *
 * Letta Cloud answers a spend with the outcome alone, so fresh figures are read
 * back afterwards exactly as the runtime reads them back for itself, and only
 * for the outcomes that changed anything.
 */
async function spendOnCloud(input: GptResetRequest, opened: Scope, providerName: string, held: string): Promise<GptResetOutcome> {
  const signIn = await cloudSpendAuth();
  if ("error" in signIn) throw new Error(signIn.error.message);

  // The reset pressed has to still be there, read fresh rather than from a cache.
  const current = await readCredits("cloud", providerName, true);
  if ("error" in current) throw new Error(current.error.message);
  const chosen = spendableResets(current.resets).find((reset) => reset.id === input.resetId);
  if (!chosen) throw new Error("That reset is no longer available. Reopen usage to see what's left.");

  // Reading them took time. Nothing is spent until this says the account, the
  // backend and the ChatGPT connection are still the ones that were read.
  heldScope(input);
  const reply = await consumeCloudReset({ auth: signIn.auth, providerName, resetId: chosen.id, idempotencyKey: randomUUID() });
  if ("error" in reply) throw new Error(reply.error.message);
  const outcome = outcomeOf(cloudOutcome(reply.raw));
  if (!outcome) throw new Error("Letta Cloud didn't say what happened to the reset, so nothing is being claimed.");

  // Only the outcomes that changed something are worth re-reading, which is
  // the rule the runtime applies to its own refresh.
  const refreshed =
    outcome === "reset" || outcome === "already_redeemed"
      ? await Promise.all([readUsage("cloud", providerName, true), readCredits("cloud", providerName, true)])
      : null;
  const [freshUsage, freshResets] = refreshed ?? [];
  return afterSpend({
    target: "cloud",
    providerName,
    opened,
    held,
    outcome,
    usage: freshUsage && "usage" in freshUsage ? freshUsage.usage : null,
    resets: freshResets && "resets" in freshResets ? freshResets.resets : null,
    refreshFailed: (freshUsage && "error" in freshUsage ? freshUsage.error : null) ?? (freshResets && "error" in freshResets ? freshResets.error : null),
    before: current.resets,
  });
}

/**
 * Spend one reset.
 *
 * Four things have to line up before anything leaves this machine: the
 * confirmation word from a press, the handle of the view the press was made in,
 * a reset id, and that same id still being spendable in a reading taken right
 * now. The handle is checked again after every wait — the check that matters is
 * the last one before the consume, because by then the account could have
 * changed under a confirmation that was left open. The idempotency key is
 * minted here, per press, so the runtime or ChatGPT re-delivering that one
 * request can't apply it twice.
 *
 * The last check has to be at the send itself, not before it. Opening a
 * connection is a wait of its own, so a check made before one would be a check
 * against a socket that doesn't exist yet: the connection could be re-pointed
 * while it opens and the spend would go out on a runtime nobody authorised.
 * So the whole spend runs on a leased socket — the fresh read and the consume
 * on the same client — and the lease refuses to send if the connection moved
 * (`requestAllowingFailureOn`).
 *
 * A Cloud plan is charged through Letta's own API rather than the runtime (see
 * `spendOnCloud`), where the sign-in takes the socket's place as the thing that
 * decides whose plan is charged. Everything before that point — the
 * confirmation word, the handle, the plan still being connected under the same
 * name, one spend at a time — is the same for both.
 */
export async function useGptReset(input: GptResetRequest): Promise<GptResetOutcome> {
  if (input.confirm !== "use-one-reset") throw new Error("A reset is only spent from a confirmed press.");
  const opened = heldScope(input);
  const target = opened.target;
  const connection = findChatGptConnection(await listProviders());
  heldScope(input);
  if (!connection) throw new Error("No ChatGPT plan is connected here, so there is nothing to reset.");
  if (connection.providerName !== input.providerName) {
    throw new Error("The ChatGPT connection changed while that was open. Reopen usage and try again.");
  }

  const held = readingsKey(opened, connection.providerName);
  if (spending.has(held)) {
    throw new Error("A reset for this plan is already being used. Wait for it to finish.");
  }
  spending.add(held);
  try {
    if (target === "cloud") return await spendOnCloud(input, opened, connection.providerName, held);
    return await withControlClient(async (lease) => {
      const dispatch = sendOn(lease);
      // Read the resets fresh: the one the person pressed has to still be
      // there, read on the very socket the spend will go out on.
      const current = await readCredits(target, connection.providerName, true, dispatch);
      if ("error" in current) throw new Error(current.error.message);
      const chosen = spendableResets(current.resets).find((reset) => reset.id === input.resetId);
      if (!chosen) throw new Error("That reset is no longer available. Reopen usage to see what's left.");
      // Reading them took time. Nothing is spent until this says the account,
      // the backend, the ChatGPT connection and the socket are still the ones
      // that were read, and that the socket in hand is that same one.
      // `dispatch` checks it once more as it sends, nothing awaited in between.
      const atDispatch = heldScope(input);
      if (atDispatch.generation !== lease.generation) {
        throw new Error("Hearthside reconnected while that was open, so nothing was spent. Reopen usage and try again.");
      }

      const reply = await dispatch("chatgpt_rate_limit_reset_credit_consume", {
        ...addressOf(target, connection.providerName),
        idempotency_key: randomUUID(),
        reset_id: chosen.id,
      });
      if (isFailure(reply)) throw new Error(reply.message);
      if (reply.success === false) throw new Error(failure(reply.error, "The reset couldn't be applied.").message);
      const outcome = outcomeOf(reply.outcome);
      if (!outcome) throw new Error("The runtime didn't say what happened to the reset, so nothing is being claimed.");

      // The runtime refreshes usage and resets as part of a reset it applied;
      // take its reading rather than asking ChatGPT again.
      return afterSpend({
        target,
        providerName: connection.providerName,
        opened,
        held,
        outcome,
        usage: readSnapshot(reply.refreshed_usage, connection.providerName),
        resets: readResets(reply.refreshed_credits),
        refreshFailed: reply.refresh_error ? failure(reply.refresh_error, "Usage couldn't be re-read after the reset.") : null,
        before: current.resets,
      });
    });
  } finally {
    spending.delete(held);
  }
}
