/** Strict civil validation before Date can normalize impossible dates. */
export function isExplicitInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = "0", , offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]! || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (offset!.toUpperCase() !== "Z" && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Wall-clock conversion independent of the browser timezone. Never guesses at DST overlaps. */
export function zonedFields(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (key: string) => parts.find((part) => part.type === key)!.value;
  const millis = new Date(iso).getUTCMilliseconds();
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${millis ? `.${String(millis).padStart(3, "0")}` : ""}`;
}

export function wallTimeChoices(wall: string, timezone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(wall)) return [];
  const normalized = (wall.length === 16 ? `${wall}:00` : wall.replace(/\.(\d{1,3})$/, (_, fraction: string) => `.${fraction.padEnd(3, "0")}`)).replace(/\.000$/, "");
  const nominal = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, normalized.length) !== normalized) return [];
  const offsets = new Set<number>();
  // Sample both sides of nearby transitions, including half-hour transitions.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = nominal + hours * 3600000;
    offsets.add(Date.parse(`${zonedFields(new Date(instant).toISOString(), timezone)}Z`) - instant);
  }
  return [...offsets].map((offset) => new Date(nominal - offset).toISOString()).filter((iso) => zonedFields(iso, timezone) === normalized).sort();
}

export function resolveWallTime(wall: string, timezone: string, explicitChoice?: string): string {
  const choices = wallTimeChoices(wall, timezone);
  if (!choices.length) throw new Error(`This date and time does not exist in ${timezone}. Choose another time.`);
  if (choices.length > 1 && !choices.includes(explicitChoice ?? "")) throw new Error("This clock time occurs twice. Choose an explicit offset.");
  return explicitChoice && choices.includes(explicitChoice) ? explicitChoice : choices[0]!;
}

export function tomorrowMorning(timezone: string, now = new Date()): string {
  const date = zonedFields(now.toISOString(), timezone).slice(0, 10);
  const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return resolveWallTime(`${next}T09:00`, timezone);
}
