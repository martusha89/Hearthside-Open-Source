export interface FollowupScope {
  connectionId: string
  agentId: string
  conversationId: string
  recipientId: string
  audience: 'private' | 'shared'
}
export type FollowupOrigin = 'agent_created' | 'classifier_proposed' | 'user_created' | 'policy_activated'
export type FollowupActor = 'agent' | 'user' | 'policy'
export type FollowupLifecycle = 'candidate' | 'pending' | 'deferred' | 'awaiting-reply' | 'resolved' | 'cancelled' | 'expired'
export type FollowupDispatch = 'not-requested' | 'claimed' | 'started' | 'replied' | 'delivered' | 'unknown' | 'failed'
export interface FollowupCreate {
  summary: string
  action: string
  eventAt: string | null
  notBefore: string | null
  expiresAt: string
  timezone: string
  sourceMessageId: string
  sourceAt: string
}
export interface Followup extends FollowupCreate {
  id: string
  scope: FollowupScope
  origin: FollowupOrigin
  adoptedBy: FollowupActor | null
  lifecycle: FollowupLifecycle
  dispatch: FollowupDispatch
  revision: number
  createdAt: string
  updatedAt: string
  attemptCount: number
  lastAttemptAt: string | null
}
export interface FollowupPolicy {
  enabled: boolean
  extractAutomatically?: boolean
  autoActivate: boolean
  proactive: boolean
  timezone: string
  quietStart: string
  quietEnd: string
  dailyLimit: number
  topicExclusions: string[]
  /** Model handle used for semantic capture; null until one is chosen. */
  semanticModel?: string | null
  /** Upper bound on classification jobs per local day. A job count, not a spend cap. */
  dailyClassifierLimit?: number
  /** Short summaries may travel in the automatic note the companion sees. */
  automaticNotes?: boolean
}
/**
 * Everything automatic is off until `enabled` is turned on, and timed wake-ups
 * stay off after that. `autoActivate` is on so that once a person does opt in,
 * what their companion notices is simply remembered: ordinary capture never
 * waits for them to adopt each item by hand.
 */
export const DEFAULT_FOLLOWUP_POLICY: FollowupPolicy = {
  enabled: false, extractAutomatically: true, autoActivate: true, proactive: false, timezone: 'UTC',
  quietStart: '22:00', quietEnd: '08:00', dailyLimit: 1, topicExclusions: [],
  semanticModel: null, dailyClassifierLimit: 40, automaticNotes: true,
}
/** What short-term memory can actually do on this connection, said plainly. */
export interface FollowupCaptureStatus {
  /** Semantic capture can run: a model is chosen and the connection supports it. */
  available: boolean
  reason: string
  model: string | null
  usedToday: number
  limit: number
  /** Temporary classifier conversations that could not be archived. */
  archiveFailures: number
}
export interface FollowupView {
  scope: FollowupScope
  policy: FollowupPolicy
  items: Followup[]
  status: string
  /** Why this conversation counts as private, shared or unverifiable. */
  audienceReason: string
  capture: FollowupCaptureStatus
}
export interface FollowupClaim {
  followup: Followup
  otid: string
  owner: string
  leaseUntil: string
}
