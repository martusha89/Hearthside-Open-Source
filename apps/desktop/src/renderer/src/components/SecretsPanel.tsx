import { useEffect, useState } from "react";
import { Spinner } from "./icons";

/**
 * Hearthside: an agent's secrets, private values its skills and tools can
 * use (like an API key) without putting them in memory or chats. Values are
 * never shown back.
 */
export function SecretsPanel({ agentId }: { agentId: string }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.bridge
      .listSecretNames(agentId)
      .then(setNames)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [agentId]);

  const run = async (action: () => Promise<string[]>) => {
    setBusy(true);
    setError(null);
    try {
      setNames(await action());
      setName("");
      setValue("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 grid gap-2 border-t border-border pt-5">
      <h3 className="text-sm font-semibold text-ink-900">Secrets</h3>
      <p className="text-xs text-muted">
        Private values the agent's skills and tools can use, like an API key, without putting them in memory or chats. Values are
        never shown again.
      </p>
      {names === null && !error && <Spinner className="h-4 w-4 text-muted" />}
      {names?.map((secret) => (
        <div key={secret} className="flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-900">{secret}</span>
          <span className="text-xs text-muted">••••••</span>
          <button type="button" className="text-xs text-muted hover:text-error hover:underline" disabled={busy} onClick={() => void run(() => window.bridge.removeSecret(agentId, secret))}>
            Remove
          </button>
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && value) void run(() => window.bridge.setSecret(agentId, name.trim(), value));
        }}
      >
        <input value={name} onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} placeholder="NAME" aria-label="Secret name" className="field w-40 font-mono text-xs" />
        <input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Value" aria-label="Secret value" autoComplete="off" className="field min-w-0 flex-1 font-mono text-xs" />
        <button type="submit" className="button-secondary" disabled={busy || !name.trim() || !value}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Add
        </button>
      </form>
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </section>
  );
}
