/**
 * Hearthside: when the agent loads a skill, the runtime puts the skill's whole
 * text into the conversation as a "user" message, wrapped in
 * <skill_content name="…">, sometimes followed by the person's own request.
 * The chat shows that as a one-line note (with the text one click away)
 * rather than a huge message from the person.
 */

export type SkillContent = { name: string; content: string; rest: string };

const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseSkillContent(text: string): SkillContent | null {
  const match = /^\s*<skill_content name="([^"]*)">\n?([\s\S]*?)\n?<\/skill_content>/.exec(text);
  if (!match) return null;
  return { name: unescape(match[1] ?? ""), content: match[2] ?? "", rest: text.slice(match[0].length).trim() };
}
