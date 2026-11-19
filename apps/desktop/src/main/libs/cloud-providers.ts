import type { ProviderField, ProviderSummary } from "@hearthside/ipc-contract";
import { currentLettaAccessToken } from "./letta-signin";
import { getConnectionConfig } from "./settings";

/**
 * Hearthside: model providers on a Letta Cloud account ("bring your own key or
 * subscription"). The runtime's provider commands only manage this computer,
 * so Cloud uses Letta's public provider API (`/v1/providers`) for listing,
 * API keys and removal, and the runtime's own `letta --backend api connect`
 * for subscription sign-ins (see provider-signin.ts).
 *
 * The catalog mirrors the providers the runtime offers for Letta Cloud; ids are
 * the names `letta connect` accepts.
 */

type CloudProvider = {
  id: string;
  name: string;
  description: string;
  providerType: string;
  /** The name the runtime saves it under; connections are matched by it or by type. */
  providerName: string;
  oauth?: boolean;
  fields?: ProviderField[];
  /** Also count account providers of this type that point at this address. */
  baseUrlIncludes?: string;
  /** Shown but can't be connected on Cloud, with the reason. */
  unavailable?: string;
};

const apiKey = (label = "API key"): ProviderField => ({ key: "apiKey", label, placeholder: null, secret: true, required: true });

export const CLOUD_CATALOG: CloudProvider[] = [
  { id: "codex", name: "ChatGPT / Codex plan", description: "Use your ChatGPT Plus or Pro plan", providerType: "chatgpt_oauth", providerName: "chatgpt-plus-pro", oauth: true },
  { id: "grok", name: "xAI (Grok / X subscription)", description: "Use your SuperGrok or X subscription", providerType: "xai", providerName: "lc-xai", oauth: true },
  { id: "openrouter-oauth", name: "OpenRouter (sign in)", description: "Sign in to your OpenRouter account", providerType: "openrouter", providerName: "openrouter-oauth", oauth: true },
  {
    id: "claude-subscription",
    name: "Claude subscription (Pro / Max)",
    description: "Use your Claude plan",
    providerType: "anthropic_oauth",
    providerName: "claude-subscription",
    unavailable: "Not available on Letta Cloud. Use it with This computer or your own server instead. A Claude API key works here.",
  },
  { id: "anthropic", name: "Claude API", description: "An Anthropic API key", providerType: "anthropic", providerName: "lc-anthropic", fields: [apiKey()] },
  { id: "openai", name: "OpenAI API", description: "An OpenAI API key", providerType: "openai", providerName: "lc-openai", baseUrlIncludes: "api.openai.com", fields: [apiKey()] },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible API",
    description: "Any server that speaks the OpenAI Chat Completions API",
    providerType: "openai",
    providerName: "lc-openai-compatible",
    fields: [
      { key: "baseUrl", label: "Server address", placeholder: "https://example.com/v1", secret: false, required: true },
      { ...apiKey(), required: false },
    ],
  },
  { id: "gemini", name: "Gemini API", description: "A Google AI Studio API key", providerType: "google_ai", providerName: "lc-gemini", fields: [apiKey()] },
  { id: "openrouter", name: "OpenRouter API", description: "An OpenRouter API key", providerType: "openrouter", providerName: "lc-openrouter", fields: [apiKey()] },
  { id: "ollama-cloud", name: "Ollama Cloud", description: "An Ollama Cloud API key", providerType: "ollama_cloud", providerName: "lc-ollama-cloud", baseUrlIncludes: "ollama.com", fields: [apiKey()] },
  { id: "zai", name: "zAI API", description: "A zAI API key", providerType: "zai", providerName: "lc-zai", fields: [apiKey()] },
  { id: "zai-coding", name: "zAI Coding Plan", description: "Your zAI coding plan key", providerType: "zai_coding", providerName: "lc-zai-coding", fields: [apiKey()] },
  { id: "minimax", name: "MiniMax API", description: "A MiniMax API key", providerType: "minimax", providerName: "lc-minimax", fields: [apiKey()] },
  { id: "moonshot", name: "Moonshot AI", description: "A Moonshot API key", providerType: "moonshot", providerName: "lc-moonshot", fields: [apiKey()] },
  { id: "kimi-code", name: "Kimi Code", description: "Your Kimi Code key", providerType: "moonshot_coding", providerName: "lc-kimi-code", fields: [apiKey()] },
];

export type AccountProvider = {
  id: string;
  name: string;
  provider_type: string;
  provider_category?: string;
  base_url?: string | null;
};

const ACCOUNT_PREFIX = "account:";

/** Signed in, but Letta couldn't be reached to renew the sign-in just now. */
export const SIGN_IN_NOT_RENEWED = "Hearthside couldn't renew your Letta sign-in just now. Check your connection and try again in a moment.";

