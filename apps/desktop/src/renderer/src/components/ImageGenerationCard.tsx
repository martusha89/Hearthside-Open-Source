import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageConnectStatus, ImageEngine, ImageSetupMode, ImageSetupStep } from "../types";
import { createSetupSession, type SetupPhase } from "../lib/image-setup-session";
import { BrandLogo, brandFor } from "./BrandLogo";
import { CheckIcon, Spinner } from "./icons";

/**
 * Hearthside: connecting an account so agents can make pictures.
 *
 * This used to be a dropdown with a line of advice ("installed, sign in with
 * codex login"), which only helped people who already knew what a terminal
 * was. It is now a card per provider that says what is true right now and
 * offers the one button that moves things forward: ChatGPT first, because
 * Hearthside can install and sign that one in itself.
 *
 * Two things are kept honest here:
 *
 *  - Connecting an account is not the same as choosing it. "Use for images"
 *    stays off until the person picks a provider, and a provider can only be
 *    picked once its sign-in has actually been confirmed.
 *  - Nothing on this card makes a picture. A picture costs the person part of
 *    their account's allowance, so the first one is made when an agent is
 *    asked for one, not to prove a button worked.
 *
 * Grok keeps the path it has: Hearthside cannot install or sign it in yet, so
 * the card says so and keeps the commands under "Advanced" rather than
 * implying a button exists.
 *
 * The panel below is given everything it draws, so every state it can be in
 * can be rendered in a test. The card around it does the talking to the main
 * process.
 */

const api = window.bridge;

export type { SetupPhase };

export function ImageGenerationCard({ engine, onChange }: { engine: ImageEngine | "off"; onChange: (engine: ImageEngine | "off") => void }) {
  const [status, setStatus] = useState<ImageConnectStatus | null>(null);
  const [phase, setPhase] = useState<SetupPhase>({ kind: "idle" });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.imageConnectStatus();
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setStatus(null);
    }
  }, []);

  /**
   * The timing around a setup — events that overtake the session id, a cancel
   * or a close while the request is in flight — lives in createSetupSession,
   * where it is tested. The card only draws what it is told.
   */
  const session = useRef<ReturnType<typeof createSetupSession> | null>(null);
  if (!session.current) {
    session.current = createSetupSession({
      start: (step, mode) => api.startImageSetup(step, mode),
      cancel: (sessionId) => api.cancelImageSetup(sessionId),
      onPhase: (next) => {
        if (mounted.current) setPhase(next);
      },
      onSettled: () => void refresh(),
    });
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const off = api.onEvent((event) => session.current?.handleEvent(event));
    return () => {
      mounted.current = false;
      off();
      // Leaving this panel mid-setup stops it rather than leaving a download or
      // a sign-in running where nobody can see or cancel it.
      session.current?.dispose();
    };
  }, [refresh]);

  return (
    <ImageConnectionPanel
      status={status}
      phase={phase}
      engine={engine}
      windows={api.platform === "win32"}
      onChange={onChange}
      onStart={(step, mode) => void session.current?.start(step, mode)}
      onCancel={() => session.current?.cancel()}
    />
  );
}

