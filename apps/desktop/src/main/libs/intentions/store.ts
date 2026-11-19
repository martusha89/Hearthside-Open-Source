import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_FOLLOWUP_POLICY } from '@hearthside/ipc-contract'
import { reportIntentionsStorageError } from './storage-errors'
import type { Followup, FollowupActor, FollowupClaim, FollowupCreate, FollowupDispatch, FollowupOrigin, FollowupPolicy, FollowupScope } from '@hearthside/ipc-contract'

const defaults: FollowupPolicy = DEFAULT_FOLLOWUP_POLICY
/** Hard ceiling on classification jobs per local day, whatever the policy asks for. */
export const CLASSIFIER_DAILY_LIMIT = 200
const closed = (f: Followup) => ['resolved', 'cancelled', 'expired'].includes(f.lifecycle)
function fail(code: string): never { throw new Error(code) }
function text(value: unknown, max = 2000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_STRING')
}
function date(value: unknown, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_DATE')
  const day = value.slice(0, 10)
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail('INVALID_DATE')
}
function zone(value: string) { text(value, 100); try { new Intl.DateTimeFormat('en', { timeZone: value }).format() } catch { fail('INVALID_TIMEZONE') } }
function scopeKey(s: FollowupScope) {
  for (const v of [s.connectionId, s.agentId, s.conversationId, s.recipientId]) text(v, 500)
  if (!['private', 'shared'].includes(s.audience)) fail('INVALID_AUDIENCE')
  return JSON.stringify([s.connectionId, s.agentId, s.conversationId, s.recipientId, s.audience])
}
function hash(v: unknown) { return createHash('sha256').update(JSON.stringify(v)).digest('hex') }
function local(d: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  const p = (type: string) => parts.find(x => x.type === type)!.value
  return { day: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` }
}

/**
 * The evidence that a source message already produced a particular item.
 *
 * One message can legitimately hold two separate things to remember ("dentist
 * tomorrow, interview Friday"), so this is per DECISION rather than per message:
 * keying on the message alone silently kept the first notice and dropped the
 * second. Summary and action are normalised, so noticing the same thing again
 * from the same message still lands on the existing item.
 */
function sourceFingerprint(input: Pick<FollowupCreate, 'sourceMessageId' | 'summary' | 'action'>) {
  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return hash([input.sourceMessageId, normalized(input.summary), normalized(input.action)])
}

/**
 * What identifies one observed message for the capture ledger.
 *
 * Two keys are kept, because the same message can be seen twice under different
 * names: live, with the otid the desktop generated, and later in history, where
 * the backend may only give its own message id. The content key (the text with
 * the local day it belongs to) matches across both. Both are hashes; the text
 * itself is never stored here.
 */
export interface CaptureIdentity {
  sourceId: string
  at: string
  text: string
}

/**
 * The parts of a policy that change what a classification would be asked or
 * whether it should happen at all. Quiet hours and the proactive settings are
 * deliberately absent: they govern sending, not noticing.
 */
function materialPolicyKey(policy: FollowupPolicy) {
  return JSON.stringify([
    policy.enabled, policy.extractAutomatically !== false, policy.automaticNotes !== false,
    policy.timezone, policy.semanticModel ?? null, [...policy.topicExclusions].map(t => t.trim().toLowerCase()).sort(),
  ])
}

function semanticKey(input: FollowupCreate) {
  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return hash([normalized(input.summary), normalized(input.action), input.eventAt && new Date(input.eventAt).toISOString(), input.notBefore && new Date(input.notBefore).toISOString(),
    // Undated recurring intentions are distinct on a new source-local calendar day.
    !input.eventAt && !input.notBefore ? local(new Date(input.sourceAt), input.timezone).day : null])
}

/** Controller-owned synchronous SQLite store. No network or Electron dependencies. */
export class IntentionsStore {
  private db: DatabaseSync
  constructor(path: string, private now: () => Date = () => new Date()) {
    let opened: DatabaseSync | undefined
    let operation = 'prepare storage files'
    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        chmodSync(dirname(path), 0o700)
        // Create privately before SQLite opens it; existing stores are tightened too.
        closeSync(openSync(path, 'a', 0o600))
        chmodSync(path, 0o600)
        for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
      }
      operation = 'open database'
      this.db = opened = new DatabaseSync(path)
      this.initialize(path, value => { operation = value })
    } catch (error) {
      // Capture failure-only metadata before close can remove/change sidecars.
      let unsupported = false
      try { unsupported = error instanceof Error && error.message === 'UNSUPPORTED_STORE_VERSION' } catch { /* Hostile error accessor. */ }
      const reported = unsupported ? error : reportIntentionsStorageError(error, operation, path)
      // A failed constructor is not cached by the service. Release its native
      // connection before a later panel request attempts to open the store again.
      if (opened) {
        try { opened.close() } catch (closeError) { reportIntentionsStorageError(closeError, 'close failed initialization') }
      }
      throw reported
    }
  }
  private initialize(path: string, operation: (value: string) => void): void {
    operation('read schema version')
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 2) fail('UNSUPPORTED_STORE_VERSION')
    operation('enable WAL')
    this.db.exec('PRAGMA journal_mode=WAL')
    operation('initialize schema')
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS intentions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, dedupe TEXT NOT NULL, data TEXT NOT NULL, closed_at TEXT, UNIQUE(scope,dedupe));
      CREATE TABLE IF NOT EXISTS intention_settings (scope TEXT PRIMARY KEY, policy TEXT, cursor TEXT);
      CREATE TABLE IF NOT EXISTS intention_outbox (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL, otid TEXT NOT NULL UNIQUE, lease_until TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT, delivery_id TEXT, day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intention_invocations (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, followup_id TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intention_owned_inputs (scope TEXT NOT NULL, otid TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(scope,otid));
      CREATE TABLE IF NOT EXISTS intention_input_provenance (scope TEXT NOT NULL, otid_hash TEXT NOT NULL, PRIMARY KEY(scope,otid_hash));
      CREATE TABLE IF NOT EXISTS intention_classifier_jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, conversation_id TEXT);
      CREATE TABLE IF NOT EXISTS intention_capture_log (scope TEXT NOT NULL, key TEXT NOT NULL, batch TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS intention_policy_state (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, material TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intentions_scope ON intentions(scope);
      CREATE INDEX IF NOT EXISTS intention_capture_batch ON intention_capture_log(scope,batch);
      CREATE INDEX IF NOT EXISTS intention_classifier_day ON intention_classifier_jobs(scope,day);`)
    operation('migrate schema')
    this.tx(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS intention_sources (scope TEXT NOT NULL, fingerprint TEXT NOT NULL, followup_id TEXT NOT NULL, PRIMARY KEY(scope,fingerprint))')
      const columns = this.db.prepare('PRAGMA table_info(intentions)').all()
      if (!columns.some(c => c.name === 'semantic')) this.db.exec('ALTER TABLE intentions ADD COLUMN semantic TEXT')
      if (version < 1) {
        // Legacy closed rows erased source IDs; their original composite hash remains
        // usable, but an independent source hash cannot be reconstructed from it.
        for (const row of this.db.prepare('SELECT id,scope,data FROM intentions ORDER BY closed_at DESC').all()) {
          const f = JSON.parse(String(row.data)) as Followup
          if (f.sourceMessageId) this.db.prepare('INSERT OR IGNORE INTO intention_sources(scope,fingerprint,followup_id) VALUES (?,?,?)').run(String(row.scope), hash(f.sourceMessageId), f.id)
          if (!closed(f)) this.db.prepare('UPDATE intentions SET semantic=? WHERE id=?').run(semanticKey(f), f.id)
        }
      }
      if (version < 2) {
        // Source evidence became per-decision. Rewrite what can be rewritten:
        // a row whose item has already had its content erased keeps its old
        // message-level fingerprint, which no longer matches anything and simply
        // ages out at the usual cutoff.
        for (const row of this.db.prepare('SELECT scope,data FROM intentions').all()) {
          const f = JSON.parse(String(row.data)) as Followup
          if (!f.sourceMessageId || !f.summary || !f.action) continue
          this.db.prepare('DELETE FROM intention_sources WHERE scope=? AND fingerprint=?').run(String(row.scope), hash(f.sourceMessageId))
          this.db.prepare('INSERT OR IGNORE INTO intention_sources(scope,fingerprint,followup_id) VALUES (?,?,?)').run(String(row.scope), sourceFingerprint(f), f.id)
        }
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS intentions_semantic ON intentions(scope,semantic); PRAGMA user_version=2')
    })
    operation('secure storage files')
    if (path !== ':memory:') for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); this.db.exec('COMMIT'); return r } catch (error) {
      // A rollback I/O failure must not replace the operation's original error.
      try { this.db.exec('ROLLBACK') } catch (rollbackError) { reportIntentionsStorageError(rollbackError, 'roll back transaction') }
      throw error
    }
  }
  private save(f: Followup) {
    this.db.prepare('UPDATE intentions SET data=?, closed_at=?, semantic=? WHERE id=? AND scope=?').run(JSON.stringify(f), closed(f) ? f.updatedAt : null, closed(f) ? null : semanticKey(f), f.id, scopeKey(f.scope))
  }
  private require(scope: FollowupScope, id: string, revision?: number) {
    const f = this.get(scope, id) ?? fail('NOT_FOUND')
    if (revision !== undefined && f.revision !== revision) fail('STALE_REVISION')
    return f
  }
  getPolicy(scope: FollowupScope): FollowupPolicy {
    const row = this.db.prepare('SELECT policy FROM intention_settings WHERE scope=?').get(scopeKey(scope))
    return row?.policy ? JSON.parse(String(row.policy)) : structuredClone(defaults)
  }
  setPolicy(scope: FollowupScope, policy: FollowupPolicy) {
    scopeKey(scope); zone(policy.timezone)
    if (typeof policy.enabled !== 'boolean' || typeof policy.autoActivate !== 'boolean' || typeof policy.proactive !== 'boolean') fail('INVALID_POLICY')
    if (policy.extractAutomatically !== undefined && typeof policy.extractAutomatically !== 'boolean') fail('INVALID_POLICY')
    if (policy.automaticNotes !== undefined && typeof policy.automaticNotes !== 'boolean') fail('INVALID_POLICY')
    if (policy.semanticModel !== undefined && policy.semanticModel !== null) text(policy.semanticModel, 300)
    if (policy.dailyClassifierLimit !== undefined && (!Number.isInteger(policy.dailyClassifierLimit) || policy.dailyClassifierLimit < 1 || policy.dailyClassifierLimit > CLASSIFIER_DAILY_LIMIT)) fail('INVALID_POLICY')
    for (const t of [policy.quietStart, policy.quietEnd]) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail('INVALID_QUIET_TIME')
    if (!Number.isInteger(policy.dailyLimit) || policy.dailyLimit < 0 || policy.dailyLimit > 100 || !Array.isArray(policy.topicExclusions) || policy.topicExclusions.length > 100) fail('INVALID_POLICY')
    policy.topicExclusions.forEach(x => text(x, 200))
    const key = scopeKey(scope)
    this.tx(() => {
      this.db.prepare('INSERT INTO intention_settings(scope,policy) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET policy=excluded.policy').run(key, JSON.stringify(policy))
      // A classification in flight was decided under the previous settings. The
      // generation only moves when something that would have changed the answer
      // changes, so saving quiet hours does not throw away a pending result,
      // while excluding a topic, moving timezone, changing model, or switching
      // the feature off and on again does.
      const material = materialPolicyKey(policy)
      const previous = this.db.prepare('SELECT generation, material FROM intention_policy_state WHERE scope=?').get(key)
      const generation = !previous ? 1 : String(previous.material) === material ? Number(previous.generation) : Number(previous.generation) + 1
      this.db.prepare('INSERT INTO intention_policy_state(scope,generation,material) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation, material=excluded.material').run(key, generation, material)
    })
    return this.getPolicy(scope)
  }
  /**
   * Which settings a decision was made under. A result that comes back against a
   * different generation is discarded rather than applied, because the person
   * changed something that would have changed what was asked.
   */
  policyGeneration(scope: FollowupScope): number {
    const row = this.db.prepare('SELECT generation FROM intention_policy_state WHERE scope=?').get(scopeKey(scope))
    return row ? Number(row.generation) : 0
  }
  /**
   * Claim one observed message, durably, BEFORE anything is sent to a model.
   *
   * Returns false when this message was already handled — by the classifier or
   * by the simple reader, in this session or a previous one. A claim is never
   * handed back: a message is processed once, and a failed or empty result is
   * still a result. Nothing here retries by itself, so a classification is never
   * billed twice and a replay can never re-apply an old reschedule on top of a
   * newer one.
   */
  beginCapture(scope: FollowupScope, identity: CaptureIdentity, generation: number): boolean {
    const keys = this.captureKeys(scope, identity)
    if (!Number.isInteger(generation) || generation < 0) fail('INVALID_GENERATION')
    return this.tx(() => {
      for (const key of keys) if (this.db.prepare('SELECT 1 AS n FROM intention_capture_log WHERE scope=? AND key=?').get(scopeKey(scope), key)) return false
      const batch = randomUUID(), at = this.now().toISOString()
      for (const key of keys) this.db.prepare("INSERT INTO intention_capture_log(scope,key,batch,at,state,generation) VALUES (?,?,?,?,'claimed',?)").run(scopeKey(scope), key, batch, at, generation)
      return true
    })
  }
  /** Record how a claimed message ended, for honest status rather than retries. */
  finishCapture(scope: FollowupScope, identity: CaptureIdentity, state: 'applied' | 'discarded' | 'failed' | 'extracted'): void {
    const keys = this.captureKeys(scope, identity)
    this.tx(() => { for (const key of keys) this.db.prepare('UPDATE intention_capture_log SET state=? WHERE scope=? AND key=?').run(state, scopeKey(scope), key) })
  }
  /** Has this message already been handled, under either of its names? */
  wasCaptured(scope: FollowupScope, identity: CaptureIdentity): boolean {
    return this.captureKeys(scope, identity).some(key => this.db.prepare('SELECT 1 AS n FROM intention_capture_log WHERE scope=? AND key=?').get(scopeKey(scope), key) !== undefined)
  }
  /**
   * The two names one message can be seen under.
   *
   * The source key is the otid live, or the backend's message id in history, so
   * on its own it would let the same message through twice. The content key is
   * the text with the local day it belongs to, which matches either way. The cost
   * of the content key is that the very same sentence sent twice in one day is
   * only noticed once; the thing it prevents — a stale reschedule being applied
   * again over a newer one — is worth more than that second notice.
   */
  private captureKeys(scope: FollowupScope, identity: CaptureIdentity): string[] {
    text(identity.sourceId, 500); text(identity.text, 20_000)
    // Looser than the item timestamps: this is whatever the backend called the
    // message's time, and it only has to name a day.
    if (typeof identity.at !== 'string' || identity.at.length > 40 || !Number.isFinite(Date.parse(identity.at))) fail('INVALID_DATE')
    const day = local(new Date(identity.at), this.getPolicy(scope).timezone).day
    return [hash(['source', identity.sourceId]), hash(['content', day, identity.text.trim()])]
  }
  create(scope: FollowupScope, input: FollowupCreate, origin: FollowupOrigin, adoptedBy: FollowupActor | null = null): Followup {
    const key = scopeKey(scope)
    text(input.summary); text(input.action); text(input.sourceMessageId, 500); zone(input.timezone)
    date(input.eventAt, true); date(input.notBefore, true); date(input.expiresAt); date(input.sourceAt)
    if (!['agent_created', 'classifier_proposed', 'user_created', 'policy_activated'].includes(origin)) fail('INVALID_ORIGIN')
    if (adoptedBy !== null && !['agent', 'user', 'policy'].includes(adoptedBy)) fail('INVALID_ACTOR')
    const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const dedupe = hash([input.sourceMessageId, normalized(input.summary), normalized(input.action), input.eventAt && new Date(input.eventAt).toISOString(), input.notBefore && new Date(input.notBefore).toISOString()])
    return this.tx(() => {
      const fingerprint = sourceFingerprint(input)
      const source = this.db.prepare('SELECT i.data FROM intention_sources s JOIN intentions i ON i.id=s.followup_id AND i.scope=s.scope WHERE s.scope=? AND s.fingerprint=?').get(key, fingerprint)
      if (source) return JSON.parse(String(source.data))
      const existing = this.db.prepare('SELECT id,data FROM intentions WHERE scope=? AND (dedupe=? OR (semantic=? AND closed_at IS NULL AND julianday(json_extract(data,\'$.expiresAt\'))>julianday(?))) ORDER BY closed_at DESC LIMIT 1').get(key, dedupe, semanticKey(input), this.now().toISOString())
      if (existing) {
        this.db.prepare('INSERT INTO intention_sources(scope,fingerprint,followup_id) VALUES (?,?,?)').run(key, fingerprint, String(existing.id))
        return JSON.parse(String(existing.data))
      }
      const policy = this.getPolicy(scope)
      if (origin !== 'user_created' && !policy.enabled) fail('POLICY_DISABLED')
      if ((adoptedBy === 'policy' || origin === 'policy_activated') && (!policy.enabled || !policy.autoActivate)) fail('POLICY_FORBIDS_ACTIVATION')
      if (origin === 'classifier_proposed' && adoptedBy && adoptedBy !== 'user' && !(policy.enabled && policy.autoActivate)) fail('POLICY_FORBIDS_ACTIVATION')
      const at = this.now().toISOString()
      const f: Followup = { ...input, scope: { ...scope }, origin, adoptedBy, id: randomUUID(), lifecycle: adoptedBy ? 'pending' : 'candidate', dispatch: 'not-requested', revision: 1, createdAt: at, updatedAt: at, attemptCount: 0, lastAttemptAt: null }
      if (Date.parse(f.expiresAt) <= this.now().getTime()) fail('EXPIRED')
      this.db.prepare('INSERT INTO intentions(id,scope,dedupe,data,semantic) VALUES (?,?,?,?,?)').run(f.id, key, dedupe, JSON.stringify(f), semanticKey(input))
      this.db.prepare('INSERT INTO intention_sources(scope,fingerprint,followup_id) VALUES (?,?,?)').run(key, fingerprint, f.id)
      return f
    })
  }
  get(scope: FollowupScope, id: string): Followup | null {
    const key = scopeKey(scope); text(id, 100)
    const row = this.db.prepare('SELECT scope,data FROM intentions WHERE id=?').get(id)
    if (!row) return null
    if (row.scope !== key) fail('SCOPE_MISMATCH')
    return JSON.parse(String(row.data))
  }
  list(scope: FollowupScope, includeClosed = false): Followup[] {
    return this.db.prepare('SELECT data FROM intentions WHERE scope=? ORDER BY id').all(scopeKey(scope)).map(r => JSON.parse(String(r.data)) as Followup).filter(f => includeClosed || !closed(f))
  }
  transition(scope: FollowupScope, id: string, revision: number, action: 'adopt' | 'defer' | 'resolve' | 'cancel', actor: FollowupActor, notBefore?: string): Followup {
    if (!['agent', 'user', 'policy'].includes(actor)) fail('INVALID_ACTOR')
    if (notBefore !== undefined) date(notBefore)
    return this.tx(() => {
      const f = this.require(scope, id, revision)
      if (closed(f)) fail('CLOSED')
      if (action === 'adopt') {
        const p = this.getPolicy(scope)
        if (actor === 'policy' && !(p.enabled && p.autoActivate)) fail('POLICY_FORBIDS_ACTIVATION')
        f.adoptedBy = actor; f.lifecycle = 'pending'
      } else if (action === 'defer') {
        if (!notBefore) fail('NOT_BEFORE_REQUIRED')
        f.notBefore = notBefore; f.lifecycle = 'deferred'
      } else if (action === 'resolve' || action === 'cancel') {
        f.lifecycle = action === 'resolve' ? 'resolved' : 'cancelled'
        f.summary = ''; f.action = ''; f.sourceMessageId = ''
      } else fail('INVALID_TRANSITION')
      // Invalidates any outstanding owner, including a worker racing a user cancellation.
      this.db.prepare("UPDATE intention_outbox SET owner='', state=CASE WHEN state='claimed' THEN 'failed' ELSE state END WHERE id=?").run(id)
      if (f.dispatch === 'claimed') f.dispatch = 'failed'
      f.revision++; f.updatedAt = this.now().toISOString(); this.save(f); return f
    })
  }
  scopes(): FollowupScope[] {
    return this.db.prepare('SELECT scope,policy FROM intention_settings WHERE policy IS NOT NULL').all().filter(r => JSON.parse(String(r.policy)).enabled).map(r => {
      const [connectionId, agentId, conversationId, recipientId, audience] = JSON.parse(String(r.scope))
      return { connectionId, agentId, conversationId, recipientId, audience }
    })
  }
  update(scope: FollowupScope, id: string, revision: number, patch: Partial<Pick<FollowupCreate, 'summary' | 'action' | 'eventAt' | 'notBefore' | 'expiresAt' | 'timezone'>>): Followup {
    const keys = ['summary', 'action', 'eventAt', 'notBefore', 'expiresAt', 'timezone']
    if (!patch || Object.keys(patch).some(k => !keys.includes(k))) fail('INVALID_PATCH')
    if (patch.summary !== undefined) text(patch.summary)
    if (patch.action !== undefined) text(patch.action)
    if (patch.eventAt !== undefined) date(patch.eventAt, true)
    if (patch.notBefore !== undefined) date(patch.notBefore, true)
    if (patch.expiresAt !== undefined) date(patch.expiresAt)
    if (patch.timezone !== undefined) zone(patch.timezone)
    return this.tx(() => {
      const f = this.require(scope, id, revision)
      if (closed(f)) fail('CLOSED')
      for (const key of keys) if (Object.hasOwn(patch, key) && patch[key as keyof typeof patch] === undefined) fail('INVALID_PATCH')
      Object.assign(f, patch)
      if (Date.parse(f.expiresAt) <= this.now().getTime()) fail('EXPIRED')
      this.db.prepare("UPDATE intention_outbox SET owner='', state=CASE WHEN state='claimed' THEN 'failed' ELSE state END WHERE id=?").run(id)
      if (f.dispatch === 'claimed') f.dispatch = 'failed'
      f.revision++; f.updatedAt = this.now().toISOString(); this.save(f); return f
    })
  }
  relevant(scope: FollowupScope, limit = 3) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) fail('INVALID_LIMIT')
    const now = this.now().getTime()
    const exclusions = this.getPolicy(scope).topicExclusions.map(s => s.toLowerCase())
    return this.list(scope).filter(f => Date.parse(f.expiresAt) > now && !exclusions.some(topic => `${f.summary} ${f.action}`.toLowerCase().includes(topic)))
      .sort((a,b) => Date.parse(a.notBefore ?? a.eventAt ?? a.expiresAt) - Date.parse(b.notBefore ?? b.eventAt ?? b.expiresAt)).slice(0, Math.min(limit, 3))
  }
  getCheckpoint(scope: FollowupScope): string | null { const row = this.db.prepare('SELECT cursor FROM intention_settings WHERE scope=?').get(scopeKey(scope)); return row?.cursor == null ? null : String(row.cursor) }
  setCheckpoint(scope: FollowupScope, cursor: string) { text(cursor, 4000); this.tx(() => this.db.prepare('INSERT INTO intention_settings(scope,cursor) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor').run(scopeKey(scope), cursor)) }
  expire(scope: FollowupScope) {
    return this.tx(() => {
      const at = this.now().toISOString(); let count = 0
      for (const f of this.list(scope)) if (Date.parse(f.expiresAt) <= Date.parse(at)) {
        f.lifecycle = 'expired'; f.summary = ''; f.action = ''; f.sourceMessageId = ''; f.updatedAt = at; f.revision++; this.save(f)
        this.db.prepare("UPDATE intention_outbox SET owner='' WHERE id=?").run(f.id); count++
      }
      const cutoff = new Date(this.now().getTime() - 30 * 86400000).toISOString()
      // Keep only input-origin hashes after operational state expires: transcript
      // attribution must not silently turn an old controller input into human speech.
      for (const row of this.db.prepare('SELECT otid FROM intention_outbox WHERE scope=?').all(scopeKey(scope)))
        this.db.prepare('INSERT OR IGNORE INTO intention_input_provenance(scope,otid_hash) VALUES (?,?)').run(scopeKey(scope), hash(String(row.otid)))
      this.db.prepare('DELETE FROM intention_outbox WHERE id IN (SELECT id FROM intentions WHERE scope=? AND closed_at<?)').run(scopeKey(scope), cutoff)
      this.db.prepare('DELETE FROM intention_sources WHERE scope=? AND followup_id IN (SELECT id FROM intentions WHERE scope=? AND closed_at<?)').run(scopeKey(scope), scopeKey(scope), cutoff)
      this.db.prepare('DELETE FROM intentions WHERE scope=? AND closed_at<?').run(scopeKey(scope), cutoff)
      this.db.prepare('DELETE FROM intention_owned_inputs WHERE scope=? AND at<?').run(scopeKey(scope), cutoff)
      // The ledger is the replay guard, so it outlives the item it produced and
      // goes at the same cutoff as the rest of the dedupe evidence.
      this.db.prepare('DELETE FROM intention_capture_log WHERE scope=? AND at<?').run(scopeKey(scope), cutoff)
      this.db.prepare('DELETE FROM intention_invocations WHERE scope=? AND at<?').run(scopeKey(scope), cutoff)
      // Old job rows go, except the ones that still describe something left
      // behind in the account: an unarchived or unknown temporary conversation
      // has to stay countable until someone deals with it.
      this.db.prepare("DELETE FROM intention_classifier_jobs WHERE scope=? AND at<? AND state NOT IN ('archive-failed','archive-unconfirmed','conversation-unknown')").run(scopeKey(scope), cutoff)
      return count
    })
  }
  claim(scope: FollowupScope, id: string, revision: number, owner: string, leaseMs: number): FollowupClaim {
    text(owner, 200)
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) fail('INVALID_LEASE')
    return this.tx(() => {
      const f = this.require(scope, id, revision); const p = this.getPolicy(scope); const now = this.now()
      if (!p.enabled || !p.proactive || scope.audience !== 'private') fail('DISPATCH_DISABLED')
      if (closed(f) || !f.adoptedBy || !['pending', 'deferred'].includes(f.lifecycle)) fail('NOT_ADOPTED')
      if (p.topicExclusions.some(t => `${f.summary} ${f.action}`.toLowerCase().includes(t.toLowerCase()))) fail('TOPIC_EXCLUDED')
      if (Date.parse(f.expiresAt) <= now.getTime()) fail('EXPIRED')
      if (f.notBefore && Date.parse(f.notBefore) > now.getTime()) fail('TOO_EARLY')
      if (['unknown', 'started', 'replied', 'delivered'].includes(f.dispatch)) fail('DISPATCH_ALREADY_ATTEMPTED')
      const clock = local(now, p.timezone)
      if (p.quietStart !== p.quietEnd && (p.quietStart < p.quietEnd ? clock.time >= p.quietStart && clock.time < p.quietEnd : clock.time >= p.quietStart || clock.time < p.quietEnd)) fail('QUIET_HOURS')
      const previous = this.db.prepare('SELECT * FROM intention_outbox WHERE id=?').get(id)
      // A claim is safe to recover only before invocation. Started/unknown are never retried.
      if (previous && previous.state !== 'failed' && !(previous.state === 'claimed' && Date.parse(String(previous.lease_until)) <= now.getTime())) fail('ALREADY_CLAIMED')
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM intention_invocations WHERE scope=? AND day=?').get(scopeKey(scope), clock.day)!
      const reserved = this.db.prepare("SELECT COUNT(*) AS n FROM intention_outbox WHERE scope=? AND day=? AND state='claimed' AND id<>?").get(scopeKey(scope), clock.day, id)!
      if (Number(used.n) + Number(reserved.n) >= p.dailyLimit) fail('DAILY_LIMIT')
      const otid = previous ? String(previous.otid) : randomUUID(); const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
      this.db.prepare("INSERT INTO intention_outbox(id,scope,owner,otid,lease_until,state,day) VALUES (?,?,?,?,?,'claimed',?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until,state='claimed',day=excluded.day").run(id, scopeKey(scope), owner, otid, leaseUntil, clock.day)
      f.dispatch = 'claimed'; f.revision++; f.updatedAt = now.toISOString(); this.save(f)
      return { followup: f, owner, otid, leaseUntil }
    })
  }
  rememberInput(scope: FollowupScope, otid: string, at: string): void {
    const key = scopeKey(scope); text(otid, 500); date(at)
    this.tx(() => {
      if (!this.getPolicy(scope).enabled || scope.audience !== 'private') fail('POLICY_DISABLED')
      if (this.isControllerOtid(scope, otid)) fail('CONTROLLER_INPUT')
      this.db.prepare('INSERT INTO intention_owned_inputs(scope,otid,at) VALUES (?,?,?) ON CONFLICT(scope,otid) DO NOTHING').run(key, otid, new Date(at).toISOString())
    })
  }
  ownsInput(scope: FollowupScope, otid: string): boolean {
    text(otid, 500)
    if (this.isControllerOtid(scope, otid)) return false
    const cutoff = new Date(this.now().getTime() - 30 * 86400000).toISOString()
    return !!this.db.prepare('SELECT otid FROM intention_owned_inputs WHERE scope=? AND otid=? AND at>=?').get(scopeKey(scope), otid, cutoff)
  }
  inputTimestamp(scope: FollowupScope, otid: string): string | null {
    if (!this.ownsInput(scope, otid)) return null
    const row = this.db.prepare('SELECT at FROM intention_owned_inputs WHERE scope=? AND otid=?').get(scopeKey(scope), otid)
    return row ? String(row.at) : null
  }
  lastInputTimestamp(scope: FollowupScope): string | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM intention_owned_inputs WHERE scope=?').get(scopeKey(scope))
    return typeof row?.at === 'string' ? row.at : null
  }
  /**
   * Reserve one classification job for today, before anything is dispatched.
   *
   * The reservation is what bounds the feature: a crash between dispatch and
   * result still consumes it, which is the conservative direction. It counts
   * JOBS, not tokens or money — one job's cost depends on the model and the
   * message, so this is not a spend cap and is not described as one.
   */
  reserveClassifierJob(scope: FollowupScope): { id: string; day: string } {
    const key = scopeKey(scope)
    return this.tx(() => {
      const policy = this.getPolicy(scope)
      if (!policy.enabled || policy.extractAutomatically === false) fail('POLICY_DISABLED')
      if (scope.audience !== 'private') fail('AUDIENCE_NOT_PRIVATE')
      const now = this.now()
      const day = local(now, policy.timezone).day
      const limit = Math.min(policy.dailyClassifierLimit ?? defaults.dailyClassifierLimit ?? 40, CLASSIFIER_DAILY_LIMIT)
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM intention_classifier_jobs WHERE scope=? AND day=?').get(key, day)!
      if (Number(used.n) >= limit) fail('CLASSIFIER_DAILY_LIMIT')
      const id = randomUUID()
      this.db.prepare("INSERT INTO intention_classifier_jobs(id,scope,day,at,state,conversation_id) VALUES (?,?,?,?,'reserved',NULL)").run(id, key, day, now.toISOString())
      return { id, day }
    })
  }
  /** Hand a reservation back. Only a job that never reached the model may be released. */
  releaseClassifierJob(scope: FollowupScope, id: string): void {
    text(id, 100)
    this.tx(() => this.db.prepare("DELETE FROM intention_classifier_jobs WHERE scope=? AND id=? AND state='reserved'").run(scopeKey(scope), id))
  }
  /** Record that a job reached the model, and the conversation it made if known. */
  markClassifierJob(scope: FollowupScope, id: string, conversationId: string | null): void {
    text(id, 100); if (conversationId !== null) text(conversationId, 500)
    this.tx(() => this.db.prepare("UPDATE intention_classifier_jobs SET state=?, conversation_id=? WHERE scope=? AND id=?")
      .run(conversationId ? 'dispatched' : 'conversation-unknown', conversationId, scopeKey(scope), id))
  }
  /**
   * Record what became of that temporary conversation. Anything but a confirmed
   * archive keeps the conversation id, so what was left behind can still be
   * found and dealt with by hand; `unconfirmed` means the archive call never
   * answered, which is not the same as having failed and is not the same as
   * having worked. Archiving is also not deletion, which the feature's own text
   * has to say.
   */
  markClassifierArchived(scope: FollowupScope, id: string, state: 'archived' | 'failed' | 'unconfirmed'): void {
    text(id, 100)
    const archived = state === 'archived'
    const value = archived ? 'archived' : state === 'failed' ? 'archive-failed' : 'archive-unconfirmed'
    this.tx(() => this.db.prepare('UPDATE intention_classifier_jobs SET state=?, conversation_id=CASE WHEN ? THEN NULL ELSE conversation_id END WHERE scope=? AND id=?')
      .run(value, archived ? 1 : 0, scopeKey(scope), id))
  }
  /** Temporary conversations this scope may have left in the account. */
  unreconciledClassifierJobs(scope: FollowupScope): Array<{ id: string; state: string; conversationId: string | null }> {
    return this.db.prepare("SELECT id, state, conversation_id FROM intention_classifier_jobs WHERE scope=? AND state IN ('archive-failed','archive-unconfirmed','conversation-unknown') ORDER BY at DESC LIMIT 100")
      .all(scopeKey(scope)).map(row => ({ id: String(row.id), state: String(row.state), conversationId: row.conversation_id == null ? null : String(row.conversation_id) }))
  }
  classifierUsage(scope: FollowupScope): { usedToday: number; limit: number; archiveFailures: number } {
    const key = scopeKey(scope)
    const policy = this.getPolicy(scope)
    const day = local(this.now(), policy.timezone).day
    const used = this.db.prepare('SELECT COUNT(*) AS n FROM intention_classifier_jobs WHERE scope=? AND day=?').get(key, day)!
    const failures = this.db.prepare("SELECT COUNT(*) AS n FROM intention_classifier_jobs WHERE scope=? AND state IN ('archive-failed','archive-unconfirmed','conversation-unknown')").get(key)!
    return {
      usedToday: Number(used.n),
      limit: Math.min(policy.dailyClassifierLimit ?? defaults.dailyClassifierLimit ?? 40, CLASSIFIER_DAILY_LIMIT),
      archiveFailures: Number(failures.n),
    }
  }
  getClaim(scope: FollowupScope, id: string): FollowupClaim | null {
    const followup = this.get(scope, id)
    if (!followup) return null
    const row = this.db.prepare('SELECT owner,otid,lease_until FROM intention_outbox WHERE id=? AND scope=?').get(id, scopeKey(scope))
    if (!row) return null
    return { followup, owner: String(row.owner), otid: String(row.otid), leaseUntil: String(row.lease_until) }
  }
  isControllerOtid(scope: FollowupScope, otid: string): boolean {
    text(otid, 500)
    return !!this.db.prepare('SELECT id FROM intention_outbox WHERE scope=? AND otid=?').get(scopeKey(scope), otid) ||
      !!this.db.prepare('SELECT otid_hash FROM intention_input_provenance WHERE scope=? AND otid_hash=?').get(scopeKey(scope), hash(otid))
  }
  markDispatch(scope: FollowupScope, id: string, owner: string, outcome: FollowupDispatch, runId?: string, deliveryId?: string): Followup {
    text(owner, 200); if (runId !== undefined) text(runId, 500); if (deliveryId !== undefined) text(deliveryId, 500)
    return this.tx(() => {
      const f = this.require(scope, id); const row = this.db.prepare('SELECT * FROM intention_outbox WHERE id=? AND scope=?').get(id, scopeKey(scope))
      if (!row || row.owner !== owner || closed(f)) fail('CLAIM_INVALIDATED')
      const allowed: Record<string, string[]> = { claimed: ['started', 'unknown', 'failed'], started: ['replied', 'unknown', 'failed'], replied: ['delivered', 'unknown', 'failed'], unknown: ['replied', 'delivered'] }
      if (!(allowed[String(row.state)] ?? []).includes(outcome)) fail('INVALID_DISPATCH_TRANSITION')
      if (row.state === 'claimed' && outcome === 'started') {
        const now = this.now(); const p = this.getPolicy(scope)
        if (Date.parse(String(row.lease_until)) <= now.getTime()) fail('LEASE_EXPIRED')
        if (!p.enabled || !p.proactive || scope.audience !== 'private') fail('DISPATCH_DISABLED')
        if (Date.parse(f.expiresAt) <= now.getTime()) fail('EXPIRED')
        if (f.notBefore && Date.parse(f.notBefore) > now.getTime()) fail('TOO_EARLY')
        const clock = local(now, p.timezone)
        if (row.day !== clock.day) fail('CLAIM_DAY_CHANGED')
        if (p.quietStart !== p.quietEnd && (p.quietStart < p.quietEnd ? clock.time >= p.quietStart && clock.time < p.quietEnd : clock.time >= p.quietStart || clock.time < p.quietEnd)) fail('QUIET_HOURS')
        if (p.topicExclusions.some(t => `${f.summary} ${f.action}`.toLowerCase().includes(t.toLowerCase()))) fail('TOPIC_EXCLUDED')
        const used = this.db.prepare('SELECT COUNT(*) AS n FROM intention_invocations WHERE scope=? AND day=?').get(scopeKey(scope), clock.day)!
        if (Number(used.n) >= p.dailyLimit) fail('DAILY_LIMIT')
        this.db.prepare('INSERT INTO intention_invocations(scope,followup_id,day,at) VALUES (?,?,?,?)').run(scopeKey(scope), id, clock.day, now.toISOString())
      }
      if (outcome === 'delivered' && !deliveryId) fail('DELIVERY_ID_REQUIRED')
      this.db.prepare('UPDATE intention_outbox SET state=?,run_id=COALESCE(?,run_id),delivery_id=COALESCE(?,delivery_id) WHERE id=?').run(outcome, runId ?? null, deliveryId ?? null, id)
      if (outcome === 'started') { f.attemptCount++; f.lastAttemptAt = this.now().toISOString() }
      if (outcome === 'delivered') f.lifecycle = 'awaiting-reply'
      f.dispatch = outcome; f.revision++; f.updatedAt = this.now().toISOString(); this.save(f); return f
    })
  }
  close() { this.db.close() }
}
