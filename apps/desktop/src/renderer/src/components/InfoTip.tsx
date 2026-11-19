import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";



export function InfoTip({ text, label = "What this means" }: { text: string; label?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
    // Below the icon unless that would run off the bottom of the window.
    const above = rect.bottom + 160 > window.innerHeight;
    setPlace({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const hide = () => setOpen(false);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", hide, true);
    return () => { window.removeEventListener("keydown", close); window.removeEventListener("scroll", hide, true); };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 translate-y-[1px] items-center justify-center rounded-full border border-current align-baseline text-[9px] font-semibold leading-none opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        i
      </button>
      {open && place && createPortal(
        <div
          id={id}
          role="tooltip"
          style={{ left: place.left, top: place.top, width: Math.min(320, window.innerWidth - 24), transform: place.above ? "translateY(-100%)" : undefined }}
          className="pointer-events-none fixed z-[1000] rounded-lg border border-border bg-surface px-3 py-2 text-xs font-normal leading-relaxed text-ink-900 shadow-elevated"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
