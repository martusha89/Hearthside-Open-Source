import { useEffect, useRef, useState } from "react";
import type { GifResult } from "../types";
import { Spinner } from "./icons";

/** Hearthside: pick a GIF to send (KLIPY). Trending first; type to search. */
export function GifPicker({ onPick, onClose }: { onPick: (gif: GifResult) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Search a moment after typing stops.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setError(null);
      void window.bridge
        .listGifs(query)
        .then((found) => live && setGifs(found))
        .catch((failure: unknown) => live && setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    }, query ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  // Closes on Escape or a click outside.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: MouseEvent) => box.current && !box.current.contains(event.target as Node) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div ref={box} role="dialog" aria-label="Send a GIF" className="absolute bottom-full left-0 z-30 mb-2 grid w-[360px] max-w-[calc(100vw-3rem)] gap-2 rounded-2xl border border-border bg-surface p-2.5 shadow-card">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search KLIPY"
        aria-label="Search GIFs"
        className="field py-1.5 text-sm"
      />
      <div className="h-72 overflow-y-auto">
        {!gifs && !error && (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-5 w-5 text-muted" />
          </div>
        )}
        {error && <p className="p-2 text-xs text-error">{error}</p>}
        {gifs?.length === 0 && <p className="p-2 text-xs text-muted">No GIFs for that. Try other words.</p>}
        {gifs && gifs.length > 0 && (
          <div className="columns-3 gap-1.5">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                title={gif.title}
                aria-label={`Send GIF: ${gif.title}`}
                onClick={() => onPick(gif)}
                className="mb-1.5 block w-full overflow-hidden rounded-lg bg-surface-secondary transition-opacity hover:opacity-80"
              >
                <img src={gif.preview} alt={gif.title} loading="lazy" className="block w-full" style={gif.width && gif.height ? { aspectRatio: `${gif.width} / ${gif.height}` } : undefined} />
              </button>
            ))}
          </div>
        )}
      </div>
      <a href="https://klipy.com" target="_blank" rel="noreferrer" className="justify-self-end text-[11px] text-muted-light hover:text-ink-700 hover:underline">
        Powered by KLIPY
      </a>
    </div>
  );
}
