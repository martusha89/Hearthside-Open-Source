import type { SkillNeeds } from "@hearthside/ipc-contract";

/**
 * Hearthside: what a skill needs, read from its SKILL.md. Skills are written
 * instructions; their power comes from programs on the computer (the `gog`
 * command for Google, `gh` for GitHub…) and sometimes API keys. Skills don't
 * declare these in a fixed format, so this reads the usual phrasings.
 */

/** Words that look like commands in backticks but aren't programs to install. */
const NOT_PROGRAMS = new Set([
  "cd", "ls", "cat", "echo", "rm", "cp", "mv", "mkdir", "grep", "find", "sed", "awk", "curl", "git", "node", "npm", "npx", "python",
  "python3", "pip", "bash", "sh", "true", "false", "json", "yaml", "md", "png", "jpg", "html", "css", "js", "ts",
]);

export function readSkillNeeds(markdown: string): SkillNeeds {
  const body = markdown.replace(/^---[\s\S]*?\n---\s*/, "");
  const programs = new Set<string>();
  const patterns = [
    /\b(?:use|uses|using|via|run|runs|install|requires?)\s+(?:the\s+)?`([a-z0-9][a-z0-9._-]{1,40})`/gi,
    /`([a-z0-9][a-z0-9._-]{1,40})`\s+(?:CLI|command|tool|binary)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const name = match[1]!.toLowerCase();
      if (!NOT_PROGRAMS.has(name) && !name.includes("/") && !/\.(md|json|ya?ml|png|txt|py|js|ts)$/.test(name)) programs.add(name);
    }
  }
  const secrets = new Set<string>();
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN|SECRET))\b/g)) secrets.add(match[1]!);

  // The skill's own setup / requirements section, as written.
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*(?:#{1,4}\s*)?(?:setup|set ?up \(once\)|requirements|prerequisites|install(?:ation)?)\b.*$/i.test(line));
  let setup: string | null = null;
  if (start >= 0) {
    const section: string[] = [];
    for (let i = start + 1; i < lines.length && section.join("\n").length < 1200; i++) {
      const line = lines[i]!;
      if (/^\s*#{1,4}\s/.test(line) || (section.length > 0 && /^\S/.test(line) && !/^\s*[-*\d]/.test(line) && !line.startsWith("`"))) break;
      section.push(line);
    }
    setup = section.join("\n").trim() || null;
  }
  return { programs: [...programs].slice(0, 6), secrets: [...secrets].slice(0, 6), setup };
}
