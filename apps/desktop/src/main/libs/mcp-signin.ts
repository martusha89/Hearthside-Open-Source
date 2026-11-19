import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { shell } from "electron";

/**
 * Hearthside: browser sign-in for connectors whose sign-in server doesn't let
 * apps register on the spot, but accepts an app identified by a public web
 * address (a "client ID metadata document"), e.g. ElevenLabs. Hearthside's
 * document lives at CLIENT_ID; it lists the loopback address below as the only
 * place a sign-in may return to.
 */

export const CLIENT_ID = "https://example.invalid/hearthside/oauth-client.json";
const PORT = 33418;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

export type ServerAuth = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  clientIdDocuments: boolean;
  scopes: string[];
};

export type SignInTokens = { accessToken: string; refreshToken?: string; expiresIn?: number; clientId: string };

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}



export function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Find how a connector's server signs people in. */
export async function discoverAuth(serverUrl: string, cancellation?: AbortSignal): Promise<ServerAuth | null> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  const url = new URL(serverUrl);
  // The server says where its details are when it refuses an unsigned request.
  let resourceMetaUrl: string | null = null;
  try {
    signal.throwIfAborted();
    const probe = await fetch(serverUrl, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    resourceMetaUrl = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "")?.[1] ?? null;
    await probe.body?.cancel();
  } catch {
    // Fall back to the well-known addresses.
  }
  const resourceMeta =
    (resourceMetaUrl && (await getJson(resourceMetaUrl, signal))) ||
    (await getJson(`${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`, signal)) ||
    (await getJson(`${url.origin}/.well-known/oauth-protected-resource`, signal));
  const issuer = (strings(resourceMeta?.authorization_servers)[0] ?? url.origin).replace(/\/+$/, "");
  const issuerUrl = new URL(issuer);
  const path = issuerUrl.pathname.replace(/\/$/, "");
  const meta =
    (await getJson(`${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`, signal)) ||
    (await getJson(`${issuerUrl.origin}/.well-known/openid-configuration${path}`, signal)) ||
    (await getJson(`${issuer}/.well-known/openid-configuration`, signal));
  if (!meta || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") return null;
  if (!isBrowserUrl(meta.token_endpoint) || !isBrowserUrl(meta.authorization_endpoint)) return null;
  return {
    resource: typeof resourceMeta?.resource === "string" ? resourceMeta.resource : serverUrl,
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : null,
    clientIdDocuments: meta.client_id_metadata_document_supported === true,
    scopes: strings(resourceMeta?.scopes_supported).length ? strings(resourceMeta?.scopes_supported) : strings(meta.scopes_supported),
  };
}

const base64url = (buffer: Buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let active: { server: Server; cancel: () => void } | null = null;

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Hearthside</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh;color:#333"><p>${message}</p></body>`;
}

/** Sign in through the browser using Hearthside's public client ID. */
export async function signInWithClientId(auth: ServerAuth, signal: AbortSignal): Promise<SignInTokens> {
  active?.cancel();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const fail = (message: string) => {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page(message));
        finish(new Error(message));
      };
      // Any web page can request this address while a sign-in waits. A request
      // without this sign-in's state isn't the sign-in server answering, so it is
      // turned away and the real answer can still arrive.
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("This sign-in link doesn't match. Try again from Hearthside."));
        return;
      }
      const iss = url.searchParams.get("iss");
      if (iss && iss.replace(/\/+$/, "") !== auth.issuer) return fail("The sign-in came back from an unexpected server.");
      const error = url.searchParams.get("error");
      if (error) return fail(error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${url.searchParams.get("error_description") ?? error}`);
      const received = url.searchParams.get("code");
      if (!received) return fail("The sign-in didn't include a code.");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Signed in. You can close this tab and go back to Hearthside."));
      finish(null, received);
    });
    const finish = (error: Error | null, value?: string) => {
      signal.removeEventListener("abort", onAbort);
      server.close();
      if (active?.server === server) active = null;
      if (error) reject(error);
      else resolve(value as string);
    };
    const onAbort = () => finish(new Error("Sign-in timed out. Try again."));
    signal.addEventListener("abort", onAbort);
    server.on("error", (error: NodeJS.ErrnoException) =>
      finish(new Error(error.code === "EADDRINUSE" ? "Another sign-in is already waiting. Finish or close it, then try again." : error.message)),
    );
    server.listen(PORT, "127.0.0.1", () => {
      active = { server, cancel: () => finish(new Error("Sign-in was replaced by a new one.")) };
      const authorize = new URL(auth.authorizationEndpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", CLIENT_ID);
      authorize.searchParams.set("redirect_uri", REDIRECT_URI);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("resource", auth.resource);
      if (auth.scopes.length) authorize.searchParams.set("scope", auth.scopes.join(" "));
      if (!isBrowserUrl(authorize.toString())) return finish(new Error("The sign-in page isn't a web address, so it wasn't opened."));
      void shell.openExternal(authorize.toString());
    });
  });

  const response = await fetch(auth.tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: auth.resource,
    }),
  });
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) throw new Error(`Sign-in failed: ${data.error_description ?? data.error ?? response.status}`);
  return {
    accessToken: data.access_token,
    clientId: CLIENT_ID,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresIn: data.expires_in } : {}),
  };
}
