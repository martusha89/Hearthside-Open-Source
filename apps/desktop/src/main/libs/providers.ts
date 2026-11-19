// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import type { ModelOption, ProviderField, ProviderSummary } from "@hearthside/ipc-contract";
import { request } from "./control.js";
import { cloudAuth, connectCloudProvider, disconnectCloudProvider, listCloudProviders } from "./cloud-providers";
import { noteProviderConnectionChange } from "./gpt-usage-readings";
import { type ProviderInfo, modelSource } from "./model-sources";
import { getConnectionConfig, providerCheck, setProviderCheck } from "./settings";
import { checkProvider, isLocalServer, recheckServer as askServer, rejectedMessage } from "./provider-check";

/** Hearthside: on Letta Cloud, providers belong to the Letta account. */
const onCloud = () => getConnectionConfig().backend === "cloud";

/**
 * Model providers for the local backend: the API keys and local inference
 * servers the runtime sends prompts to. Credentials are stored by the runtime,
 * never by this app.
 */

// Wire shapes from the app server protocol (protocol_v2 in @letta-ai/letta-code).
// They are declared here because the package's type export for them does not
// resolve under Node module resolution.
type WireField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
};

type WireConnection = {
  is_connected: boolean;
  provider_name?: string;
  auth_type?: "api" | "oauth";
  base_url?: string;
};

type WireProvider = {
  id: string;
  display_name: string;
  description: string;
  provider_name: string;
  is_oauth?: boolean;
  fields?: WireField[];
  auth_methods?: Array<{ id: string; label: string; description: string; fields: WireField[] }>;
  connected_providers: WireConnection[];
};

type ProvidersReply = { type: string; providers: WireProvider[] };

type ModelsReply = {
  type: string;
  entries: Array<{
    id: string;
    handle: string;
    label?: string;
    isDefault?: boolean;
    updateArgs?: { reasoning_effort?: unknown; context_window?: unknown };
  }>;
  available_handles?: string[] | null;
};

/**
 * Hearthside: the runtime lists one catalog entry per reasoning tier
 * ("gpt-5.5-low", "gpt-5.5-high", …) under the same handle and label. Group
 * them into one model with its tiers, so the picker shows each model once and
 * reasoning is chosen separately. The model's `id` is its default tier.
 */
export function groupModels(entries: ModelsReply["entries"]): ModelOption[] {
  const groups = new Map<string, ModelOption & { hasDefault: boolean }>();
  for (const entry of entries) {
    const effort = typeof entry.updateArgs?.reasoning_effort === "string" ? entry.updateArgs.reasoning_effort : null;
    const contextWindow = typeof entry.updateArgs?.context_window === "number" ? entry.updateArgs.context_window : undefined;
    let group = groups.get(entry.handle);
    if (!group) {
      group = {
        id: entry.id,
        handle: entry.handle,
        label: entry.label || entry.handle,
        ...(contextWindow ? { contextWindow } : {}),
        reasoning: [],
        hasDefault: false,
      };
      groups.set(entry.handle, group);
    }
    if (effort) group.reasoning.push({ id: entry.id, effort });
    if (entry.isDefault && !group.hasDefault) {
      group.id = entry.id;
      group.hasDefault = true;
    }
  }
  return [...groups.values()].map(({ hasDefault, ...model }) => {
    // Without a catalog default, start at medium reasoning when the model has it.
    const medium = model.reasoning.find((tier) => tier.effort === "medium");
    return hasDefault || !medium ? model : { ...model, id: medium.id };
  });
}

function toField(field: WireField): ProviderField {
  return {
    key: field.key,
    label: field.label,
    placeholder: field.placeholder ?? null,
    secret: field.secret ?? false,
    required: field.required ?? false,
  };
}

/**
 * Hearthside: Anthropic accepts Claude subscription sign-ins only from Claude
 * Code and claude.ai, so the runtime's own Claude subscription sign-in can't
 * work. Show it, but explain; a Claude Code option is planned instead.
 */
