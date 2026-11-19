import type { FollowupCreate } from '@hearthside/ipc-contract'
import { isValidLocalDateTime, isValidTimezone, resolveLocalDateTime, zonedParts } from './time'

/** Zero-provider-cost, deterministic English adapter. No network/model calls or data export.
 * Supported: a single declarative "I have / I've got / I am having / I'm having"
 * appointment, meeting, interview or exam; today, tomorrow or YYYY-MM-DD;
 * optional "at HH:mm" (24h) or "at h[:mm] am/pm".
 * Missing/ambiguous times yield an unscheduled candidate, not an inferred time.
 * Quotes, questions, conditionals, past statements and multiple dates are rejected.
 * This intentionally is not general NLP. A future provider adapter can implement
 * this same signature, but must be explicitly opted into. Never activates a followup
 * or interprets replies as completion; that belongs to explicit service/tools policy.
 */
export function extractFollowup(message: { id: string; text: string; at: string }, timezone: string): FollowupCreate | null {
  if (!message || typeof message.text !== 'string' || message.text.length > 4000 ||
      typeof message.id !== 'string' || !message.id || message.id.length > 500 ||
      typeof message.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(message.at) ||
      !isValidTimezone(timezone)) return null
  const source = Date.parse(message.at)
  const local = zonedParts(message.at, timezone)
  if (!Number.isFinite(source) || !local) return null
  const text = message.text.trim()
  // Apostrophes in contractions are fine; quoted or non-declarative language is not.
  if (/["“”`?\n]/.test(text) || /(^|\s)['‘]|['’](?=\s|$)/.test(text) ||
      /\b(if|would|could|might|maybe|suppose|imagine|wish|not|never|cancelled|canceled|or|approximately|around|about|possibly|probably|rescheduled|joking|pretend|example|hypothetical)\b/i.test(text)) return null
  const declaration = /^(?:I have|I've got|I’ve got|I am having|I'm having|I’m having)\s+(?:(?:an?|my)\s+)?(?:(?:doctor's|doctor’s|dentist's|dentist’s|medical|job|work|dental)\s+)?(appointment|meeting|interview|exam)\b/i.exec(text)
  if (!declaration || /\b(?:and|but|then)\b/i.test(text) || /[.!]\s+\S/.test(text)) return null
  const dates = [...text.matchAll(/\b(today|tomorrow|\d{4}-\d{2}-\d{2})\b/gi)]
  const dateMatch = dates[0]
  if (dates.length !== 1 || !dateMatch) return null
  const dateText = dateMatch[0].toLowerCase()
  let day = { year: local.year, month: local.month, day: local.day }
  if (dateText === 'tomorrow') {
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
    day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
  } else if (dateText !== 'today') {
    day = { year: Number(dateText.slice(0, 4)), month: Number(dateText.slice(5, 7)), day: Number(dateText.slice(8, 10)) }
  }
  if (!isValidLocalDateTime({ ...day, hour: 0, minute: 0 })) return null
  const dateNumber = (d: typeof day): number => Date.UTC(d.year, d.month - 1, d.day)
  if (dateNumber(day) < dateNumber(local)) return null
  const times = [...text.matchAll(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi)]
  let eventAt: string | null = null
  const timeMatch = times[0]
  if (times.length === 1 && timeMatch) {
    const [, hours, minutes, meridiem] = timeMatch
    let hour = Number(hours)
    const minute = Number(minutes ?? 0)
    if (meridiem && hour >= 1 && hour <= 12 && minute < 60) {
      hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0)
      eventAt = resolveLocalDateTime({ ...day, hour, minute }, timezone)
    } else if (!meridiem && minutes !== undefined && hour < 24 && minute < 60) {
      eventAt = resolveLocalDateTime({ ...day, hour, minute }, timezone)
    }
  }
  if (eventAt && Date.parse(eventAt) <= source) return null
  const notBefore = eventAt ? new Date(Date.parse(eventAt) + 2 * 3_600_000).toISOString() : null
  return {
    summary: `User said: ${text.slice(0, 300)}`,
    action: 'askhowitwent',
    eventAt,
    notBefore,
    expiresAt: new Date(Math.max(source, notBefore ? Date.parse(notBefore) : source) + 7 * 86_400_000).toISOString(),
    timezone,
    sourceMessageId: message.id,
    sourceAt: new Date(source).toISOString()
  }
}
