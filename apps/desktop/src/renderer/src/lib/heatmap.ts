// Memory activity heatmap: commits per day, laid out as week columns
// (Monday first) ending with the current week. Pure, for testing.

export interface HeatmapDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  count: number;
  /** 0 = none, 1–4 = increasing activity relative to the busiest day. */
  level: 0 | 1 | 2 | 3 | 4;
  /** False for days after today in the final week. */
  inRange: boolean;
}

export interface Heatmap {
  /** Columns of 7 days, Monday→Sunday. */
  weeks: HeatmapDay[][];
  total: number;
  max: number;
  /** Month label positions: week index → short month name. */
  months: Array<{ week: number; label: string }>;
}

export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function levelFor(count: number, max: number): HeatmapDay["level"] {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as HeatmapDay["level"];
}

export function buildHeatmap(timestamps: readonly number[], today: Date, weekCount = 26): Heatmap {
  const counts = new Map<string, number>();
  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const key = localDateKey(new Date(timestamp));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Monday of the current week, then step back to the first displayed Monday.
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const mondayOffset = (end.getDay() + 6) % 7;
  const start = new Date(end);
  start.setDate(end.getDate() - mondayOffset - (weekCount - 1) * 7);

  const todayKey = localDateKey(end);
  const days: Array<Omit<HeatmapDay, "level">> = [];
  let inRange = true;
  for (let i = 0; i < weekCount * 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = localDateKey(day);
    days.push({ date: key, count: inRange ? (counts.get(key) ?? 0) : 0, inRange });
    if (key === todayKey) inRange = false;
  }

  const max = Math.max(0, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const weeks: HeatmapDay[][] = [];
  for (let w = 0; w < weekCount; w++) {
    weeks.push(days.slice(w * 7, w * 7 + 7).map((day) => ({ ...day, level: levelFor(day.count, max) })));
  }

  const months: Heatmap["months"] = [];
  let lastMonth = -1;
  weeks.forEach((week, index) => {
    const first = week[0];
    if (!first) return;
    const month = Number(first.date.slice(5, 7));
    if (month !== lastMonth) {
      months.push({ week: index, label: new Date(2000, month - 1, 1).toLocaleString("en", { month: "short" }) });
      lastMonth = month;
    }
  });

  return { weeks, total, max, months };
}