const CLAUDE_SUBSCRIPTION_NOTE =
  "Anthropic only lets Claude Pro/Max be used through Claude Code, so this sign-in doesn't work. A Claude Code option is coming to Hearthside. A Claude API key works today.";

function isClaudeSubscription(entry: WireProvider): boolean {
  return (entry.is_oauth ?? false) && /^(anthropic|claude)/i.test(entry.id);
}

/**
 * Hearthside: these two sign-ins ask a question part-way through (GitHub's
 * enterprise address; OpenRouter's pasted code), and the runtime only asks
 * when it is run in a terminal. Hearthside starts it without one, so both
 * failed the moment they were started ("requires input"), every time, and the
 * answer box Hearthside showed could never reach it. Until Hearthside can give
 * the sign-in a terminal they are shown as not available, with the reason,
 * rather than offered and broken. A sign-in already made elsewhere still works.
 */
const NEEDS_TERMINAL_NOTE =
  "This sign-in asks a question part-way through that Hearthside can't answer for it yet, so it can't be finished from here.";
const OPENROUTER_KEY_NOTE = " An OpenRouter API key works today.";

function needsTerminal(entry: WireProvider): string | null {
  if (!(entry.is_oauth ?? false)) return null;
  if (/^github-copilot/i.test(entry.id)) return NEEDS_TERMINAL_NOTE;
  if (/^openrouter/i.test(entry.id)) return NEEDS_TERMINAL_NOTE + OPENROUTER_KEY_NOTE;
  return null;
}

function toProviderSummary(entry: WireProvider): ProviderSummary {
  const terminal = needsTerminal(entry);
  const connected = entry.connected_providers.filter((state) => state.is_connected);
  // A sign-in was completed with the provider itself; a key or address was only
  // saved, and is "verified" only once a check of it has said so.
  // Only for This computer: on a self-hosted server the addresses are that
  // server's own ("localhost" is its localhost), so nothing asked from here
  // would say anything about them.
  const check = connected.length === 0 || getConnectionConfig().backend !== "local" ? undefined
    : connected.every((state) => state.auth_type === "oauth") ? "verified" as const
    : providerCheck(entry.id) ?? "unchecked" as const;
  return {
    ...(check ? { check } : {}),
    ...(terminal ? { unavailable: terminal } : {}),
    ...(isClaudeSubscription(entry) ? { unavailable: CLAUDE_SUBSCRIPTION_NOTE } : {}),
    id: entry.id,
    name: entry.display_name,
    description: entry.description,
    oauth: entry.is_oauth ?? false,
    fields: (entry.fields ?? []).map(toField),
    authMethods: (entry.auth_methods ?? []).map((method) => ({
      id: method.id,
      label: method.label,
      description: method.description,
      fields: method.fields.map(toField),
    })),
    connections: entry.connected_providers
      .filter((state) => state.is_connected)
      .map((state) => ({
        name: state.provider_name ?? entry.provider_name,
        authType: state.auth_type ?? null,
        baseUrl: state.base_url ?? null,
      })),
  };
}

export async function listProviders(): Promise<ProviderSummary[]> {
  if (onCloud()) return listCloudProviders();
  const reply = await request<ProvidersReply>("list_connect_providers", { target: "local" });
  noteConnections(reply.providers);
  return Promise.all(reply.providers.map(toProviderSummary).map(recheckServer));
}

/** How many rechecks in a row each verified server has not answered (this run only). */
const missedRechecks = new Map<string, number>();

/**
 * A local server that wasn't answering when it was saved is asked again each
 * time the list is read (one request to this computer), so starting Ollama
 * afterwards is noticed without connecting it a second time.
 */
