import { randomUUID } from 'node:crypto'
import type { FollowupClaim, FollowupScope } from '@hearthside/ipc-contract'
import { IntentionsStore, type CaptureIdentity } from './store'
import { extractFollowup } from './extractor'
import type { CaptureItemRef, CaptureRequest, CaptureReview } from './decisions'

export interface IntentionMessage {
  id: string
  /**
   * The ORIGINAL moment of the message. For a live desktop input this is
   * captured when the person submits, before any queue wait, so an item is
   * grounded in the clock the person actually spoke against.
   */
  at: string
  text: string
  role: 'user' | 'assistant' | 'controller'
  otid?: string
  /** Trusted decoder tag for contiguous projections of one persisted assistant message. */
  projection?: 'reasoning_message' | 'assistant_message'
}
/** Semantic capture, injected so the controller never talks to a model itself. */
export interface IntentionsCapture {
  /** Whether a classification could run now, and plain words for why not. */
  available(scope: FollowupScope): { available: boolean; reason: string }
  /** Throws when the job could not run; the caller then falls back and says so. */
  classify(scope: FollowupScope, request: CaptureRequest): Promise<CaptureReview>
}
export interface IntentionsHooks {
  readPage(scope: FollowupScope, options: { after?: string; limit: number; order: 'asc' }): Promise<{ messages: IntentionMessage[]; hasMore?: boolean }>
  assertScope(scope: FollowupScope): Promise<void>
  isBusy(scope: FollowupScope): boolean
  invoke(claim: FollowupClaim): Promise<{ runId?: string; deliveryId?: string; delivered: boolean }>
  reconcile?(scope: FollowupScope, otid: string): Promise<{ state: 'delivered' | 'present' | 'absent' | 'unknown'; runId?: string; deliveryId?: string }>
  capture?: IntentionsCapture
}
export interface IntentionsTickResult {
  scanned: number
  proposed: number
  dispatched: number
  expired: number
  errors: Array<{ scope: FollowupScope; error: string }>
}
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500 && id.trim() === id && [...id].every(c => c.charCodeAt(0) >= 32)
const validAt = (at: unknown): at is string => typeof at === 'string' && at.length <= 40 && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(at) && Number.isFinite(Date.parse(at))
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Open items shown to the classifier, so one request stays small and bounded. */
const OPEN_REFS = 6
/**
 * How many of a catch-up's messages reach the classifier.
 *
 * Reopening the app after a week must not replay a week. The scan still walks
 * history to advance its checkpoint, but only the most recent few eligible
 * messages are actually classified: short-term memory is about what was said
 * recently, and this is the bound that stops both an avalanche of stale items
 * and a surprise bill at startup.
 */
const CATCHUP_LIMIT = 3

/** No timers or transport: the app explicitly drives this controller while running. */
export class IntentionsController {
  private ticking = false
  constructor(private store: IntentionsStore, private hooks: IntentionsHooks, private now: () => Date = () => new Date()) {}

  /**
   * Live observation of one desktop input.
   *
   * When semantic capture is available this is the only path that runs: the
   * message goes to the bounded classifier and nothing is created from the
   * keyword extractor, because both would fight over the same source id and the
   * weaker proposal would win the dedupe.
   *
   * When capture is unavailable — no model chosen, budget spent, backend without
   * support — the old deterministic extractor still runs, and the reason is kept
   * so the panel can say which of the two actually happened instead of implying
   * the semantic flow worked.
   */
  async observe(scope: FollowupScope, message: IntentionMessage): Promise<boolean> {
    await this.hooks.assertScope(scope)
    const source = this.eligible(scope, message)
    if (!source) return false
    const capture = this.hooks.capture
    if (!capture) return this.observeChecked(scope, message)
    const readiness = capture.available(scope)
    if (!readiness.available) {
      this.captureNote = readiness.reason
      return this.observeChecked(scope, message)
    }
    return (await this.captureSemantic(scope, message, source, capture)) > 0
  }

  /** The last reason semantic capture did not run, for honest status text. */
  captureStatus(): string | null { return this.captureNote }
  private captureNote: string | null = null

