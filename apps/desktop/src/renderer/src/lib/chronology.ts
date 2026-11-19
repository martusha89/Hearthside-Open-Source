import type { ChatRow } from "../types";

// Cache formatters, not messages/history; cap the cache for callers testing many zones.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, timeZone, options]);
  let value = formatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, value);
  }
  return value;
}

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Only accept an absolute instant. A timezone-less history date is ambiguous. */
export function timestampDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth || hour! > 23 || minute! > 59 || second! > 59) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function calendarDay(date: Date, timeZone: string): string {
  const parts = formatter("en-US", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function rowDay(row: ChatRow, timeZone: string): string | null {
  // Thoughts may be hidden or folded inside a tool run; they must not create
  // floating day headings for messages the viewer cannot see.
  const date = timestampDate(row.kind === "user" || row.kind === "assistant" ? row.date : undefined);
  return date ? calendarDay(date, timeZone) : null;
}

export function dayLabel(day: string, now: Date, timeZone: string, locale?: string): string {
  const today = calendarDay(now, timeZone);
  if (day === today) return "Today";
  // Calendar arithmetic, not 24 elapsed hours (which fails at DST transitions).
  const previous = new Date(`${today}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  if (day === previous.toISOString().slice(0, 10)) return "Yesterday";
  return formatter(locale, "UTC", { month: "long", day: "numeric", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) }).format(new Date(`${day}T12:00:00Z`));
}

/** Unknown rows do not acquire a day or erase the previous known day. Runs stay intact. */
export function dayStarts(rows: readonly ChatRow[], timeZone: string): Map<string, string> {
  const starts = new Map<string, string>();
  let previous: string | null = null;
  for (const row of rows) {
    const day = rowDay(row, timeZone);
    if (!day) continue;
    if (day !== previous) starts.set(row.key, day);
    previous = day;
  }
  return starts;
}

export function timestampLabels(value: string | null | undefined, timeZone: string, locale?: string) {
  const date = timestampDate(value);
  if (!date) return null;
  return {
    dateTime: date.toISOString(),
    short: formatter(locale, timeZone, { hour: "numeric", minute: "2-digit" }).format(date),
    precise: formatter(locale, timeZone, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).format(date),
  };
}
