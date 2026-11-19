import type { FollowupScope } from '@hearthside/ipc-contract'
import { CAPTURE_SCHEMA, CAPTURE_SYSTEM_PROMPT, captureUserMessage, validateDecisions, type CaptureRequest, type CaptureReview } from './decisions'

/**
 * Runs one bounded structured classification and nothing else.
 *
 * Shape of the call, and why each part is there:
 *
 * - It runs in its own agent-free conversation created by the SDK's `query()`,
 *   with a complete system prompt of our own. The companion's agent, persona,
 *   memory filesystem and transcript are not involved. `parentAgentId` records
 *   which companion asked; it does not inherit that companion's memory, persona
 *   or tools.
 * - `query()` is an async generator: it is iterated, never awaited as a promise.
 *   Awaiting it would never start the turn.
 * - `maxRetries: 0`. The SDK's default is two further corrective turns, which
 *   would silently triple the cost of one classification.
 * - Shell and action tools are off: no skills, no client tools, an empty
 *   allowlist, strict permissions and a deny-everything callback. This is not
 *   the same as "zero tools" — the SDK still installs its own StructuredOutput
 *   sink to collect the result, which is how the result arrives at all.
 * - One wall-clock deadline covers creation AND streaming. On expiry the turn is
 *   interrupted first, then closed: closing alone does not abort a running turn.
 *   Anything that arrives after the deadline is discarded.
 * - Every step that waits on the transport has its own bound. An interrupt that
 *   never settles must not hold the deadline open, and neither must an archive
 *   call that never settles; both are raced against a timer. Nothing here claims
 *   a turn was stopped unless the interrupt actually confirmed it — otherwise the
 *   error says a stop was requested and may not have landed.
 * - A result counts only when the SDK reports success AND a schema-validated
 *   structured value. A stream that ends without one is a failure.
 * - The conversation is archived afterwards when its id is known. The id is read
 *   after closing, because it can arrive with the settlement. If the backend
 *   created a conversation but initialisation failed, the id can be unknown, and
 *   then there is nothing to archive by: that is recorded as an unknown
 *   conversation so it can be reconciled by hand, never as cleaned up. Archive
 *   failures and unconfirmed archives are recorded and shown the same way.
 * - That archive is bound to the job: it goes back to the client that created the
 *   conversation, not to whichever account happens to be connected when cleanup
 *   runs. Switching connection mid-check must not archive against the wrong
 *   backend, and must never hand a private conversation id to an unrelated one.
 *
 * The daily job count is a job count. It bounds how many calls this feature can
 * make; it is NOT a spend or token cap, even with retries off, because one call's
 * cost depends on the model and the message.
 */

export interface ClassifierJob {
  /** Non-sensitive display name for the temporary conversation. */
  name: string
  model: string
  system: string
  prompt: string
  parentAgentId: string
  schema: Record<string, unknown>
}

export interface ClassifierStreamEvent {
  type: string
  success?: boolean
  structuredOutput?: unknown
  error?: string
  errorCode?: string
}

export interface ClassifierHandle {
  stream: AsyncIterable<ClassifierStreamEvent>
  /** Null until the conversation exists; retained after close. */
  conversationId(): string | null
  interrupt(): Promise<void>
  close(): void
  /**
   * Archives this job's own conversation on the backend that created it.
   *
   * Preferred over `ClassifierTransport.archive`, which can only resolve the
   * connection that is current when cleanup runs. A conversation id from one
   * account must never be sent to another: see `classifyMessage`.
   */
  archive?(conversationId: string): Promise<void>
}

export interface ClassifierTransport {
  /** Starts the job. Throwing here means nothing was dispatched. */
  start(job: ClassifierJob): ClassifierHandle
  /**
   * Fallback archive for a handle that cannot bind one. Resolves whatever
   * connection is current, so a handle-bound archive is always tried first.
   */
  archive(conversationId: string): Promise<void>
  /** Describes a transport-level refusal, e.g. a backend without this support. */
  unsupported?(error: unknown): string | null
}

export interface ClassifierBudget {
  /** Reserve one job before dispatch. Rejects by throwing when the day is spent. */
  reserve(scope: FollowupScope): { id: string; day: string }
  /** Give a reservation back. Only valid before anything was dispatched. */
  release(scope: FollowupScope, id: string): void
  /** Record the conversation a dispatched job created, when known. */
  dispatched(scope: FollowupScope, id: string, conversationId: string | null): void
  /**
   * Record what became of that conversation. `unconfirmed` means the archive
   * call never settled inside its bound, so it is not known to have worked.
   */
  archived(scope: FollowupScope, id: string, state: ArchiveState): void
}

export type ArchiveState = 'archived' | 'failed' | 'unconfirmed'

export interface ClassifierLimits {
  /** Wall clock for creation and streaming together. */
  deadlineMs: number
  /** How long to let an interrupt land before giving up on confirming it. */
  graceMs: number
  /** How long to wait for the archive call before calling it unconfirmed. */
  archiveMs: number
}

export const CLASSIFIER_LIMITS: ClassifierLimits = { deadlineMs: 45_000, graceMs: 3_000, archiveMs: 10_000 }

/**
 * Wait for one transport promise, bounded.
 *
 * A promise that never settles is reported as `pending` and left to its fate;
 * its rejection is always handled here, so abandoning it cannot crash the
 * process later. A callback that throws synchronously counts as `failed`.
 */