  /** Gates shared by both capture paths. Returns the message's identity, or null to skip. */
  private eligible(scope: FollowupScope, message: IntentionMessage): { sourceId: string; identity: CaptureIdentity } | null {
    const policy = this.store.getPolicy(scope)
    if (!policy.enabled || policy.extractAutomatically === false || message.role !== 'user' || !validId(message.id)) return null
    if (scope.audience !== 'private') return null
    if (message.otid && this.store.isControllerOtid(scope, message.otid)) return null
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000) return null
    const lower = message.text.toLowerCase()
    if (policy.topicExclusions.slice(0, 100).some(topic => topic.length > 0 && lower.includes(topic.slice(0, 200).toLowerCase()))) return null
    const sourceId = message.otid ?? message.id
    if (!validId(sourceId) || !validAt(message.at)) return null
    return { sourceId, identity: { sourceId, at: message.at, text: message.text } }
  }

  /**
   * The deterministic fallback path.
   *
   * It claims the message in the same durable ledger the classifier uses, so one
   * message is handled by exactly one path, exactly once: a message read by the
   * simple reader today is not re-read by the classifier after a model is
   * chosen, and a restart does not walk it again.
   */
  private observeChecked(scope: FollowupScope, message: IntentionMessage): boolean {
    const policy = this.store.getPolicy(scope)
    const source = this.eligible(scope, message)
    if (!source) return false
    if (!this.store.beginCapture(scope, source.identity, this.store.policyGeneration(scope))) return false
    const input = extractFollowup({ ...message, id: source.sourceId }, policy.timezone)
    if (!input || Date.parse(input.expiresAt) <= this.now().getTime()) {
      this.store.finishCapture(scope, source.identity, 'discarded')
      return false
    }
    const existing = new Set(this.store.list(scope, true).map(item => item.id))
    const created = this.store.create(scope, input, policy.autoActivate ? 'policy_activated' : 'classifier_proposed', policy.autoActivate ? 'policy' : null)
    this.store.finishCapture(scope, source.identity, 'extracted')
    return !existing.has(created.id)
  }

  /** The open items the classifier may reason about, with their live revisions. */
  private openRefs(scope: FollowupScope): CaptureItemRef[] {
    return this.store.list(scope)
      .filter(item => Date.parse(item.expiresAt) > this.now().getTime())
      .sort((a, b) => Date.parse(a.notBefore ?? a.eventAt ?? a.expiresAt) - Date.parse(b.notBefore ?? b.eventAt ?? b.expiresAt))
      .slice(0, OPEN_REFS)
      .map(item => ({ id: item.id, revision: item.revision, summary: item.summary, action: item.action, eventAt: item.eventAt, notBefore: item.notBefore, expiresAt: item.expiresAt, lifecycle: item.lifecycle }))
  }

  /**
   * One classification and its application. Returns how many items were newly
   * created, so callers can report proposals without counting updates twice.
   */
  private async captureSemantic(scope: FollowupScope, message: IntentionMessage, source: { sourceId: string; identity: CaptureIdentity }, capture: IntentionsCapture): Promise<number> {
    const policy = this.store.getPolicy(scope)
    const generation = this.store.policyGeneration(scope)
    // Claimed durably before anything is sent, so a crash, a restart or a later
    // catch-up cannot classify this message a second time.
    if (!this.store.beginCapture(scope, source.identity, generation)) return 0
    const request: CaptureRequest = {
      // Grounded in when the person spoke, never in when this code ran.
      capturedAt: message.at,
      timezone: policy.timezone,
      message: { sourceId: source.sourceId, text: message.text },
      open: this.openRefs(scope),
    }
    let review: CaptureReview
    try {
      review = await capture.classify(scope, request)
      this.captureNote = null
    } catch (error) {
      this.captureNote = errorText(error)
      // A failure is an outcome. Nothing retries this message by itself.
      this.store.finishCapture(scope, source.identity, 'failed')
      return 0
    }
    // The person may have switched the feature off, excluded the topic, moved
    // timezone or changed model while the job was in flight, and the destination
    // may have changed. Any of those invalidates the whole review: it answers a
    // question that is no longer the question being asked.
    await this.hooks.assertScope(scope)
    if (this.store.policyGeneration(scope) !== generation || !this.eligible(scope, message)) {
      this.captureNote = 'Settings changed while a message was being read, so that reading was discarded.'
      this.store.finishCapture(scope, source.identity, 'discarded')
      return 0
    }
    const applied = this.applyReview(scope, review)
    this.store.finishCapture(scope, source.identity, 'applied')
    return applied
  }

  /**
   * Apply a validated review. Each operation is attempted independently and a
   * loser of a compare-and-set is dropped, never retried with a fresh revision:
   * the decision was made about the state the classifier was shown.
   */
  private applyReview(scope: FollowupScope, review: CaptureReview): number {
    let created = 0
    const policy = this.store.getPolicy(scope)
    for (const operation of review.operations) {
      try {
        if (operation.kind === 'create') {
          const existing = new Set(this.store.list(scope, true).map(item => item.id))
          const item = this.store.create(scope, operation.input, policy.autoActivate ? 'policy_activated' : 'classifier_proposed', policy.autoActivate ? 'policy' : null)
          if (!existing.has(item.id)) created++
        } else if (operation.kind === 'update') {
          this.store.update(scope, operation.id, operation.revision, operation.patch)
        } else {
          this.store.transition(scope, operation.id, operation.revision, operation.action, 'policy')
        }
      } catch (error) { this.captureNote = `Part of an observation could not be applied (${errorText(error)}).` }
    }
    return created
  }

  /**
   * Catch up on messages that arrived while this app was closed or busy.
   *
   * With semantic capture available, the walk itself creates nothing: it
   * keeps a ring of the most recent eligible messages, classified afterwards.
   * The semantic checkpoint is committed only after those inputs are accounted
   * for. A failed history read or restart must not skip unclassified inputs;
   * the durable capture ledger deduplicates classifications already attempted.
   */
  async scan(scope: FollowupScope): Promise<{ scanned: number; proposed: number }> {
    await this.hooks.assertScope(scope)
    if (!this.store.getPolicy(scope).enabled) return { scanned: 0, proposed: 0 }
    const capture = this.hooks.capture
    const readiness = capture?.available(scope)
    const semantic = capture && readiness?.available ? capture : null
    if (capture && !semantic && readiness) this.captureNote = readiness.reason
    const recent: IntentionMessage[] = []
    let after = this.store.getCheckpoint(scope) ?? undefined
    if (after !== undefined && !validId(after)) throw new Error('INVALID_CHECKPOINT')
    const seen = new Set<string>(after ? [after] : [])
    let scanned = 0
    let proposed = 0
    // Even a server returning one message with hasMore=true cannot spin indefinitely.
    while (scanned < 500) {
      await this.hooks.assertScope(scope)
      const limit = Math.min(100, 500 - scanned)
      const page = await this.hooks.readPage(scope, { after, limit, order: 'asc' })
      await this.hooks.assertScope(scope)
      if (!Array.isArray(page.messages) || page.messages.length > limit) throw new Error('INVALID_HISTORY_PAGE')
      if (!page.messages.length) {
        if (page.hasMore) throw new Error('HISTORY_NO_PROGRESS')
        break
      }
      let previous: IntentionMessage | undefined
      const projections = new Set<string>()
      for (const message of page.messages) {
        const continuation = previous?.id === message.id && previous.role === 'assistant' && message.role === 'assistant'
          && previous.projection && message.projection && !projections.has(message.projection)
        if (!validId(message.id) || (seen.has(message.id) && !continuation)) throw new Error('HISTORY_CURSOR_CYCLE')
        if (previous?.id !== message.id) projections.clear()
        if (message.projection) projections.add(message.projection)
        previous = message
        if (!validAt(message.at)) throw new Error('INVALID_SOURCE_TIMESTAMP')
        if (message.otid !== undefined && !validId(message.otid)) throw new Error('INVALID_SOURCE_ID')
        if (!this.store.getPolicy(scope).enabled) return { scanned, proposed }
        if (semantic) {
          // Already-handled messages must not fill the catch-up ring, or a
          // reopened app would spend its few slots re-reading what it has read.
          const source = this.eligible(scope, message)
          if (source && !this.store.wasCaptured(scope, source.identity)) {
            recent.push(message)
            if (recent.length > CATCHUP_LIMIT) recent.shift()
          }
        } else {
          // No await between durable creation/dedupe and checkpoint advancement.
          if (this.observeChecked(scope, message)) proposed++
        }
        if (!semantic) this.store.setCheckpoint(scope, message.id)
        seen.add(message.id)
        after = message.id
        scanned++
      }
      if (page.hasMore === false || (page.hasMore !== true && page.messages.length < limit)) break
    }
    for (const message of recent) {
      if (!semantic) break
      await this.hooks.assertScope(scope)
      if (!this.store.getPolicy(scope).enabled) return { scanned, proposed }
      const ready = semantic.available(scope)
      if (!ready.available) { this.captureNote = ready.reason; return { scanned, proposed } }
      const source = this.eligible(scope, message)
      if (!source) continue
      proposed += await this.captureSemantic(scope, message, source, semantic)
    }
    if (semantic && after) this.store.setCheckpoint(scope, after)
    return { scanned, proposed }
  }

  async tick(scopes: FollowupScope[]): Promise<IntentionsTickResult> {
    const result: IntentionsTickResult = { scanned: 0, proposed: 0, dispatched: 0, expired: 0, errors: [] }
    if (this.ticking) return result
    this.ticking = true
    const startedAt = this.now().getTime()
    const fresh = () => { const age = this.now().getTime() - startedAt; if (age < 0 || age > 60_000) throw new Error('STALE_TICK') }
    try {
      for (const scope of scopes) {
        try {
          await this.hooks.assertScope(scope)
          fresh()
          if (!this.store.getPolicy(scope).enabled || this.hooks.isBusy(scope)) continue
          result.expired += this.store.expire(scope)
          const scan = await this.scan(scope)
          await this.hooks.assertScope(scope)
          fresh()
          result.scanned += scan.scanned
          result.proposed += scan.proposed
          if (this.hooks.isBusy(scope)) continue
          const policy = this.store.getPolicy(scope)
          if (!policy.enabled || !policy.proactive || scope.audience !== 'private') continue
          for (const item of this.store.list(scope)) {
            if (!item.adoptedBy || !['pending', 'deferred'].includes(item.lifecycle)) continue
            if (['unknown', 'started', 'replied'].includes(item.dispatch)) {
              await this.reconcile(scope, item.id)
              await this.hooks.assertScope(scope)
              fresh()
              continue
            }
            if (result.dispatched || !['not-requested', 'claimed'].includes(item.dispatch) || !item.notBefore) continue
            if (item.dispatch === 'claimed') {
              const previous = this.store.getClaim(scope, item.id)
              if (!previous || Date.parse(previous.leaseUntil) > this.now().getTime()) continue
            }
            if (Date.parse(item.notBefore) > this.now().getTime()) continue
            if (this.now().getTime() - Date.parse(item.notBefore) > 86400000) {
              // Explicitly suppress an old backlog until expiry, not a rolling reminder.
              this.store.transition(scope, item.id, item.revision, 'defer', 'policy', item.expiresAt)
              continue
            }
            await this.hooks.assertScope(scope)
            fresh()
            if (this.hooks.isBusy(scope)) break
            let claim: FollowupClaim
            try {
              claim = this.store.claim(scope, item.id, item.revision, randomUUID(), 60_000)
            } catch (error) {
              // The person's own settings said "not now": quiet hours, today's
              // follow-ups already used, or a topic they excluded. The item
              // simply waits. Reporting these as a failed pass put a "could
              // not verify its source or delivery" warning on the panel every
              // minute of every night, and skipped the chat's other items.
              const reason = errorText(error)
              if (reason === 'QUIET_HOURS' || reason === 'DAILY_LIMIT') break
              if (reason === 'TOPIC_EXCLUDED') continue
              throw error
            }
            let invoked = false
            try {
              await this.hooks.assertScope(scope)
              fresh()
              // Positively pre-invocation: retain the durable claimed state so
              // lease recovery can retry it. Never infer safety from attemptCount
              // or reopen a failed/started/uncertain delivery.
              if (this.hooks.isBusy(scope)) break
              const activePolicy = this.store.getPolicy(scope)
              if (!activePolicy.enabled || !activePolicy.proactive) throw new Error('DISPATCH_DISABLED')
              const current = this.store.get(scope, item.id)
              if (!current || current.revision !== claim.followup.revision) throw new Error('CLAIM_INVALIDATED')
              claim.followup = this.store.markDispatch(scope, item.id, claim.owner, 'started')
              invoked = true
              result.dispatched++
              const response = await this.hooks.invoke(claim)
              await this.hooks.assertScope(scope)
              this.store.markDispatch(scope, item.id, claim.owner, 'replied', response.runId)
              if (response.delivered && response.deliveryId) this.store.markDispatch(scope, item.id, claim.owner, 'delivered', response.runId, response.deliveryId)
              else this.store.markDispatch(scope, item.id, claim.owner, 'unknown', response.runId)
            } catch (error) {
              try { this.store.markDispatch(scope, item.id, claim.owner, invoked ? 'unknown' : 'failed') }
              catch (markError) { result.errors.push({ scope, error: errorText(markError) }) }
              throw error
            }
          }
        } catch (error) { result.errors.push({ scope, error: errorText(error) }) }
      }
      return result
    } finally { this.ticking = false }
  }

  private async reconcile(scope: FollowupScope, id: string) {
    if (!this.hooks.reconcile) return
    const claim = this.store.getClaim(scope, id)
    if (!claim) return
    await this.hooks.assertScope(scope)
    const response = await this.hooks.reconcile(scope, claim.otid)
    await this.hooks.assertScope(scope)
    if (response.state !== 'delivered' || !response.deliveryId) return
    if (claim.followup.dispatch === 'started') this.store.markDispatch(scope, id, claim.owner, 'replied', response.runId)
    this.store.markDispatch(scope, id, claim.owner, 'delivered', response.runId, response.deliveryId)
  }
}
