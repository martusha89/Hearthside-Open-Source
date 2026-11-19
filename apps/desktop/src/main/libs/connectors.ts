import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { app, shell } from "electron";
import type { AgentToolResultContent, AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { ConnectedMcpServer, McpServerConfig, McpToolDefinition } from "@letta-ai/letta-code/mcp-client";
import type { Connector, ConnectorImport, ConnectorInput, ConnectorTool, ConnectorVoice } from "@hearthside/ipc-contract";
import { cloudAuth } from "./cloud-providers";
import { discoverAuth, isBrowserUrl, type ServerAuth, signInWithClientId } from "./mcp-signin";
import { directNpx } from "./npx-runner";
import { readLocalMedia } from "./local-media";
import { hostIsOrUnder, readCapped, safeFetch } from "./safe-fetch";
import {
  type ConnectorOAuth,
  getConnectionConfig,
  getSettings,
  getConnectorOAuthValue,
  loadConnectors,
  saveConnectors,
  clearConnectorSignIn,
  setConnectorOAuthValue,
  type StoredConnector,
} from "./settings";

/**
 * Hearthside: connectors (MCP servers). Two kinds in one list:
 * - this computer: Hearthside connects to them and hands the tools you chose
 *   to the agent's chat sessions as custom tools (only those, so a big server
 *   doesn't flood the agent's context), filling in defaults like a voice;
 * - your Letta account (Cloud): servers registered on the account, whose tools
 *   are attached to agents and run by Letta Cloud.
 * Keys and passwords (env values, headers) are stored encrypted and never
 * sent to the window.
 */

function toConnector(stored: StoredConnector): Connector {
  return {
    id: stored.id,
    name: stored.name,
    where: "computer",
    kind: stored.kind,
    command: stored.command ?? "",
    args: stored.args ?? [],
    url: stored.url ?? "",
    envKeys: Object.keys(stored.env ?? {}),
    headerKeys: Object.keys(stored.headers ?? {}),
    agentIds: stored.agentIds,
    tools: [],
    preset: stored.preset ?? null,
    signedIn: Boolean(stored.oauth),
    enabledTools: stored.enabledTools ?? null,
    defaultVoice: stored.defaultVoice ?? null,
    voiceModel: stored.voiceModel ?? null,
  };
}

/** Where ElevenLabs' older (API key) server saves audio. */
export function voiceFolder(): string {
  const folder = join(app.getPath("music"), "Hearthside");
  mkdirSync(folder, { recursive: true });
  return folder;
}

function commandEnv(stored: StoredConnector): Record<string, string> | undefined {
  // ElevenLabs' older server writes audio under its base path (the Desktop by default).
  if (stored.preset === "elevenlabs-key") {
    return { ELEVENLABS_MCP_BASE_PATH: voiceFolder(), ELEVENLABS_MCP_OUTPUT_MODE: "files", ...stored.env };
  }
  return stored.env;
}

function isSse(url: string): boolean {
  return url.replace(/\/+$/, "").endsWith("/sse");
}

function webHeaders(stored: StoredConnector, token: string | null): Record<string, string> | undefined {
  const headers = { ...stored.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return Object.keys(headers).length ? headers : undefined;
}

async function clientConfig(stored: StoredConnector, token: string | null): Promise<McpServerConfig> {
  if (stored.kind === "command") {
    const env = commandEnv(stored);
    // npx connectors run directly with Hearthside's Node: npm would flash a console window.
    const direct = await directNpx(stored.command ?? "", stored.args ?? []);
    if (direct) return { name: stored.name, transport: "stdio", command: direct.command, args: direct.args, env: { ...env, ...direct.env } };
    return { name: stored.name, transport: "stdio", command: stored.command ?? "", args: stored.args ?? [], ...(env ? { env } : {}) };
  }
  const headers = webHeaders(stored, token);
  return { name: stored.name, transport: stored.transport ?? (isSse(stored.url ?? "") ? "sse" : "http"), url: stored.url ?? "", ...(headers ? { headers } : {}) };
}

// --- Live connections, reused across turns ---------------------------------------

type Live = { server: ConnectedMcpServer; signature: string; idleTimer: NodeJS.Timeout | null };
const live = new Map<string, Live>();
const connecting = new Map<string, Promise<ConnectedMcpServer>>();
const IDLE_MS = 10 * 60_000;

function signatureOf(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function touch(id: string, entry: Live): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => void dropConnection(id), IDLE_MS);
  entry.idleTimer.unref?.();
}

export async function dropConnection(id: string): Promise<void> {
  const entry = live.get(id);
  live.delete(id);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  await entry?.server.close().catch(() => undefined);
}

export async function closeAllConnectors(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => dropConnection(id)));
}

/**
 * What happens to a command connector's log output (stderr). The connection
 * library offers "pipe", but hands back nothing to read the pipe with, so a
 * server that logs each request (most Python ones) filled it within a few
 * hundred kilobytes and then froze inside its own logging call until the
 * connection was dropped. Nothing ever read that output, so it is thrown away
 * instead. The library passes this value straight to Node's spawn, which
 * accepts "ignore" although the library's own type doesn't list it.
 */
const DISCARD_STDERR = "ignore" as unknown as "pipe";

async function connection(stored: StoredConnector): Promise<ConnectedMcpServer> {
  const token = await freshToken(stored).catch(() => stored.oauth?.accessToken ?? null);
  let config: McpServerConfig;
  try {
    config = await clientConfig(stored, token);
  } catch (error) {
    throw new Error(friendlyConnectorError(error, stored));
  }
  const signature = signatureOf(config);
  const existing = live.get(stored.id);
  if (existing && existing.signature === signature) {
    touch(stored.id, existing);
    return existing.server;
  }
  if (existing) await dropConnection(stored.id);
  const pending = connecting.get(stored.id);
  if (pending) return pending;
  const attempt = (async () => {
    const { connectMcpServer } = await import("@letta-ai/letta-code/mcp-client");
    // The connect signal stays attached to every later web request on this
    // connection, so it must only limit connecting, then never fire.
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new Error("It didn't answer within a minute.")), 60_000);
    try {
      const server = await connectMcpServer(config, {
        clientInfo: { name: "Hearthside", version: app.getVersion() },
        stderr: DISCARD_STDERR,
        signal: limit.signal,
      });
      clearTimeout(timer);
      const entry: Live = { server, signature, idleTimer: null };
      live.set(stored.id, entry);
      touch(stored.id, entry);
      return server;
    } catch (error) {
      throw new Error(friendlyConnectorError(error, stored));
    } finally {
      clearTimeout(timer);
      connecting.delete(stored.id);
    }
  })();
  connecting.set(stored.id, attempt);
  return attempt;
}

// --- Choosing tools -----------------------------------------------------------------

/** Rough size in tokens of what a tool adds to every message. */
function toolTokens(tool: McpToolDefinition): number {
  return Math.ceil(JSON.stringify({ name: tool.name, description: tool.description ?? "", schema: tool.inputSchema }).length / 4);
}

