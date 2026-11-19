import { createHash } from "node:crypto";
import type { GptUsageFailure } from "@hearthside/ipc-contract";
import { cloudAuth, providerError } from "./cloud-providers";
import type { WireCredits, WireSnapshot } from "./gpt-usage";

/**
 * Hearthside: a ChatGPT plan's usage and resets on a **Letta Cloud** account,
 * read from Letta's own provider API with this app's sign-in.
 *
 * Why not the runtime, when the local target goes through it?
 *
 * The runtime's cloud reader resolves its Letta credential from
 * `LETTA_API_KEY` in its environment, the same key in its settings file, or a
 * refresh token in that file (`resolveCloudApiKey` in letta-code 0.34.36).
 * Hearthside owns the OAuth grant itself and hands the runtime short-lived
 * access tokens over the desktop-credentials IPC channel instead — and that
 * resolver, unlike the one the ordinary API client uses, never looks at them.
 * Both processes also delete `LETTA_API_KEY` from the environment when that
 * channel is in use. So all three of its sources are empty on a correctly
 * signed-in Cloud account, and every `chatgpt_usage_read` with `target: "api"`
 * came back "Sign in with Letta to read ChatGPT usage" (Hearthside 0.1.25).
 *
 * Nothing Hearthside can pass the runtime fixes that: the environment variable
 * is deleted again at startup, and writing the token into the runtime's
 * settings file would put a bearer token on disk in plain text, outside
 * safeStorage, where it would also go stale within the hour.
 *
 * So Cloud reads the same endpoints the runtime would have called, over the
 * same Letta Cloud API this app already uses for the provider list itself
 * (`cloud-providers.ts`), with the credential this app legitimately holds. The
 * token stays in the main process; the renderer never sees it. The local and
 * self-hosted targets are untouched and still go through the runtime, which is
 * the only thing that holds *those* ChatGPT credentials.
 *
 * Answers are turned into the runtime's own wire shapes rather than into the
 * IPC types directly, so `readSnapshot`/`readResets` in gpt-usage.ts stay the
 * single place a reading becomes something the app shows.
 */

const USAGE_PATH = "/v1/providers/chatgpt-usage";
const RESETS_PATH = "/v1/providers/chatgpt-rate-limit-reset-credits";
const CONSUME_PATH = "/v1/providers/chatgpt-rate-limit-reset-credits/consume";

/** Letta Cloud proxies ChatGPT, which the runtime gives 15 seconds of its own. */
const REQUEST_TIMEOUT_MS = 20_000;
/** The runtime's own cache window, so opening the popover repeatedly is one read. */
const CACHE_TTL_MS = 30_000;

type Json = Record<string, unknown>;

/** What a reading is about, for messages a person has to act on. */
type Subject = "usage" | "resets";

