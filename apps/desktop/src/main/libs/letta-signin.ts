import { app, shell } from "electron";
import { resolve } from "node:path";
import {
  buildAuthorizeUrl,
  codeFromCallback,
  createPkce,
  exchangeCode,
  isLettaCallbackUrl,
  LETTA_OAUTH_SCHEME,
  type LettaOAuthCredential,
  LettaOAuthError,
  lettaOAuthClientId,
  REFRESH_MARGIN_MS,
  refreshCredential,
  refreshDelay,
  revokeCredential,
} from "./letta-oauth";
import { getLettaCredential, saveLettaCredential, SecretStorageUnavailableError } from "./settings";

/**
 * "Sign in with Letta" in the main process: runs the browser sign-in, keeps
 * the credential fresh, and hands the current access token to whoever needs
 * it (the runtime receives it over its desktop-credentials IPC channel).
 *
 * The letta-mobile:// protocol is registered only while a sign-in is waiting,
 * and a callback is accepted only if its state matches the sign-in we started.
 */

const SIGN_IN_LIMIT_MS = 10 * 60_000;

type Pending = { state: string; verifier: string; resolve: (url: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
let pending: Pending | null = null;

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    // Development: Electron is started with the app path as its first argument.
    app.setAsDefaultProtocolClient(LETTA_OAUTH_SCHEME, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(LETTA_OAUTH_SCHEME);
  }
}

function unregisterProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.removeAsDefaultProtocolClient(LETTA_OAUTH_SCHEME, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.removeAsDefaultProtocolClient(LETTA_OAUTH_SCHEME);
  }
}

/** Feed a URL the OS handed to Hearthside (second-instance argv, macOS open-url). Returns true if it was ours. */
export function deliverLettaCallback(url: string): boolean {
  if (!isLettaCallbackUrl(url) || !pending) return false;
  // Any web page can open a letta-mobile:// link. One that doesn't carry the
  // state of the sign-in we started isn't Letta answering it, so it is ignored
  // and the real answer can still arrive, rather than ending the sign-in.
  let state: string | null = null;
  try {
    state = new URL(url).searchParams.get("state");
  } catch {
    return false;
  }
  if (state !== pending.state) return false;
  pending.resolve(url);
  return true;
}

/** Pick the callback URL out of a command line (Windows/Linux protocol launch). */
export function callbackFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => isLettaCallbackUrl(arg)) ?? null;
}

export async function signInWithLetta(): Promise<LettaOAuthCredential> {
  if (pending) throw new LettaOAuthError("A sign-in is already waiting in your browser.");
  const clientId = lettaOAuthClientId();
  const { verifier, challenge, state } = createPkce();

  registerProtocol();
  try {
    const callback = new Promise<string>((resolveUrl, reject) => {
      pending = {
        state,
        verifier,
        resolve: resolveUrl,
        reject,
        timer: setTimeout(() => reject(new LettaOAuthError("Sign-in timed out. Try again.")), SIGN_IN_LIMIT_MS),
      };
    });
    await shell.openExternal(buildAuthorizeUrl({ clientId, challenge, state }));
    const url = await callback;
    const code = codeFromCallback(url, state);
    const credential = await exchangeCode({ clientId, code, verifier });
    generation++;
    retryDelay = FIRST_RETRY_MS;
    refreshHalted = false;
    saveLettaCredential(credential, true);
    scheduleRefresh(credential);
    notify(credential.accessToken);
    return credential;
  } finally {
    // `pending` is assigned inside the Promise executor, which TypeScript can't see.
    const finished = pending as Pending | null;
    if (finished) clearTimeout(finished.timer);
    pending = null;
    unregisterProtocol();
  }
}

export function cancelLettaSignIn(): void {
  pending?.reject(new LettaOAuthError("Sign-in was cancelled."));
}

export async function signOutOfLetta(): Promise<void> {
  const credential = getLettaCredential();
  // A refresh already in flight must not resurrect or "expire" this sign-in.
  generation++;
  stopRefresh();
  retryDelay = FIRST_RETRY_MS;
  refreshHalted = false;
  saveLettaCredential(null);
  if (credential) await revokeCredential(credential, lettaOAuthClientId());
}

// --- Keeping the token fresh -------------------------------------------------

type TokenListener = (accessToken: string) => void;
const listeners = new Set<TokenListener>();
let refreshTimer: NodeJS.Timeout | null = null;
let refreshFailure: ((reason: string) => void) | null = null;
/** Bumped on sign-in and sign-out; refreshes started under an older value are ignored. */
let generation = 0;
let refreshing: { generation: number; refreshToken: string; promise: Promise<LettaOAuthCredential | null> } | null = null;

function notify(accessToken: string): void {
  for (const listener of listeners) listener(accessToken);
}

function stopRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/**
 * How long one timer may wait before looking at the clock again. A timer counts
 * time the computer is awake, so after a night asleep a long one fires hours
 * late and the runtime is left holding a dead token. Short waits keep that
 * lateness within the refresh margin even where no wake-up signal arrives.
 * (Timers also can't wait longer than ~24.8 days: a longer delay fires at once.)
 */
