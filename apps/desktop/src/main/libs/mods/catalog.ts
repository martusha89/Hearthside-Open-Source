import type { ModCapabilityInfo, ModCommandInfo } from "@hearthside/ipc-contract";

/**
 * What the runtime advertises for one chat.
 *
 * There is no request that lists commands. The catalog rides along on the
 * device-status replay Hearthside already asks for (the same call behind
 * Settings → Tools), as two fields of `DeviceStatus`
 * (dist/types/types/protocol_v2.d.ts:307):
 *
 *   supported_commands: string[]            built-in ids this runtime can run
 *   mod_commands?: { id, description, args? }[]
 *
 * `mod_commands` carries nothing else: no owner, no file, no `runWhenBusy`, no
 * `showInTranscript`, no result type. Nothing here guesses the missing fields.
 */

export type AdvertisedCommands = {
  /** Built-in ids the runtime says it can run through `execute_command`. */
  supported: string[];
  /** Commands contributed by loaded mods. Empty when the runtime sent none. */
  mods: ModCommandInfo[];
};

export function readAdvertisedCommands(status: Record<string, unknown>): AdvertisedCommands {
  const supported = Array.isArray(status.supported_commands)
    ? status.supported_commands.filter((value): value is string => typeof value === "string")
    : [];
  const raw = Array.isArray(status.mod_commands) ? status.mod_commands : [];
  const seen = new Set<string>();
  const mods: ModCommandInfo[] = [];
  for (const item of raw) {
    const entry = item as { id?: unknown; description?: unknown; args?: unknown } | null;
    // The runtime's own id rule (validateModCommandId, letta.js 434722). A
    // command id that could not have been registered is not rendered as one.
    if (!entry || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    mods.push({
      id: entry.id,
      description: typeof entry.description === "string" ? entry.description.slice(0, 500) : "",
      argument: typeof entry.args === "string" && entry.args.trim() ? entry.args.trim().slice(0, 100) : null,
    });
  }
  return { supported, mods: mods.sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * What the runtime says a mod may use, for the two scopes the desktop sees.
 *
 * Mirrored from LISTENER_MOD_CAPABILITIES and LISTENER_AGENT_MOD_CAPABILITIES
 * (letta.js 436003 and 436019) because the runtime does not report them over
 * the protocol or export them from the package. `runtime-contract.test.ts`
 * fails if the bundle changes them.
 *
 * These are advertised API availability, not a sandbox: loading a mod imports
 * and runs it, with everything the runtime process can reach.
 */
export const LISTENER_MOD_CAPABILITIES: ModCapabilityInfo[] = [
  { id: "tools", name: "Give the agent new tools", machine: true, agent: true },
  { id: "commands", name: "Add slash commands", machine: true, agent: true },
  { id: "permissions", name: "Decide whether a tool call is allowed", machine: true, agent: true },
  { id: "providers", name: "Add a model provider", machine: true, agent: false },
  { id: "events.tools", name: "React to tool calls starting and finishing", machine: true, agent: true },
  { id: "events.turns", name: "React to a reply starting and finishing", machine: true, agent: true },
  { id: "events.lifecycle", name: "React to chats opening and closing", machine: false, agent: false },
  { id: "events.compact", name: "React to summarising", machine: false, agent: false },
  { id: "events.llm", name: "React to each model call", machine: false, agent: false },
  { id: "ui.panels", name: "Draw a panel", machine: false, agent: false },
];