export type CloudAuth = { baseUrl: string; token: string };

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** The first key that carries anything. Letta Cloud answers in snake_case or camelCase. */
function pick(raw: Json | null, keys: readonly string[]): unknown {
  if (!raw) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function str(raw: Json | null, keys: readonly string[]): string | null {
  const value = pick(raw, keys);
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function num(raw: Json | null, keys: readonly string[]): number | null {
  const value = pick(raw, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nested(raw: Json | null, keys: readonly string[]): Json | null {
  return asRecord(pick(raw, keys));
}

/** Seconds since the epoch, from seconds, milliseconds or a date-time. */
function timestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampSeconds(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

const RESET_AT_KEYS = ["reset_at", "resetAt", "resets_at", "resetsAt"] as const;

function resetsAtSeconds(raw: Json | null, nowMs: number): number | null {
  const stated = timestampSeconds(pick(raw, RESET_AT_KEYS));
  if (stated !== null) return stated;
  const after = num(raw, ["reset_after_seconds", "resetAfterSeconds"]);
  return after === null ? null : Math.floor(nowMs / 1000 + after);
}

/** One window, in the shape the runtime sends over the socket. */
function usageWindow(value: unknown, fallbackLabel: string, nowMs: number): WireSnapshot["primary"] {
  const raw = asRecord(value);
  if (!raw) return null;
  const usedPercent = num(raw, ["used_percent", "usedPercent", "used_percentage", "usedPercentage", "percent_used", "percentUsed"]);
  const limitWindowSeconds = num(raw, ["limit_window_seconds", "limitWindowSeconds"]);
  const windowDurationMins =
    num(raw, ["window_duration_minutes", "windowDurationMinutes", "window_duration_mins", "windowDurationMins", "window_minutes", "windowMinutes"]) ??
    (limitWindowSeconds === null ? null : limitWindowSeconds / 60);
  const resetsAt = resetsAtSeconds(raw, nowMs);
  // A window reporting none of the three says nothing; the runtime drops it too.
  if (usedPercent === null && windowDurationMins === null && resetsAt === null) return null;
  return { label: str(raw, ["label", "name"]) ?? fallbackLabel, usedPercent, windowDurationMins, resetsAt };
}

function individualLimit(raw: Json, nowMs: number): WireSnapshot["individualLimit"] {
  const spendControl = nested(raw, ["spend_control", "spendControl"]);
  const limit = nested(raw, ["individual_limit", "individualLimit"]) ?? nested(spendControl, ["individual_limit", "individualLimit"]);
  if (!limit) return null;
  const stated = str(limit, ["limit"]);
  const used = str(limit, ["used"]);
  const remainingPercent = num(limit, ["remaining_percent", "remainingPercent"]);
  const resetsAt = resetsAtSeconds(limit, nowMs);
  // All four or none, as `normalizeIndividualLimit` in the runtime does: a
  // spend limit missing its figures is half a sentence, not a reading.
  if (stated === null || used === null || remainingPercent === null || resetsAt === null) return null;
  return { limit: stated, used, remainingPercent, resetsAt };
}

/** Letta Cloud's usage answer as the runtime would have sent it. */
export function cloudUsageWire(raw: Json, providerName: string, nowMs: number): WireSnapshot {
  const limitReached = pick(raw, ["limit_reached", "limitReached"]);
  const additional = pick(raw, ["additional", "additional_rate_limits", "additionalRateLimits"]);
  return {
    providerName: str(raw, ["provider_name", "providerName"]) ?? providerName,
    fetchedAt: str(raw, ["fetched_at", "fetchedAt"]) ?? new Date(nowMs).toISOString(),
    summary: str(raw, ["summary"]) ?? "",
    planType: str(raw, ["plan_type", "planType"]),
    limitReached: typeof limitReached === "boolean" ? limitReached : null,
    rateLimitReachedType: str(raw, ["rate_limit_reached_type", "rateLimitReachedType"]),
    primary: usageWindow(pick(raw, ["primary", "primary_window", "primaryWindow"]), "primary", nowMs),
    secondary: usageWindow(pick(raw, ["secondary", "secondary_window", "secondaryWindow"]), "secondary", nowMs),
    additional: (Array.isArray(additional) ? additional : [])
      .map((entry, index) => usageWindow(entry, `limit ${index + 1}`, nowMs))
      .filter((entry): entry is NonNullable<WireSnapshot["primary"]> => !!entry),
    individualLimit: individualLimit(raw, nowMs),
  };
}

/**
 * The resets, or null when the answer isn't one. The runtime refuses a payload
 * where any single credit is malformed rather than quietly showing fewer than
 * the plan has, and so does this: an under-count here is a person believing
 * they have one reset left when they have two.
 */
export function cloudResetsWire(raw: Json, providerName: string, nowMs: number): WireCredits | null {
  const availableCount = num(raw, ["available_count", "availableCount"]);
  const rawCredits = raw.credits;
  if (availableCount === null || !Number.isInteger(availableCount) || availableCount < 0 || !Array.isArray(rawCredits)) return null;
  const credits = rawCredits.map((value) => {
    const credit = asRecord(value);
    const id = str(credit, ["id"]);
    const resetType = str(credit, ["reset_type", "resetType"]);
    const status = str(credit, ["status"]);
    const grantedAt = str(credit, ["granted_at", "grantedAt"]);
    if (!id || !resetType || !status || !grantedAt) return null;
    return {
      id,
      resetType,
      status,
      grantedAt,
      expiresAt: str(credit, ["expires_at", "expiresAt"]),
      title: str(credit, ["title"]),
      description: str(credit, ["description"]),
    };
  });
  if (credits.some((credit) => credit === null)) return null;
  return {
    providerName,
    fetchedAt: new Date(nowMs).toISOString(),
    availableCount,
    credits: credits as NonNullable<(typeof credits)[number]>[],
  };
}

/** What Letta Cloud says became of a spend, in the runtime's own words. */
export function cloudOutcome(raw: Json): string | null {
  const outcome = str(raw, ["outcome", "code"]);
  if (outcome === "nothingToReset") return "nothing_to_reset";
  if (outcome === "noCredit") return "no_credit";
  if (outcome === "alreadyRedeemed") return "already_redeemed";
  return outcome === "reset" || outcome === "nothing_to_reset" || outcome === "no_credit" || outcome === "already_redeemed" ? outcome : null;
}

function retryAfterMs(response: Response, raw: Json | null): number | null {
  const body = num(raw, ["retry_after_ms", "retryAfterMs"]);
  if (body !== null && body >= 0) return body;
  const seconds = Number(response.headers.get("retry-after") ?? "");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * A failed answer, said in terms of the thing a person can actually change. A
 * 401 here is this app's Letta sign-in, not a ChatGPT one — the difference is
 * the whole point of this module, so the message has to carry it.
 */
function cloudFailure(status: number, text: string, response: Response, subject: Subject): GptUsageFailure {
  const raw = (() => {
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return null;
    }
  })();
  const detail = str(raw, ["message", "detail", "error"]);
  const thing = subject === "usage" ? "usage" : "resets";
  if (status === 401) {
    return { code: "unauthorized", message: `Your Letta sign-in isn't working, so ChatGPT ${thing} couldn't be read. Sign in again in Settings.`, retryAfterMs: null };
  }
  if (status === 403) {
    return { code: "forbidden", message: detail ?? `ChatGPT ${thing} aren't available for this Letta Cloud account.`, retryAfterMs: null };
  }
  if (status === 404) {
    return { code: "not_connected", message: detail ?? "Letta Cloud has no ChatGPT plan connected to this account.", retryAfterMs: null };
  }
  if (status === 429) {
    return { code: "rate_limited", message: detail ?? `ChatGPT ${thing} are rate limited. Try again later.`, retryAfterMs: retryAfterMs(response, raw) };
  }
  if (status === 400) {
    return { code: "bad_request", message: detail ?? `Letta Cloud rejected the ChatGPT ${thing} request.`, retryAfterMs: null };
  }
  return { code: "network_error", message: providerError(status, text), retryAfterMs: null };
}

type Answer = { raw: Json } | { error: GptUsageFailure };

/** One call to Letta Cloud, answered either way rather than thrown. */
async function call(
  auth: CloudAuth,
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: Json; subject: Subject },
): Promise<Answer> {
  const url = new URL(`${auth.baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    return {
      error: {
        code: "network_error",
        message: timedOut
          ? "Letta Cloud didn't answer the ChatGPT usage request in time."
          : error instanceof Error
            ? error.message
            : "Hearthside couldn't reach Letta Cloud.",
        retryAfterMs: null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) return { error: cloudFailure(response.status, text, response, options.subject) };
  try {
    const raw = asRecord(JSON.parse(text));
    return raw ? { raw } : { error: { code: "bad_response", message: "Letta Cloud answered the ChatGPT usage request with something that wasn't a reading.", retryAfterMs: null } };
  } catch {
    return { error: { code: "bad_response", message: "Letta Cloud answered the ChatGPT usage request with invalid JSON.", retryAfterMs: null } };
  }
}

/**
 * The sign-in to read with, as a failure rather than a throw — "not signed in"
 * is an answer this panel shows, not a crash.
 */
async function auth(): Promise<{ auth: CloudAuth } | { error: GptUsageFailure }> {
  try {
    return { auth: await cloudAuth() };
  } catch (error) {
    return {
      error: {
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Sign in to Letta Cloud first.",
        retryAfterMs: null,
      },
    };
  }
}

/**
 * Readings held briefly, as the runtime holds its own.
 *
 * Keyed per *account*, not merely per server and plan. Hearthside switches
 * Letta accounts without restarting, and `api.letta.com` with
 * `chatgpt-plus-pro` is the same pair for every account on Letta Cloud — so a
 * key of those two alone answers the second account out of the first one's
 * entry, with no request made and nothing to show the figures are not theirs.
 * The account is identified by a digest of the credential itself, below.
 *
 * Usage and resets expire independently. They are fetched by separate calls at
 * separate moments, so a single shared deadline would let a fresh usage read
 * extend the apparent freshness of resets fetched a whole window earlier — and
 * resets are the figures someone is about to spend against.
 */
type Held<T> = { value: T; expiresAt: number };
const cache = new Map<string, { usage?: Held<WireSnapshot>; resets?: Held<WireCredits> }>();

/**
 * A separator that cannot occur in a URL, a digest or a provider name, so two
 * different triples cannot collide into one key. Written as an escape so the
 * source file itself stays plain text.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * An opaque fingerprint of the credential, standing in for an account id —
 * Letta's sign-in gives this app a bearer token and no account identifier to
 * key on.
 *
 * A one-way digest held only in this process's memory: never written to disk,
 * never logged, never put in an IPC message or a request. Its only job is to
 * keep two sign-ins' figures apart, which a truncated SHA-256 does.
 */
function credentialDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 16);
}

/** The account a reading belongs to: which server, and which sign-in on it. */
function accountScope(auth: CloudAuth): string {
  return [auth.baseUrl, credentialDigest(auth.token)].join(KEY_SEPARATOR);
}

function cacheKey(scope: string, providerName: string): string {
  return [scope, providerName].join(KEY_SEPARATOR);
}

/**
 * The account the last resolved sign-in belonged to, and a count of how often
 * that has changed. The count is what lets a request that was already in
 * flight when the account changed be thrown away, rather than written into the
 * new account's scope.
 */
let currentScope: string | null = null;
let scopeEra = 0;

function enterScope(scope: string): number {
  if (currentScope === scope) return scopeEra;
  currentScope = scope;
  scopeEra += 1;
  // One account's figures shouldn't outlive its sign-in, even unreachably.
  const prefix = `${scope}${KEY_SEPARATOR}`;
  for (const key of [...cache.keys()]) if (!key.startsWith(prefix)) cache.delete(key);
  return scopeEra;
}

/**
 * A reading that arrived after the account changed. It is a real answer, but
 * for a sign-in that is no longer the current one, so it is neither shown nor
 * cached: figures under the wrong account are the mistake this scoping exists
 * to prevent, and quietly returning nothing would be that mistake left untold.
 */
function accountChanged(subject: Subject): { error: GptUsageFailure } {
  return {
    error: {
      code: "account_changed",
      message: `Your Letta sign-in changed while ChatGPT ${subject} were being read, so that answer was discarded rather than shown against the wrong account. Open this again to read them.`,
      retryAfterMs: null,
    },
  };
}

/** A spend changes both, so neither may be served from before it. */
export function forgetCloudUsage(auth: CloudAuth, providerName: string): void {
  cache.delete(cacheKey(accountScope(auth), providerName));
}

export async function readCloudUsage(providerName: string, refresh: boolean): Promise<{ usage: WireSnapshot } | { error: GptUsageFailure }> {
  const resolved = await auth();
  if ("error" in resolved) return resolved;
  const scope = accountScope(resolved.auth);
  const era = enterScope(scope);
  const key = cacheKey(scope, providerName);
  const held = cache.get(key)?.usage;
  if (!refresh && held && held.expiresAt > Date.now()) return { usage: held.value };

  const answer = await call(resolved.auth, "GET", USAGE_PATH, { query: { provider_name: providerName }, subject: "usage" });
  if ("error" in answer) return answer;
  if (era !== scopeEra) return accountChanged("usage");
  const usage = cloudUsageWire(answer.raw, providerName, Date.now());
  cache.set(key, { ...cache.get(key), usage: { value: usage, expiresAt: Date.now() + CACHE_TTL_MS } });
  return { usage };
}

export async function readCloudResets(providerName: string, refresh: boolean): Promise<{ resets: WireCredits } | { error: GptUsageFailure }> {
  const resolved = await auth();
  if ("error" in resolved) return resolved;
  const scope = accountScope(resolved.auth);
  const era = enterScope(scope);
  const key = cacheKey(scope, providerName);
  const held = cache.get(key)?.resets;
  if (!refresh && held && held.expiresAt > Date.now()) return { resets: held.value };

  const answer = await call(resolved.auth, "GET", RESETS_PATH, { query: { provider_name: providerName }, subject: "resets" });
  if ("error" in answer) return answer;
  if (era !== scopeEra) return accountChanged("resets");
  const resets = cloudResetsWire(answer.raw, providerName, Date.now());
  if (!resets) return { error: { code: "bad_response", message: "Letta Cloud reported this plan's resets in a shape Hearthside couldn't read, so none are offered.", retryAfterMs: null } };
  cache.set(key, { ...cache.get(key), resets: { value: resets, expiresAt: Date.now() + CACHE_TTL_MS } });
  return { resets };
}
/**
 * Spend one reset on the Letta Cloud account.
 *
 * The caller resolves the sign-in first and hands it in, so the account these
 * figures were read on is the account charged: whatever happens to the app's
 * connection between the read and this call, the request still goes to the
 * token that was checked. `idempotencyKey` is the caller's, minted per press,
 * so a re-delivered request can't spend twice.
 */
export async function consumeCloudReset(input: {
  auth: CloudAuth;
  providerName: string;
  resetId: string;
  idempotencyKey: string;
}): Promise<{ raw: Json } | { error: GptUsageFailure }> {
  const answer = await call(input.auth, "POST", CONSUME_PATH, {
    body: { provider_name: input.providerName, idempotency_key: input.idempotencyKey, reset_id: input.resetId },
    subject: "resets",
  });
  if (!("error" in answer)) forgetCloudUsage(input.auth, input.providerName);
  return answer;
}

/** The sign-in a spend will be charged to, resolved before anything is checked against it. */
export async function cloudSpendAuth(): Promise<{ auth: CloudAuth } | { error: GptUsageFailure }> {
  return auth();
}

/** Tests only: readings held between calls would otherwise leak across cases. */
export function clearCloudUsageCache(): void {
  cache.clear();
}
