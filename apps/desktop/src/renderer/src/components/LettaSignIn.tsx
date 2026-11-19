// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useState } from "react";
import { useAppStore } from "../store";
import type { AppSettings } from "../types";
import { CheckIcon, Spinner } from "./icons";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hearthside: "Sign in with Letta" for Letta Cloud. Opens Letta's sign-in page
 * in the browser (OAuth with PKCE); the API key field below stays as an
 * alternative.
 */
export function LettaSignIn({ settings }: { settings: AppSettings }) {
  const [phase, setPhase] = useState<"idle" | "waiting" | "signing-out">("idle");
  const [error, setError] = useState<string | null>(null);

  const apply = (next: AppSettings) => useAppStore.setState({ settings: next });

  const signIn = async () => {
    setPhase("waiting");
    setError(null);
    try {
      apply(await window.bridge.signInWithLetta());
    } catch (failure) {
      const message = errorMessage(failure);
      if (!/cancelled/i.test(message)) setError(message);
    } finally {
      setPhase("idle");
    }
  };

  const signOut = async () => {
    setPhase("signing-out");
    setError(null);
    try {
      apply(await window.bridge.signOutOfLetta());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPhase("idle");
    }
  };

  if (settings.hasLettaSignIn) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-3">
        <span className="flex items-center gap-2 text-sm text-ink-900">
          <CheckIcon className="h-4 w-4 text-success" /> Signed in with Letta
        </span>
        <button type="button" className="button-secondary" disabled={phase !== "idle"} onClick={() => void signOut()}>
          {phase === "signing-out" && <Spinner className="h-3.5 w-3.5" />}
          Sign out
        </button>
        {error && <p className="break-words text-xs text-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl border border-border px-3.5 py-3">
      {phase === "waiting" ? (
        <>
          <p className="flex items-center gap-2 text-sm text-ink-900">
            <Spinner className="h-3.5 w-3.5" /> Finish signing in in your browser…
          </p>
          <p className="text-xs text-muted">
            Letta's page may call this app "Letta Mobile"; that's expected. Hearthside uses Letta's public sign-in.
          </p>
          <div>
            <button type="button" className="button-secondary" onClick={() => void window.bridge.cancelLettaSignIn()}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <button type="button" className="button-primary" onClick={() => void signIn()}>
              Sign in with Letta
            </button>
          </div>
          <p className="text-xs text-muted">Opens Letta in your browser. No API key needed.</p>
        </>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}
