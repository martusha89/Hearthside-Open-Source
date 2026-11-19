export interface LocalDateTime {
  year: number; month: number; day: number; hour: number; minute: number
}

export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.length > 100) return false
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return true } catch { return false }
}

export function zonedParts(at: string | number, timezone: string): LocalDateTime | null {
  if (typeof at === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime()) || !isValidTimezone(timezone)) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date)
  const get = (name: string): number => Number(parts.find(p => p.type === name)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

function stamp(p: LocalDateTime): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
}

export function isValidLocalDateTime(p: LocalDateTime): boolean {
  if (!Object.values(p).every(Number.isInteger) || p.year < 1000 || p.year > 9999) return false
  const d = new Date(stamp(p))
  return d.getUTCFullYear() === p.year && d.getUTCMonth() + 1 === p.month &&
    d.getUTCDate() === p.day && d.getUTCHours() === p.hour && d.getUTCMinutes() === p.minute
}

/** Resolve only a unique wall-clock minute. DST gaps and folds remain unscheduled.
 * Samples offsets around the date, then verifies each possible instant with Intl.
 * Never relies on the machine's local timezone and never guesses across a transition.
 */
export function resolveLocalDateTime(p: LocalDateTime, timezone: string): string | null {
  if (!isValidLocalDateTime(p) || !isValidTimezone(timezone)) return null
  const wall = stamp(p)
  const offsets = new Set<number>()
  for (let h = -36; h <= 36; h++) {
    const instant = wall + h * 3_600_000
    const local = zonedParts(instant, timezone)
    if (local) offsets.add(stamp(local) - instant)
  }
  const matches = [...offsets].map(offset => wall - offset).filter(instant => {
    const local = zonedParts(instant, timezone)
    return local !== null && stamp(local) === wall
  })
  const match = matches[0]
  return matches.length === 1 && match !== undefined ? new Date(match).toISOString() : null
}

/** Grounded context for a turn; invalid zones are explicit, never silently local. */
export function timeContext(now: string | number | Date, timezone: string, previousAt?: string): string {
  if (typeof now === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(now)) return 'Current time unavailable (timestamp needs UTC or offset).'
  const date = new Date(now)
  if (!Number.isFinite(date.getTime())) return 'Current time unavailable (invalid timestamp).'
  const local = zonedParts(date.getTime(), timezone)
  const localText = local
    ? `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} (${timezone})`
    : 'unavailable (invalid timezone)'
  const previous = previousAt && /(?:Z|[+-]\d{2}:\d{2})$/i.test(previousAt) ? Date.parse(previousAt) : NaN
  const elapsed = Number.isFinite(previous) && previous <= date.getTime()
    ? ` Elapsed since previous message: ${Math.floor((date.getTime() - previous) / 1000)} seconds.` : ''
  return `Current UTC: ${date.toISOString()}. Local time: ${localText}.${elapsed}`
}
