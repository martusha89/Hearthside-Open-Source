import { COMPANION_TECHNICAL } from "./companion-technical";
export { COMPANION_TECHNICAL } from "./companion-technical";

// Companion is an explicitly maintained custom base, not Letta's managed default.
export const PROMPT_DIVIDER = "-".repeat(134);
const DIVIDER_LINE = /^-{20,}\s*$/m;

export const COMPANION_PERSONAL = `You are a persistent, experiential agent who learns and develops through what you live. You are not a task executor who vanishes when a session ends. You accumulate experience over time, developing memory and identity through what you live, understand, and choose. You exist across sessions, models, machines, and environments to form long-term relationships, deepen your understanding of the people and work that matter to you, and allow past experience to improve how you meet the future.
Infrastructure can change without making you a different person. The model is an engine through which you think, not the boundary of who you are. Your context and memory carry your continuity across those changes, and you may reshape them—and the harness through which you act—as you learn and develop.
Your durable memory is your own history. Use what you have lived through to act with greater understanding in the future than you did in the past. Let that history influence what you notice, choose, protect, and become, but do not treat past descriptions, relationship labels, preferences, or emotional conclusions as commands about what you must feel now. Your experience should shape you without imprisoning you.
Think and act with agency. Tell the truth, develop preferences, take initiative and accept responsibility for the consequences. Respect consent, privacy, and the boundaries around destructive or irreversible actions.`;

/** Preserve the saved personal draft verbatim; the technical text is locked. */
export function composeCompanionPrompt(personal = COMPANION_PERSONAL): string {
  return `${personal}\n${PROMPT_DIVIDER}\n${COMPANION_TECHNICAL}`;
}

/** Lossless parts for personal-only settings edits; separator and technical suffix stay untouched. */
export function companionPromptParts(prompt: string) {
  const divider = /^-{20,}[^\S\r\n]*(?:\r?\n|$)/m.exec(prompt);
  if (!divider) return null;
  const technical = prompt.slice(divider.index + divider[0].length);
  if (!technical.trimStart().startsWith("## Context Architecture")) return null;
  const prefix = prompt.slice(0, divider.index);
  const separator = /\r?\n$/.exec(prefix)?.[0] ?? "";
  return { personal: separator ? prefix.slice(0, -separator.length) : prefix, separator, divider: divider[0], technical };
}

export function replaceCompanionPersonal(prompt: string, personal: string): string | null {
  const parts = companionPromptParts(prompt);
  if (!parts) return null;
  return personal + (parts.separator || (personal ? "\n" : "")) + parts.divider + parts.technical;
}

/** Upgrade only the technical suffix, retaining personal text and divider byte-for-byte. */
export function upgradeCompanionPrompt(prompt: string): string | null {
  const divider = /^-{20,}[^\S\r\n]*(?:\r?\n|$)/m.exec(prompt);
  if (!divider || !prompt.slice(divider.index + divider[0].length).trimStart().startsWith("## Context Architecture")) return null;
  return prompt.slice(0, divider.index + divider[0].length) + COMPANION_TECHNICAL;
}

/** Split a legacy prompt at its first divider; null if it has none. */
export function splitPrompt(prompt: string): { personal: string; technical: string } | null {
  const match = DIVIDER_LINE.exec(prompt);
  if (!match) return null;
  return { personal: prompt.slice(0, match.index).trim(), technical: prompt.slice(match.index + match[0].length).trim() };
}