export async function cloudAuth(): Promise<{ baseUrl: string; token: string }> {
  const config = getConnectionConfig();
  // The sign-in first, as chats do. While signed in, a sign-in that can't be
  // renewed this minute must not quietly become the saved key: the key may
  // belong to another account or project, and the work would land there.
  const token = (await currentLettaAccessToken()) || (config.lettaSignedIn ? "" : config.apiKey);
  if (!token) throw new Error(config.lettaSignedIn ? SIGN_IN_NOT_RENEWED : "Sign in to Letta Cloud first.");
  return { baseUrl: (config.apiBaseUrl || "https://api.letta.com").replace(/\/+$/, ""), token };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = await cloudAuth();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(providerError(response.status, text));
  return (text ? JSON.parse(text) : {}) as T;
}

/** Letta wraps the provider's own error; dig out something a person can act on. */
export function providerError(status: number, text: string): string {
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // Not JSON.
  }
  // "Provider request failed (401)": the provider itself turned the key down.
  if (/provider request failed \((401|403)\)|incorrect api key|invalid api key|invalid x-api-key/i.test(detail)) {
    return "That key was rejected. Check it and try again.";
  }
  if (status === 401) return "Your Letta sign-in isn't working. Sign in again in Settings.";
  if (status === 403) return "Letta Cloud didn't allow this. Try signing in again.";
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail || `Letta Cloud error (${status}).`;
}

export function listAccountProviders(): Promise<AccountProvider[]> {
  return api<AccountProvider[]>("GET", "/v1/providers");
}

/** Which catalog entry an account provider belongs to, if any. */
export function matchCatalog(provider: AccountProvider): CloudProvider | undefined {
  const byName = CLOUD_CATALOG.find((entry) => entry.providerName === provider.name);
  if (byName) return byName;
  const sameType = CLOUD_CATALOG.filter((entry) => entry.providerType === provider.provider_type && !entry.unavailable);
  const byAddress = sameType.find((entry) => entry.baseUrlIncludes && provider.base_url?.includes(entry.baseUrlIncludes));
  if (byAddress) return byAddress;
  // A type shared by several entries (OpenAI vs OpenAI-compatible) needs the address to tell.
  const plain = sameType.filter((entry) => !entry.baseUrlIncludes);
  return sameType.length === 1 ? sameType[0] : plain.length === 1 ? plain[0] : undefined;
}

/** The catalog with this account's connections, plus account providers the catalog doesn't know. */
export function summarize(account: readonly AccountProvider[]): ProviderSummary[] {
  const byEntry = new Map<string, AccountProvider[]>();
  const others: AccountProvider[] = [];
  for (const provider of account) {
    const entry = matchCatalog(provider);
    if (entry) byEntry.set(entry.id, [...(byEntry.get(entry.id) ?? []), provider]);
    else others.push(provider);
  }
  const connection = (provider: AccountProvider) => ({
    name: provider.name,
    authType: provider.provider_type.endsWith("oauth") ? ("oauth" as const) : ("api" as const),
    baseUrl: provider.base_url ?? null,
  });
  return [
    ...CLOUD_CATALOG.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      oauth: entry.oauth ?? false,
      fields: entry.fields ?? [],
      authMethods: [],
      connections: (byEntry.get(entry.id) ?? []).map(connection),
      ...(entry.unavailable ? { unavailable: entry.unavailable } : {}),
    })),
    ...others.map((provider) => ({
      id: `${ACCOUNT_PREFIX}${provider.id}`,
      name: provider.name,
      description: `Connected to your Letta account (${provider.provider_type})`,
      oauth: false,
      fields: [],
      authMethods: [],
      connections: [connection(provider)],
    })),
  ];
}

export async function listCloudProviders(): Promise<ProviderSummary[]> {
  return summarize(await listAccountProviders());
}

export async function connectCloudProvider(input: { providerId: string; fields: Record<string, string> }): Promise<ProviderSummary[]> {
  const entry = CLOUD_CATALOG.find((item) => item.id === input.providerId);
  if (!entry || entry.oauth || entry.unavailable) throw new Error("This provider can't be connected that way.");
  const key = input.fields.apiKey?.trim() ?? "";
  const baseUrl = input.fields.baseUrl?.trim() ?? "";
  if (entry.fields?.some((field) => field.required && !input.fields[field.key]?.trim())) throw new Error("Fill in the required fields.");
  const body = { provider_type: entry.providerType, api_key: key, ...(baseUrl ? { base_url: baseUrl } : {}) };
  // Check the key first, as the runtime does, so a typo isn't saved.
  await api("POST", "/v1/providers/check", body);
  const existing = (await listAccountProviders()).find((provider) => provider.name === entry.providerName);
  if (existing) await api("PATCH", `/v1/providers/${existing.id}`, { api_key: key, ...(baseUrl ? { base_url: baseUrl } : {}) });
  else await api("POST", "/v1/providers", { name: entry.providerName, ...body });
  return listCloudProviders();
}

export async function disconnectCloudProvider(input: { providerId: string; providerName?: string }): Promise<ProviderSummary[]> {
  const account = await listAccountProviders();
  const target = input.providerId.startsWith(ACCOUNT_PREFIX)
    ? account.find((provider) => provider.id === input.providerId.slice(ACCOUNT_PREFIX.length))
    : account.find((provider) => provider.name === input.providerName && matchCatalog(provider)?.id === input.providerId);
  if (!target) throw new Error("That connection is already gone.");
  await api("DELETE", `/v1/providers/${target.id}`);
  return listCloudProviders();
}
