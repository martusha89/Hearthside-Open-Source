import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import type { CalendarOccurrence, CalendarSubscription } from "../types";
import { Spinner } from "./icons";
import { LaterActions } from "./LaterActions";
import { TimezoneSelect } from "./ZonedDateTime";
import { isExplicitInstant, resolveWallTime, wallTimeChoices } from "../lib/zoned-date";
import { addDays, blankDraft, daysBetween, type Draft, draftFrom, eventEnd, remindAgentFor, splitLocal } from "../lib/calendar-draft";

/**
 * Hearthside: the built-in calendar. Your own events, plus read-only calendars
 * imported from an iCal link (Google, iCloud, Outlook). Agents you allow can see
 * it and add events; reminders notify you and can also tell your agent.
 */

const DAYS_SHOWN = 60;
const REMINDERS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "No reminder" },
  { value: 0, label: "At the start" },
  { value: 5, label: "5 minutes before" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 1_440, label: "1 day before" },
];

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function dayKey(occurrence: CalendarOccurrence): string {
  return occurrence.allDay ? occurrence.start : new Date(occurrence.start).toLocaleDateString("en-CA");
}

function dayLabel(key: string): string {
  const today = new Date().toLocaleDateString("en-CA");
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA");
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function timeLabel(occurrence: CalendarOccurrence): string {
  if (occurrence.allDay) return "All day";
  const format = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return occurrence.end ? `${format(occurrence.start)} – ${format(occurrence.end)}` : format(occurrence.start);
}


function EventForm({ draft, agentId, agentName, agentAllowed, onDone, onCancel }: { draft: Draft; agentId: string | null; agentName: string; agentAllowed: boolean; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState(draft);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [startChoice, setStartChoice] = useState("");
  const [endChoice, setEndChoice] = useState("");
  const [rawStart, setRawStart] = useState("");
  const [rawEnd, setRawEnd] = useState("");
  const startWall = `${value.date}T${value.start || "09:00"}`;
  const lastDay = value.endDate && value.endDate >= value.date ? value.endDate : value.date;
  const endDay = lastDay === value.date && value.start && value.end && value.end <= value.start ? addDays(lastDay, 1) : lastDay;
  const endWall = `${endDay}T${value.end}`;
  const clockValid = (wall: string, choice: string) => { const choices = wallTimeChoices(wall, timezone); return choices.length === 1 || choices.includes(choice); };
  const timingValid = value.allDay || ((rawStart ? isExplicitInstant(rawStart) : clockValid(startWall, startChoice)) && (rawEnd ? isExplicitInstant(rawEnd) : !value.end || clockValid(endWall, endChoice)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setValue((current) => ({ ...current, ...patch }));
  // The event already tells a different companion (the calendar is shared).
  // Its tick is shown under that companion's name, so saving keeps it and
  // unticking it is a choice, not a side effect of who is selected.
  const tellsOther = Boolean(draft.tellAgentId && draft.tellAgentId !== agentId);
  const otherName = useAppStore((state) => state.agents.find((agent) => agent.id === draft.tellAgentId)?.name ?? "another companion");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!timingValid) throw new Error("Choose an existing time and confirm its offset.");
      for (const raw of value.allDay ? [] : [rawStart, rawEnd]) if (raw && !isExplicitInstant(raw)) throw new Error("Advanced timestamps need an explicit ISO timezone offset.");
      await window.bridge.saveCalendarEvent({
        ...(value.id ? { id: value.id, revision: value.revision } : {}),
        title: value.title,
        allDay: value.allDay,
        start: value.allDay ? value.date : rawStart || resolveWallTime(startWall, timezone, startChoice),
        end: value.allDay ? eventEnd(value) : rawEnd || (value.end ? resolveWallTime(endWall, timezone, endChoice) : null),
        location: value.location || null,
        notes: value.notes || null,
        reminderMinutes: value.reminder,
        remindAgentId: remindAgentFor(value, agentId),
      });
      onDone();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!value.id) return;
    setBusy(true);
    try {
      await window.bridge.deleteCalendarEvent(value.id);
      onDone();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-surface-secondary p-4" data-testid="event-form">
      <LaterActions current="calendar" />
      {!value.allDay && <><TimezoneSelect value={timezone} onChange={(zone) => { setTimezone(zone); setStartChoice(""); setEndChoice(""); }} />
        <p className="text-xs text-muted">Event date and times are interpreted in {timezone}.</p>
        {([{ label: "Start", wall: startWall, choice: startChoice, setChoice: setStartChoice }, { label: "End", wall: endWall, choice: endChoice, setChoice: setEndChoice }]).map(({ label, wall, choice, setChoice }) => {
          const choices = wallTimeChoices(wall, timezone);
          return choices.length > 1 ? <label key={label} className="grid gap-1 text-xs">{label} occurs twice — choose an explicit offset<select className="field" value={choices.includes(choice) ? choice : ""} onChange={(event) => setChoice(event.target.value)}><option value="">Choose occurrence…</option>{choices.map((iso) => <option key={iso} value={iso}>{new Intl.DateTimeFormat(undefined, { timeZone: timezone, timeZoneName: "longOffset", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))} · {iso}</option>)}</select></label> : null;
        })}</>}
      <input autoFocus className="field text-sm" placeholder="What's happening?" aria-label="Event title" value={value.title} onChange={(event) => set({ title: event.target.value })} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-800">
        <input
          type="date"
          ref={(input) => { input?.setCustomValidity(timingValid ? "" : "Choose an existing time and confirm its offset."); }}
          className="field w-auto py-1 text-xs"
          aria-label="Date"
          value={value.date}
          // Moving the start moves the end with it, keeping the length.
          onChange={(event) => event.target.value && set({ date: event.target.value, endDate: addDays(event.target.value, Math.max(0, daysBetween(value.date, value.endDate))) })}
        />
        {value.endDate !== value.date && (
          <>
            <span className="text-muted">to</span>
            <input type="date" className="field w-auto py-1 text-xs" aria-label="End date" min={value.date} value={value.endDate} onChange={(event) => set({ endDate: event.target.value || value.date })} />
          </>
        )}
        {!value.allDay && (
          <>
            <input type="time" className="field w-auto py-1 text-xs" aria-label="Start time" value={value.start} onChange={(event) => set({ start: event.target.value })} />
            <span className="text-muted">to</span>
            <input type="time" className="field w-auto py-1 text-xs" aria-label="End time" value={value.end} onChange={(event) => set({ end: event.target.value })} />
          </>
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={value.allDay} onChange={(event) => set({ allDay: event.target.checked })} />
          All day
        </label>
      </div>
      {!value.allDay && <details><summary className="cursor-pointer text-xs text-muted">Advanced: explicit-offset ISO overrides</summary><p className="text-xs text-muted">Nonempty values override the date and time controls above; their explicit offsets determine the instant.</p><label className="grid gap-1 text-xs">Start (ISO override)<input ref={(input) => { input?.setCustomValidity(rawStart && !isExplicitInstant(rawStart) ? "Use a valid civil timestamp with an explicit offset." : ""); }} aria-invalid={Boolean(rawStart && !isExplicitInstant(rawStart))} className="field" value={rawStart} onChange={(event) => setRawStart(event.target.value)} /></label><label className="grid gap-1 text-xs">End (optional ISO override)<input ref={(input) => { input?.setCustomValidity(rawEnd && !isExplicitInstant(rawEnd) ? "Use a valid civil timestamp with an explicit offset." : ""); }} aria-invalid={Boolean(rawEnd && !isExplicitInstant(rawEnd))} className="field" value={rawEnd} onChange={(event) => setRawEnd(event.target.value)} /></label></details>}
      <input className="field text-sm" placeholder="Where (optional)" aria-label="Location" value={value.location} onChange={(event) => set({ location: event.target.value })} />
      <textarea className="field min-h-14 text-sm" placeholder="Notes (optional, kept private from reminders)" aria-label="Notes" value={value.notes} onChange={(event) => set({ notes: event.target.value })} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-800">
        <select className="field w-auto py-1 text-xs" aria-label="Reminder" value={value.reminder === null ? "none" : String(value.reminder)} onChange={(event) => set({ reminder: event.target.value === "none" ? null : Number(event.target.value) })}>
          {REMINDERS.map((item) => (
            <option key={String(item.value)} value={item.value === null ? "none" : String(item.value)}>
              {item.label}
            </option>
          ))}
        </select>
        {value.reminder !== null && (tellsOther ? draft.tellAgent : agentAllowed) && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={value.tellAgent} onChange={(event) => set({ tellAgent: event.target.checked })} />
            Also tell {tellsOther ? otherName : agentName}
          </label>
        )}
      </div>
      {!timingValid && <p role="alert" className="text-xs text-error">Choose an existing date and time, confirm repeated-time offsets, and correct any invalid ISO overrides.</p>}
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex items-center gap-2">
        {value.id && (
          <button type="button" className="text-xs text-error hover:underline" disabled={busy} onClick={() => void remove()}>
            Delete event
          </button>
        )}
        <span className="flex-1" />
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" disabled={busy || !value.title.trim() || !value.date || !timingValid} onClick={() => void save()}>
          {value.id ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

function Subscriptions({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<CalendarSubscription[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void window.bridge.listCalendarSubscriptions().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(refresh, [refresh]);

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      refresh();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold text-ink-900">Imported calendars</h2>
      <p className="text-xs text-muted">Show your Google, iCloud or Outlook calendar here, read-only, from its private iCal link. Agents you allow can see these events but not change them.</p>
      {items?.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink-900">{item.name}</span>
            <span className={`block text-[11px] ${item.status === "error" ? "text-error" : "text-muted"}`}>
              {item.status === "error"
                ? `${item.error ?? "Couldn't refresh"}${item.lastFetched ? " · showing the last good copy" : ""}`
                : item.lastFetched
                  ? `${item.count} events · refreshed ${new Date(item.lastFetched).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${item.status === "stale" ? " (stale)" : ""}`
                  : "Not loaded yet"}{" "}
              · {item.host}
            </span>
          </span>
          <button type="button" className="button-secondary py-1 text-xs" disabled={busy !== null} onClick={() => void act(`r-${item.id}`, () => window.bridge.refreshCalendarSubscription(item.id))}>
            {busy === `r-${item.id}` ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="text-xs text-muted hover:text-error hover:underline" disabled={busy !== null} onClick={() => void act(`x-${item.id}`, () => window.bridge.removeCalendarSubscription(item.id))}>
            Remove
          </button>
        </div>
      ))}
      {adding ? (
        <div className="grid gap-2 rounded-2xl border border-border bg-surface-secondary p-3">
          <input className="field text-sm" placeholder="Name, e.g. My Google calendar" aria-label="Calendar name" value={name} onChange={(event) => setName(event.target.value)} />
          <input type="password" className="field font-mono text-xs" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" aria-label="Calendar link" value={url} onChange={(event) => setUrl(event.target.value)} />
          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer">Where do I find this link?</summary>
            <ul className="mt-1 grid gap-1 pl-4">
              <li>
                <b>Google:</b> calendar.google.com → Settings → your calendar under "Settings for my calendars" → Integrate calendar → <i>Secret address in iCal format</i>.
              </li>
              <li>
                <b>Outlook:</b> Settings → Calendar → Shared calendars → Publish a calendar → copy the <i>ICS</i> link.
              </li>
              <li>
                <b>iCloud:</b> Calendar app → share the calendar as a public calendar → copy the link (anyone with it can see the calendar).
              </li>
            </ul>
            <p className="mt-1">The link works like a password, so Hearthside stores it encrypted and never shows it to agents.</p>
          </details>
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="button-secondary"
              disabled={busy !== null}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={busy !== null || !url.trim()}
              onClick={() =>
                void act("add", async () => {
                  await window.bridge.addCalendarSubscription(name, url);
                  setAdding(false);
                  setName("");
                  setUrl("");
                })
              }
            >
              {busy === "add" ? "Loading…" : "Add calendar"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="button-secondary justify-self-start" onClick={() => setAdding(true)}>
          Add a calendar link
        </button>
      )}
      {!adding && error && <p className="text-xs text-error">{error}</p>}
    </section>
  );
}

/** Local YYYY-MM-DD for a Date. */
function ymd(date: Date): string {
  return date.toLocaleDateString("en-CA");
}

/** The days an occurrence covers (all-day ends are exclusive). */
function daysCovered(occurrence: CalendarOccurrence): string[] {
  if (!occurrence.allDay) return [dayKey(occurrence)];
  const days: string[] = [];
  const start = new Date(`${occurrence.start}T12:00:00`);
  const end = occurrence.end ? new Date(`${occurrence.end}T12:00:00`) : new Date(start.getTime() + 86_400_000);
  for (let day = start; day < end && days.length < 62; day = new Date(day.getTime() + 86_400_000)) days.push(ymd(day));
  return days.length ? days : [occurrence.start];
}

/** The six-week grid (Monday first) around a month. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getTime() - offset * 86_400_000);
  return Array.from({ length: 42 }, (_, index) => new Date(start.getTime() + index * 86_400_000));
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MonthView({
  month,
  onMonth,
  items,
  selected,
  onSelect,
  onOpen,
}: {
  month: Date;
  onMonth: (month: Date) => void;
  items: CalendarOccurrence[];
  selected: string;
  onSelect: (day: string) => void;
  onOpen: (item: CalendarOccurrence) => void;
}) {
  const days = monthGrid(month);
  const today = ymd(new Date());
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    for (const item of items) for (const day of daysCovered(item)) map.set(day, [...(map.get(day) ?? []), item]);
    return map;
  }, [items]);
  const selectedItems = byDay.get(selected) ?? [];
  return (
    <section className="grid gap-3" aria-label="Month">
      <div className="flex items-center gap-2">
        <button type="button" className="button-secondary px-3 py-1" aria-label="Previous month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1, 12))}>
          ‹
        </button>
        <button type="button" className="button-secondary px-3 py-1" aria-label="Next month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1, 12))}>
          ›
        </button>
        <h2 className="text-base font-semibold text-ink-900">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <span className="flex-1" />
        <button
          type="button"
          className="text-xs text-accent hover:underline"
          onClick={() => {
            onMonth(new Date());
            onSelect(today);
          }}
        >
          Today
        </button>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-2xl border border-border">
        {WEEKDAYS.map((day) => (
          <div key={day} className="border-b border-border bg-surface-secondary px-2 py-1 text-center text-[11px] font-medium text-muted">
            {day}
          </div>
        ))}
        {days.map((day, index) => {
          const key = ymd(day);
          const list = byDay.get(key) ?? [];
          const inMonth = day.getMonth() === month.getMonth();
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-label={day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
              aria-pressed={key === selected}
              onClick={() => onSelect(key)}
              onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect(key)}
              className={`min-h-24 cursor-pointer border-border p-1 text-left transition-colors ${index % 7 !== 6 ? "border-r" : ""} ${index < 35 ? "border-b" : ""} ${key === selected ? "bg-accent-subtle" : "hover:bg-surface-secondary"} ${inMonth ? "" : "opacity-45"}`}
            >
              <span className={`mb-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${key === today ? "bg-accent font-semibold text-brand-content" : "text-ink-800"}`}>{day.getDate()}</span>
              <div className="grid gap-0.5">
                {list.slice(0, 3).map((item) => (
                  <button
                    key={`${item.id}:${key}`}
                    type="button"
                    title={`${timeLabel(item)} · ${item.title}${item.readOnly ? ` (${item.sourceName})` : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(key);
                      if (!item.readOnly) onOpen(item);
                    }}
                    className={`truncate rounded px-1 py-0.5 text-left text-[11px] ${item.readOnly ? "bg-surface-tertiary text-ink-800" : "bg-accent/15 text-ink-900"}`}
                  >
                    {!item.allDay && <span className="tabular-nums text-muted">{new Date(item.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} </span>}
                    {item.title}
                  </button>
                ))}
                {list.length > 3 && <span className="px-1 text-[10px] text-muted">+{list.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid gap-1.5" aria-label="Selected day">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{dayLabel(selected)}</h3>
        {selectedItems.length === 0 && <p className="text-sm text-muted">Nothing that day.</p>}
        {selectedItems.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.readOnly}
            onClick={() => onOpen(item)}
            className="flex min-w-0 items-start gap-3 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-surface-secondary disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="w-28 shrink-0 text-xs tabular-nums text-muted">{timeLabel(item)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink-900">{item.title}</span>
              {item.location && <span className="block truncate text-xs text-muted">{item.location}</span>}
            </span>
            {item.readOnly && <span className="shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-[11px] text-muted">{item.sourceName}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

export function CalendarView() {
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name ?? "your agent");
  const [items, setItems] = useState<CalendarOccurrence[] | null>(null);
  const [access, setAccess] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"agenda" | "month">(() => {
    try {
      return localStorage.getItem("hearthside.calendarMode") === "month" ? "month" : "agenda";
    } catch {
      return "agenda";
    }
  });
  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [monthItems, setMonthItems] = useState<CalendarOccurrence[]>([]);
  const chooseMode = (next: "agenda" | "month") => {
    setMode(next);
    try {
      localStorage.setItem("hearthside.calendarMode", next);
    } catch {
      // Not remembered; fine.
    }
  };

  const refresh = useCallback(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    void window.bridge
      .listCalendar(from.getTime(), from.getTime() + DAYS_SHOWN * 86_400_000)
      .then(setItems)
      .catch((failure: unknown) => setError(errorText(failure)));
    const grid = monthGrid(month);
    const gridStart = new Date(grid[0]!);
    gridStart.setHours(0, 0, 0, 0);
    void window.bridge
      .listCalendar(gridStart.getTime(), gridStart.getTime() + 42 * 86_400_000)
      .then(setMonthItems)
      .catch(() => undefined);
    void window.bridge.calendarAccess().then(setAccess).catch(() => undefined);
  }, [month]);
  useEffect(() => {
    refresh();
    // Agents can add events from a chat; keep the page current.
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const days = useMemo(() => {
    const groups = new Map<string, CalendarOccurrence[]>();
    for (const item of items ?? []) {
      const key = dayKey(item);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const allowed = Boolean(agentId && access.includes(agentId));

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-border px-6">
        <span className="truncate text-sm font-medium text-ink-700">Calendar</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-5 px-6 py-6">
          <div className="flex flex-wrap items-center gap-3">
            {agentId && (
              <label className="flex flex-1 items-center gap-2 text-sm text-ink-800">
                <input
                  type="checkbox"
                  checked={allowed}
                  onChange={(event) => {
                    // Tick at once; undo if saving fails.
                    const allow = event.target.checked;
                    const before = access;
                    setAccess(allow ? [...access.filter((id) => id !== agentId), agentId] : access.filter((id) => id !== agentId));
                    void window.bridge
                      .setCalendarAccess(agentId, allow)
                      .then(setAccess)
                      .catch((failure: unknown) => {
                        setAccess(before);
                        setError(errorText(failure));
                      });
                  }}
                />
                Let {agentName} see and add to your calendar
              </label>
            )}
            <div role="tablist" aria-label="Calendar view" className="flex rounded-full border border-border p-0.5 text-xs">
              {(["agenda", "month"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  onClick={() => chooseMode(item)}
                  className={`rounded-full px-3 py-1 ${mode === item ? "bg-ink-900/10 font-medium text-ink-900" : "text-muted hover:text-ink-800"}`}
                >
                  {item === "agenda" ? "Agenda" : "Month"}
                </button>
              ))}
            </div>
            {!draft && (
              <button type="button" className="button-primary" onClick={() => setDraft(mode === "month" ? { ...blankDraft(), date: selected } : blankDraft())}>
                New event
              </button>
            )}
          </div>
          <p className="-mt-3 text-[11px] text-muted">
            Reminders work while Hearthside is running, even with its window closed. If you quit it, they can't fire; you'll get one "missed" note when it's back.
          </p>
          {draft && (
            <EventForm
              key={draft.id ?? "new"}
              draft={draft}
              agentId={agentId}
              agentName={agentName}
              agentAllowed={allowed}
              onCancel={() => setDraft(null)}
              onDone={() => {
                setDraft(null);
                refresh();
              }}
            />
          )}
          {error && <p className="text-sm text-error">{error}</p>}
          {!items && !error && <Spinner className="h-4 w-4 text-muted" />}
          {mode === "month" && (
            <MonthView month={month} onMonth={setMonth} items={monthItems} selected={selected} onSelect={setSelected} onOpen={(item) => setDraft(draftFrom(item, agentId))} />
          )}
          {mode === "agenda" && items && days.length === 0 && <p className="text-sm text-muted">Nothing in the next {DAYS_SHOWN} days.</p>}
          {mode === "agenda" && (
          <section className="grid gap-4" aria-label="Agenda">
            {days.map(([key, list]) => (
              <div key={key} className="grid gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{dayLabel(key)}</h3>
                {list.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.readOnly}
                    onClick={() => setDraft(draftFrom(item, agentId))}
                    className="flex min-w-0 items-start gap-3 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-surface-secondary disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="w-28 shrink-0 text-xs tabular-nums text-muted">{timeLabel(item)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-900">{item.title}</span>
                      {item.location && <span className="block truncate text-xs text-muted">{item.location}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                      {item.reminderMinutes !== null && <span title="Reminder set">🔔</span>}
                      {item.readOnly && <span className="rounded bg-surface-tertiary px-1.5 py-0.5">{item.sourceName}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </section>
          )}
          <Subscriptions onChanged={refresh} />
        </div>
      </div>
    </main>
  );
}
