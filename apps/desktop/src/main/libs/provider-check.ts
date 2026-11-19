/**
 * Hearthside: find out whether what was typed for a model provider on This
 * computer actually works, before calling it connected.
 *
 * The runtime checks a key with Letta when the connection is for Letta Cloud,
 * and not at all for the local backend: it saves whatever it is given. So a
 * mistyped or expired key was shown as "Connected" with a full model list, and
 * the first anyone heard of it was a failed message. The same went for a local
 * server (Ollama, LM Studio) that wasn't running.
 *
 * This asks the provider itself one cheap, read-only question. It is
 * deliberately cautious about saying no: only an answer that can mean nothing
 * else refuses the connection — the provider naming the key as invalid, not
 * merely a 401, which OpenAI also gives a working key that lacks the scope to
 * list models. A restricted key, a proxy in the way, no network, a token this
 * cannot present the way the runtime will: all of those leave the answer
 * unknown, the connection is saved as before, and the window says it was
 * saved rather than checked.
 */
export type ProviderCheck = "verified" | "rejected" | "unreachable" | "unchecked";

type Reply = { status: number; text?: () => Promise<string> };
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Reply>;

const TIMEOUT_MS = 8_000;
/** A server that was already saved is only being asked whether it is up: this computer, or nearby. */
const RECHECK_TIMEOUT_MS = 1_500;

type Keyed = {
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Whether a 401's body says the key itself is no good. */
  invalid: (body: string) => boolean;
  /** Keys this request cannot present the way the runtime will. */
  skip?: (key: string) => boolean;
};

/** Providers that take an API key, and the read-only request that proves one. */
const KEYED: Record<string, Keyed> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    invalid: (body) => /"code"\s*:\s*"invalid_api_key"/.test(body),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    invalid: (body) => /"type"\s*:\s*"authentication_error"/.test(body),
    // A Claude sign-in token goes out as a bearer token from the runtime; sent
    // as an API key it is refused, which says nothing about whether it works.
    skip: (key) => key.includes("sk-ant-oat"),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    invalid: () => true,
  },
};

/** Servers a person runs themselves, with the address the runtime assumes when none is given. */
const SERVERS: Record<string, string | null> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  "llama-cpp": "http://localhost:8080/v1",
  "openai-compatible": null,
};

/** A server the person runs themselves: it can come up, or go away, after it was saved. */
export function isLocalServer(providerId: string): boolean {
  return providerId in SERVERS;
}

export function checkable(providerId: string): boolean {
  return providerId in KEYED || providerId in SERVERS;
}

async function ask(fetcher: Fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  try {
    const reply = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = reply.status === 401 && reply.text ? await reply.text().catch(() => "") : "";
    return { status: reply.status, body };
  } catch {
    return null;
  }
}

const ok = (status: number): boolean => status >= 200 && status < 300;

function serverAddress(providerId: string, baseUrl: string): string | null {
  const address = baseUrl.trim().replace(/\/+$/, "") || SERVERS[providerId];
  return address && /^https?:\/\//i.test(address) ? address : null;
}

export async function checkProvider(providerId: string, fields: Record<string, string>, fetcher: Fetch = fetch as unknown as Fetch): Promise<ProviderCheck> {
  const key = fields.apiKey?.trim() ?? "";
  const baseUrl = fields.baseUrl?.trim() ?? "";

  const keyed = KEYED[providerId];
  if (keyed) {
    // A key sent to an address the person chose proves nothing about the provider's own rules.
    if (!key || baseUrl || keyed.skip?.(key)) return "unchecked";
    const reply = await ask(fetcher, keyed.url, keyed.headers(key), TIMEOUT_MS);
    if (!reply) return "unchecked";
    if (reply.status === 401 && keyed.invalid(reply.body)) return "rejected";
    return ok(reply.status) ? "verified" : "unchecked";
  }

  if (providerId in SERVERS) {
    const address = serverAddress(providerId, baseUrl);
    if (!address) return "unchecked";
    const reply = await ask(fetcher, `${address}/models`, key ? { Authorization: `Bearer ${key}` } : {}, TIMEOUT_MS);
    if (!reply) return "unreachable";
    // A server of the person's own that wants a different key is theirs to
    // sort out when a message fails; it is answering, which is what is known.
    return ok(reply.status) ? "verified" : "unchecked";
  }

  return "unchecked";
}

/**
 * Ask a server that is already saved whether it is up, without its key (which
 * only the runtime holds). Any answer at all means it is there; only a clean
 * one, needing no key, confirms it.
 */
export async function recheckServer(providerId: string, baseUrl: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<ProviderCheck> {
  const address = serverAddress(providerId, baseUrl);
  if (!address) return "unchecked";
  const reply = await ask(fetcher, `${address}/models`, {}, RECHECK_TIMEOUT_MS);
  if (!reply) return "unreachable";
  return ok(reply.status) ? "verified" : "unchecked";
}

export function rejectedMessage(providerName: string): string {
  return `${providerName} rejected that key, so it wasn't saved. Check it was copied whole and hasn't been revoked, then try again.`;
}