export function ImageConnectionPanel({
  status,
  phase,
  engine,
  windows,
  onChange,
  onStart,
  onCancel,
}: {
  status: ImageConnectStatus | null;
  phase: SetupPhase;
  engine: ImageEngine | "off";
  windows: boolean;
  onChange: (engine: ImageEngine | "off") => void;
  onStart: (step: ImageSetupStep, mode?: ImageSetupMode) => void;
  onCancel: () => void;
}) {
  const codex = status?.codex;
  const grok = status?.grok;
  const busy = phase.kind === "starting" || phase.kind === "running";
  /** "Connected" means a ChatGPT account, confirmed by the CLI — not an API key. */
  const connected = codex?.signedIn === true && codex.authMode === "chatgpt";

  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-surface px-4 py-3" data-testid="builtin-images">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-base">
          🎨
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink-900">Image generation</span>
          <span className="block text-xs text-muted">Agents can make pictures using an account you already have.</span>
        </span>
        <label className="flex shrink-0 items-center gap-2 text-xs text-ink-800">
          Use for images:
          <select className="field w-auto shrink-0 py-1 text-xs" aria-label="Image engine" value={engine} onChange={(event) => onChange(event.target.value as ImageEngine | "off")}>
            <option value="off">Off</option>
            {/* Only a confirmed sign-in can be chosen: an agent set to use an
                engine that isn't connected would fail at the picture. */}
            <option value="codex" disabled={!connected}>
              ChatGPT{connected ? "" : " (not connected)"}
            </option>
            <option value="grok" disabled={!grok?.signedIn}>
              Grok{grok?.signedIn ? "" : " (not connected)"}
            </option>
          </select>
        </label>
      </div>

      {/* --- ChatGPT, the one Hearthside can set up itself --- */}
      <div className="grid gap-2 rounded-xl border border-border bg-surface-secondary p-3" data-testid="image-provider-chatgpt">
        <div className="flex items-center gap-3">
          <BrandLogo brand={brandFor("ChatGPT", "OpenAI")} label="ChatGPT" size={28} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900">ChatGPT</span>
            <span className="block text-xs text-muted" data-testid="image-chatgpt-status">
              {!status
                ? "Checking…"
                : codex?.supported === false
                  ? "Hearthside can't set this up on this kind of computer."
                  : !codex?.installed
                    ? "Not set up yet."
                    : connected
                      ? `Connected to your ChatGPT account${codex?.source === "user" ? " (using the Codex you installed)" : ""}.`
                      : codex?.authMode === "api-key"
                        ? "Signed in with an OpenAI API key, not a ChatGPT account."
                        : "Installed. Not signed in yet."}
            </span>
          </span>
          {connected && !busy && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-success">
              <CheckIcon className="h-4 w-4" /> Ready
            </span>
          )}
        </div>

        {status && codex?.supported === false && (
          <p className="text-xs text-muted">
            OpenAI doesn't publish its image app for this computer, so Hearthside can't install it here. Grok below can still make pictures.
          </p>
        )}

        {/* Not installed: say plainly what the one click will do. */}
        {status && codex?.supported !== false && !codex?.installed && !busy && (
          <>
            <p className="text-xs text-ink-700">
              Hearthside will download OpenAI's Codex tool (about 150&nbsp;MB), which it uses to make pictures, into your own Hearthside folder. Then you can connect your
              ChatGPT account. It doesn't change your PATH or require administrator rights.
            </p>
            <div>
              <button type="button" className="button-primary" onClick={() => onStart("install")} data-testid="image-setup-start">
                Set up image generation
              </button>
            </div>
          </>
        )}

        {/* Installed but not signed in, or signed in as something else. */}
        {status && codex?.installed && !connected && !busy && (
          <>
            <p className="text-xs text-ink-700">
              {codex.authMode === "api-key"
                ? "Pictures made this way would be billed to that API key rather than coming out of a ChatGPT plan. Sign in with your ChatGPT account instead:"
                : "Sign in to ChatGPT to connect your account. Hearthside opens ChatGPT's own sign-in page; it never asks for your password."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="button-primary" onClick={() => onStart("login", "browser")} data-testid="image-connect-browser">
                Connect ChatGPT
              </button>
              <button type="button" className="button-secondary" onClick={() => onStart("login", "device")} data-testid="image-connect-device">
                Sign in with a code instead
              </button>
            </div>
            <p className="text-[11px] text-muted">Use the code option when your browser is on another device, or if the browser sign-in doesn't come back.</p>
          </>
        )}

        {/* Connected: allow swapping to a different ChatGPT account. */}
        {status && connected && !busy && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="button-secondary" onClick={() => onStart("login", "browser")} data-testid="image-reconnect">
              Reconnect or change account
            </button>
          </div>
        )}

        {busy && <SetupProgress phase={phase} onCancel={onCancel} />}

        {phase.kind === "failed" && (
          <div className="grid gap-2">
            <p className="break-words text-xs text-error" data-testid="image-setup-error">
              {phase.error}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button-secondary" onClick={() => onStart(codex?.installed ? "login" : "install", "browser")} data-testid="image-setup-retry">
                Try again
              </button>
              {codex?.installed && (
                <button type="button" className="button-secondary" onClick={() => onStart("login", "device")}>
                  Try a one-time code
                </button>
              )}
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted">Connecting doesn't make a picture. The first one an agent makes is what uses your ChatGPT plan's image allowance.</p>
      </div>

      {/* --- Grok, which still needs its own install and sign-in --- */}
      <div className="grid gap-2 rounded-xl border border-border bg-surface-secondary p-3" data-testid="image-provider-grok">
        <div className="flex items-center gap-3">
          <BrandLogo brand={brandFor("Grok", "xAI")} label="Grok" size={28} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900">Grok</span>
            <span className="block text-xs text-muted" data-testid="image-grok-status">
              {!status ? "Checking…" : !grok?.installed ? "Not installed." : grok.signedIn ? "Installed and signed in." : "Installed. Not signed in yet."}
            </span>
          </span>
          {grok?.signedIn && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-success">
              <CheckIcon className="h-4 w-4" /> Ready
            </span>
          )}
        </div>
        {status && !grok?.signedIn && (
          <>
            <p className="text-xs text-ink-700">
              Hearthside can't install or sign in to Grok for you yet — that one still needs a terminal. If you'd rather not, use ChatGPT above.
            </p>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer text-ink-700">Advanced: do it yourself</summary>
              <div className="mt-1 grid gap-1">
                <span>{grok?.installed ? "Grok is installed. Sign in with:" : "Install the Grok CLI, then sign in with:"}</span>
                <code className="rounded-lg bg-surface px-2 py-1 font-mono text-[11px] text-ink-900">grok login</code>
                <span>Hearthside picks it up once it's signed in.</span>
              </div>
            </details>
          </>
        )}
      </div>

      <p className="text-[11px] text-muted">Pictures are saved in Pictures{windows ? "\\" : "/"}Hearthside.</p>
    </div>
  );
}

