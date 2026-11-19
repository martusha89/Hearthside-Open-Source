import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { validChatIcon } from "../lib/chat-organisation";

const SYMBOLS = ["💬", "🌱", "🏡", "✨", "❤️", "📚", "🎨", "🎵", "🌙", "☀️", "🌈", "⭐", "◆", "●", "▲", "✦"];

export function ChatIconDialog({ title, icon, onSave, onClose }: { title: string; icon: string | null; onSave: (icon: string | null) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(icon ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async (next: string | null) => {
    setBusy(true);
    setError(false);
    try { await onSave(next); onClose(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[360px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-5 shadow-elevated">
        <Dialog.Title className="text-base font-semibold text-ink-900">Choose chat icon</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-muted">An optional emoji or symbol for {title}. This does not change its title.</Dialog.Description>
        <div className="my-4 grid grid-cols-8 gap-1" aria-label="Suggested symbols">
          {SYMBOLS.map((symbol) => <button key={symbol} type="button" disabled={busy} aria-label={`Choose ${symbol}`} aria-pressed={value === symbol} onClick={() => setValue(symbol)} className="rounded-lg border border-border p-1 text-xl hover:bg-surface-tertiary focus-visible:outline focus-visible:outline-2">{symbol}</button>)}
        </div>
        <label className="grid gap-1 text-sm text-ink-800">Custom emoji or symbol
          <input className="field" value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} aria-describedby="chat-icon-help" />
        </label>
        <p id="chat-icon-help" className="mt-1 text-xs text-muted">Use one emoji or symbol. Joined emoji and flags are welcome.</p>
        {value && !validChatIcon(value) && <p role="status" className="mt-1 text-xs text-error">Choose just one emoji or symbol.</p>}
        {error && <p role="alert" className="mt-2 text-xs text-error">Could not save the icon. Try again.</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void save(null)}>Reset icon</button>
          <Dialog.Close className="button-secondary" disabled={busy}>Cancel</Dialog.Close>
          <button type="button" className="button-primary" disabled={busy || !validChatIcon(value)} onClick={() => void save(value)}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
