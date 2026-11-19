import type { CalendarOccurrence } from "../types";




/** Local "YYYY-MM-DD" and "HH:MM" from an ISO time. */
export function splitLocal(iso: string): { date: string; time: string } {
  const value = new Date(iso);
  return { date: value.toLocaleDateString("en-CA"), time: value.toTimeString().slice(0, 5) };
}

export function offsetIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

export type Draft = {
  id?: string;
  revision?: number;
  title: string;
  allDay: boolean;
  date: string;


  endDate: string;
  start: string;
  end: string;
  location: string;
  notes: string;
  reminder: number | null;
  tellAgent: boolean;
  /**
   * Hearthside: which companion "Also tell" is about. The calendar is shared,
   * so an event may already tell a companion other than the one selected;
   * that must survive an edit made from another companion's view.
   */
  tellAgentId?: string | null;
};

/** The companion the saved event should tell: the one the tick is about, or nobody. */
export function remindAgentFor(value: Pick<Draft, "tellAgent" | "tellAgentId">, agentId: string | null): string | null {
  return value.tellAgent ? (value.tellAgentId ?? agentId) : null;
}

export function blankDraft(): Draft {
  const now = new Date(Date.now() + 3_600_000);
  const date = now.toLocaleDateString("en-CA");
  return { title: "", allDay: false, date, endDate: date, start: `${String(now.getHours()).padStart(2, "0")}:00`, end: "", location: "", notes: "", reminder: 15, tellAgent: false };
}

/** A local calendar date moved by whole days. */
export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00`).getTime() + days * 86_400_000).toLocaleDateString("en-CA");
}

/** Whole days from one local date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000);
}

export function draftFrom(occurrence: CalendarOccurrence, agentId: string | null): Draft {
  if (occurrence.allDay) {
    // All-day ends are exclusive: an event to the 16th ends on the 17th.
    const last = occurrence.end && occurrence.end > occurrence.start ? addDays(occurrence.end, -1) : occurrence.start;
    return { id: occurrence.eventId, revision: occurrence.revision, title: occurrence.title, allDay: true, date: occurrence.start, endDate: last, start: "", end: "", location: occurrence.location ?? "", notes: occurrence.notes ?? "", reminder: occurrence.reminderMinutes, tellAgent: Boolean(occurrence.remindAgentId), tellAgentId: occurrence.remindAgentId ?? agentId };
  }
  const start = splitLocal(occurrence.start);
  const end = occurrence.end ? splitLocal(occurrence.end) : null;
  return {
    id: occurrence.eventId,
    revision: occurrence.revision,
    title: occurrence.title,
    allDay: false,
    date: start.date,
    endDate: end?.date ?? start.date,
    start: start.time,
    end: end?.time ?? "",
    location: occurrence.location ?? "",
    notes: occurrence.notes ?? "",
    reminder: occurrence.reminderMinutes,
    tellAgent: Boolean(occurrence.remindAgentId),
    tellAgentId: occurrence.remindAgentId ?? agentId,
  };
}



export function eventEnd(value: Pick<Draft, "allDay" | "date" | "endDate" | "start" | "end">): string | null {
  const last = value.endDate && value.endDate >= value.date ? value.endDate : value.date;
  if (value.allDay) return addDays(last, 1);
  if (!value.end) return null;
  const overnight = last === value.date && value.start && value.end <= value.start;
  return offsetIso(overnight ? addDays(last, 1) : last, value.end);
}

