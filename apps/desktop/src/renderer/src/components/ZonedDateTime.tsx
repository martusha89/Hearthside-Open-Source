import { useEffect, useId, useRef, useState } from "react";
import { isExplicitInstant, wallTimeChoices, zonedFields } from "../lib/zoned-date";

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const zones = Intl.supportedValuesOf("timeZone");
  return <label className="grid gap-1">Timezone<select className="field min-w-0 w-full" value={value} onChange={(event) => onChange(event.target.value)}>{[...new Set([value, "UTC", ...zones])].map((zone) => <option key={zone}>{zone}</option>)}</select></label>;
}

/** Invalid nonempty edits remain nonempty, so optional times can never silently become "now". */
export function ZonedDateTime({ label, value, timezone, onChange, required = false }: { label: string; value: string; timezone: string; onChange: (value: string) => void; required?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const emitted = useRef(value);
  const previousZone = useRef(timezone);
  const input = useRef<HTMLInputElement>(null);
  const rawInput = useRef<HTMLInputElement>(null);
  const valid = isExplicitInstant(value);
  const externalChange = emitted.current !== value || previousZone.current !== timezone;
  const wall = !externalChange && draft !== null ? draft : valid ? zonedFields(value, timezone) : "";
  const choices = wall ? wallTimeChoices(wall, timezone) : [];
  const error = value && !valid ? "Choose an existing time with an explicit offset; repeated clock times need an occurrence choice." : "";
  useEffect(() => {
    if (externalChange) { setDraft(null); emitted.current = value; previousZone.current = timezone; }
    input.current?.setCustomValidity(error);
    rawInput.current?.setCustomValidity(error);
  }, [value, timezone, error, externalChange]);
  const emit = (next: string) => { emitted.current = next; onChange(next); };
  const chosen = valid ? new Date(value).toISOString() : "";
  return <div className="grid gap-1">
    <label htmlFor={id}>{label}</label>
    <input ref={input} id={id} type="datetime-local" step="0.001" required={required} className="field min-w-0 w-full" value={wall} aria-invalid={Boolean(error)} aria-describedby={`${id}-zone`} onChange={(event) => {
      const next = event.target.value;
      setDraft(next);
      const matches = wallTimeChoices(next, timezone);
      emit(matches.length === 1 ? matches[0]! : next);
    }} />
    <p id={`${id}-zone`} className="text-xs text-muted">Interpreted in {timezone}</p>
    {error && <p role="alert" className="text-xs text-error">{error}</p>}
    {choices.length > 1 && <label className="grid gap-1 text-xs">This time occurs twice — choose an explicit offset<select required className="field" value={choices.includes(chosen) ? chosen : ""} onChange={(event) => emit(event.target.value || wall)}><option value="">Choose which occurrence…</option>{choices.map((iso) => <option key={iso} value={iso}>{new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", timeZoneName: "longOffset" }).format(new Date(iso))} · {iso}</option>)}</select></label>}
    <details><summary className="cursor-pointer text-xs text-muted">Advanced: explicit-offset ISO</summary><label className="grid gap-1 text-xs">{label} (ISO)<input ref={rawInput} className="field" value={value} aria-invalid={Boolean(error)} onChange={(event) => { setDraft(null); emit(event.target.value); }} /></label></details>
  </div>;
}