const MAX_TIMER_MS = REFRESH_MARGIN_MS;
/** A failed refresh is tried again after a minute, then less and less often. */
const FIRST_RETRY_MS = 60_000;
const SLOWEST_RETRY_MS = 30 * 60_000;
let retryDelay = FIRST_RETRY_MS;
/** Set when refreshing was stopped on purpose (the result can't be kept); a new sign-in clears it. */
let refreshHalted = false;

function scheduleRefresh(credential: LettaOAuthCredential): void {
  stopRefresh();
  // Letta tokens last 30 days: an unclamped timer fired at once and refreshed in a loop.
  refreshTimer = setTimeout(() => {
    const saved = getLettaCredential();
    if (saved && refreshDelay(saved) > 0) scheduleRefresh(saved);
    else void refreshNow();
  }, Math.min(refreshDelay(credential), MAX_TIMER_MS));
  refreshTimer.unref?.();
}

async function refreshNow(): Promise<LettaOAuthCredential | null> {
  const current = getLettaCredential();
  if (!current) return null;
  const started = generation;
  if (refreshing?.generation === started && refreshing.refreshToken === current.refreshToken) return refreshing.promise;
  stopRefresh();
  const promise = performRefresh(current, started).finally(() => {
    // A new sign-in may already have started its own refresh.
    if (refreshing?.promise === promise) refreshing = null;
  });
  refreshing = { generation: started, refreshToken: current.refreshToken, promise };
  return promise;
}

async function performRefresh(current: LettaOAuthCredential, started: number): Promise<LettaOAuthCredential | null> {
  const stillCurrent = () => {
    const saved = getLettaCredential();
    return started === generation && saved?.refreshToken === current.refreshToken && saved.accessToken === current.accessToken;
  };
  try {
    const next = await refreshCredential(current, lettaOAuthClientId());
    if (!stillCurrent()) return null;
    saveLettaCredential(next);
    retryDelay = FIRST_RETRY_MS;
    scheduleRefresh(next);
    notify(next.accessToken);
    return next;
  } catch (error) {
    // Network blips: try again in a minute. A rejected refresh token needs a new sign-in.
    const message = error instanceof Error ? error.message : String(error);
    // Signed out (or in again) meanwhile: this result no longer matters.
    if (!stillCurrent()) return null;
    console.warn(`[hearthside] Letta token refresh failed: ${message}`);
    if (error instanceof SecretStorageUnavailableError) {
      // The refresh worked but the result could not be kept. A refresh spends its
      // refresh token, so retrying every minute would burn one rotated sign-in per
      // attempt and keep none of them. Stop, and say what actually needs fixing.
      stopRefresh();
      refreshHalted = true;
      refreshFailure?.(`Hearthside can't keep your Letta sign-in on this computer: ${message} Sign in again once protected storage is working.`);
    } else if (error instanceof LettaOAuthError && error.permanent) {
      stopRefresh();
      refreshFailure?.(`Your Letta sign-in has expired (${message}). Sign in again in Settings.`);
    } else {
      // Network blips, server errors, rate limits and answers that don't say the
      // sign-in is finished: keep it and try again, a little less often each time
      // so a long outage isn't asked about every minute.
      refreshTimer = setTimeout(() => void refreshNow(), retryDelay);
      refreshTimer.unref?.();
      retryDelay = Math.min(retryDelay * 2, SLOWEST_RETRY_MS);
    }
    return null;
  }
}

/** A valid access token, refreshing first if it is close to expiry. Null when not signed in. */
export async function currentLettaAccessToken(): Promise<string | null> {
  const saved = getLettaCredential();
  if (!saved) return null;
  if (refreshDelay(saved) > 0) {
    scheduleRefresh(saved);
    return saved.accessToken;
  }
  const refreshed = await refreshNow();
  if (refreshed) return refreshed.accessToken;
  // The refresh starts a few minutes before the token runs out. If it failed for
  // now (offline, Letta busy) the token in hand still works until then, so use it
  // rather than report "not signed in"; the retry already under way is left alone.
  const kept = getLettaCredential();
  const usable = kept?.accessToken === saved.accessToken && kept.expiresAt - Date.now() > STILL_USABLE_MS;
  return usable ? kept.accessToken : null;
}

/** A token this close to running out isn't handed over: the request using it may not finish in time. */
const STILL_USABLE_MS = 30_000;

/**
 * The computer woke up (wired to Electron's "resume" in index.ts). Time passed
 * that the refresh timer did not count, so look at the clock now: refresh if the
 * token is due, which also hands the new one to the runtime, otherwise set the
 * timer again from the real time left.
 */
export function checkLettaSignInAfterWake(): void {
  const saved = getLettaCredential();
  if (!saved || refreshHalted) return;
  if (refreshDelay(saved) === 0) void refreshNow();
  else scheduleRefresh(saved);
}

/** Subscribe to token changes (sign-in and refreshes). */
export function onLettaAccessToken(listener: TokenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when the sign-in can no longer be refreshed. */
export function onLettaSignInExpired(listener: (reason: string) => void): void {
  refreshFailure = listener;
}
