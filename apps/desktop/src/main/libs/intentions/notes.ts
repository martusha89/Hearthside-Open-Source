import type { Followup, FollowupScope } from '@hearthside/ipc-contract'
import { zonedParts } from './time'

/**
 * The short note the companion sees without having to ask for it.
 *
 * The only supported way to put something in front of the model automatically,
 * on an existing agent's session, is the description of a tool registered for
 * that turn. There is no per-turn context option, and the person's own message
 * is never edited to carry controller state.
 *
 * Two consequences are designed for rather than hoped away:
 *
 * - A tool definition is matched by agent and conversation, not by connection.
 *   While it is registered, another session on the same conversation can see it.
 *   So the note is built only for a conversation that has been shown to be
 *   private, and it lives for one turn. Nothing here — not a summary, not a
 *   count, not a date — is emitted for a shared or unknown audience.
 * - The description is part of that turn's model request and is retained with
 *   it. The feature's consent text says so.
 *
 * The clock in the note is a snapshot from when the turn was prepared, and is
 * labelled as one. It is never presented as the current time; the tool itself
 * returns a fresh clock when called.
 */

const MAX_ITEMS = 3
const MAX_SUMMARY = 90
const MAX_ACTION = 70

export interface NoteOptions {
  /** When this note's clock was read, as an ISO instant with an offset. */
  preparedAt: string
  timezone: string
  audience: FollowupScope['audience']
  /** The person has consented to short summaries travelling in the note. */
  includeSummaries: boolean
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

function localClock(at: string, timezone: string): string {
  const parts = zonedParts(at, timezone)
  if (!parts) return 'local time unavailable (invalid timezone)'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} ${timezone}`
}

/** A one-line, non-identifying description of when the item is due. */
function timing(item: Followup, timezone: string): string {
  if (item.eventAt) return `due ${localClock(item.eventAt, timezone)}`
  if (item.notBefore) return `follow up after ${localClock(item.notBefore, timezone)}`
  return 'no time given'
}

/**
 * Build the automatic note. Returns an empty string when there is nothing to
 * say, or when the audience is anything other than private.
 */
export function automaticNote(items: Followup[], options: NoteOptions): string {
  if (options.audience !== 'private') return ''
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(options.preparedAt)) return ''
  const open = (Array.isArray(items) ? items : [])
    .filter(item => item && !['resolved', 'cancelled', 'expired'].includes(item.lifecycle))
    .slice(0, MAX_ITEMS)
  const snapshot = `Snapshot prepared at ${options.preparedAt} (${localClock(options.preparedAt, options.timezone)}). This is when the turn started, not the current time.`
  if (!open.length) return `${snapshot} Nothing is being kept in mind for this conversation.`
  if (!options.includeSummaries) {
    return `${snapshot} ${open.length === 1 ? 'One thing is' : `${open.length} things are`} being kept in mind for this conversation; call the tool to read them.`
  }
  const lines = open.map(item => {
    const summary = clip(item.summary, MAX_SUMMARY)
    const action = clip(item.action, MAX_ACTION)
    return `- ${summary || 'unlabelled'} (${timing(item, options.timezone)}${action ? `; open: ${action}` : ''})`
  })
  return [
    snapshot,
    'Observed from this conversation and held briefly. These are notes about what the person said, not intentions your companion formed, and a due time is not evidence that anything happened:',
    ...lines,
    'Call the tool for a fresh clock and the full list before acting on any of it.',
  ].join('\n')
}
