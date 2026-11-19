// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useState } from "react";
import type { DreamSettings } from "../types";
import { Spinner } from "./icons";
import { useAppStore } from "../store";

/** Hearthside's suggested review guidance for companion agents. Editable before saving. */
export const COMPANION_REVIEW_GUIDANCE = `This agent is a long-term companion. When reviewing memory updates:
- Keep what matters for the relationship: how the person is feeling, what they shared, important dates, people, pets, routines and preferences.
- Preserve the agent's own identity, voice and boundaries; change persona files only with care and only when the conversation clearly calls for it.
- Record emotional context with dates ("2026-10-10: stressed about work, asked for gentler check-ins"), not transcripts.
- Correct outdated facts at the source rather than adding contradictions.
- Never store secrets, passwords or anything the person asked to forget.`;

const TRIGGERS: Array<{ id: DreamSettings["trigger"]; label: string; detail: string }> = [
  { id: "off", label: "Off", detail: "The agent never dreams in the background." },
  { id: "step-count", label: "Every N steps", detail: "After a set amount of activity." },
  { id: "compaction-event", label: "When the chat is summarised", detail: "When older messages are summarised to make room." },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dreaming: background reflection that reviews recent conversations and
 * updates the agent's memory without interrupting chats.
 */
export function DreamSettingsPanel({ agentId }: { agentId: string }) {
  const [saved, setSaved] = useState<DreamSettings | null>(null);
  const [draft, setDraft] = useState<DreamSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // The runtime is on this computer unless the app is connected to someone's server.
  const windowsRuntime = useAppStore((state) => window.bridge.platform === "win32" && state.connection?.backend !== "remote");

  useEffect(() => {
    let cancelled = false;
    window.bridge
      .getDreamSettings(agentId)
      .then((settings) => {
        if (cancelled) return;
        setSaved(settings);
        setDraft(settings);
      })
      .catch((failure: unknown) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (!draft || !saved) {
    return error ? (
      <p className="break-words text-xs text-error">{error}</p>
    ) : (
      <div className="flex justify-center py-4">
        <Spinner className="h-4 w-4 text-muted" />
      </div>
    );
  }

  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const edit = (patch: Partial<DreamSettings>) => {
    setDraft({ ...draft, ...patch });
    setJustSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.bridge.setDreamSettings(agentId, draft);
      setSaved(next);
      setDraft(next);
      setJustSaved(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4 rounded-xl border border-border px-3.5 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) void save();
      }}
    >
      <div>
        <div className="text-sm font-medium text-ink-900">Dreaming</div>
        <div className="text-xs text-muted">
          While you're away, the agent reflects on recent chats and updates its memory.
        </div>
      </div>

      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-ink-700">When to dream</legend>
        {TRIGGERS.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="dream-trigger"
              className="mt-1 accent-[var(--color-accent)]"
              checked={draft.trigger === item.id}
              onChange={() => edit({ trigger: item.id })}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-ink-900">
                {item.id === "step-count" ? (
                  <>
                    Every
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      aria-label="Steps between dreams"
                      value={draft.stepCount}
                      onFocus={() => edit({ trigger: "step-count" })}
                      onChange={(event) => edit({ stepCount: Math.max(1, Math.round(Number(event.target.value) || 1)) })}
                      className="field w-20 py-1 text-center"
                    />
                    steps
                  </>
                ) : (
                  item.label
                )}
              </span>
              <span className="block text-xs text-muted">{item.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Hearthside: the runtime switches automatic dreaming off on Windows (it
          works in a second copy of the memory folder, whose path gets too long
          there), and says nothing: the choice saved and no dream ever started.
          It applies when the runtime runs on this computer. */}
      {draft.trigger !== "off" && windowsRuntime && (
        <p role="note" className="rounded-lg bg-warning-light px-3 py-2 text-xs text-ink-800">
          Automatic dreaming doesn't run on Windows yet, so this choice is saved but nothing will start on its own.
          You can still start a dream yourself by typing <code>/dream</code> in a chat.
        </p>
      )}

      {draft.trigger !== "off" && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-xs font-medium text-ink-700">What happens to the changes</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="dream-merge"
              className="mt-1 accent-[var(--color-accent)]"
              checked={draft.merge === "auto"}
              onChange={() => edit({ merge: "auto" })}
            />
            <span>
              <span className="block text-ink-900">Save them straight away</span>
              <span className="block text-xs text-muted">Changes go straight into memory.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="dream-merge"
              className="mt-1 accent-[var(--color-accent)]"
              checked={draft.merge === "explicit"}
              onChange={() => edit({ merge: "explicit" })}
            />
            <span>
              <span className="block text-ink-900">Double-check them first</span>
              <span className="block text-xs text-muted">
                A second pass checks and revises the changes first. Uses more of your model allowance; it doesn't ask you.
              </span>
            </span>
          </label>
        </fieldset>
      )}

      {draft.trigger !== "off" && draft.merge === "explicit" && (
        <div className="grid gap-1.5">
          {/* The button sits outside the <label> so the label names the textarea, not the button. */}
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="dream-review-instructions" className="text-xs font-medium text-ink-700">
              Review instructions <span className="font-normal text-muted">(optional)</span>
            </label>
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => edit({ mergeInstructions: COMPANION_REVIEW_GUIDANCE })}
            >
              Use companion guidance
            </button>
          </div>
          <textarea
            id="dream-review-instructions"
            value={draft.mergeInstructions}
            onChange={(event) => edit({ mergeInstructions: event.target.value })}
            rows={6}
            placeholder="Optional: what the reviewing agent should keep, change or avoid."
            className="field resize-y text-xs leading-relaxed"
          />
          <p className="text-xs text-muted">
            Review works without these: the agent already checks each change for accuracy, where it belongs and whether it fits
            existing memory. Anything you write here is added on top.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 break-words text-xs" role="status">
          {error ? <span className="text-error">{error}</span> : justSaved && !changed && <span className="text-success">Saved</span>}
        </p>
        <button type="submit" className="button-primary" disabled={!changed || busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Save dream settings
        </button>
      </div>
    </form>
  );
}
