// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useMemo, useRef, useState } from "react";
import { modelLabel } from "../lib/format";
import { resolveModel, valueForModel } from "../lib/models";
import type { ModelOption } from "../types";
import { CheckIcon, ChevronDownIcon } from "./icons";

const MAX_RESULTS = 60;

/** Searchable model menu. Catalogs run to hundreds of models, so it filters as you type. */
export function ModelPicker({
  value,
  effort = null,
  models,
  onChange,
  disabled = false,
  placement = "top",
  className = "",
  compact = false,
  footer,
  placeholder = "Default model",
}: {
  value: string | null;
  /** Hearthside: the reasoning level the chat runs at, when it is known. */
  effort?: string | null;
  models: ModelOption[];
  onChange: (handle: string) => void;
  disabled?: boolean;
  placement?: "top" | "bottom";
  className?: string;
  /** Compact composer presentation; other forms retain their disclosure arrow. */
  compact?: boolean;
  /** Hearthside: extra action under the list, e.g. "Make this the agent's default". */
  footer?: (close: () => void) => React.ReactNode;
  /** Hearthside: what the button says when nothing is chosen. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length
      ? models.filter((model) => {
          const haystack = `${model.label} ${model.handle} ${model.source?.label ?? ""}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
      : models;
    return matches.slice(0, MAX_RESULTS);
  }, [models, query]);

  // Hearthside: models arrive grouped (one row per model, reasoning chosen
  // separately); keep the current reasoning tier when switching models.
  // The chat's own level comes first: `value` is usually a plain handle, which
  // names no level, so without it switching models would drop to the default.
  const current = resolveModel(value, models);
  const choose = (model: ModelOption) => {
    onChange(valueForModel(model, effort ?? current?.effort ?? null));
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled || models.length === 0}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ?? undefined}
        className="chip max-w-full"
      >
        <span className="truncate">{value ? modelLabel(value, models) : placeholder}</span>
        {!compact && <ChevronDownIcon className="h-3 w-3 shrink-0" />}
      </button>
      {open && (
        <div
          className={`absolute left-0 z-50 w-80 rounded-xl border border-border bg-surface p-1.5 shadow-elevated ${placement === "top" ? "bottom-full mb-2" : "top-full mt-2"}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0]) choose(results[0]);
            }}
            placeholder="Search models"
            className="w-full rounded-lg bg-surface-tertiary px-3 py-2 text-sm text-ink-900 placeholder:text-muted focus:outline-none"
          />
          <div role="listbox" className="mt-1.5 max-h-72 overflow-y-auto">
            {results.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted">No models match.</div>
            )}
            {results.map((model) => (
              <button
                key={model.handle}
                type="button"
                role="option"
                aria-selected={model.handle === current?.model.handle}
                onClick={() => choose(model)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-surface-tertiary"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-900">{model.label}</span>
                  
                  {model.source && <span className="block truncate text-[11px] text-ink-700" title={model.source.label}>{model.source.label}</span>}
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {model.handle}
                  </span>
                </span>
                {model.handle === current?.model.handle && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
          {footer && <div className="mt-1 border-t border-border pt-1">{footer(() => setOpen(false))}</div>}
        </div>
      )}
    </div>
  );
}
