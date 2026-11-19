/**
 * Hearthside: the agents your agents create. The runtime's Agent tool makes a
 * helper agent per job and tags it "role:subagent" and "parent:<agent id>";
 * helpers persist and are reused. Hearthside keeps them out of the agent list
 * and shows them under the agent that made them (More → Helpers).
 */

export const HELPER_TAG = "role:subagent";
const PARENT_PREFIX = "parent:";

export function isHelper(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).includes(HELPER_TAG);
}

/** The agent a helper works for, from its tags. */
export function helperParent(tags: readonly string[] | null | undefined): string | null {
  const tag = (tags ?? []).find((item) => item.startsWith(PARENT_PREFIX));
  return tag ? tag.slice(PARENT_PREFIX.length) || null : null;
}