async function settleWithin(work: () => unknown, ms: number): Promise<'ok' | 'failed' | 'pending'> {
  let promise: Promise<unknown>
  try { promise = Promise.resolve(work()) } catch { return 'failed' }
  let timer: ReturnType<typeof setTimeout> | null = null
  const expiry = new Promise<'pending'>(resolve => {
    timer = setTimeout(() => resolve('pending'), Math.max(1, ms))
    timer.unref?.()
  })
  const outcome = await Promise.race([promise.then(() => 'ok' as const, () => 'failed' as const), expiry])
  if (timer) clearTimeout(timer)
  return outcome
}

export class ClassifierUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'ClassifierUnavailable' }
}

const DEADLINE = Symbol('deadline')

async function collect(handle: ClassifierHandle, limits: ClassifierLimits, now: () => number): Promise<unknown> {
  const started = now()
  const iterator = handle.stream[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | null = null
  const remaining = () => limits.deadlineMs - (now() - started)
  let success = false
  let structured: unknown
  let seenResult = false
  let failure: string | null = null
  try {
    for (;;) {
      if (remaining() <= 0) throw DEADLINE
      const expiry = new Promise<typeof DEADLINE>(resolve => {
        timer = setTimeout(() => resolve(DEADLINE), Math.max(1, remaining()))
        timer.unref?.()
      })
      const next = await Promise.race([iterator.next(), expiry])
      if (timer) { clearTimeout(timer); timer = null }
      if (next === DEADLINE) throw DEADLINE
      if (next.done) break
      const event = next.value
      if (!event || typeof event.type !== 'string') continue
      if (event.type === 'result') {
        // Later results never overwrite a settled one; the first terminal
        // result is the answer for this single-turn job.
        if (seenResult) continue
        seenResult = true
        success = event.success === true
        structured = event.structuredOutput
        failure = typeof event.error === 'string' ? event.error : typeof event.errorCode === 'string' ? event.errorCode : null
      }
    }
  } catch (error) {
    if (error === DEADLINE) {
      // The interrupt is itself bounded: a transport whose abort never settles
      // must not hold this deadline open for ever. Whatever happens, the stream
      // is abandoned here and anything it emits later is discarded.
      const stop = await settleWithin(() => handle.interrupt(), limits.graceMs)
      throw new Error(stop === 'ok'
        ? 'The classification took too long and was stopped. Nothing from it was recorded.'
        : 'The classification took too long. A stop was requested but not confirmed, so it may still be running; its output is discarded and nothing from it was recorded.')
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!seenResult) throw new Error('The classification ended without a result. Nothing was recorded.')
  if (!success) throw new Error(`The classification failed${failure ? ` (${failure})` : ''}. Nothing was recorded.`)
  if (structured === undefined || structured === null) throw new Error('The classification returned no structured result. Nothing was recorded.')
  return structured
}

export interface ClassifyOptions {
  scope: FollowupScope
  request: CaptureRequest
  model: string
  transport: ClassifierTransport
  budget: ClassifierBudget
  limits?: ClassifierLimits
  now?: () => number
}

/**
 * One classification: reserve, dispatch, validate, archive.
 *
 * Returns the validated review. Throws `ClassifierUnavailable` when the
 * connection cannot run this at all (so the caller can report it as unavailable
 * instead of pretending the flow worked), and an ordinary Error for a job that
 * was dispatched and did not produce a usable result.
 */
export async function classifyMessage(options: ClassifyOptions): Promise<CaptureReview> {
  const limits = options.limits ?? CLASSIFIER_LIMITS
  const now = options.now ?? (() => Date.now())
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (!model) throw new ClassifierUnavailable('No model is chosen for short-term memory, so nothing is classified.')

  const reservation = options.budget.reserve(options.scope)
  let handle: ClassifierHandle | null = null
  let dispatched = false
  try {
    handle = options.transport.start({
      // Deliberately uninformative: the name is persisted on the conversation.
      name: `Hearthside short-term memory check ${reservation.id.slice(0, 8)}`,
      model,
      system: CAPTURE_SYSTEM_PROMPT,
      prompt: captureUserMessage(options.request),
      parentAgentId: options.scope.agentId,
      schema: CAPTURE_SCHEMA as unknown as Record<string, unknown>,
    })
    dispatched = true
  } catch (error) {
    const unsupported = options.transport.unsupported?.(error) ?? null
    options.budget.release(options.scope, reservation.id)
    if (unsupported) throw new ClassifierUnavailable(unsupported)
    throw error
  }

  try {
    const value = await collect(handle, limits, now)
    return validateDecisions(options.request, value)
  } finally {
    if (dispatched) {
      // Close no matter how the turn ended, including after an abort that could
      // not be confirmed, so the transport never keeps this job registered.
      const beforeClose = handle.conversationId()
      try { handle.close() } catch { /* closing twice is not an error worth raising */ }
      // Read the id again afterwards: it can arrive with the settlement, and a
      // value only captured before the close would be lost.
      const conversationId = handle.conversationId() ?? beforeClose
      options.budget.dispatched(options.scope, reservation.id, conversationId)
      if (conversationId) {
        // Archive through the handle when it has one: it is bound to the client
        // that created this conversation. Resolving the connection at cleanup
        // instead would archive against whatever account is current by then,
        // which after a mid-check switch means sending a private conversation
        // id to an unrelated backend. The transport fallback stays for handles
        // that cannot bind a client.
        const job = handle
        const archive = job.archive ? () => job.archive!(conversationId) : () => options.transport.archive(conversationId)
        const outcome = await settleWithin(archive, limits.archiveMs)
        options.budget.archived(options.scope, reservation.id, outcome === 'ok' ? 'archived' : outcome === 'failed' ? 'failed' : 'unconfirmed')
      }
    }
  }
}
