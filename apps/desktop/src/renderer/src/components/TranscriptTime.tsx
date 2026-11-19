import { dayLabel, timestampLabels, viewerTimeZone } from "../lib/chronology";

export function DaySeparator({ day, now, timeZone = viewerTimeZone() }: { day: string; now: Date; timeZone?: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
      <time dateTime={day}>{dayLabel(day, now, timeZone)}</time>
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** The containing message is the keyboard navigation target, not a second tab stop.
 * Focus within reveals the precise instant; screen readers always receive it.
 */
export function TranscriptTimestamp({ date, timeZone = viewerTimeZone() }: { date?: string; timeZone?: string }) {
  const labels = timestampLabels(date, timeZone);
  if (!labels) return null;
  return (
    <time
      dateTime={labels.dateTime}
      aria-label={labels.precise}
      title={labels.precise}
      className="block pt-1 text-[11px] text-muted opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 group-focus/transcript-row:opacity-100"
    >
      <span aria-hidden="true" className="group-focus-within/message:hidden group-focus/transcript-row:hidden">{labels.short}</span>
      <span aria-hidden="true" className="hidden group-focus-within/message:inline group-focus/transcript-row:inline">{labels.precise}</span>
    </time>
  );
}