/** Tools on by default, so a big server can't fill the agent's context by itself. */
const DEFAULT_BUDGET = 25_000;
const ELEVENLABS_DEFAULTS = /^(text_to_speech|search_voices|list_voices|get_voice|get_voices|text_to_sound_effects|speech_to_text)$/;

// ElevenLabs' hosted server has ~160 tools (most for building phone agents). Hearthside
// gives the agent one simple voice-message tool and sorts the rest into a few groups.
const SPEAK = "voice_message";
/** Only Eleven v3 understands these. */
const SPEAK_TAGS = " You can add audio tags for expression, e.g. [whispers], [laughs softly], [sighs].";
const SPEAK_TOOL: McpToolDefinition = {
  name: SPEAK,
  description:
    "Send the user a voice message: speaks the text aloud with ElevenLabs and plays it in the chat. Use it when the user asks to hear you, or when a spoken message suits the moment.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to say, exactly as it should be spoken." },
      voice_id: { type: "string", description: "Only to use a different voice than the usual one." },
    },
    required: ["text"],
  },
};

/** Tools meant for ElevenLabs' own web view, never for an agent. */
const HIDDEN = /^creative_(get|save)_view_state$/;

function elevenLabsGroup(name: string): string {
  if (name === SPEAK) return "Voice messages";
  if (name === "creative_transcribe_audio") return "Transcribe audio";
  if (/^creative_(list_voices|design_voice|save_designed_voice|get_voice_design_previews)$/.test(name)) return "Find and design voices";
  if (/brand_kit/.test(name)) return "Brand kits";
  if (name.startsWith("agents_")) return "Build ElevenLabs voice agents (advanced)";
  if (name.startsWith("creative_")) return "Images, video and the creative canvas (advanced)";
  return "Other";
}

function genericGroup(name: string, tools: McpToolDefinition[]): string {
  const prefix = name.split(/[_\-.]/)[0] ?? name;
  const siblings = tools.filter((tool) => (tool.name.split(/[_\-.]/)[0] ?? tool.name) === prefix).length;
  if (siblings < 3) return "Tools";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** The connector's tools as Hearthside offers them (ElevenLabs gets its voice-message tool). */
function offeredTools(stored: StoredConnector, tools: McpToolDefinition[]): McpToolDefinition[] {
  const visible = tools.filter((tool) => !HIDDEN.test(tool.name));
  const canSpeak = stored.preset === "elevenlabs" && tools.some((tool) => tool.name === "creative_generate_speech");
  return canSpeak ? [SPEAK_TOOL, ...visible] : visible;
}

function groupOf(stored: StoredConnector, name: string, tools: McpToolDefinition[]): string {
  return stored.preset?.startsWith("elevenlabs") ? elevenLabsGroup(name) : genericGroup(name, tools);
}

const ELEVENLABS_KEY_DEFAULTS = /^(text_to_speech|search_voices|list_voices|get_voice|get_voices|text_to_sound_effects|speech_to_text)$/;
/** Bumped when the defaults change, so connectors set up before pick up the new ones. */
const DEFAULTS_VERSION = 2;

function defaultTools(stored: StoredConnector, tools: McpToolDefinition[]): string[] {
  if (stored.preset === "elevenlabs" && tools.some((tool) => tool.name === SPEAK)) return [SPEAK];
  if (stored.preset?.startsWith("elevenlabs")) {
    const picked = tools.filter((tool) => ELEVENLABS_KEY_DEFAULTS.test(tool.name)).map((tool) => tool.name);
    if (picked.length) return picked;
  }
  const names: string[] = [];
  let used = 0;
  for (const tool of tools) {
    const size = toolTokens(tool);
    if (used + size > DEFAULT_BUDGET) continue;
    used += size;
    names.push(tool.name);
  }
  return names;
}

function enabledNames(stored: StoredConnector, tools: McpToolDefinition[]): Set<string> {
  if (stored.enabledTools && (stored.defaultsVersion ?? 1) >= DEFAULTS_VERSION) return new Set(stored.enabledTools);
  const names = defaultTools(stored, tools);
  // Remember the first choice so it stays stable when the server adds tools.
  updateStored(stored.id, (connector) => ({ ...connector, enabledTools: names, defaultsVersion: DEFAULTS_VERSION }));
  return new Set(names);
}

function describeTools(stored: StoredConnector, serverTools: McpToolDefinition[]): ConnectorTool[] {
  const tools = offeredTools(stored, serverTools);
  const enabled = enabledNames(stored, tools);
  return tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description ?? "",
    enabled: enabled.has(tool.name),
    tokens: toolTokens(tool),
    group: groupOf(stored, tool.name, tools),
  }));
}

export function setConnectorTools(id: string, names: string[]): void {
  updateStored(id, (connector) => ({ ...connector, enabledTools: names, defaultsVersion: DEFAULTS_VERSION }));
}

// --- Voice (ElevenLabs and other speech tools) ------------------------------------------

export const DEFAULT_VOICE_MODEL = "eleven_v3";

export function setConnectorVoiceModel(id: string, model: string | null): void {
  updateStored(id, ({ voiceModel: _old, ...connector }) => (model ? { ...connector, voiceModel: model } : connector));
}

export function setConnectorVoice(id: string, voice: ConnectorVoice | null): void {
  updateStored(id, ({ defaultVoice: _old, ...connector }) => (voice ? { ...connector, defaultVoice: voice } : connector));
}