async function recheckServer(provider: ProviderSummary): Promise<ProviderSummary> {
  if (!provider.check || !isLocalServer(provider.id)) return provider;
  const found = await askServer(provider.id, provider.connections[0]?.baseUrl ?? "");
  if (provider.check === "verified") {
    // It was checked with its key when it was connected, and is asked here
    // without one, so nothing this hears can take that back: "wants a key" is
    // what a protected server says to anyone. The saved answer stays as it is.
    // (It used to be replaced by "not answering" after one slow moment, and then
    // by "not checked" for good, because by then it no longer counted as verified.)
    if (found !== "unreachable") {
      missedRechecks.delete(provider.id);
      return provider;
    }
    // One missed answer may be a slow moment (waking up, a busy server). Twice
    // running, say it isn't answering for now, without saving that.
    const missed = (missedRechecks.get(provider.id) ?? 0) + 1;
    missedRechecks.set(provider.id, missed);
    return missed >= 2 ? { ...provider, check: "unreachable" } : provider;
  }
  const check = found === "rejected" ? provider.check : found;
  if (check !== provider.check) setProviderCheck(provider.id, check);
  return { ...provider, check };
}

export async function connectProvider(input: {
  providerId: string;
  authMethodId?: string;
  fields: Record<string, string>;
}): Promise<ProviderSummary[]> {
  if (onCloud()) {
    const providers = await connectCloudProvider(input);
    // Hearthside: a ChatGPT sign-in here may be a different plan than the one
    // before it, and nothing it reports would say so (libs/gpt-usage-readings).
    noteProviderConnectionChange(input.providerId);
    return providers;
  }
  // Empty optional fields are left out so the runtime applies its defaults.
  const fields = Object.fromEntries(
    Object.entries(input.fields)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value),
  );
  // The runtime saves a local connection without asking the provider anything,
  // so ask first: a key the provider rejects outright is not saved at all.
  // (This computer only; see toProviderSummary.)
  const check = getConnectionConfig().backend === "local" ? await checkProvider(input.providerId, fields) : "unchecked";
  if (check === "rejected") {
    const name = (await listProviders().catch(() => [])).find((provider) => provider.id === input.providerId)?.name ?? "The provider";
    throw new Error(rejectedMessage(name));
  }
  const reply = await request<ProvidersReply>("connect_provider", {
    target: "local",
    provider_id: input.providerId,
    ...(input.authMethodId ? { auth_method_id: input.authMethodId } : {}),
    fields,
  });
  if (getConnectionConfig().backend === "local") setProviderCheck(input.providerId, check);
  missedRechecks.delete(input.providerId);
  noteProviderConnectionChange(input.providerId);
  noteConnections(reply.providers, true);
  return reply.providers.map(toProviderSummary);
}

export async function disconnectProvider(input: {
  providerId: string;
  providerName?: string;
}): Promise<ProviderSummary[]> {
  if (onCloud()) {
    const providers = await disconnectCloudProvider(input);
    noteProviderConnectionChange(input.providerId, input.providerName);
    return providers;
  }
  const reply = await request<ProvidersReply>("disconnect_provider", {
    target: "local",
    provider_id: input.providerId,
    ...(input.providerName ? { provider_name: input.providerName } : {}),
  });
  setProviderCheck(input.providerId, null);
  missedRechecks.delete(input.providerId);
  // Whatever is signed in here next is a new plan as far as Hearthside can tell.
  noteProviderConnectionChange(input.providerId, input.providerName);
  noteConnections(reply.providers, true);
  return reply.providers.map(toProviderSummary);
}

const AVAILABILITY_RETRIES = 8;
const AVAILABILITY_RETRY_MS = 700;

/** How long after a provider is connected, changed or removed the runtime may still be working out what is available. */
const SETTLING_WINDOW_MS = 30_000;
let connectionsChangedAt = 0;
let connectionsSeen: string | null = null;

/**
 * Remember when the set of connected providers last changed. `changed` is for
 * a connect or disconnect made here; otherwise the list is compared with the
 * one read before, which also notices a sign-in finished in the browser. The
 * first list read after starting is only what was already there.
 */
