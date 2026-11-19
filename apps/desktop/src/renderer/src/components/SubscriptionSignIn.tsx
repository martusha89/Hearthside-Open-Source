// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useRef, useState } from "react";
import type { ProviderSignInState, ProviderSummary } from "../types";
import { useAppStore } from "../store";
import { CheckIcon, Spinner } from "./icons";

const api = window.bridge;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; sessionId: string; state: ProviderSignInState | null }
  | { kind: "done" }
  | { kind: "failed"; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sign in to a subscription provider (ChatGPT Plus/Pro, Claude Pro/Max,
 * GitHub Copilot, Grok…). The runtime runs the provider's own login; this
 * shows what it asks for: a page to open, a code to enter, or a question.
 */
export function SubscriptionSignIn({ provider }: { provider: ProviderSummary }) {
  const loadProviders = useAppStore((state) => state.loadProviders);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    const off = api.onEvent((event) => {
      if (event.type === "signin.update" && event.sessionId === sessionRef.current) {
        setPhase({ kind: "running", sessionId: event.sessionId, state: event.state });
      }
      if (event.type === "signin.finished" && event.sessionId === sessionRef.current) {
        sessionRef.current = null;
        if (event.ok) {
          setPhase({ kind: "done" });
          void loadProviders();
          void useAppStore.getState().reloadModels().catch(() => undefined);
        } else {
          setPhase({ kind: "failed", error: event.error ?? "Sign-in did not complete." });
        }
      }
    });
    return () => {
      off();
      // Leaving the panel mid-sign-in cancels it rather than leaving it running unseen.
      if (sessionRef.current) void api.cancelProviderSignIn(sessionRef.current).catch(() => undefined);
    };
  }, [loadProviders]);

  const start = async () => {
    setPhase({ kind: "starting" });
    setAnswer("");
    try {
      const { sessionId } = await api.startProviderSignIn(provider.id);
      sessionRef.current = sessionId;
      setPhase((current) => (current.kind === "starting" ? { kind: "running", sessionId, state: null } : current));
    } catch (error) {
      setPhase({ kind: "failed", error: errorMessage(error) });
    }
  };

  const cancel = () => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    setPhase({ kind: "idle" });
    if (sessionId) void api.cancelProviderSignIn(sessionId).catch(() => undefined);
  };

  if (phase.kind === "done") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckIcon className="h-4 w-4" /> Signed in. {provider.name} models are ready to use.
      </p>
    );
  }

  if (phase.kind === "idle" || phase.kind === "failed") {
    return (
      <div className="grid gap-2">
        <p className="text-xs text-ink-700">Uses your {provider.name} subscription instead of an API key.</p>
        {phase.kind === "failed" && <p className="break-words text-xs text-error">{phase.error}</p>}
        <div>
          <button type="button" className="button-primary" onClick={() => void start()}>
            {phase.kind === "failed" ? "Try again" : `Sign in with ${provider.name}`}
          </button>
        </div>
      </div>
    );
  }

  const state = phase.kind === "running" ? phase.state : null;
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-surface-secondary p-3">
      {!state && (
        <p className="flex items-center gap-2 text-sm text-ink-700">
          <Spinner className="h-3.5 w-3.5" /> Starting sign-in…
        </p>
      )}

      {state?.code && (
        <div className="grid gap-1">
          <span className="text-xs text-ink-700">Enter this code on the sign-in page:</span>
          <div className="flex items-center gap-2">
            <code className="rounded-lg bg-surface px-3 py-1.5 font-mono text-lg tracking-widest text-ink-900">
              {state.code}
            </code>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(state.code ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {state?.url && (
        <div>
          {/* Opens in the system browser (the app never navigates away). */}
          <a href={state.url} target="_blank" rel="noreferrer" className="button-primary">
            Open sign-in page
          </a>
        </div>
      )}

      {state?.prompt && (
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (phase.kind !== "running") return;
            void api.answerProviderSignIn(phase.sessionId, answer.trim()).catch((error: unknown) =>
              setPhase({ kind: "failed", error: errorMessage(error) }),
            );
            setAnswer("");
          }}
        >
          <span className="text-xs text-ink-700">{state.prompt}</span>
          <div className="flex gap-2">
            <input
              autoFocus
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="field font-mono"
            />
            <button type="submit" className="button-secondary">
              Send
            </button>
          </div>
        </form>
      )}

      {state && !state.code && !state.prompt && state.url && (
        <p className="text-xs text-muted">Finish signing in in your browser. This updates on its own.</p>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3 w-3" /> Waiting for {provider.name}…
        </span>
        <button type="button" className="button-secondary" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