/** Pull voice names and ids out of whatever a "list voices" tool returned. */
export function parseVoices(text: string): ConnectorVoice[] {
  const found = new Map<string, ConnectorVoice>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const id = record.voice_id ?? record.voiceId ?? record.id;
      if (typeof id === "string" && typeof record.name === "string") found.set(id, { id, name: record.name });
      Object.values(record).forEach(visit);
    }
  };
  try {
    visit(JSON.parse(text));
  } catch {
    // Not JSON: look for "Name ... ID: xxxxx" style lines.
  }
  if (found.size === 0) {
    for (const line of text.split(/\r?\n/)) {
      const id = /\b([A-Za-z0-9]{20})\b/.exec(line)?.[1];
      if (!id) continue;
      const labelled = /\bname\s*[:=]\s*([^,;|\n]+)/i.exec(line)?.[1]?.trim();
      const name = (labelled ?? line)
        .replace(id, "")
        .replace(/\b(voice[_ ]?id|id|name)\s*[:=]/gi, "")
        .replace(/[,;()[\]{}"'|-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (name) found.set(id, { id, name: name.slice(0, 60) });
    }
  }
  return [...found.values()].slice(0, 200);
}

function resultText(content: unknown[]): string {
  return content
    .map((item) => (item && typeof item === "object" && (item as { type?: string }).type === "text" ? String((item as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

export async function listConnectorVoices(id: string): Promise<ConnectorVoice[]> {
  const stored = loadConnectors().find((connector) => connector.id === id);
  if (!stored) throw new Error("That connector is gone.");
  const server = await connection(stored);
  const tool =
    server.tools.find((item) => /^(creative_list_voices|search_voices|list_voices|get_voices)$/.test(item.name)) ?? server.tools.find((item) => /voices/.test(item.name));
  if (!tool) throw new Error("This connector has no tool that lists voices. Type the voice name instead.");
  const needsContext = ((tool.inputSchema as { required?: string[] }).required ?? []).includes("context");
  const result = await server.callTool(tool.name, needsContext ? { context: "Choosing the default voice in Hearthside" } : {}, { signal: AbortSignal.timeout(30_000) });
  const voices = parseVoices(resultText(result.content));
  if (voices.length === 0) throw new Error("Couldn't read the voice list. Type the voice name instead.");
  return voices;
}

function withVoice(stored: StoredConnector, tool: McpToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const voice = stored.defaultVoice;
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  if (!voice || args.voice_id || args.voice_name) return args;
  if ("voice_id" in properties && voice.id) return { ...args, voice_id: voice.id };
  if ("voice_name" in properties) return { ...args, voice_name: voice.name };
  return args;
}

function usesVoice(tool: McpToolDefinition): boolean {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return "voice_id" in properties || "voice_name" in properties;
}

// --- ElevenLabs voice message (runs the hosted server's multi-step speech job) -----------

function parseJsonText(content: unknown[]): Record<string, unknown> {
  const text = resultText(content);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    try {
      return match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

/** Every URL in a result, audio-looking ones first. */
export function audioUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/https?:\/\/[^\s"'<>]+/g)) urls.add(match[0]);
    } else if (Array.isArray(item)) item.forEach((entry) => visit(entry, key));
    else if (item && typeof item === "object") for (const [name, entry] of Object.entries(item)) visit(entry, name);
  };
  visit(value);
  const score = (url: string) => (/\.(mp3|wav|ogg|m4a|opus|flac|webm)(\?|$)/i.test(url) ? 0 : /audio|speech|generation|output/i.test(url) ? 1 : 2);
  return [...urls].filter((url) => !/orb|thumbnail|\.webp|\.png|\.jpe?g/i.test(url)).sort((a, b) => score(a) - score(b));
}

/** Voice files are small; anything past this isn't a voice message. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;



export function tokenHostCheck(connectorUrl: string | undefined): (url: URL) => boolean {
  let own: string | null = null;
  try {
    own = connectorUrl ? new URL(connectorUrl).hostname.toLowerCase() : null;
  } catch {
    own = null;
  }
  return (url) => url.protocol === "https:" && (hostIsOrUnder(url.hostname, "elevenlabs.io") || (own !== null && url.hostname.toLowerCase() === own));
}

async function downloadAudio(urls: string[], token: string | null, trusted: (url: URL) => boolean): Promise<string | null> {
  for (const url of urls.slice(0, 6)) {
    const attempts: Array<string | null> = [null];
    try {
      if (token && trusted(new URL(url))) attempts.push(`Bearer ${token}`);
    } catch {
      continue;
    }
    for (const authorization of attempts) {
      try {
        const response = await safeFetch(url, { authorization, trusted, timeoutMs: 60_000 });
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !(type.startsWith("audio/") || type === "application/octet-stream")) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        const bytes = await readCapped(response, MAX_AUDIO_BYTES);
        return saveAudio(bytes.toString("base64"), type.startsWith("audio/") ? type.split(";")[0]! : "audio/mpeg");
      } catch {
        // Try the next one.
      }
    }
  }
  return null;
}

async function speak(current: StoredConnector, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResultContent[]> {
  const server = await connection(current);
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("Nothing to say: pass the text to speak.");
  let voiceId = typeof args.voice_id === "string" && args.voice_id ? args.voice_id : current.defaultVoice?.id;
  if (!voiceId) {
    const listed = await server.callTool("creative_list_voices", { context: "Picking a voice for a voice message" }, { signal: AbortSignal.timeout(30_000) });
    voiceId = parseVoices(resultText(listed.content))[0]?.id;
  }
  if (!voiceId) throw new Error("No voice to use. Choose one on the Connectors page.");
  const started = await server.callTool(
    "creative_generate_speech",
    { prompt: text, voice_id: voiceId, model_id: current.voiceModel ?? DEFAULT_VOICE_MODEL, generations_count: 1, context: "A voice message for the user, sent from Hearthside" },
    signal ? { signal } : undefined,
  );
  if (started.isError) throw new Error(resultText(started.content) || "ElevenLabs couldn't start the voice message.");
  const job = parseJsonText(started.content);
  const flowId = job.flow_id;
  const sessions = job.session_ids;
  if (typeof flowId !== "string" || !Array.isArray(sessions)) throw new Error(`ElevenLabs answered unexpectedly: ${resultText(started.content).slice(0, 300)}`);
  const deadline = Date.now() + 3 * 60_000;
  let status: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Stopped.");
    const wait = Math.min(Math.max(Number(status.poll_after_seconds) || 2, 1), 10) * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const polled = await server.callTool("creative_get_flow_run_status", { flow_id: flowId, session_ids: sessions, context: "Waiting for the voice message" }, signal ? { signal } : undefined);
    status = parseJsonText(polled.content);
    if (status.has_failures === true) throw new Error(`ElevenLabs couldn't make the voice message: ${resultText(polled.content).slice(0, 300)}`);
    if (status.all_completed === true) break;
  }
  if (status.all_completed !== true) throw new Error("ElevenLabs is taking too long. Try again in a moment.");
  const token = await freshToken(current).catch(() => current.oauth?.accessToken ?? null);
  const path = await downloadAudio(audioUrls(status), token, tokenHostCheck(current.url));
  const canvas = typeof job.url === "string" ? `\nOpen in ElevenLabs: ${job.url}` : "";
  if (!path) return [{ type: "text", text: `The voice message is ready in ElevenLabs, but Hearthside couldn't download it.${canvas}\n${JSON.stringify(status).slice(0, 1500)}` }];
  return [{ type: "text", text: `Voice message sent. Audio saved as: ${path}${canvas}` }];
}

// --- Tools for a chat session ----------------------------------------------------------

const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac" };

/** Audio a tool returned inline is saved as a file, so the chat can play it. */
function saveAudio(data: string, mimeType: string): string {
  const path = join(voiceFolder(), `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.${AUDIO_EXT[mimeType] ?? "mp3"}`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

function toContent(items: unknown[]): AgentToolResultContent[] {
  const out: AgentToolResultContent[] = [];
  for (const raw of items) {
    const item = raw as { type?: string; text?: string; data?: string; mimeType?: string; uri?: string; resource?: { text?: string; blob?: string; mimeType?: string; uri?: string } };
    if (item.type === "text") out.push({ type: "text", text: item.text ?? "" });
    else if (item.type === "image" && item.data) out.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
    else if (item.type === "audio" && item.data) out.push({ type: "text", text: `Audio saved as: ${saveAudio(item.data, item.mimeType ?? "audio/mpeg")}` });
    else if (item.type === "resource" && item.resource) {
      const resource = item.resource;
      if (resource.blob && resource.mimeType?.startsWith("audio/")) out.push({ type: "text", text: `Audio saved as: ${saveAudio(resource.blob, resource.mimeType)}` });
      else if (resource.blob && resource.mimeType?.startsWith("image/")) out.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
      else if (resource.text !== undefined) out.push({ type: "text", text: resource.text });
      else if (resource.uri) out.push({ type: "text", text: resource.uri });
    } else if (item.type === "resource_link" && item.uri) out.push({ type: "text", text: item.uri });
  }
  return out.length ? out : [{ type: "text", text: "(no output)" }];
}

const connectorKey = (stored: StoredConnector) => stored.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "connector";

/** Allocate in identity order, not connection-completion order. Keep short names readable. */
function nameTools(entries: Array<{ stored: StoredConnector; original: string; tool: AnyAgentTool }>): AnyAgentTool[] {
  const candidate = (entry: (typeof entries)[number]) => `mcp__${connectorKey(entry.stored)}__${entry.original.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(candidate(entry), (counts.get(candidate(entry)) ?? 0) + 1);
  const taken = new Set<string>();
  const identity = (entry: (typeof entries)[number]) => JSON.stringify([entry.stored.id, entry.original]);
  for (const entry of [...entries].sort((a, b) => identity(a).localeCompare(identity(b)))) {
    const base = candidate(entry);
    let name = base;
    let attempt = 0;
    if (base.length > 64 || counts.get(base)! > 1) {
      do {
        const suffix = createHash("sha256").update(`${identity(entry)}:${attempt++}`).digest("hex").slice(0, 16);
        name = `${base.slice(0, 47)}_${suffix}`;
      } while (taken.has(name) || counts.has(name));
    }
    taken.add(name);
    entry.tool.name = name;
  }
  return entries.map(({ tool }) => tool);
}



export function stillAllowed(id: string, agentId: string, toolName: string, offered: McpToolDefinition[]): StoredConnector | null {
  const current = loadConnectors().find((item) => item.id === id);
  if (!current || !current.agentIds.includes(agentId)) return null;
  return enabledNames(current, offered).has(toolName) ? current : null;
}

const notAllowed = (name: string) => ({ content: [{ type: "text" as const, text: `${name} isn't available to you any more: it was removed, detached, or this tool was switched off.` }], isError: true });

/** The chosen tools of an agent's connectors, ready for its chat session. */
export async function connectorToolsFor(agentId: string, onError?: (message: string) => void): Promise<AnyAgentTool[]> {
  const enabled = loadConnectors().filter((connector) => connector.agentIds.includes(agentId));
  const entries: Array<{ stored: StoredConnector; original: string; tool: AnyAgentTool }> = [];
  await Promise.all(
    enabled.map(async (stored) => {
      const tools: AnyAgentTool[] = [];
      let server: ConnectedMcpServer;
      try {
        server = await connection(stored);
      } catch (error) {
        onError?.(`${stored.name}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const offered = offeredTools(stored, server.tools);
      const chosen = enabledNames(stored, offered);
      for (const tool of offered) {
        if (!chosen.has(tool.name)) continue;
        if (tool.name === SPEAK) {
          tools.push({
            name: SPEAK,
            label: "Voice message",
            description: `${tool.description ?? ""}${(stored.voiceModel ?? DEFAULT_VOICE_MODEL) === "eleven_v3" ? SPEAK_TAGS : ""}${stored.defaultVoice ? ` Your usual voice: ${stored.defaultVoice.name}.` : ""}`,
            parameters: tool.inputSchema,
            execute: async (_toolCallId, args, signal) => {
              const current = stillAllowed(stored.id, agentId, SPEAK, offered);
              if (!current) return notAllowed(stored.name);
              try {
                return { content: await speak(current, (args ?? {}) as Record<string, unknown>, signal) };
              } catch (error) {
                return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
              }
            },
          });
          continue;
        }
        const voiceNote = stored.defaultVoice && usesVoice(tool) ? ` Default voice: ${stored.defaultVoice.name} (used unless you choose another).` : "";
        tools.push({
          name: tool.name,
          label: tool.title ?? tool.name,
          description: `${tool.description ?? tool.name}${voiceNote}`,
          parameters: tool.inputSchema,
          execute: async (_toolCallId, args, signal) => {
            const current = stillAllowed(stored.id, agentId, tool.name, offered);
            if (!current) return notAllowed(stored.name);
            const input = withVoice(current, tool, (args ?? {}) as Record<string, unknown>);
            const call = async () => (await connection(current)).callTool(tool.name, input, signal ? { signal } : undefined);
            let result;
            try {
              result = await call();
            } catch (error) {
              // The server may have completed a mutation before its response was lost.
              // Reconnect on the NEXT call, never replay this one automatically.
              void dropConnection(stored.id);
              return { content: [{ type: "text", text: `The call failed; its outcome may be unknown. It was not retried. ${friendlyConnectorError(error, stored)}` }], isError: true };
            }
            return { content: toContent(result.content), ...(result.isError ? { isError: true } : {}) };
          },
        });
      }
      entries.push(...tools.map((tool) => ({ stored, original: tool.name, tool })));
    }),
  );
  return nameTools(entries);
}

// --- Browser sign-in (OAuth) for web connectors ----------------------------------

/**
 * Where the sign-in library keeps its working copy of a sign-in. It used to be
 * the settings file, but nothing ever removed an entry: "Sign out" and removing
 * a connector left the tokens on disk, and the next "Sign in" quietly picked
 * them up again without opening the browser, so switching accounts was not
 * possible. Hearthside keeps what it needs on the connector itself, so the
 * library's copy lives in memory and is dropped as soon as the sign-in ends.
 */
const signInScratch = new Map<string, string>();
let signInsRunning = 0;
const oauthStorage = {
  get: async (key: string) => signInScratch.get(key) ?? null,
  set: async (key: string, value: string) => void signInScratch.set(key, value),
  delete: async (key: string) => signInScratch.delete(key),
};

/**
 * The name the sign-in library files a connector's sign-in under (its
 * mcp-oauth-identity, as of the pinned 0.34.36). Only used to clear out copies
 * that versions before this one left in the settings file.
 */
export function savedSignInKey(name: string, url: string): string {
  let address = url;
  try {
    const parsed = new URL(url);
    const suffix = parsed.search + parsed.hash;
    address = parsed.pathname !== "/" ? parsed.href : parsed.href.slice(0, parsed.href.length - suffix.length - 1) + suffix;
  } catch {
    // Filed under the address as typed.
  }
  return `mcp-oauth-${createHash("sha256").update(`hearthside\x00${name}\x00${address}`).digest("hex").slice(0, 32)}`;
}

/** Remove any copy of this connector's sign-in an earlier version left in the settings file. */
function forgetSavedSignIn(stored: Pick<StoredConnector, "name" | "url"> | undefined): void {
  if (!stored?.url) return;
  const key = savedSignInKey(stored.name, stored.url);
  try {
    // Only write when there is something to remove: most connectors never had one.
    if (getConnectorOAuthValue(key) !== null) setConnectorOAuthValue(key, null);
  } catch (error) {
    console.warn(`[connectors] ${stored.name}: couldn't clear its old saved sign-in: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function updateStored(id: string, change: (connector: StoredConnector) => StoredConnector): void {
  saveConnectors(loadConnectors().map((connector) => (connector.id === id ? change(connector) : connector)));
}

/**
 * The address to keep after sign-in. A server may name a regional host for itself
 * (api.us.elevenlabs.io for api.elevenlabs.io): take that host, same site only,
 * but keep the connector's own path (Notion names just its origin).
 */
export function regionalUrl(url: string, resource: string): string {
  try {
    const current = new URL(url);
    const named = new URL(resource);
    const site = (host: string) => host.split(".").slice(-2).join(".");
    if (named.host === current.host || site(named.hostname) !== site(current.hostname)) return url;
    current.host = named.host;
    return current.toString();
  } catch {
    return url;
  }
}

export async function signInConnector(id: string): Promise<void> {
  const stored = loadConnectors().find((connector) => connector.id === id);
  if (!stored || stored.kind !== "url" || !stored.url) throw new Error("Only web connectors can sign in.");
  const site = (url: string) => new URL(url).hostname.split(".").slice(-2).join(".");
  // Servers that accept an app identified by a public address (ElevenLabs, Notion, Todoist…) get
  // Hearthside's client ID, so their sign-in page names Hearthside. Others register on the spot below.
  const auth = await discoverAuth(stored.url);
  if (auth?.clientIdDocuments) {
    const tokens = await signInWithClientId(auth, AbortSignal.timeout(5 * 60_000));
    const url = regionalUrl(stored.url, auth.resource);
    const oauth: ConnectorOAuth = {
      accessToken: tokens.accessToken,
      clientId: tokens.clientId,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresIn ? { expiresAt: Date.now() + tokens.expiresIn * 1000 } : {}),
      ...boundServer(auth),
    };
    updateStored(id, (connector) => ({ ...connector, url, oauth }));
    return;
  }
  const { authorizeMcpServerWithStorage } = await import("@letta-ai/letta-code/mcp-oauth");
  const authorize = (serverUrl: string) =>
    authorizeMcpServerWithStorage({
      agentId: "hearthside",
      storageNamespace: "hearthside-settings",
      storage: oauthStorage,
      serverName: stored.name,
      serverUrl,
      openBrowser: async (url) => {
        if (!isBrowserUrl(url)) throw new Error("The sign-in page isn't a web address, so it wasn't opened.");
        await shell.openExternal(url);
      },
      signal: AbortSignal.timeout(5 * 60_000),
    });
  let snapshot;
  let signedInAt = stored.url;
  // "Sign in" always means the browser, whatever an earlier version left behind.
  forgetSavedSignIn(stored);
  signInsRunning += 1;
  try {
    try {
      snapshot = await authorize(stored.url);
    } catch (error) {
      // Some servers live at a regional address (e.g. api.us.elevenlabs.io); follow it once, same site only.
      const moved = /Protected resource (https:\/\/\S+) does not match/.exec(error instanceof Error ? error.message : String(error))?.[1];
      if (!moved || site(moved) !== site(stored.url)) throw error;
      forgetSavedSignIn({ name: stored.name, url: moved });
      snapshot = await authorize(moved);
      signedInAt = moved;
      updateStored(id, (connector) => ({ ...connector, url: moved }));
    }
  } finally {
    // Two connectors can be signing in at once; clear up when the last one ends.
    signInsRunning -= 1;
    if (signInsRunning === 0) signInScratch.clear();
  }
  // Pin where renewals go now, while the sign-in is fresh.
  const bound = await discoverAuth(signedInAt).catch(() => null);
  const oauth: ConnectorOAuth = {
    accessToken: snapshot.access_token,
    clientId: snapshot.client_id,
    ...(snapshot.refresh_token ? { refreshToken: snapshot.refresh_token } : {}),
    ...(snapshot.client_secret ? { clientSecret: snapshot.client_secret } : {}),
    ...(snapshot.expires_in ? { expiresAt: Date.now() + snapshot.expires_in * 1000 } : {}),
    ...(bound ? boundServer(bound) : {}),
  };
  updateStored(id, (connector) => ({ ...connector, oauth }));
}

const oauthGenerations = new Map<string, number>();

export function signOutConnector(id: string): void {
  oauthGenerations.set(id, (oauthGenerations.get(id) ?? 0) + 1);
  void dropConnection(id);
  const connector = loadConnectors().find((entry) => entry.id === id);
  clearConnectorSignIn(id, connector?.url ? savedSignInKey(connector.name, connector.url) : undefined);
}

function boundServer(auth: ServerAuth): Pick<ConnectorOAuth, "issuer" | "tokenEndpoint" | "resource"> {
  return { issuer: auth.issuer, tokenEndpoint: auth.tokenEndpoint, resource: auth.resource };
}

type RenewalTarget = { tokenEndpoint: string; resource: string; bindNow?: Pick<ConnectorOAuth, "issuer" | "tokenEndpoint" | "resource"> };

/**
 * The registrable part of a host name, roughly: the last two labels, or three
 * for a country second level such as example.co.uk.
 */
export function siteOf(value: string): string {
  const labels = new URL(value).hostname.toLowerCase().replace(/\.$/, "").split(".");
  const two = labels.slice(-2);
  const countrySecondLevel = labels.length >= 3 && two[1]!.length === 2 && ["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or"].includes(two[0]!);
  return labels.slice(countrySecondLevel ? -3 : -2).join(".");
}



export async function renewalTarget(stored: Pick<StoredConnector, "name" | "url" | "oauth">, discover: (url: string) => Promise<ServerAuth | null> = discoverAuth): Promise<RenewalTarget | null> {
  const oauth = stored.oauth;
  if (!oauth || !stored.url) return null;
  if (oauth.tokenEndpoint) return isBrowserUrl(oauth.tokenEndpoint) ? { tokenEndpoint: oauth.tokenEndpoint, resource: oauth.resource ?? stored.url } : null;
  const auth = await discover(stored.url).catch(() => null);
  if (!auth) return null;
  try {
    const home = siteOf(stored.url);
    if (siteOf(auth.issuer) !== home || siteOf(auth.tokenEndpoint) !== home) {
      console.warn(`[connectors] ${stored.name}: signed in before 0.1.16 with a sign-in server on another site; sign in again to keep it renewing`);
      return null;
    }
  } catch {
    return null;
  }
  return { tokenEndpoint: auth.tokenEndpoint, resource: auth.resource, bindNow: boundServer(auth) };
}

/** Renewals under way, so calls that overlap share one instead of each spending the refresh token. */
const renewals = new Map<string, Promise<string | null>>();

/** The connector's access token, refreshed when it is about to run out. */
async function freshToken(stored: StoredConnector): Promise<string | null> {
  // Callers may hold a copy read before another call renewed the sign-in. Work
  // from what is saved now, or the spent refresh token would be sent again.
  const saved = loadConnectors().find((item) => item.id === stored.id);
  const oauth = saved && saved.url === stored.url ? saved.oauth : stored.oauth;
  if (!oauth) return null;
  if (!oauth.expiresAt || oauth.expiresAt - Date.now() > 120_000 || !oauth.refreshToken) return oauth.accessToken;
  // Two tool calls at once (or two chats starting) near expiry: the second waits
  // for the first's answer. Sent twice, a server that rotates refresh tokens can
  // treat the repeat as theft and end the sign-in; and the call that lost used to
  // connect signed out, closing the connection the other call was using.
  const key = `${stored.id}\n${oauth.refreshToken}`;
  const running = renewals.get(key);
  if (running) return running;
  const renewal = renewToken({ ...stored, oauth }, oauth, oauth.refreshToken).finally(() => {
    if (renewals.get(key) === renewal) renewals.delete(key);
  });
  renewals.set(key, renewal);
  return renewal;
}

async function renewToken(stored: StoredConnector, oauth: ConnectorOAuth, refreshToken: string): Promise<string | null> {
  const generation = oauthGenerations.get(stored.id);
  const snapshot = JSON.stringify(oauth);
  const isCurrent = () => {
    const current = loadConnectors().find((item) => item.id === stored.id);
    return oauthGenerations.get(stored.id) === generation && current?.url === stored.url && JSON.stringify(current?.oauth) === snapshot;
  };
  // Someone else changed the sign-in meanwhile (signed out, signed in again, or
  // renewed it): use whatever is saved now, which is nothing after a sign-out.
  const savedNow = () => {
    const current = loadConnectors().find((item) => item.id === stored.id);
    return current && current.url === stored.url ? (current.oauth?.accessToken ?? null) : null;
  };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: oauth.clientId });
  if (oauth.clientSecret) body.set("client_secret", oauth.clientSecret);
  // Never send refresh credentials to a guessed or newly discovered /token endpoint.
  const target = await renewalTarget(stored);
  if (!target) {
    console.warn(`[connectors] ${stored.name}: couldn't find where to renew its sign-in; using the current one`);
    return oauth.accessToken;
  }
  if (!isCurrent()) return savedNow();
  body.set("resource", target.resource);
  const response = await fetch(target.tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    // Diagnosable: a server may refuse the refresh (e.g. the resource parameter); sign in again if calls start failing.
    console.warn(`[connectors] ${stored.name}: renewing its sign-in was refused (${response.status}); using the current one`);
    await response.body?.cancel();
    return oauth.accessToken;
  }
  const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  // A sign-out, replacement, or another completed renewal owns the state now.
  if (!isCurrent()) return savedNow();
  if (!data.access_token) {
    console.warn(`[connectors] ${stored.name}: the sign-in renewal had no new token; using the current one`);
    return oauth.accessToken;
  }
  const next: ConnectorOAuth = {
    ...oauth,
    ...target.bindNow,
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
  };
  updateStored(stored.id, (connector) => ({ ...connector, oauth: next }));
  return next.accessToken;
}

// --- Audio player ------------------------------------------------------------------

const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

/** An audio file an agent made, as a data: URL (audio files only, up to 40 MB). */
export function readAudioFile(path: string): Promise<string> {
  return readLocalMedia(path, AUDIO_TYPES, 40 * 1024 * 1024, { kind: "an audio file", gone: "That audio file is gone.", tooBig: "That audio file is too big to play here." });
}

// --- Letta account (Cloud) ----------------------------------------------------



export function redactCloudError(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password|cookie|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)[^"',\s&}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|lk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

async function cloud<T>(method: string, path: string, auth?: Awaited<ReturnType<typeof cloudAuth>>): Promise<T> {
  const { baseUrl, token } = auth ?? await cloudAuth();
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Letta Cloud said ${response.status}: ${redactCloudError(text.slice(0, 200))}`);
  return (text ? JSON.parse(text) : {}) as T;
}

type CloudServer = { id: string; server_name: string; mcp_server_type?: string; server_url?: string; command?: string };
type CloudTool = {
  id: string; name?: string | null; description?: string | null;
  json_schema?: Record<string, unknown> | null;
  args_json_schema?: Record<string, unknown> | null;
};

/** Zero means unavailable, not a measured zero-cost schema. */
function cloudToolTokens(tool: CloudTool): number {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const schema = record(tool.json_schema) ? tool.json_schema : record(tool.args_json_schema)
    ? { name: tool.name ?? tool.id, description: tool.description ?? "", parameters: tool.args_json_schema }
    : null;
  return schema === null ? 0 : Math.ceil(JSON.stringify(schema).length / 4);
}

type ToolDiscovery = { status: "success"; tools: CloudTool[] } | { status: "unavailable"; error: string };

/** Only exact IDs from this server's catalog establish provenance. Names are never evidence. */
export function mapCloudConnector(server: CloudServer, agentId: string, catalog: ToolDiscovery, attached: ToolDiscovery): Connector {
  const tools = catalog.status === "success" ? catalog.tools : [];
  const ids = attached.status === "success" ? new Set(attached.tools.map((tool) => tool.id)) : null;
  const count = ids ? tools.filter((tool) => ids.has(tool.id)).length : 0;
  const attachment = !ids || !tools.length ? "unknown" : count === tools.length ? "on" : count ? "partial" : "off";
  return {
    id: `letta:${server.id}`, name: server.server_name, where: "letta",
    kind: server.mcp_server_type === "stdio" ? "command" : "url",
    command: server.command ?? "", args: [], url: server.server_url ?? "", envKeys: [], headerKeys: [],
    agentIds: count ? [agentId] : [],
    cloudDiscovery: {
      discoveryId: "", catalog: catalog.status, attachment,
      error: [catalog.status === "unavailable" ? `Tool catalog unavailable: ${catalog.error}` : null,
        attached.status === "unavailable" ? `Agent attachments unavailable: ${attached.error}` : null].filter(Boolean).join(" ") || null,
    },
    preset: null, signedIn: false, enabledTools: null, defaultVoice: null, voiceModel: null,
    tools: tools.map((tool) => ({ id: tool.id, name: tool.name || tool.id, description: tool.description ?? "", enabled: ids ? ids.has(tool.id) : null, tokens: cloudToolTokens(tool), group: "Tools" })),
  };
}

const cloudEvidence = new Map<string, { request: string; identity: string; tools: Set<string> }>();
function cloudIdentity(): string {
  const config = getConnectionConfig();
  return createHash("sha256").update(JSON.stringify([config.backend, config.apiBaseUrl, config.serverUrl,
    config.apiKey, config.lettaSignedIn, config.serverToken, getSettings().connectionRevision])).digest("hex");
}

async function cloudConnectors(agentId: string): Promise<Connector[]> {
  const request = randomUUID();
  const identity = cloudIdentity();
  cloudEvidence.set(agentId, { request, identity: "", tools: new Set() });
  // Keep every read in this discovery on the same account, even if settings change mid-flight.
  const auth = await cloudAuth();
  if (cloudIdentity() !== identity) throw new Error("The account changed. Please retry.");
  const discover = async (path: string): Promise<ToolDiscovery> => {
    try {
      if (cloudIdentity() !== identity || cloudEvidence.get(agentId)?.request !== request) throw new Error("Discovery changed.");
      const tools = await cloud<CloudTool[]>("GET", path, auth);
      if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool.id !== "string" || !tool.id.trim())) {
        throw new Error("The tool list was not a valid catalog.");
      }
      return { status: "success", tools };
    } catch (error) {
      return { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
    }
  };
  const discoverAttached = async (): Promise<ToolDiscovery> => {
    const tools: CloudTool[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let after = "";
    // Letta SDK ArrayPage advances with the last ID, even for a short page,
    // and finishes only on an empty page. Never guess completeness from length.
    for (let page = 0; page < 20; page += 1) {
      const result = await discover(`/v1/agents/${encodeURIComponent(agentId)}/tools?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      if (result.status === "unavailable") return result;
      if (!result.tools.length) return { status: "success", tools };
      const cursor = result.tools[result.tools.length - 1]!.id;
      // Overlapping pages are valid; repeated cursors or no new IDs are not
      // evidence of completeness. Keep the bound even if every cursor is new.
      if (cursors.has(cursor) || result.tools.every((tool) => seen.has(tool.id))) {
        return { status: "unavailable", error: "The attachment list did not advance. Please retry." };
      }
      cursors.add(cursor);
      for (const tool of result.tools) {
        if (!seen.has(tool.id)) tools.push(tool);
        seen.add(tool.id);
      }
      after = cursor;
    }
    return { status: "unavailable", error: "The attachment list exceeded the bounded discovery limit; completeness could not be verified." };
  };
  const [servers, attached] = await Promise.all([
    cloud<CloudServer[]>("GET", "/v1/mcp-servers/", auth),
    discoverAttached(),
  ]);
  const connectors = await Promise.all(servers.map(async (server) => mapCloudConnector(server, agentId,
    await discover(`/v1/mcp-servers/${encodeURIComponent(server.id)}/tools`), attached)));
  if (cloudEvidence.get(agentId)?.request !== request || cloudIdentity() !== identity) {
    throw new Error("The account or discovery request changed. Please retry.");
  }
  for (const connector of connectors) connector.cloudDiscovery!.discoveryId = request;
  cloudEvidence.set(agentId, { request, identity, tools: new Set(connectors
    .filter((connector) => connector.cloudDiscovery?.attachment !== "unknown")
    .flatMap((connector) => connector.tools.map((tool) => tool.id))) });
  return connectors;
}

export async function setLettaToolAttached(agentId: string, toolId: string, attached: boolean, discoveryId: string): Promise<void> {
  const identity = cloudIdentity();
  const auth = await cloudAuth();
  const evidence = cloudEvidence.get(agentId);
  if (getConnectionConfig().backend !== "cloud" || !evidence?.tools.has(toolId) || evidence.request !== discoveryId || evidence.identity !== identity || cloudIdentity() !== identity) {
    throw new Error("Attachment state is not verified for this account. Refresh connectors before changing tools.");
  }
  try {
    await cloud("PATCH", `/v1/agents/${encodeURIComponent(agentId)}/tools/${attached ? "attach" : "detach"}/${encodeURIComponent(toolId)}`, auth);
    // A write may have completed on the old account. Never report its result
    // as current, replay it, or revoke a newer discovery's proof.
    if (cloudIdentity() !== identity || cloudEvidence.get(agentId) !== evidence) throw new Error("The account or discovery changed.");
  } catch {
    if (cloudEvidence.get(agentId)?.request === discoveryId) cloudEvidence.delete(agentId);
    throw new Error("Could not confirm the tool change. Refresh connectors to check its state before retrying.");
  }
}

// --- List, add, change ---------------------------------------------------------

export async function listConnectors(agentId: string): Promise<{ connectors: Connector[]; lettaError: string | null }> {
  const local = loadConnectors().map(toConnector);
  if (getConnectionConfig().backend !== "cloud") return { connectors: local, lettaError: null };
  try {
    return { connectors: [...(await cloudConnectors(agentId)), ...local], lettaError: null };
  } catch (error) {
    return { connectors: local, lettaError: error instanceof Error ? error.message : String(error) };
  }
}

function parseLines(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined) return undefined;
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.search(/[=:]/);
      return at > 0 ? ([line.slice(0, at).trim(), line.slice(at + 1).trim()] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null && entry[0].length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Split a command line into program and arguments (quotes respected). */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((part) => part.replace(/^["']|["']$/g, ""));
  return { command: clean[0] ?? "", args: clean.slice(1) };
}

function buildStored(input: ConnectorInput, existing: StoredConnector | undefined): StoredConnector {
  const { command, args } = input.kind === "command" ? splitCommand(input.commandLine ?? "") : { command: "", args: [] };
  if (input.kind === "command" && !command) throw new Error(`Type the command that starts it, e.g. ${process.platform === "win32" ? "python C:\\path\\server.py" : "python /path/server.py"}`);
  if (input.kind === "url" && !/^https?:\/\//.test(input.url ?? "")) throw new Error("The web address should start with https://");
  const url = input.url?.trim();
  const preset = input.preset ?? existing?.preset;
  const transport = input.transport ?? (existing?.kind === "url" && existing.url === url ? existing.transport : undefined);
  const sameIdentity = existing?.kind === input.kind && (existing.preset ?? "") === (preset ?? "") && (
    input.kind === "command"
      ? existing.command === command && JSON.stringify(existing.args ?? []) === JSON.stringify(args)
      : existing.url === url && (existing.transport ?? (isSse(existing.url ?? "") ? "sse" : "http")) === (transport ?? (isSse(url ?? "") ? "sse" : "http"))
  );
  const env = parseLines(input.envText) ?? (sameIdentity && input.envText === undefined ? existing.env : undefined);
  const headers = parseLines(input.headersText) ?? (sameIdentity && input.headersText === undefined ? existing.headers : undefined);
  const next: StoredConnector = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim() || "Connector",
    kind: input.kind,
    ...(input.kind === "command" ? { command, args } : { url, ...(transport ? { transport } : {}) }),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    agentIds: input.agentIds,
    ...(preset ? { preset } : {}),
    ...(sameIdentity ? { enabledTools: existing.enabledTools, defaultsVersion: existing.defaultsVersion, defaultVoice: existing.defaultVoice, voiceModel: existing.voiceModel } : {}),
    ...(sameIdentity && existing.oauth ? { oauth: existing.oauth } : {}),
  };
  return next;
}

export function saveConnector(input: ConnectorInput): Connector {
  const all = loadConnectors();
  const existing = input.id ? all.find((connector) => connector.id === input.id) : undefined;
  const next = buildStored(input, existing);
  saveConnectors([...all.filter((connector) => connector.id !== next.id), next]);
  return toConnector(next);
}

/** Connect to a connector that isn't saved yet, list its tools, and disconnect. */
export async function testConnectorInput(input: ConnectorInput): Promise<ConnectorTool[]> {
  const draft = buildStored({ ...input, id: undefined }, undefined);
  const { connectMcpServer } = await import("@letta-ai/letta-code/mcp-client");
  let server;
  try {
    server = await connectMcpServer(await clientConfig(draft, null), {
      clientInfo: { name: "Hearthside", version: app.getVersion() },
      stderr: DISCARD_STDERR,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(friendlyConnectorError(error, draft));
  }
  try {
    return server.tools.map((tool) => ({ id: tool.name, name: tool.name, description: tool.description ?? "", enabled: true, tokens: toolTokens(tool), group: "Tools" }));
  } finally {
    await server.close().catch(() => undefined);
  }
}

type PastedServer = { command?: unknown; args?: unknown; env?: unknown; url?: unknown; serverUrl?: unknown; headers?: unknown; type?: unknown; transport?: unknown };

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Read pasted MCP config: {"mcpServers": {...}}, VS Code's {"servers": {...}}, or a bare {name: {...}} map. */
export function parseServerJson(json: string): Array<{ name: string; server: StoredConnector }> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("That isn't valid JSON. Paste the whole block, including the outer { }.");
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const map = (record.mcpServers ?? record.servers ?? record) as Record<string, PastedServer>;
  const found: Array<{ name: string; server: StoredConnector }> = [];
  for (const [name, config] of Object.entries(map)) {
    if (!config || typeof config !== "object") continue;
    const url = typeof config.url === "string" ? config.url : typeof config.serverUrl === "string" ? config.serverUrl : null;
    const type = String(config.type ?? config.transport ?? "").toLowerCase();
    const base = { id: randomUUID(), name, agentIds: [] as string[] };
    if (typeof config.command === "string" && config.command) {
      const env = stringMap(config.env);
      found.push({ name, server: { ...base, kind: "command", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], ...(env ? { env } : {}) } });
    } else if (url && /^https?:\/\//.test(url)) {
      const headers = stringMap(config.headers);
      const transport = type === "sse" ? "sse" : type ? "http" : undefined;
      found.push({ name, server: { ...base, kind: "url", url, ...(transport ? { transport } : {}), ...(headers ? { headers } : {}) } });
    }
  }
  if (found.length === 0) throw new Error("No servers found. It should look like {\"mcpServers\": {\"name\": {\"command\": ...}}} or have a \"url\".");
  return found;
}

export function addConnectorsFromJson(json: string, agentIds: string[]): string[] {
  const found = parseServerJson(json);
  saveConnectors([...loadConnectors(), ...found.map(({ server }) => ({ ...server, agentIds }))]);
  return found.map(({ name }) => name);
}

export function setConnectorAgents(id: string, agentIds: string[]): void {
  saveConnectors(loadConnectors().map((connector) => (connector.id === id ? { ...connector, agentIds } : connector)));
}

export function removeConnector(id: string): void {
  void dropConnection(id);
  forgetSavedSignIn(loadConnectors().find((connector) => connector.id === id));
  saveConnectors(loadConnectors().filter((connector) => connector.id !== id));
}

/** Connect and list the tools, with which are on (the "Test" button). */
export async function testConnector(id: string): Promise<ConnectorTool[]> {
  const stored = loadConnectors().find((connector) => connector.id === id);
  if (!stored) throw new Error("That connector is gone.");
  const server = await connection(stored);
  return describeTools(loadConnectors().find((connector) => connector.id === id) ?? stored, server.tools);
}

export function friendlyConnectorError(error: unknown, stored: StoredConnector): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthori[sz]ed|invalid_token|oauth/i.test(message)) {
    return stored.kind === "url" ? "It needs you to sign in first. Use Sign in." : "It refused the key. Check the API key.";
  }
  if (/ENOENT|not recognized|spawn/i.test(message) && stored.kind === "command") {
    return stored.command === "uvx" || stored.command === "uv"
      ? "It needs uv, which isn't installed. Install it from https://docs.astral.sh/uv/ and try again."
      : `Couldn't start "${stored.command}". Is it installed?`;
  }
  if (/abort|timeout/i.test(message)) return "It didn't answer within a minute.";
  return message.slice(0, 300);
}

// --- Import from Claude Desktop / Claude Code ------------------------------------

type ImportedConfig = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; type?: string };

/** Claude Desktop stores its MCP configuration in each platform's app-data home. */
export function claudeDesktopConfigPath(
  platform = process.platform,
  home = homedir(),
  appData = process.env.APPDATA,
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(appData ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
}

function readMcpServers(path: string): Record<string, ImportedConfig> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, ImportedConfig> };
    return data.mcpServers ?? {};
  } catch {
    return {};
  }
}

export function listImports(): ConnectorImport[] {
  const sources: Array<[string, string]> = [
    ["Claude Desktop", claudeDesktopConfigPath()],
    ["Claude Code", join(homedir(), ".claude.json")],
  ];
  const have = new Set(loadConnectors().map((connector) => connector.name.toLowerCase()));
  const out: ConnectorImport[] = [];
  for (const [from, path] of sources) {
    for (const [name, config] of Object.entries(readMcpServers(path))) {
      if (!config.command && !config.url) continue;
      out.push({
        from,
        name,
        kind: config.command ? "command" : "url",
        summary: config.command ? [config.command, ...(config.args ?? [])].join(" ") : (config.url ?? ""),
        already: have.has(name.toLowerCase()),
      });
    }
  }
  return out;
}

/** Copy connectors from Claude Desktop / Claude Code, secrets included (stored encrypted). */
export function importConnectors(picks: Array<{ from: string; name: string }>, agentIds: string[]): number {
  const sources: Record<string, string> = {
    "Claude Desktop": claudeDesktopConfigPath(),
    "Claude Code": join(homedir(), ".claude.json"),
  };
  const all = loadConnectors();
  let added = 0;
  for (const pick of picks) {
    const config = readMcpServers(sources[pick.from] ?? "")[pick.name];
    if (!config) continue;
    all.push({
      id: randomUUID(),
      name: pick.name,
      kind: config.command ? "command" : "url",
      ...(config.command ? { command: config.command, args: config.args ?? [] } : { url: config.url }),
      ...(config.env ? { env: config.env } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      agentIds,
    });
    added++;
  }
  saveConnectors(all);
  return added;
}
