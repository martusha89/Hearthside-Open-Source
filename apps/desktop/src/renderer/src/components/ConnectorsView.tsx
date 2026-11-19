import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { Connector, ConnectorImport, ConnectorInput, ConnectorTool, ConnectorVoice } from "../types";
import { BrandLogo, brandFor } from "./BrandLogo";
import { CATALOG, CATEGORIES, type CatalogEntry } from "../lib/connector-catalog";
import { ChevronRightIcon, Spinner } from "./icons";
import { ImageGenerationCard } from "./ImageGenerationCard";
import { CompanionPageHeader } from "./CompanionPageHeader";

/**
 * Hearthside: connectors (MCP servers) give an agent extra tools. One list:
 * the ones Hearthside runs from this computer, plus, on Letta Cloud, the ones
 * already on your Letta account (pulled through as they are).
 */

const ELEVENLABS_URL = "https://api.us.elevenlabs.io/v1/mcp";


function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // IPC errors arrive wrapped; keep the useful part.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function ElevenLabsSetup({ agentId, onDone, onCancel }: { agentId: string; onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"signin" | "key">("signin");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasUv, setHasUv] = useState<boolean | null>(null);

  useEffect(() => {
    if (mode !== "key") return;
    void window.bridge.checkPrograms(["uvx"]).then((found) => setHasUv(found.uvx === true)).catch(() => setHasUv(null));
  }, [mode]);

  const finish = async (connector: Connector) => {
    setStatus("Checking it works…");
    const tools = await window.bridge.testConnector(connector.id);
    setStatus(`Connected: ${tools.length} ${tools.length === 1 ? "tool" : "tools"}.`);
    onDone();
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    let created: Connector | null = null;
    try {
      created = await window.bridge.saveConnector({ name: "ElevenLabs", kind: "url", url: ELEVENLABS_URL, agentIds: [agentId], preset: "elevenlabs" });
      setStatus("Finish signing in in your browser…");
      await window.bridge.signInConnector(created.id);
      await finish(created);
    } catch (failure) {
      if (created) await window.bridge.removeConnector(created.id).catch(() => undefined);
      setError(errorText(failure));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const useKey = async () => {
    setBusy(true);
    setError(null);
    let created: Connector | null = null;
    try {
      created = await window.bridge.saveConnector({
        name: "ElevenLabs",
        kind: "command",
        commandLine: "uvx elevenlabs-mcp",
        envText: `ELEVENLABS_API_KEY=${key.trim()}`,
        agentIds: [agentId],
        preset: "elevenlabs-key",
      });
      setStatus("Starting it (the first time downloads it, so give it a minute)…");
      await finish(created);
    } catch (failure) {
      if (created) await window.bridge.removeConnector(created.id).catch(() => undefined);
      setError(errorText(failure));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-surface-secondary p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">ElevenLabs voice</h3>
        <p className="mt-1 text-xs text-muted">
          Lets your agent speak: voice messages, sound effects, voice design. The audio plays right in the chat. Uses your ElevenLabs account and its credits.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === "signin"} onChange={() => setMode("signin")} disabled={busy} />
          Sign in with ElevenLabs (recommended)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === "key"} onChange={() => setMode("key")} disabled={busy} />
          Use an API key instead
        </label>
      </div>
      {mode === "key" && (
        <div className="grid gap-2">
          <input
            type="password"
            className="field"
            placeholder="ElevenLabs API key (sk_…)"
            aria-label="ElevenLabs API key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-muted">
            This uses ElevenLabs' older server, which runs on this computer and needs{" "}
            <a className="underline" href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noreferrer">
              uv
            </a>
            . {hasUv === false && <span className="text-error">uv isn't installed yet.</span>} Audio is saved in your Music folder, under Hearthside.
          </p>
        </div>
      )}
      {status && (
        <p className="flex items-center gap-2 text-xs text-ink-700">
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {status}
        </p>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="button-primary"
          disabled={busy || (mode === "key" && !key.trim())}
          onClick={() => void (mode === "signin" ? signIn() : useKey())}
        >
          {mode === "signin" ? "Sign in with ElevenLabs" : "Connect"}
        </button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Pair = { key: string; value: string };

/** Name/value rows (environment variables or headers). Values are hidden like passwords. */
function PairRows({ pairs, onChange, keyLabel, keyPlaceholder }: { pairs: Pair[]; onChange: (pairs: Pair[]) => void; keyLabel: string; keyPlaceholder: string }) {
  return (
    <div className="grid gap-1.5">
      {pairs.map((pair, index) => (
        <div key={index} className="flex gap-1.5">
          <input
            className="field w-2/5 py-1.5 font-mono text-xs"
            placeholder={keyPlaceholder}
            aria-label={`${keyLabel} ${index + 1}`}
            value={pair.key}
            onChange={(event) => onChange(pairs.map((item, at) => (at === index ? { ...item, key: event.target.value } : item)))}
          />
          <input
            type="password"
            className="field min-w-0 flex-1 py-1.5 font-mono text-xs"
            placeholder="Value"
            aria-label={`${keyLabel} ${index + 1} value`}
            value={pair.value}
            onChange={(event) => onChange(pairs.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)))}
          />
          <button type="button" className="px-1.5 text-muted hover:text-error" aria-label={`Remove ${keyLabel} ${index + 1}`} onClick={() => onChange(pairs.filter((_, at) => at !== index))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="justify-self-start text-xs text-accent hover:underline" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
        + Add {keyLabel.toLowerCase()}
      </button>
    </div>
  );
}

function pairsText(pairs: Pair[], separator: "=" | ": "): string {
  return pairs
    .filter((pair) => pair.key.trim())
    .map((pair) => `${pair.key.trim()}${separator}${pair.value}`)
    .join("\n");
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${value === option.id ? "bg-ink-900/10 font-medium text-ink-900" : "text-muted hover:bg-ink-900/5 hover:text-ink-800"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type Auth = "none" | "token" | "headers" | "signin";

/** Add your own connector (an MCP server): by hand, or by pasting JSON from a README or Claude's config. */
function CustomForm({
  agentId,
  initial,
  onDone,
  onCancel,
}: {
  agentId: string;
  /** Prefilled from the catalog (e.g. GitHub, which takes an access token). */
  initial?: { name: string; url: string; auth: Auth; tokenHelp?: string; preset?: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"manual" | "json">("manual");
  const [kind, setKind] = useState<"url" | "command">("url");
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [auth, setAuth] = useState<Auth>(initial?.auth ?? "none");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<Pair[]>([{ key: "", value: "" }]);
  const [commandLine, setCommandLine] = useState("");
  const [env, setEnv] = useState<Pair[]>([]);
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<ConnectorTool[] | null>(null);

  // The server name doubles as the tool prefix, so default it from the address or command.
  const suggestedName = (() => {
    try {
      if (kind === "url" && url) return new URL(url).hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] ?? "";
    } catch {
      // Not a full address yet.
    }
    if (kind === "command" && commandLine) {
      const last = commandLine.trim().split(/\s+/).pop() ?? "";
      return last.replace(/^@[^/]+\//, "").replace(/\.(py|js|mjs|ts)$/, "").split(/[\\/]/).pop() ?? "";
    }
    return "";
  })();

  const input = (): ConnectorInput => {
    const finalName = name.trim() || suggestedName || "Connector";
    if (kind === "command") return { name: finalName, kind, commandLine, envText: pairsText(env, "="), agentIds: [agentId] };
    const headersText = auth === "token" ? (token.trim() ? `Authorization: Bearer ${token.trim()}` : "") : auth === "headers" ? pairsText(headers, ": ") : "";
    return { name: finalName, kind, url: url.trim(), transport, headersText, agentIds: [agentId], ...(initial?.preset ? { preset: initial.preset } : {}) };
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("test", async () => {
      setTested(null);
      setTested(await window.bridge.testConnectorInput(input()));
    });

  const add = () =>
    run("add", async () => {
      if (mode === "json") {
        await window.bridge.addConnectorsFromJson(json, [agentId]);
        onDone();
        return;
      }
      const saved = await window.bridge.saveConnector(input());
      if (kind === "url" && auth === "signin") {
        try {
          await window.bridge.signInConnector(saved.id);
        } catch (failure) {
          await window.bridge.removeConnector(saved.id).catch(() => undefined);
          throw failure;
        }
      }
      onDone();
    });

  const ready = mode === "json" ? json.trim().length > 0 : kind === "url" ? /^https?:\/\/\S+/.test(url.trim()) : commandLine.trim().length > 0;

  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-surface-secondary p-4" data-testid="add-server">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{initial ? `Add ${initial.name}` : "Add a server"}</h3>
        <Segmented
          label="How to add it"
          value={mode}
          onChange={setMode}
          options={[
            { id: "manual", label: "Manually" },
            { id: "json", label: "JSON" },
          ]}
        />
      </div>

      {mode === "json" ? (
        <label className="grid gap-1.5 text-xs text-muted">
          Paste the config from the server's instructions or Claude's settings. Several servers at once is fine.
          <textarea
            className="field min-h-40 font-mono text-xs"
            aria-label="Server JSON"
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"],\n      "env": { "API_KEY": "…" }\n    }\n  }\n}'}
            value={json}
            onChange={(event) => setJson(event.target.value)}
          />
        </label>
      ) : (
        <>
          <Segmented
            label="Where it runs"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setTested(null);
            }}
            options={[
              { id: "url", label: "Web server" },
              { id: "command", label: "Program on this computer" },
            ]}
          />
          {kind === "url" ? (
            <>
              <label className="grid gap-1 text-xs font-medium text-ink-700">
                Server URL
                <input className="field font-mono text-xs font-normal" placeholder="https://example.com/mcp" aria-label="Server URL" value={url} onChange={(event) => setUrl(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-medium text-ink-700">
                Server name
                <input className="field text-sm font-normal" placeholder={suggestedName || "my_mcp_server"} aria-label="Server name" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <div className="grid gap-1 text-xs font-medium text-ink-700">
                Server type
                <Segmented
                  label="Server type"
                  value={transport}
                  onChange={setTransport}
                  options={[
                    { id: "http", label: "Streamable HTTP" },
                    { id: "sse", label: "SSE" },
                  ]}
                />
              </div>
              <div className="grid gap-1.5 text-xs font-medium text-ink-700">
                Authentication
                <Segmented
                  label="Authentication"
                  value={auth}
                  onChange={setAuth}
                  options={[
                    { id: "none", label: "None" },
                    { id: "signin", label: "Sign in" },
                    { id: "token", label: "Access token / API key" },
                    { id: "headers", label: "Custom headers" },
                  ]}
                />
                {auth === "signin" && <p className="font-normal text-muted">Your browser opens to sign in when you add it.</p>}
                {auth === "token" && initial?.tokenHelp && (
                  <a className="font-normal text-accent hover:underline" href={initial.tokenHelp} target="_blank" rel="noreferrer">
                    Make a token
                  </a>
                )}
                {auth === "token" && (
                  <input type="password" className="field font-mono text-xs font-normal" placeholder="Token or API key (sent as a Bearer token)" aria-label="Access token" value={token} onChange={(event) => setToken(event.target.value)} />
                )}
                {auth === "headers" && <PairRows pairs={headers} onChange={setHeaders} keyLabel="Header" keyPlaceholder="X-Api-Key" />}
              </div>
            </>
          ) : (
            <>
              <label className="grid gap-1 text-xs font-medium text-ink-700">
                Command
                <input
                  className="field font-mono text-xs font-normal"
                  placeholder={`npx -y @modelcontextprotocol/server-filesystem ${window.bridge.platform === "win32" ? "C:\\Users\\me\\Documents" : "/Users/me/Documents"}`}
                  aria-label="Command"
                  value={commandLine}
                  onChange={(event) => setCommandLine(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-ink-700">
                Server name
                <input className="field text-sm font-normal" placeholder={suggestedName || "my_mcp_server"} aria-label="Server name" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <div className="grid gap-1.5 text-xs font-medium text-ink-700">
                Environment variables
                <PairRows pairs={env} onChange={setEnv} keyLabel="Variable" keyPlaceholder="API_KEY" />
              </div>
            </>
          )}
        </>
      )}

      {tested && (
        <p className="rounded-xl bg-surface px-3 py-2 text-xs text-ink-800">
          Connected. {tested.length} {tested.length === 1 ? "tool" : "tools"}
          {tested.length > 0 && <span className="text-muted">: {tested.slice(0, 12).map((tool) => tool.name).join(", ")}{tested.length > 12 ? "…" : ""}</span>}
        </p>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {mode === "manual" && !(kind === "url" && auth === "signin") && (
          <button type="button" className="button-secondary" disabled={!ready || busy !== null} onClick={() => void test()}>
            {busy === "test" ? "Connecting…" : "Test connection"}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" className="button-secondary" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" disabled={!ready || busy !== null} onClick={() => void add()}>
          {busy === "add" ? (kind === "url" && auth === "signin" && mode === "manual" ? "Finish in your browser…" : "Adding…") : "Add"}
        </button>
      </div>
    </div>
  );
}

function ImportPanel({ agentId, imports, onDone, onCancel }: { agentId: string; imports: ConnectorImport[]; onDone: () => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const keyOf = (item: ConnectorImport) => `${item.from}\u0000${item.name}`;
  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-surface-secondary p-4">
      <h3 className="text-sm font-semibold text-ink-900">Copy from Claude</h3>
      <p className="text-xs text-muted">Connectors you set up in Claude Desktop or Claude Code. Their keys come along and are stored encrypted.</p>
      <div className="grid gap-1.5">
        {imports.map((item) => (
          <label key={keyOf(item)} className={`flex items-start gap-2 text-sm ${item.already ? "opacity-50" : ""}`}>
            <input
              type="checkbox"
              disabled={item.already || busy}
              checked={picked.has(keyOf(item))}
              onChange={(event) => {
                const next = new Set(picked);
                if (event.target.checked) next.add(keyOf(item));
                else next.delete(keyOf(item));
                setPicked(next);
              }}
            />
            <span className="min-w-0">
              <span className="text-ink-900">{item.name}</span> <span className="text-xs text-muted">from {item.from}{item.already ? " · already added" : ""}</span>
              <span className="block truncate font-mono text-xs text-muted">{item.summary}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="button-primary"
          disabled={busy || picked.size === 0}
          onClick={() => {
            setBusy(true);
            const picks = imports.filter((item) => picked.has(keyOf(item))).map((item) => ({ from: item.from, name: item.name }));
            void window.bridge.importConnectors(picks, [agentId]).finally(() => {
              setBusy(false);
              onDone();
            });
          }}
        >
          Copy {picked.size || ""}
        </button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function sizeLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

/** Switching on more than this many tools, or this much schema, asks first. */
export const BIG_CATALOG_TOOLS = 10;
export const BIG_CATALOG_TOKENS = 8_000;
export function isBigCatalog(tools: ConnectorTool[]): boolean {
  const tokens = tools.reduce((sum, tool) => sum + (Number.isFinite(tool.tokens) && tool.tokens > 0 ? tool.tokens : 0), 0);
  return tools.length > BIG_CATALOG_TOOLS || tokens > BIG_CATALOG_TOKENS;
}

/** A missing schema measurement is unknown, never proof that a tool is free. */
function schemaSizeLabel(tools: ConnectorTool[]): string {
  const tokens = tools.reduce((sum, tool) => sum + (Number.isFinite(tool.tokens) && tool.tokens > 0 ? tool.tokens : 0), 0);
  const unknown = tools.filter((tool) => !Number.isFinite(tool.tokens) || tool.tokens <= 0).length;
  if (!tokens && unknown) return `Schema size unavailable for ${unknown} tools`;
  return `About ${sizeLabel(tokens)} estimated schema tokens${unknown ? `, plus ${unknown} tools with unknown schema size` : ""}`;
}

/** What the agent can do with a connector: a few plain groups, each with one switch. */
function ToolPicker({ connector, tools, onTools }: { connector: Connector; tools: ConnectorTool[]; onTools: (tools: ConnectorTool[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const total = tools.filter((tool) => tool.enabled).reduce((sum, tool) => sum + tool.tokens, 0);
  const groups = [...new Set(tools.map((tool) => tool.group))].map((name) => ({ name, tools: tools.filter((tool) => tool.group === name) }));

  const save = (next: ConnectorTool[]) => {
    onTools(next);
    setError(null);
    void window.bridge
      .setConnectorTools(
        connector.id,
        next.filter((tool) => tool.enabled).map((tool) => tool.name),
      )
      .catch((failure) => setError(errorText(failure)));
  };
  const setGroup = (group: string, enabled: boolean) => save(tools.map((tool) => (tool.group === group ? { ...tool, enabled } : tool)));

  if (tools.length === 0) return <p className="rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">Connected, but it has no tools.</p>;

  const shown = groups.length <= 3 ? groups : groups.filter((group) => group.tools.some((tool) => tool.enabled));
  const folded = groups.filter((group) => !shown.includes(group));
  const foldedCount = folded.reduce((sum, group) => sum + group.tools.length, 0);
  const renderGroup = (group: { name: string; tools: ConnectorTool[] }) => {
        const on = group.tools.filter((tool) => tool.enabled).length;
        const size = group.tools.reduce((sum, tool) => sum + tool.tokens, 0);
        return (
          <div key={group.name} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                aria-label={group.name}
                checked={on === group.tools.length}
                ref={(element) => {
                  if (element) element.indeterminate = on > 0 && on < group.tools.length;
                }}
                onChange={() => setGroup(group.name, on < group.tools.length)}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{group.name}</span>
              <span className="shrink-0 text-muted">
                {group.tools.length > 1 ? `${on}/${group.tools.length} · ` : ""}
                {sizeLabel(size)}
              </span>
              {group.tools.length > 1 && (
                <button type="button" className="shrink-0 text-muted hover:text-ink-800 hover:underline" onClick={() => setOpenGroup(openGroup === group.name ? null : group.name)}>
                  {openGroup === group.name ? "Hide" : "Choose"}
                </button>
              )}
            </div>
            {openGroup === group.name && (
              <div className="ml-6 mt-1 grid max-h-64 min-w-0 gap-1 overflow-y-auto">
                {group.tools.map((tool) => (
                  <label key={tool.name} className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      checked={tool.enabled === true}
                      aria-label={tool.name}
                      onChange={() => save(tools.map((item) => (item.name === tool.name ? { ...item, enabled: !item.enabled } : item)))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="break-all font-mono text-ink-900">{tool.name}</span> <span className="text-muted">· {sizeLabel(tool.tokens)}</span>
                      {tool.description && (
                        <span className="block truncate text-muted" title={tool.description}>
                          {tool.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      };
  return (
    <div className="grid min-w-0 gap-1.5 rounded-xl bg-surface-secondary px-3 py-2 text-xs">
      <p className="text-ink-800">What it can do:</p>
      {shown.map(renderGroup)}
      {folded.length > 0 && (
        <details className="min-w-0">
          <summary className="cursor-pointer text-muted">More tools · {folded.length} groups, {foldedCount} tools, all off</summary>
          <div className="mt-1 grid gap-1.5">{folded.map(renderGroup)}</div>
        </details>
      )}
      <p className={total > 25_000 ? "text-error" : "text-muted"}>
        Adds about {sizeLabel(total)} tokens to every message.
        {total > 25_000 && " That's a lot. Turn off what you don't need, or the agent may run out of room."}
      </p>
      {error && <p className="text-error">{error}</p>}
    </div>
  );
}

/** The voice speech tools use when the agent doesn't choose one. */
function VoicePicker({ connector, onChanged }: { connector: Connector; onChanged: () => void }) {
  const [voices, setVoices] = useState<ConnectorVoice[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (voice: ConnectorVoice | null) => {
    setError(null);
    try {
      await window.bridge.setConnectorVoice(connector.id, voice);
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <div className="grid min-w-0 gap-1.5 rounded-xl bg-surface-secondary px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-800">Voice:</span>
        <span className="font-medium text-ink-900">{connector.defaultVoice?.name ?? "the agent chooses"}</span>
        {connector.defaultVoice && (
          <button type="button" className="text-muted hover:text-ink-800 hover:underline" onClick={() => void choose(null)}>
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="button-secondary py-1 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void window.bridge
              .listConnectorVoices(connector.id)
              .then(setVoices)
              .catch((failure) => setError(errorText(failure)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Loading…" : "Choose from my voices"}
        </button>
        {voices && (
          <select
            className="field w-auto max-w-[16rem] py-1 text-xs"
            aria-label="Voice"
            value={connector.defaultVoice?.id ?? ""}
            onChange={(event) => {
              const voice = voices.find((item) => item.id === event.target.value);
              if (voice) void choose(voice);
            }}
          >
            <option value="" disabled>
              Pick a voice…
            </option>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        )}
        <span className="text-muted">or</span>
        <input
          className="field w-48 py-1 text-xs"
          placeholder="Voice name or ID"
          aria-label="Voice name or ID"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) {
              const value = typed.trim();
              void choose(/^[A-Za-z0-9]{20}$/.test(value) ? { id: value, name: value } : { id: "", name: value });
              setTyped("");
            }
          }}
        />
      </div>
      {connector.preset === "elevenlabs" && (
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-ink-800">Model:</span>
          <select
            className="field w-auto max-w-full py-1 text-xs"
            aria-label="Speech model"
            value={connector.voiceModel ?? "eleven_v3"}
            onChange={(event) => {
              setError(null);
              void window.bridge
                .setConnectorVoiceModel(connector.id, event.target.value === "eleven_v3" ? null : event.target.value)
                .then(onChanged)
                .catch((failure) => setError(errorText(failure)));
            }}
          >
            {VOICE_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="text-error">{error}</p>}
    </div>
  );
}

/** ElevenLabs' speech models, as its voice-message tool accepts them. */
const VOICE_MODELS = [
  { id: "eleven_v3", label: "Eleven v3: most expressive, understands [whispers] and [laughs] (default)" },
  { id: "eleven_v4", label: "Eleven v4: ElevenLabs' newest" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2: steady and natural, many languages" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5: quick" },
  { id: "eleven_flash_v2_5", label: "Flash v2.5: fastest and cheapest" },
];

/** The catalog of one-click connectors, by category, with a search. */
function CatalogBrowser({
  agentId,
  connectors,
  onAdded,
  onNeedsToken,
}: {
  agentId: string;
  connectors: Connector[];
  onAdded: () => void;
  onNeedsToken: (entry: CatalogEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const added = (entry: CatalogEntry) => connectors.some((connector) => connector.preset === entry.id || connector.url === entry.url);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = CATALOG.filter((entry) => terms.every((term) => `${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(term)));

  /** Save it, sign in when needed, check it works; nothing half-added is left on failure. */
  const connect = async (entry: CatalogEntry) => {
    if (entry.auth === "token") {
      onNeedsToken(entry);
      return;
    }
    setBusy(entry.id);
    setFailed(null);
    let created: Connector | null = null;
    try {
      created = await window.bridge.saveConnector({ name: entry.name, kind: "url", url: entry.url, agentIds: [agentId], preset: entry.id });
      if (entry.auth === "signin") await window.bridge.signInConnector(created.id);
      await window.bridge.testConnector(created.id);
      onAdded();
    } catch (failure) {
      if (created) await window.bridge.removeConnector(created.id).catch(() => undefined);
      setFailed({ id: entry.id, message: errorText(failure) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="grid gap-3" aria-label="Browse connectors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">Browse connectors</h2>
        <input className="field w-56 py-1.5 text-sm" placeholder="Search connectors" aria-label="Search connectors" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {shown.length === 0 && <p className="text-sm text-muted">Nothing matches. Use "Add a server" for anything else.</p>}
      {CATEGORIES.map((category) => {
        const entries = shown.filter((entry) => entry.category === category);
        if (entries.length === 0) return null;
        return (
          <div key={category} className="grid gap-1.5">
            <h3 className="text-xs font-medium text-muted">{category}</h3>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => {
                const isAdded = added(entry);
                const note = busy === entry.id ? (entry.auth === "signin" ? "Finish signing in in your browser…" : "Connecting…") : failed?.id === entry.id ? failed.message : entry.description;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={isAdded || busy !== null}
                    title={entry.url}
                    onClick={() => void connect(entry)}
                    className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface-secondary px-2.5 py-2 text-left transition-colors hover:bg-surface-tertiary disabled:cursor-default disabled:hover:bg-surface-secondary"
                  >
                    <BrandLogo brand={entry.brand ?? entry.id} label={entry.name} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink-900">{entry.name}</span>
                        {isAdded && <span className="shrink-0 rounded bg-success-light px-1 text-[10px] text-success">Added</span>}
                        {!isAdded && entry.auth === "none" && <span className="shrink-0 rounded bg-surface-tertiary px-1 text-[10px] text-ink-700">No account</span>}
                      </span>
                      <span className={`block truncate text-[11px] ${failed?.id === entry.id ? "text-error" : "text-muted"}`} title={note}>
                        {note}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Hearthside's own tools: GIFs and weather. Switched on for all agents. */
function BuiltInCards() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [homeTown, setHomeTown] = useState(settings?.homeTown ?? "");
  useEffect(() => setHomeTown(settings?.homeTown ?? ""), [settings?.homeTown]);
  if (!settings) return null;
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold text-ink-900">Built in</h2>
      {settings.gifsAvailable && (
        <div className="grid gap-2 rounded-2xl border border-border bg-surface px-4 py-3" data-testid="builtin-gifs">
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-[11px] font-bold text-ink-700">
              GIF
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink-900">GIFs</span>
              <span className="block text-xs text-muted">Agents send reaction GIFs now and then. Powered by KLIPY.</span>
            </span>
            <label className="flex shrink-0 items-center gap-2 text-xs text-ink-800">
              <input type="checkbox" checked={settings.gifs} onChange={(event) => void saveSettings({ gifs: event.target.checked })} />
              On
            </label>
          </div>
          {settings.gifs && (
            <label className="ml-11 flex flex-wrap items-center gap-2 text-xs text-ink-800">
              Content filter:
              <select className="field w-auto py-1 text-xs" value={settings.gifFilter} onChange={(event) => void saveSettings({ gifFilter: event.target.value as typeof settings.gifFilter })}>
                <option value="high">Strict</option>
                <option value="medium">Standard</option>
                <option value="low">Relaxed</option>
                <option value="off">Off</option>
              </select>
            </label>
          )}
        </div>
      )}
      <ImageGenerationCard engine={settings.imageEngine} onChange={(imageEngine) => void saveSettings({ imageEngine })} />
      <div className="grid gap-2 rounded-2xl border border-border bg-surface px-4 py-3" data-testid="builtin-obsidian">
        <div className="flex items-center gap-3">
          <BrandLogo brand="obsidian" label="Obsidian" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900">Obsidian notes</span>
            <span className="block truncate text-xs text-muted" title={settings.obsidianVault || undefined}>
              {settings.obsidianVault
                ? `Vault: ${settings.obsidianVault}`
                : "Agents can search, read and add to your notes. Writing a note asks you first."}
            </span>
          </span>
          {settings.obsidianVault ? (
            <button type="button" className="shrink-0 text-xs text-muted hover:text-error hover:underline" onClick={() => void saveSettings({ obsidianVault: "" })}>
              Remove
            </button>
          ) : null}
          <button
            type="button"
            className="button-secondary shrink-0 py-1 text-xs"
            onClick={() =>
              void window.bridge.selectDirectory().then((folder) => {
                if (folder) void saveSettings({ obsidianVault: folder });
              })
            }
          >
            {settings.obsidianVault ? "Change" : "Choose vault"}
          </button>
        </div>
      </div>
      <div className="grid gap-2 rounded-2xl border border-border bg-surface px-4 py-3" data-testid="builtin-weather">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-base">
            ☀️
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900">Weather</span>
            <span className="block text-xs text-muted">Forecasts and air pressure (rising or falling), for any town. No account needed.</span>
          </span>
          <label className="flex shrink-0 items-center gap-2 text-xs text-ink-800">
            <input type="checkbox" checked={settings.weather} onChange={(event) => void saveSettings({ weather: event.target.checked })} />
            On
          </label>
        </div>
        {settings.weather && (
          <label className="ml-11 flex flex-wrap items-center gap-2 text-xs text-ink-800">
            Your home town:
            <input
              className="field w-56 py-1 text-xs"
              placeholder="e.g. Edinburgh"
              aria-label="Home town"
              value={homeTown}
              onChange={(event) => setHomeTown(event.target.value)}
              onBlur={() => homeTown.trim() !== settings.homeTown && void saveSettings({ homeTown })}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
            <a href="https://open-meteo.com" target="_blank" rel="noreferrer" className="text-[11px] text-muted-light hover:underline">
              Weather data by Open-Meteo.com
            </a>
          </label>
        )}
      </div>
    </section>
  );
}

function attachmentState(connector: Connector, agentId: string): "on" | "off" | "partial" | "unknown" {
  return connector.where === "letta" ? connector.cloudDiscovery?.attachment ?? "unknown" : connector.agentIds.includes(agentId) ? "on" : "off";
}

function canSwitch(connector: Connector): boolean {
  return connector.where !== "letta" || (connector.cloudDiscovery?.catalog === "success" && Boolean(connector.cloudDiscovery.discoveryId) && connector.cloudDiscovery.attachment !== "unknown" && connector.tools.length > 0);
}

/** Stop multi-step actions as soon as their card/account/agent leaves the screen. */
function useCurrentView() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const { agentId, backendEpoch } = useAppStore.getState();
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.agentId !== agentId || state.backendEpoch !== backendEpoch) live.current = false;
    });
    return () => { live.current = false; unsubscribe(); };
  }, []);
  return live;
}

/** Local connector availability never expands Cloud tool selections. */
function AllConnectorsToggle({ connectors, agentId, agentName, onChanged, onError, cloudUnavailable, checking = false }: { connectors: Connector[]; agentId: string; agentName: string; onChanged: () => void; onError: (message: string | null) => void; cloudUnavailable: boolean; checking?: boolean }) {
  const [busy, setBusy] = useState(false);
  // While switching, show where it's going rather than where it was; the refresh confirms it.
  const [pending, setPending] = useState<boolean | null>(null);
  const live = useCurrentView();
  const ref = useRef<HTMLInputElement>(null);
  const switchable = connectors.filter((connector) => connector.where === "computer");
  const hasCloud = connectors.some((connector) => connector.where === "letta");
  const onCount = switchable.filter((connector) => attachmentState(connector, agentId) === "on").length;
  // This checkbox describes computer connectors only; Cloud selection is separate.
  const all = pending ?? (switchable.length > 0 && onCount === switchable.length);
  const mixed = pending === null && !all && onCount > 0;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  if (switchable.length < 2 && !hasCloud && !cloudUnavailable) return null;
  const setAll = async (target: boolean) => {
    if (!live.current || busy || checking) return;
    setBusy(true);
    setPending(target);
    onError(null);
    let failureMessage: string | null = null;
    try {
      for (const connector of switchable) {
        if (!live.current) return;
        if (attachmentState(connector, agentId) === (target ? "on" : "off")) continue;
        const others = connector.agentIds.filter((id) => id !== agentId);
        await window.bridge.setConnectorAgents(connector.id, target ? [...others, agentId] : others);
      }
    } catch (failure) {
      failureMessage = errorText(failure);
    } finally {
      if (live.current) {
        setBusy(false);
        setPending(null);
        onChanged();
        if (failureMessage) onError(failureMessage);
      }
    }
  };
  return (
    <div className="grid min-w-0 max-w-full gap-1 text-xs text-ink-800">
      {switchable.length >= 2 && <label className="flex min-w-0 flex-wrap items-center gap-2">
        {busy && <Spinner className="h-3.5 w-3.5" />}
        <input ref={ref} type="checkbox" checked={all} disabled={busy || checking} onChange={() => void setAll(!all)} aria-label={`All computer connectors on for ${agentName}`} />
        All computer connectors on for {agentName}
      </label>}
      {hasCloud && <p className="text-muted">Letta account connectors: choose tools individually.</p>}
      {cloudUnavailable && <p className="text-muted">Cloud connectors unavailable. Refresh discovery to choose their tools separately.</p>}
    </div>
  );
}

function ConnectorCard({ connector, agentId, agentName, onChanged, onError, checking = false, actionEpoch }: { connector: Connector; agentId: string; agentName: string; onChanged: () => void; onError: (message: string) => void; checking?: boolean; actionEpoch: React.RefObject<number> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ConnectorTool[] | null>(connector.where === "letta" ? connector.tools : null);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  // Opening a connector of this computer shows its tools (the connection is kept for chats).
  useEffect(() => {
    if (!open || tools || connector.where !== "computer") return;
    let live = true;
    void window.bridge
      .testConnector(connector.id)
      .then((result) => live && setTools(result))
      .catch((failure) => live && setError(errorText(failure)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector.id, open]);
  const live = useCurrentView();
  const state = attachmentState(connector, agentId);
  // A local connector flips at once and the refresh confirms it. A Cloud
  // connector shows only what verified discovery established.
  const [localOn, setLocalOn] = useState<boolean | null>(null);
  useEffect(() => setLocalOn(null), [connector.agentIds, agentId]);
  const on = connector.where === "computer" && localOn !== null ? localOn : state === "on";
  const switchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (switchRef.current) switchRef.current.indeterminate = state === "partial" || state === "unknown";
  }, [state]);

  const act = async (label: string, run: () => Promise<unknown>, confirm = false) => {
    if (!live.current) return;
    const epoch = actionEpoch.current;
    setBusy(label);
    setError(null);
    let failureMessage: string | null = null;
    try {
      await run();
    } catch (failure) {
      failureMessage = errorText(failure);
    } finally {
      // A manual refresh or context switch revokes this action's UI ownership.
      // Confirm our own change first, then publish its error after refresh clears
      // old errors; there is no await between this ownership check and publication.
      if (live.current) {
        setBusy(null);
        // The change is still ours to confirm: a manual refresh may have read the
        // server before this write landed, and another refresh is idempotent.
        if (confirm) onChanged();
        // Only a current action publishes its error. After a manual refresh the
        // list shows what the server holds and old errors were already cleared.
        if (failureMessage && epoch === actionEpoch.current) {
          setError(failureMessage);
          onError(failureMessage);
        }
      }
    }
  };

  const summary = connector.kind === "command" ? [connector.command, ...connector.args].join(" ") : connector.url;
  const needsSignIn = connector.where === "computer" && connector.kind === "url" && connector.headerKeys.length === 0;
  const selectedTools = connector.tools.filter((tool) => tool.enabled === true);
  const cloudDisabled = busy !== null || checking || !canSwitch(connector);
  const changeCloudTools = (target: boolean) => {
    if (cloudDisabled || !live.current) return;
    setConfirmation(null);
    return act("tools", async () => {
      for (const tool of connector.tools) {
        if (!live.current) return;
        if (tool.enabled !== target) await window.bridge.setLettaToolAttached(agentId, tool.id, target, connector.cloudDiscovery!.discoveryId);
      }
    }, true);
  };
  const bigCatalog = isBigCatalog(connector.tools);

  const toggle = () => {
    if (!live.current || busy || checking) return;
    if (connector.where === "letta") {
      if (cloudDisabled) return;
      // Switching on a small connector attaches its tools; a big catalog asks first,
      // because every schema rides along on every message. Switching off detaches.
      if (state === "on") return changeCloudTools(false);
      if (bigCatalog) { setConfirmation(connector.cloudDiscovery!.discoveryId); return; }
      return changeCloudTools(true);
    }
    const target = !on;
    setLocalOn(target);
    return act("toggle", async () => {
      try {
        const others = connector.agentIds.filter((id) => id !== agentId);
        await window.bridge.setConnectorAgents(connector.id, target ? [...others, agentId] : others);
      } catch (failure) {
        if (live.current) setLocalOn(null);
        throw failure;
      }
    }, true);
  };

  return (
    <div className="grid min-w-0 gap-2 overflow-hidden rounded-2xl border border-border bg-surface px-4 py-3" data-testid="connector-card">
      <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
          aria-label={`${connector.name} details`}
          onClick={() => setOpen(!open)}
        >
          <BrandLogo brand={brandFor(connector.preset, connector.name, connector.url, connector.command, ...connector.args)} label={connector.name} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-ink-900">{connector.name}</span>
              <span className="rounded-md bg-surface-tertiary px-1.5 py-0.5 text-[11px] text-ink-700">
                {connector.where === "letta" ? "Letta account" : "This computer"}
              </span>
              {connector.signedIn && <span className="rounded-md bg-success-light px-1.5 py-0.5 text-[11px] text-success">Signed in</span>}
            </span>
            {connector.defaultVoice && <span className="block truncate text-xs text-muted">Voice: {connector.defaultVoice.name}</span>}
          </span>
          <ChevronRightIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <label className="flex shrink-0 items-center gap-2 text-xs text-ink-800" title={state === "unknown" ? "Status unavailable" : undefined}>
          <input ref={switchRef} type="checkbox" checked={on} disabled={busy !== null || checking || !canSwitch(connector)} aria-label={`On for ${agentName}`} onChange={() => void toggle()} />
          On for {agentName}
          {state === "partial" && <span className="text-muted">(some tools)</span>}
        </label>
      </div>
      {confirmation && confirmation === connector.cloudDiscovery?.discoveryId && !checking && <div role="alertdialog" aria-label="Switch on all connector tools" className="grid gap-2 rounded-xl border border-border bg-surface-secondary p-3 text-xs">
        <p>Switch on all {connector.tools.length} tools from {connector.name} for {agentName}? {schemaSizeLabel(connector.tools)} will ride along on every message, which uses up the companion's context and adds cost. You can instead open the card and tick only the tools you need.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="button-primary py-1 text-xs" disabled={cloudDisabled} onClick={() => void changeCloudTools(true)}>Switch on all {connector.tools.length} tools</button>
          <button type="button" className="button-secondary py-1 text-xs" onClick={() => { setConfirmation(null); setOpen(true); }}>Choose tools instead</button>
          <button type="button" className="button-secondary py-1 text-xs" onClick={() => setConfirmation(null)}>Cancel</button>
        </div>
      </div>}
      {open && (
        <div className="grid min-w-0 gap-1">
          <p className="truncate font-mono text-xs text-muted" title={summary}>
            {summary}
          </p>
          {(connector.envKeys.length > 0 || connector.headerKeys.length > 0) && (
            <p className="text-xs text-muted">Keys: {[...connector.envKeys, ...connector.headerKeys].join(", ")}</p>
          )}
        </div>
      )}

      {connector.where === "letta" && state === "unknown" && (
        <p className="text-xs text-muted">
          {connector.cloudDiscovery?.error ?? (connector.cloudDiscovery?.catalog === "success" ? "The catalog returned no tools; attachment state cannot be verified." : "Tool catalog unavailable.")}
          {" "}Changes are disabled until attachment state is verified.
          <button type="button" className="ml-2 text-accent underline" onClick={onChanged}>Retry discovery</button>
        </p>
      )}
      {open && connector.where === "letta" && connector.tools.length > 0 && (
        <div className="text-xs">
          <p className="text-muted">
            {state === "unknown" ? `Attachment unknown for ${connector.tools.length} tools` : `${connector.tools.filter((tool) => tool.enabled).length} of ${connector.tools.length} tools on`}
          </p>
          <p className="mt-1 text-muted">{state === "unknown" ? "Selected schema size unknown until attachments are verified." : `Selected tools: ${schemaSizeLabel(selectedTools)} per model request.`}</p>
          <div className="mt-1.5 grid gap-1">
            {connector.tools.map((tool) => (
              <label key={tool.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  aria-label={tool.name}
                  checked={tool.enabled === true}
                  disabled={busy !== null || checking || !canSwitch(connector) || tool.enabled === null}
                  onChange={() =>
                    void act(`tool-${tool.id}`, async () => {
                      if (!canSwitch(connector) || tool.enabled === null || !live.current) return;
                      await window.bridge.setLettaToolAttached(agentId, tool.id, !tool.enabled, connector.cloudDiscovery!.discoveryId);
                    }, true)
                  }
                />
                <span>
                  <span className="font-mono text-ink-900">{tool.name}</span>
                  {tool.tokens > 0 && <span className="ml-1 text-muted">· {sizeLabel(tool.tokens)}</span>}
                  {tool.description && <span className="block text-muted">{tool.description.slice(0, 160)}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {open && connector.where === "computer" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="button-secondary py-1 text-xs"
            disabled={busy !== null}
            onClick={() => void act("test", async () => setTools(await window.bridge.testConnector(connector.id)))}
          >
            {busy === "test" ? "Checking…" : "Test"}
          </button>
          {connector.kind === "url" &&
            (connector.signedIn ? (
              <button
                type="button"
                className="button-secondary py-1 text-xs"
                disabled={busy !== null}
                onClick={() =>
                  void act("signout", async () => {
                    await window.bridge.signOutConnector(connector.id);
                    onChanged();
                  })
                }
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                className={`${needsSignIn ? "button-primary" : "button-secondary"} py-1 text-xs`}
                disabled={busy !== null}
                onClick={() =>
                  void act("signin", async () => {
                    await window.bridge.signInConnector(connector.id);
                    onChanged();
                  })
                }
              >
                {busy === "signin" ? "Finish in your browser…" : "Sign in"}
              </button>
            ))}
          <button
            type="button"
            className="ml-auto text-error hover:underline"
            disabled={busy !== null}
            onClick={() =>
              void act("remove", async () => {
                await window.bridge.removeConnector(connector.id);
                onChanged();
              })
            }
          >
            Remove
          </button>
        </div>
      )}

      {open && connector.where === "computer" && tools && <ToolPicker connector={connector} tools={tools} onTools={setTools} />}
      {open && connector.where === "computer" && (connector.preset?.startsWith("elevenlabs") || tools?.some((tool) => /text_to_speech/.test(tool.name))) && (
        <VoicePicker connector={connector} onChanged={onChanged} />
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}

export function ConnectorsView() {
  const agentId = useAppStore((state) => state.agentId);
  const epoch = useAppStore((state) => state.backendEpoch);
  // Remount all card/action state on account, connection, or agent changes.
  return <ConnectorsForContext key={`${epoch}:${agentId}`} />;
}

function ConnectorsForContext() {
  const live = useCurrentView();
  const requests = useRef(0);
  const epoch = useAppStore((state) => state.backendEpoch);
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name ?? "your agent");
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [lettaError, setLettaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imports, setImports] = useState<ConnectorImport[]>([]);
  const [form, setForm] = useState<"none" | "elevenlabs" | "custom" | "import">("none");
  const actionEpoch = useRef(0);

  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!agentId || !live.current) return;
    const request = ++requests.current;
    const current = () => live.current && request === requests.current && useAppStore.getState().agentId === agentId && useAppStore.getState().backendEpoch === epoch;
    if (!current()) return;
    // The list stays visible while re-verifying, with every control disabled:
    // the main process revokes old discovery proofs as soon as a new discovery
    // starts, so nothing stale can write, and the page does not blank on each toggle.
    setLoading(true);
    setError(null);
    setLettaError(null);
    try {
      const result = await window.bridge.listConnectors(agentId);
      if (!current()) return;
      setConnectors(result.connectors);
      setLettaError(result.lettaError);
    } catch (failure) {
      if (current()) {
        setError(errorText(failure));
        // Preserve the visible list, but revoke stale Cloud mutation authority.
        setConnectors((items) => items?.map((connector) => connector.where === "letta" ? {
          ...connector,
          cloudDiscovery: { discoveryId: "", catalog: connector.cloudDiscovery?.catalog ?? "unavailable", attachment: "unknown", error: "Could not refresh attachment state. Retry discovery before changing tools." },
        } : connector) ?? null);
      }
    } finally {
      if (current()) setLoading(false);
    }
    if (!current()) return;
    void window.bridge.listConnectorImports().then((result) => { if (current()) setImports(result); }).catch(() => { if (current()) setImports([]); });
  }, [agentId, epoch, live]);
  useEffect(() => {
    void refresh();
    return () => { requests.current++; };
  }, [refresh]);

  const done = () => {
    setForm("none");
    void refresh();
  };
  const hasElevenLabs = connectors?.some((connector) => connector.preset?.startsWith("elevenlabs") || /elevenlabs/i.test(connector.name));
  const newImports = imports.filter((item) => !item.already);
  const [tokenEntry, setTokenEntry] = useState<CatalogEntry | null>(null);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <CompanionPageHeader title="Connectors" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-6">
          <p className="text-sm text-muted">
            Connectors give {agentName} extra tools, like a voice, your calendar or your own apps. They use MCP, the same standard Claude uses. {agentName} asks
            before using one unless you allow it.
          </p>
          {error && <p role="alert" className="rounded-xl bg-error-light px-3.5 py-2.5 text-sm text-error">{error}</p>}

          {form === "none" && agentId && (
            <div className="grid gap-2 sm:grid-cols-2">
              {!hasElevenLabs && (
                <button type="button" className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary p-3 text-left hover:bg-surface-tertiary" onClick={() => setForm("elevenlabs")}>
                  <BrandLogo brand="elevenlabs" label="ElevenLabs" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900">ElevenLabs voice</span>
                    <span className="block text-xs text-muted">Voice messages and sound, played in the chat.</span>
                  </span>
                </button>
              )}
              <button type="button" className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary p-3 text-left hover:bg-surface-tertiary" onClick={() => {
                  setTokenEntry(null);
                  setForm("custom");
                }}>
                <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-lg text-ink-700">
                  +
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900">Add a server</span>
                  <span className="block text-xs text-muted">Any MCP server: a web address, a program, or pasted JSON.</span>
                </span>
              </button>
              {newImports.length > 0 && (
                <button type="button" className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary p-3 text-left hover:bg-surface-tertiary" onClick={() => setForm("import")}>
                  <BrandLogo brand="claude" label="Claude" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900">Copy from Claude</span>
                    <span className="block text-xs text-muted">{newImports.length} found in Claude Desktop or Claude Code.</span>
                  </span>
                </button>
              )}
              <div className="flex cursor-not-allowed items-center gap-3 rounded-2xl border border-dashed border-border p-3 opacity-60" aria-disabled="true" title="Coming soon">
                <BrandLogo brand="claude" label="Claude Code" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900">Claude Code</span>
                  <span className="block text-xs text-muted">Coming soon</span>
                </span>
              </div>
            </div>
          )}
          {form === "elevenlabs" && agentId && <ElevenLabsSetup agentId={agentId} onDone={done} onCancel={() => setForm("none")} />}
          {form === "custom" && agentId && (
            <CustomForm
              key={tokenEntry?.id ?? "custom"}
              agentId={agentId}
              initial={tokenEntry ? { name: tokenEntry.name, url: tokenEntry.url, auth: "token", tokenHelp: tokenEntry.tokenHelp, preset: tokenEntry.id } : undefined}
              onDone={done}
              onCancel={() => setForm("none")}
            />
          )}
          {form === "import" && agentId && <ImportPanel agentId={agentId} imports={imports} onDone={done} onCancel={() => setForm("none")} />}

          {form === "none" && <BuiltInCards />}
          {lettaError && (
            <p className="rounded-xl bg-surface-secondary px-3.5 py-2.5 text-xs text-muted">Couldn't load the connectors on your Letta account: {lettaError}</p>
          )}
          <button type="button" className="button-secondary justify-self-start" onClick={() => {
            actionEpoch.current++;
            void refresh();
          }}>Refresh connectors</button>
          {loading && <p role="status" aria-live="polite" className="text-xs text-muted">Checking connector catalogs and attachments… Changes are disabled while checking.</p>}
          {!connectors && loading && <Spinner className="h-4 w-4 text-muted" />}
          {connectors?.length === 0 && !lettaError && form === "none" && <p className="text-sm text-muted">No connectors yet.</p>}
          {connectors && connectors.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <h2 className="shrink-0 text-sm font-semibold text-ink-900">Your connectors</h2>
              {agentId && <AllConnectorsToggle connectors={connectors} agentId={agentId} agentName={agentName} cloudUnavailable={Boolean(lettaError)} checking={loading} onChanged={() => void refresh()} onError={setError} />}
            </div>
          )}
          {agentId &&
            connectors?.map((connector) => (
              <ConnectorCard key={connector.id} connector={connector} agentId={agentId} agentName={agentName} checking={loading} actionEpoch={actionEpoch} onChanged={() => void refresh()} onError={setError} />
            ))}
          {form === "none" && agentId && (
            <CatalogBrowser
              agentId={agentId}
              connectors={connectors ?? []}
              onAdded={() => void refresh()}
              onNeedsToken={(entry) => {
                setTokenEntry(entry);
                setForm("custom");
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}
