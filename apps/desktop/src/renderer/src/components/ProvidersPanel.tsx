// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import type { ProviderSummary } from "../types";
import { CheckIcon, ChevronRightIcon, Spinner } from "./icons";
import { GptUsagePanel, isChatGptProvider } from "./GptUsagePanel";
import { SubscriptionSignIn } from "./SubscriptionSignIn";

/** Shown first among providers that are not connected yet. */
const FEATURED = [
  "openai-codex-oauth",
  // Letta Cloud ids.
  "codex",
  "grok",
  "anthropic-oauth",
  "github-copilot",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
  "lmstudio",
  "openai-compatible",
];

function rank(provider: ProviderSummary): number {
  if (provider.connections.length > 0) return 0;
  // Hearthside: what can't be connected here goes last.
  if (provider.unavailable) return 1000;
  const featured = FEATURED.indexOf(provider.id);
  return featured >= 0 ? 1 + featured : 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ProviderForm({ provider, onDone }: { provider: ProviderSummary; onDone: () => void }) {
  const connectProvider = useAppStore((state) => state.connectProvider);
  const [methodId, setMethodId] = useState(provider.authMethods[0]?.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const method = provider.authMethods.find((item) => item.id === methodId);
  const fields = method ? method.fields : provider.fields;
  const complete = fields.every((field) => !field.required || values[field.key]?.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectProvider({
        providerId: provider.id,
        ...(method ? { authMethodId: method.id } : {}),
        fields: Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? ""])),
      });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void submit();
      }}
    >
      {provider.authMethods.length > 1 && (
        <div className="grid gap-1.5">
          {provider.authMethods.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${provider.id}-method`}
                className="mt-1 accent-[var(--color-accent)]"
                checked={item.id === methodId}
                onChange={() => setMethodId(item.id)}
              />
              <span>
                <span className="block text-ink-900">{item.label}</span>
                <span className="block text-xs text-muted">{item.description}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {fields.map((field, index) => (
        <label key={field.key} className="grid gap-1">
          <span className="text-xs font-medium text-ink-700">
            {field.label}
            {!field.required && <span className="font-normal text-muted"> (optional)</span>}
          </span>
          <input
            autoFocus={index === 0}
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[field.key] ?? ""}
            placeholder={field.placeholder ?? undefined}
            onChange={(event) =>
              setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
            }
            className="field font-mono"
          />
        </label>
      ))}
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div>
        <button type="submit" className="button-primary" disabled={!complete || busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {provider.connections.length > 0 ? "Update" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function ProviderRow({
  provider,
  open,
  onToggle,
}: {
  provider: ProviderSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const disconnectProvider = useAppStore((state) => state.disconnectProvider);
  // Hearthside: which connection this is. Usage read on one account must not
  // stay on screen as if it were the next one's, so the panel starts again.
  const connectionRevision = useAppStore((state) => state.settings?.connectionRevision ?? "initial");
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = provider.connections.length > 0;
  const unavailable = provider.unavailable;

  const disconnect = async (name: string) => {
    setRemoving(name);
    setError(null);
    try {
      await disconnectProvider({ providerId: provider.id, providerName: name });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-tertiary transition-colors"
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${unavailable ? "text-muted" : "text-ink-900"}`}>
            {provider.name}
          </span>
          {!open && (
            <span className="block truncate text-xs text-muted">{provider.description}</span>
          )}
        </span>
        {unavailable && !connected && <span className="shrink-0 text-xs text-muted">Not available</span>}
        {/* Hearthside: on This computer a key is saved without the provider
            being asked, so "Connected" is kept for what a check confirmed. */}
        {connected && (provider.check === undefined || provider.check === "verified") && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-success">
            <CheckIcon className="h-3.5 w-3.5" />
            Connected
          </span>
        )}
        {connected && provider.check === "unchecked" && (
          <span className="shrink-0 text-xs text-muted" title="Saved on this computer. Hearthside couldn't confirm it with the provider, so you'll find out whether it works when you send a message.">
            Saved, not checked
          </span>
        )}
        {connected && provider.check === "unreachable" && (
          <span className="shrink-0 text-xs text-muted" title="Saved on this computer, but nothing answered at that address. Start the server, then open this panel again to see its models.">
            Saved, server not answering
          </span>
        )}
        <ChevronRightIcon
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="grid gap-3 px-3 pb-3.5">
          <p className="text-xs text-muted">{provider.description}</p>
          {provider.connections.map((connection) => (
            <div
              key={connection.name}
              className="flex items-center gap-3 rounded-lg bg-surface-tertiary px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-ink-900">
                  {connection.name}
                </span>
                {connection.baseUrl && (
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {connection.baseUrl}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="button-secondary shrink-0"
                disabled={removing !== null}
                onClick={() => void disconnect(connection.name)}
              >
                {removing === connection.name && <Spinner className="h-3.5 w-3.5" />}
                Disconnect
              </button>
            </div>
          ))}
          {error && <p className="break-words text-xs text-error">{error}</p>}
          {/* Hearthside: a connected ChatGPT plan reports its own usage and resets. */}
          {connected && isChatGptProvider(provider) && <GptUsagePanel key={connectionRevision} />}
          {unavailable ? (
            <p className="rounded-lg bg-surface-tertiary px-3 py-2 text-xs text-ink-700">{unavailable}</p>
          ) : provider.oauth ? (
            // Hearthside: sign in from the app instead of sending people to the CLI.
            !connected && <SubscriptionSignIn provider={provider} />
          ) : provider.fields.length > 0 || provider.authMethods.length > 0 ? (
            <ProviderForm provider={provider} onDone={onToggle} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Connect API keys and local inference servers for the local backend. */
export function ProvidersPanel() {
  const providers = useAppStore((state) => state.providers);
  const available = useAppStore(
    (state) => state.connection?.status === "ready" && state.connection.providers,
  );
  const backend = useAppStore((state) => state.connection?.backend);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // Hearthside: a local server (Ollama, LM Studio) can be started, or given a
  // new model, after it was connected here, and nothing read the model list
  // again until the app restarted. Opening this panel does, and reads the
  // connections again too, so "server not answering" is brought up to date.
  const reloadModels = useAppStore((state) => state.reloadModels);
  useEffect(() => {
    if (available && backend !== "cloud") void reloadModels().catch(() => undefined);
  }, [available, backend, reloadModels]);

  const visible = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (providers ?? [])
      .filter((provider) => {
        const haystack = `${provider.name} ${provider.id}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [providers, query]);

  if (!available) {
    return (
      <p className="mt-4 text-sm text-muted">
        {backend === "cloud"
          ? "Letta Cloud manages model access. Provider setup here applies to the local backend."
          : "Model providers are set up on the server this app is connected to."}
      </p>
    );
  }

  if (!providers) {
    return (
      <div className="mt-6 flex justify-center">
        <Spinner className="h-5 w-5 text-muted" />
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-3">
      <p className="text-sm text-muted">
        {backend === "cloud"
          ? "Connected to your Letta account, so your Cloud agents can use them on any device. Keys and sign-ins are kept by Letta Cloud."
          : "Your agents send prompts to these providers. Keys are stored by the Letta runtime on the machine it runs on."}
      </p>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search providers"
        className="field"
      />
      <div className="max-h-[22rem] overflow-y-auto rounded-xl border border-border">
        {visible.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted">No providers match.</div>
        )}
        {visible.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            open={openId === provider.id}
            onToggle={() => setOpenId(openId === provider.id ? null : provider.id)}
          />
        ))}
      </div>
    </div>
  );
}
