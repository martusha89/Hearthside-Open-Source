import { useEffect, useState } from "react";
import type { ToolsetInfo, ToolsetPreference } from "../types";
import { Spinner } from "./icons";

/** Hearthside: plain-language names for the runtime's built-in tool sets. */
const FRIENDLY: Record<ToolsetPreference, { name: string; description: string }> = {
  auto: { name: "Automatic", description: "Picks the right set for the model. Recommended." },
  default: { name: "Claude-style tools", description: "Best for Claude and most models other than OpenAI's." },
  codex: { name: "Codex-style tools", description: "Best for OpenAI GPT models." },
  letta: { name: "Letta all-in-one (experimental)", description: "One set meant to work with every model." },
  none: { name: "No built-in tools", description: "Only skills and connected tools. For a companion that mostly chats." },
};

/** Which built-in tools the agent has (files, commands, web…). Saves on choice. */
export function ToolsetPanel({ agentId }: { agentId: string }) {
  const [info, setInfo] = useState<ToolsetInfo | null>(null);
  const [busy, setBusy] = useState<ToolsetPreference | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.bridge
      .getToolset(agentId)
      .then((value) => !cancelled && setInfo(value))
      .catch((failure: unknown) => !cancelled && setError(failure instanceof Error ? failure.message : String(failure)));
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const choose = async (preference: ToolsetPreference) => {
    const before = info;
    setBusy(preference);
    setError(null);
    // Show the choice straight away; put it back if saving fails.
    setInfo((current) => (current ? { ...current, preference } : current));
    try {
      setInfo(await window.bridge.setToolset(agentId, preference));
    } catch (failure) {
      setInfo(before);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const ids = info?.options.map((option) => option.id).filter((id): id is ToolsetPreference => id in FRIENDLY) ?? [];
  return (
    <section className="mt-6 grid gap-2 border-t border-border pt-5">
      <h3 className="text-sm font-semibold text-ink-900">Tools</h3>
      <p className="text-xs text-muted">The built-in tools the agent can use, such as files, commands and the web.</p>
      {!info && !error && <Spinner className="h-4 w-4 text-muted" />}
      {info && (
        <fieldset className="grid gap-1.5" disabled={busy !== null}>
          <legend className="sr-only">Tool set</legend>
          {ids.map((id) => (
            <label key={id} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="toolset"
                className="mt-1 accent-[var(--color-accent)]"
                checked={info.preference === id}
                onChange={() => void choose(id)}
              />
              <span>
                <span className="block text-ink-900">
                  {FRIENDLY[id].name}
                  {busy === id && <Spinner className="ml-2 inline h-3 w-3" />}
                  {id === "auto" && info.preference === "auto" && info.current && (
                    <span className="text-xs text-muted"> (using {FRIENDLY[info.current as ToolsetPreference]?.name ?? info.current})</span>
                  )}
                </span>
                <span className="block text-xs text-muted">{FRIENDLY[id].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </section>
  );
}
