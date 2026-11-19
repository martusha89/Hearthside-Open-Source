// "Sign in with Letta": OAuth 2.0 Authorization Code + PKCE against Letta Cloud.
// Endpoints, the public client and the token handling follow Letta's public
// mobile example, letta-ai/agent-sdk-mobile-app (Apache-2.0,
// src/lib/auth/oauthTokens.ts). Pure (no Electron) so it can be unit-tested.
import { createHash, randomBytes } from "node:crypto";

export const LETTA_OAUTH_BASE_URL = "https://platform.letta.com";
export const LETTA_OAUTH_AUTHORIZE_URL = `${LETTA_OAUTH_BASE_URL}/oauth/authorize`;
export const LETTA_OAUTH_TOKEN_URL = `${LETTA_OAUTH_BASE_URL}/api/oauth/token`;
export const LETTA_OAUTH_REVOKE_URL = `${LETTA_OAUTH_BASE_URL}/api/oauth/revoke`;

/**
 * Letta's general-purpose public client from its mobile example. A public
 * client id is an identifier, not a secret; PKCE protects each sign-in. Its
 * registered redirect is letta-mobile://oauth/callback. Override with
 * HEARTHSIDE_SOURCE_LETTA_OAUTH_CLIENT_ID if Letta ever issues a dedicated client.
 */
export const LETTA_OAUTH_SCHEME = "hearthside-source";
export const LETTA_OAUTH_REDIRECT_URI = `${LETTA_OAUTH_SCHEME}://oauth/callback`;

export function lettaOAuthClientId(env: NodeJS.ProcessEnv = process.env): string {
  const clientId = env.HEARTHSIDE_SOURCE_LETTA_OAUTH_CLIENT_ID?.trim();
  if (!clientId) throw new Error("Configure a source-edition OAuth client, or use an API key instead.");
  return clientId;
}

export interface LettaOAuthCredential {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export class LettaOAuthError extends Error {
  /**
   * True when Letta definitively rejected the grant (e.g. invalid_grant):
   * signing in again is the only fix. False for server errors, rate limits and
   * answers that don't say why, which are worth retrying.
   */
  readonly permanent: boolean;
  constructor(message: string, permanent = true) {
    super(message);
    this.permanent = permanent;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: a high-entropy verifier and its S256 challenge, plus a CSRF state. */
export function createPkce(random: (size: number) => Buffer = randomBytes) {
  const verifier = base64Url(random(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(random(24));
  return { verifier, challenge, state };
}

export function challengeFor(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(options: { clientId: string; challenge: string; state: string }): string {
  const url = new URL(LETTA_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", LETTA_OAUTH_REDIRECT_URI);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  return url.toString();
}

/** True for a URL Letta redirected back to us with (code, error, or neither). */
export function isLettaCallbackUrl(value: string): boolean {
  return value.toLowerCase().startsWith(`${LETTA_OAUTH_SCHEME}://oauth/callback`);
}

/**
 * Extract the authorization code from the redirect, refusing anything whose
 * state doesn't match the sign-in we started (protects against injected or
 * stale callbacks).
 */
export function codeFromCallback(callbackUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new LettaOAuthError("Letta returned an unreadable sign-in response.");
  }
  const params = url.searchParams;
  if (params.get("state") !== expectedState) {
    throw new LettaOAuthError("This sign-in response doesn't match the sign-in Hearthside started. Try again.");
  }
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    throw new LettaOAuthError(error === "access_denied" ? "Sign-in was cancelled." : description || `Letta Cloud refused sign-in (${error}).`);
  }
  const code = params.get("code");
  if (!code) throw new LettaOAuthError("Letta Cloud did not return the required sign-in details.");
  return code;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type Fetch = typeof fetch;

/**
 * The OAuth answers that mean the grant itself is finished (RFC 6749 section 5.2):
 * the refresh token was revoked or has expired, or Letta no longer knows this app.
 */
const DEAD_GRANT = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

async function requestTokens(body: Record<string, string>, fetchImpl: Fetch, retried: boolean): Promise<TokenResponse> {
  const response = await fetchImpl(LETTA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    // Only Letta saying so in OAuth's own words ends a sign-in. A bare 401/403/404
    // can come from a firewall, a filtering proxy or a maintenance page in front of
    // Letta, and deleting a sign-in that is still good over one of those costs the
    // person a trip through the browser.
    const permanent = response.status >= 400 && response.status < 500 && typeof result.error === "string" && DEAD_GRANT.has(result.error);
    const detail = result.error_description || result.error || `HTTP ${response.status}`;
    // A refresh is tried again by itself; a sign-in is not, so don't promise it.
    const passing = retried || response.status >= 500 || response.status === 408 || response.status === 429;
    throw new LettaOAuthError(permanent || !passing ? detail : `Letta Cloud is having trouble (${detail}). ${retried ? "Retrying." : "Try again."}`, permanent);
  }
  return result;
}

export async function exchangeCode(
  options: { clientId: string; code: string; verifier: string; now?: () => number },
  fetchImpl: Fetch = fetch,
): Promise<LettaOAuthCredential> {
  const result = await requestTokens(
    {
      grant_type: "authorization_code",
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.verifier,
      redirect_uri: LETTA_OAUTH_REDIRECT_URI,
    },
    fetchImpl,
    false,
  );
  if (!result.access_token || !result.refresh_token || !result.expires_in) {
    throw new LettaOAuthError("Letta Cloud returned an incomplete sign-in response.");
  }
  const now = options.now ?? Date.now;
  return { kind: "oauth", accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: now() + result.expires_in * 1000 };
}

export async function refreshCredential(
  credential: LettaOAuthCredential,
  clientId: string,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): Promise<LettaOAuthCredential> {
  const result = await requestTokens(
    { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refreshToken },
    fetchImpl,
    true,
  );
  if (!result.access_token || !result.expires_in) {
    // Not a refusal: a page from something in between can answer 200 with no token in it.
    throw new LettaOAuthError("Letta Cloud returned an incomplete refresh response.", false);
  }
  return {
    kind: "oauth",
    accessToken: result.access_token,
    refreshToken: result.refresh_token || credential.refreshToken,
    expiresAt: now() + result.expires_in * 1000,
  };
}

export async function revokeCredential(credential: LettaOAuthCredential, clientId: string, fetchImpl: Fetch = fetch): Promise<void> {
  await fetchImpl(LETTA_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: credential.refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
  }).catch(() => undefined);
}

export function parseCredential(value: string): LettaOAuthCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<LettaOAuthCredential>;
    if (
      parsed.kind === "oauth" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as LettaOAuthCredential;
    }
  } catch {
    // Not a stored credential.
  }
  return null;
}

/** Refresh this long before expiry, so the runtime never holds a dead token. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export function refreshDelay(credential: LettaOAuthCredential, now = Date.now()): number {
  return Math.max(0, credential.expiresAt - REFRESH_MARGIN_MS - now);
}
