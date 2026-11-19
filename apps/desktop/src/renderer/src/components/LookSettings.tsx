import { useEffect, useRef, useState } from "react";
import type { Look, LookStyle } from "@hearthside/ipc-contract";
import { useAppStore } from "../store";
import { imageToDataUrl, MAX_BLUR } from "../lib/looks";
import { Avatar } from "./Avatar";
import { Spinner } from "./icons";

/**
 * Hearthside: "make it yours". A picture for a companion (and one for the
 * person, in Settings → Appearance), a theme colour the whole app takes on while
 * that companion is selected, and a blurred picture behind their chats. Kept
 * on this computer only; the agent's memory isn't touched.
 */

type Kind = "avatar" | "background";
const NO_LOOK: Look = { avatar: null, accent: null, background: null, blur: 14 };
// Mid-tone colours: the accent and surfaces are re-derived from them in light and dark alike.
const SWATCHES = ["#8b5cf6", "#ec4899", "#e11d48", "#f59e0b", "#10b981", "#3b82f6", "#f97316", "#64748b"];

function useLookActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };
  const pick = (target: string, kind: Kind, file: File | undefined) => {
    if (file) void run(kind, async () => window.bridge.setLookImage(target, kind, await imageToDataUrl(file, kind)));
  };
  const clear = (target: string, kind: Kind) => void run(kind, () => window.bridge.clearLookImage(target, kind));
  return { busy, error, run, pick, clear };
}

function PictureRow({
  label,
  hint,
  preview,
  hasPicture,
  busy,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  preview: React.ReactNode;
  hasPicture: boolean;
  busy: boolean;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-3">
      {preview}
      <div className="min-w-0 flex-1">
        <span className="block text-sm text-ink-900">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        aria-label={`${label} file`}
        onChange={(event) => {
          onPick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {hasPicture && (
        <button type="button" aria-label={`Remove ${label.toLowerCase()}`} className="text-xs text-muted hover:text-error" disabled={busy} onClick={onClear}>
          Remove
        </button>
      )}
      <button type="button" className="button-secondary" disabled={busy} onClick={() => input.current?.click()}>
        {busy && <Spinner className="h-3.5 w-3.5" />}
        {hasPicture ? "Change…" : "Choose…"}
      </button>
    </div>
  );
}

/** In Agent settings: the companion's picture, theme colour and chat background. */
export function AgentLookPanel({ agentId, name }: { agentId: string; name: string }) {
  const look = useAppStore((state) => state.looks?.agents[agentId]) ?? NO_LOOK;
  const { busy, error, run, pick, clear } = useLookActions();
  const setStyle = (style: LookStyle) => void run("style", () => window.bridge.setLookStyle(agentId, style));
  // The slider saves once it settles, not on every pixel.
  const [blur, setBlur] = useState(look.blur);
  useEffect(() => setBlur(look.blur), [look.blur]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeBlur = (value: number) => {
    setBlur(value);
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setStyle({ blur: value }), 250);
  };

  return (
    <section className="grid gap-4 rounded-xl border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">Make it yours</h3>
        <p className="text-xs text-muted">
          A picture and a colour for {name}, and what sits behind your chats. Stays on this computer; {name}'s memory isn't touched.
        </p>
      </div>
      <PictureRow
        label="Picture"
        hint="In the sidebar, beside replies, and on notifications."
        preview={<Avatar name={name} src={look.avatar} px={48} />}
        hasPicture={Boolean(look.avatar)}
        busy={busy === "avatar"}
        onPick={(file) => pick(agentId, "avatar", file)}
        onClear={() => clear(agentId, "avatar")}
      />
      <div className="grid gap-2">
        <div>
          <span className="block text-sm text-ink-900">Theme colour</span>
          <span className="block text-xs text-muted">The whole app takes on {name}'s colour while you're with them.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={!look.accent}
            onClick={() => setStyle({ accent: null })}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${look.accent ? "border-border text-ink-700 hover:bg-surface-tertiary" : "border-accent bg-accent-light text-accent"}`}
          >
            Hearthside teal
          </button>
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={`Colour ${swatch}`}
              aria-pressed={look.accent === swatch}
              onClick={() => setStyle({ accent: swatch })}
              style={{ backgroundColor: swatch }}
              className={`h-7 w-7 rounded-full border ${look.accent === swatch ? "border-ink-900 ring-2 ring-accent/40" : "border-border"}`}
            />
          ))}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-700">
            <input
              type="color"
              aria-label="Theme colour"
              value={look.accent ?? "#0f766e"}
              onChange={(event) => setStyle({ accent: event.target.value })}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            Any colour
          </label>
        </div>
      </div>
      <div className="grid gap-2">
        <PictureRow
          label="Background"
          hint="A picture behind your chats, blurred so the words stay easy to read."
          preview={
            look.background ? (
              <img src={look.background} alt="" className="h-12 w-16 shrink-0 rounded-lg object-cover" style={{ filter: `blur(${Math.min(3, blur / 6)}px)` }} />
            ) : (
              <span aria-hidden className="h-12 w-16 shrink-0 rounded-lg border border-dashed border-border bg-surface-secondary" />
            )
          }
          hasPicture={Boolean(look.background)}
          busy={busy === "background"}
          onPick={(file) => pick(agentId, "background", file)}
          onClear={() => clear(agentId, "background")}
        />
        {look.background && (
          <label className="grid gap-1">
            <span className="text-xs text-muted">Blur{blur ? ` · ${blur} px` : ""}</span>
            <input
              type="range"
              min={0}
              max={MAX_BLUR}
              value={blur}
              aria-label="Blur the background"
              onChange={(event) => changeBlur(Number(event.target.value))}
              className="accent-[var(--color-accent)]"
            />
            <span className="flex justify-between text-[11px] text-muted" aria-hidden>
              <span>Sharp</span>
              <span>Blurred</span>
            </span>
          </label>
        )}
      </div>
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </section>
  );
}

/** In General settings: the person's own picture, shown beside their messages. */
export function MyPicturePanel() {
  const src = useAppStore((state) => state.looks?.me.avatar ?? null);
  const { busy, error, pick, clear } = useLookActions();
  return (
    <div className="grid gap-2">
      <PictureRow
        label="Your picture"
        hint="Shown beside your messages. Stays on this computer."
        preview={<Avatar name="You" src={src} px={48} />}
        hasPicture={Boolean(src)}
        busy={busy === "avatar"}
        onPick={(file) => pick("me", "avatar", file)}
        onClear={() => clear("me", "avatar")}
      />
      {error && <p className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}