/** What is happening right now, with a way out of it. */
function SetupProgress({ phase, onCancel }: { phase: SetupPhase; onCancel: () => void }) {
  const state = phase.kind === "running" ? phase.state : null;
  const percent = state?.progress === null || state?.progress === undefined ? null : Math.round(state.progress * 100);
  return (
    <div className="grid gap-2" data-testid="image-setup-progress">
      <p className="flex items-center gap-2 text-sm text-ink-700">
        <Spinner className="h-3.5 w-3.5" />
        <span data-testid="image-setup-message">{state?.message ?? "Starting…"}</span>
      </p>

      {percent !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}

      {state?.code && (
        <div className="grid gap-1">
          <span className="text-xs text-ink-700">Type this one-time code on the page:</span>
          <code className="w-fit rounded-lg bg-surface px-3 py-1.5 font-mono text-lg tracking-widest text-ink-900" data-testid="image-setup-code">
            {state.code}
          </code>
          <span className="text-[11px] text-muted">Only continue if you started this sign-in here. If a website or someone else gave you a code, cancel.</span>
        </div>
      )}

      {state?.url && (
        <div>
          {/* The main process only ever sends one of OpenAI's own sign-in
              addresses, and this opens in the system browser. */}
          <a href={state.url} target="_blank" rel="noreferrer" className="button-primary" data-testid="image-setup-url">
            Open the ChatGPT sign-in page
          </a>
        </div>
      )}

      <div>
        <button type="button" className="button-secondary" onClick={onCancel} data-testid="image-setup-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
