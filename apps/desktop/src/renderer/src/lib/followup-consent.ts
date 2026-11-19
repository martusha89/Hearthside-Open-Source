import type { FollowupPolicy } from "@hearthside/ipc-contract";

/** A grant is needed for new access or larger automatic model-use limits, not to turn anything off. */
export function needsFollowupConsent(before: FollowupPolicy | null, next: FollowupPolicy): boolean {
  if (!next.enabled) return false;
  if (!before?.enabled) return true;
  if ((!before.extractAutomatically && next.extractAutomatically) || (!before.proactive && next.proactive) ||
    (!(before.automaticNotes ?? true) && (next.automaticNotes ?? true)) || (!before.autoActivate && next.autoActivate)) return true;
  if (next.extractAutomatically && (before.semanticModel !== next.semanticModel || (next.dailyClassifierLimit ?? 40) > (before.dailyClassifierLimit ?? 40) ||
    before.topicExclusions.some((topic) => !next.topicExclusions.includes(topic)))) return true;
  return next.proactive && next.dailyLimit > before.dailyLimit;
}

/** Bind the acknowledgement to the reviewed choices, rather than a sticky checkbox. */
export function followupConsentKey(policy: FollowupPolicy): string { return JSON.stringify(policy); }

/**
 * Hearthside: the settings as "Enable" is ticked. Turning short-term memory
 * on for the first time takes the computer's own time zone: left at the
 * built-in UTC, "tomorrow at nine" was read as nine in London, and quiet
 * hours of 22:00 to 08:00 fell in the afternoon for someone in Los Angeles.
 * Once it has been on, the zone is whatever the person saved, UTC included;
 * the zone is shown in the form either way, so it can be changed before saving.
 */
export function enabledFollowupPolicy(policy: FollowupPolicy, saved: FollowupPolicy | null, computerZone: string | undefined): FollowupPolicy {
  const firstTime = !saved?.enabled && policy.timezone === "UTC";
  return {
    ...policy, enabled: true, extractAutomatically: true, autoActivate: true, automaticNotes: true,
    ...(firstTime && computerZone ? { timezone: computerZone } : {}),
  };
}
