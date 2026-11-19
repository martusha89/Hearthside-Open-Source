import type { ChatCommand, RuntimeCommand } from "../types";

/** Hearthside: slash commands offered in the message box. */

export type SlashCommand = {
  name: string;
  /** What it does, in plain words. */
  description: string;
  /** Shown after the name, e.g. "something to remember". */
  argument?: string;
  /** Run by the runtime, or handled here in the app. */
  runtime?: RuntimeCommand;
  /** The argument is required. */
  needsArgument?: boolean;
  /** Contributed by a mod the runtime has loaded, not built in. */
  mod?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "remember", description: "Ask the agent to save something to memory", argument: "what to remember", needsArgument: true },
  { name: "dream", description: "Reflect on this conversation and update memory", runtime: "dream" },
  { name: "compact", description: "Summarise older messages now to free up context", runtime: "compact" },
  { name: "recompile", description: "Refresh this conversation's system prompt from saved core memory; evicts the prompt cache and may increase cost", runtime: "recompile" },
  { name: "doctor", description: "The agent checks its memory for problems and tidies it up", argument: "optional symptom", runtime: "doctor" },
  { name: "init", description: "The agent sets up its memory by getting to know you", runtime: "init" },
  { name: "new", description: "Start a new chat" },
  { name: "reload", description: "Reload mods and skills", runtime: "reload" },
];

/**
 * Hearthside: the commands a mod has registered, as the runtime advertises
 * them for the open chat. A mod command never replaces a built-in of the same
 * name: the runtime's own dispatch answers built-in ids itself before it ever
 * looks at loaded mods, so offering one here would run something else.
 */
export function withModCommands(mods: ChatCommand[]): SlashCommand[] {
  const builtIn = new Set(SLASH_COMMANDS.map((command) => command.name));
  const extra = mods
    .filter((command) => command.source === "mod" && !builtIn.has(command.id))
    .map((command): SlashCommand => ({
      name: command.id,
      description: command.description || "A command from a mod",
      ...(command.argument ? { argument: command.argument } : {}),
      mod: true,
    }));
  return [...SLASH_COMMANDS, ...extra];
}

/** The shape of typed text that looks like a command, whether or not it is one. */
export function readSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * A known command at the start of the text, with what follows it. `commands`
 * defaults to the built-ins only, so a caller that has not loaded the chat's
 * mod commands cannot accidentally match one.
 */
export function parseCommand(text: string, commands: SlashCommand[] = SLASH_COMMANDS): { command: SlashCommand; args: string } | null {
  const slash = readSlash(text);
  if (!slash) return null;
  const command = commands.find((item) => item.name === slash.name || (slash.name === "reflect" && item.name === "dream"));
  return command ? { command, args: slash.args } : null;
}

/** Commands matching what has been typed so far ("/dr" → dream). Empty once a space is typed. */
export function suggestCommands(text: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const match = /^\/([a-z0-9-]*)$/i.exec(text);
  if (!match) return [];
  const typed = match[1]!.toLowerCase();
  return commands.filter((item) => item.name.startsWith(typed));
}

/** The message /remember sends. */
export function rememberMessage(what: string): string {
  return `Please remember this and save it to your memory: ${what}`;
}

/**
 * What to say about text that starts with "/" and names nothing known.
 *
 * It is never sent: not as a command the runtime would reject, and not as a
 * message the agent would read as instructions. A mod command only exists once
 * the runtime says it does.
 */
export function unknownCommandNotice(name: string, modsLoaded: boolean): string {
  const base = `There's no /${name} command, so nothing was sent.`;
  return modsLoaded
    ? `${base} Check the spelling, or look in Settings → Mods for what this companion has loaded.`
    : `${base} If it comes from a mod, Hearthside couldn't ask the runtime what's loaded just now.`;
}