function noteConnections(providers: WireProvider[], changed = false): void {
  const now = JSON.stringify(
    providers.flatMap((provider) => provider.connected_providers
      .filter((state) => state.is_connected)
      .map((state) => [provider.id, state.provider_name ?? "", state.auth_type ?? "", state.base_url ?? ""])),
  );
  if (changed || (connectionsSeen !== null && connectionsSeen !== now)) connectionsChangedAt = Date.now();
  connectionsSeen = now;
}

function connectionsJustChanged(): boolean {
  return !onCloud() && Date.now() - connectionsChangedAt < SETTLING_WINDOW_MS;
}

/** The runtime knows of models but says none can be used: true while it is still working that out. */
function settling(reply: ModelsReply): boolean {
  return reply.entries.length > 0 && Array.isArray(reply.available_handles) && reply.available_handles.length === 0;
}

/**
 * The model catalog. `refresh` bypasses the runtime's availability cache, which
 * is needed right after a provider is connected or removed.
 */
export async function listModels(refresh = false): Promise<ModelOption[]> {
  let reply = await request<ModelsReply>("list_models", { force: refresh });
  // Right after a provider is connected the runtime lists its models but, for
  // about a second, reports none of them as available yet (seen with LM Studio:
  // the first forced read came back with the model and an empty availability
  // list, the next one a second later had it). Read then, the list was empty:
  // the picker showed nothing and a companion waiting for a model was not given
  // one until something read the list again. "Models, and none available" is
  // therefore asked again a few times before it is believed.
  // Only for a short while after a provider was connected or changed. At any
  // other time the same answer (the catalogue, none of it available) is simply
  // the truth: nothing connected, an Ollama that was saved but isn't running, a
  // key that stopped working. Waiting on it then held every send of a companion
  // with no model for more than five seconds.
  const worthWaiting = refresh && settling(reply) && connectionsJustChanged();
  for (let attempt = 0; worthWaiting && attempt < AVAILABILITY_RETRIES && settling(reply); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, AVAILABILITY_RETRY_MS));
    reply = await request<ModelsReply>("list_models", { force: false });
  }
  const available = reply.available_handles ? new Set(reply.available_handles) : null;
  const models = groupModels(reply.entries.filter((entry) => !available || available.has(entry.handle)));
  const backend = getConnectionConfig().backend;
  const providers = backend === "cloud" ? await cloudProviderInfo(refresh) : new Map<string, ProviderInfo>();
  return models.map((model) => ({ ...model, source: modelSource(model.handle, backend, providers.get(model.handle.split("/")[0]!)) }));
}

/**
 * Hearthside: on Letta Cloud, which provider each handle prefix is, and whether it
 * is Letta's own or one the person connected. Read from /v1/models (read-only),
 * kept for ten minutes. If Letta can't be asked, the picker falls back to what
 * the handle itself says rather than guessing.
 */
let providerCache: { at: number; map: Map<string, ProviderInfo> } | null = null;
async function cloudProviderInfo(refresh: boolean): Promise<Map<string, ProviderInfo>> {
  if (!refresh && providerCache && Date.now() - providerCache.at < 10 * 60_000) return providerCache.map;
  try {
    const { baseUrl, token } = await cloudAuth();
    const response = await fetch(`${baseUrl}/v1/models/`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = (await response.json()) as unknown;
    const map = new Map<string, ProviderInfo>();
    if (Array.isArray(rows)) for (const row of rows as Array<Record<string, unknown>>) {
      const handle = typeof row.handle === "string" ? row.handle : "";
      const prefix = handle.split("/")[0];
      if (!prefix || map.has(prefix)) continue;
      if (typeof row.provider_name === "string" && typeof row.provider_type === "string" && typeof row.provider_category === "string") {
        map.set(prefix, { name: row.provider_name, type: row.provider_type, category: row.provider_category });
      }
    }
    providerCache = { at: Date.now(), map };
    return map;
  } catch (error) {
    console.warn(`[models] provider details unavailable: ${error instanceof Error ? error.name : "error"}`);
    return providerCache?.map ?? new Map();
  }
}
