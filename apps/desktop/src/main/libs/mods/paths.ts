import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModDirectoryRule } from "@hearthside/ipc-contract";

/**
 * Where the runtime reads mods from, and whether it reads them at all.
 *
 * @letta-ai/letta-code does not export `src/mods/paths.ts` or
 * `src/mods/disable.ts`, so these rules are mirrored here from the pinned
 * bundle (letta.js 264540-264561 and 206135-206152). `runtime-contract.test.ts`
 * fails if the bundle stops agreeing, which is the point: an inventory that
 * disagrees with the runtime would be worse than none.
 *
 * Every resolution takes the environment as an argument. The environment that
 * matters is the one Hearthside hands the child process (`runtimeChildEnv`),
 * not this process's: an inherited LETTA_MODS_DIR moves the folder outside the
 * sandbox home, and the screen has to show where the runtime will really look.
 */

export const MODS_DIR_ENV = "LETTA_MODS_DIR";
export const LEGACY_EXTENSIONS_DIR_ENV = "LETTA_EXTENSIONS_DIR";
/** letta-code 0.34.36: an absolute LETTA_CONFIG_DIR replaces `<home>/.letta` as the state root. */
export const CONFIG_DIR_ENV = "LETTA_CONFIG_DIR";
export const DISABLE_MODS_ENV = "LETTA_DISABLE_MODS";
export const LEGACY_DISABLE_EXTENSIONS_ENV = "LETTA_DISABLE_EXTENSIONS";

/** The extensions the runtime loads (MOD_FILE_EXTENSIONS). */
export const MOD_FILE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx"] as const;

/** `packages.json` / `packages/` in the mods folder (MOD_PACKAGES_*). */
export const PACKAGES_REGISTRY_FILENAME = "packages.json";
export const PACKAGES_DIRECTORY_NAME = "packages";

/**
 * Exactly the runtime's rule, capitals included: it compares the extension as
 * written, so it never loads "Foo.JS". Listing such a file as a mod showed
 * something that does nothing, and that the window could not then open.
 */
export function isModFileName(name: string): boolean {
  if (name.startsWith(".")) return false;
  return MOD_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** The runtime's truthiness rule for its disable flags, exactly. */
function truthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * A disable flag already set in the environment, if any. Hearthside never
 * overwrites one: a person who turned mods off outside Hearthside keeps them
 * off, whatever Hearthside's own switch says.
 */
export function modsDisabledByEnvironment(env: NodeJS.ProcessEnv): string | null {
  if (truthyFlag(env[DISABLE_MODS_ENV])) return DISABLE_MODS_ENV;
  if (truthyFlag(env[LEGACY_DISABLE_EXTENSIONS_ENV])) return LEGACY_DISABLE_EXTENSIONS_ENV;
  return null;
}

export type ModsDirectory = { directory: string; rule: ModDirectoryRule };

/**
 * The machine-wide mods folder, by the runtime's own order of preference:
 * LETTA_MODS_DIR, then the legacy LETTA_EXTENSIONS_DIR, then <root>/mods if
 * it exists, then the legacy <root>/extensions if it exists, else <root>/mods,
 * where <root> is LETTA_CONFIG_DIR when set (0.34.36, getModsStateRoot) and
 * ~/.letta otherwise. Hearthside never sets LETTA_CONFIG_DIR itself.
 */
export function modsStateRoot(home: string, env: NodeJS.ProcessEnv): string {
  const configDir = env[CONFIG_DIR_ENV]?.trim();
  return configDir ? configDir : join(home, ".letta");
}

export function machineModsDirectory(
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): ModsDirectory {
  const override = env[MODS_DIR_ENV]?.trim();
  if (override) return { directory: override, rule: MODS_DIR_ENV };
  const legacyOverride = env[LEGACY_EXTENSIONS_DIR_ENV]?.trim();
  if (legacyOverride) return { directory: legacyOverride, rule: LEGACY_EXTENSIONS_DIR_ENV };
  const root = modsStateRoot(home, env);
  const mods = join(root, "mods");
  if (exists(mods)) return { directory: mods, rule: "default" };
  const legacy = join(root, "extensions");
  if (exists(legacy)) return { directory: legacy, rule: "legacy-default" };
  return { directory: mods, rule: "default" };
}

/** `<mods>/diagnostics/latest.json`, where the runtime writes its load errors. */
export function diagnosticsFile(modsDirectory: string): string {
  return join(modsDirectory, "diagnostics", "latest.json");
}

/**
 * An agent's mods folder: `<memory root>/mods`, and only when MemFS is on for
 * that agent. The memory root is the one the runtime reports as
 * `device_status.memory_directory`.
 */
export function agentModsDirectory(memoryDirectory: string | null, memfsEnabled: boolean): string | null {
  if (!memoryDirectory || !memfsEnabled) return null;
  return join(memoryDirectory, "mods");
}
