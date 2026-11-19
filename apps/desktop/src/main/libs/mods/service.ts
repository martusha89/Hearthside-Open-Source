import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModScope,
  ModScopeInfo,
  ModSourceView,
  ModsOffState,
  ModsOverview,
} from "@hearthside/ipc-contract";
import { deviceStatus, request } from "../control";
import { listMemory } from "../memory";
import { executionTarget } from "../remote-execution";
import { getConnectionConfig, getSettings, updateSettings } from "../settings";
import { externalModsDisable, modsOffSetting, runtimeChildEnv, setModsOff } from "../../runtime/child-env";
import { resolveRuntimeHome } from "../../runtime/paths";
import { LISTENER_MOD_CAPABILITIES, readAdvertisedCommands } from "./catalog";
import { MAX_SOURCE_BYTES, listModFiles, listModPackages, readModDiagnostics, readModFile } from "./inventory";
import { agentModsDirectory, machineModsDirectory } from "./paths";
import { type ImportContext, forgetModImport } from "./import";

/**
 * Settings → Mods: what the runtime will really read, what is in it, what it
 * advertises as loaded, and the one switch Hearthside owns.
 *
 * Two rules run through all of it. Resolve from the environment the runtime
 * actually gets, not from this process's own, so an inherited LETTA_MODS_DIR
 * is shown rather than hidden. And never claim something that hasn't been
 * read: a folder on another machine is reported as not inspectable, not as
 * empty.
 */

/** The environment Hearthside hands a letta-code child process. */
function runtimeEnvironment(): NodeJS.ProcessEnv {
  return runtimeChildEnv();
}

/** The home the runtime process will see: the sandbox, or the real one. */
function runtimeHome(): string {
  return resolveRuntimeHome().home ?? homedir();
}

function writable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    // A folder that doesn't exist yet is still writable if its parent is.
    try {
      accessSync(join(directory, ".."), constants.W_OK);
      return !existsSync(directory);
    } catch {
      return false;
    }
  }
}

/**
 * Whether mods are off, and whose decision that was.
 *
 * "environment" means a flag Hearthside *inherited*. It must never be read off
 * the child environment, which already carries Hearthside's own injected flag
 * when the switch is on — that would report the person's own choice back to
 * them as something they cannot change.
 */
export function modsOffState(needsRestart = false): ModsOffState {
  const variable = externalModsDisable();
  if (variable) return { active: true, reason: "environment", variable, needsRestart: false };
  const off = modsOffSetting();
  return { active: off, reason: off ? "setting" : null, variable: null, needsRestart };
}

/**
 * True when the runtime Hearthside talks to is one it started on this
 * computer, so paths it reports are paths here. With a self-hosted server they
 * belong to that machine and must not be read locally.
 */
function runtimeIsLocal(): boolean {
  return getConnectionConfig().backend !== "remote";
}

function machineScope(): ModScopeInfo {
  const { directory, rule } = machineModsDirectory(runtimeHome(), runtimeEnvironment());
  const local = runtimeIsLocal();
  if (!local) {
    return {
      scope: "machine", directory, rule, exists: false, inspectable: false, readOnly: true,
      files: [], packages: [], packagesProblem: null,
      note: "This folder is on the self-hosted server's machine, not this one, so Hearthside can't read it from here.",
    };
  }
  const exists = existsSync(directory);
  const { packages, problem } = exists ? listModPackages(directory) : { packages: [], problem: null };
  const canWrite = writable(directory);
  return {
    scope: "machine",
    directory,
    rule,
    exists,
    inspectable: true,
    readOnly: !canWrite,
    files: exists ? listModFiles(directory) : [],
    packages,
    packagesProblem: problem,
    note: canWrite ? null : "Hearthside can't write to this folder, so a mod file can't be added here.",
  };
}

async function agentScope(agentId: string): Promise<ModScopeInfo | null> {
  let status: Record<string, unknown>;
  try {
    status = await deviceStatus({ agent_id: agentId, conversation_id: "default" });
  } catch {
    return null;
  }
  const memoryDirectory = typeof status.memory_directory === "string" ? status.memory_directory : null;
  // Agent mods only load when MemFS is on for that agent; the runtime reports
  // the memory root either way, so ask whether the memory is actually live.
  const memfs = await listMemory(agentId).then((overview) => overview.enabled).catch(() => false);
  const directory = agentModsDirectory(memoryDirectory, memfs);
  if (!directory) return null;
  const base: ModScopeInfo = {
    scope: "agent", directory, rule: "agent-memory", exists: false, inspectable: false, readOnly: true,
    files: [], packages: [], packagesProblem: null, note: null,
  };
  if (!runtimeIsLocal()) {
    return { ...base, note: "These mods live on the self-hosted server's machine, so Hearthside can't list them from here." };
  }
  const exists = existsSync(directory);
  return {
    ...base,
    exists,
    inspectable: true,
    files: exists ? listModFiles(directory) : [],
    note: "Hearthside only reads this companion's mods. Adding, changing or removing them happens in its memory, not here.",
  };
}

export async function getModsOverview(agentId: string | null): Promise<ModsOverview> {
  const off = modsOffState();
  const machine = machineScope();
  const target = executionTarget();

  let advertised: ModsOverview["advertised"] = null;
  let advertisedError: string | null = null;
  if (off.active) {
    advertisedError = "Mods are turned off, so the runtime has none loaded.";
  } else if (agentId) {
    try {
      const status = await deviceStatus({ agent_id: agentId, conversation_id: "default" });
      const { mods } = readAdvertisedCommands(status);
      advertised = { commands: mods, agentId, asOf: Date.now() };
    } catch (error) {
      advertisedError = error instanceof Error ? error.message : String(error);
    }
  } else {
    advertisedError = "Open a companion to see what the runtime has loaded for it.";
  }

  return {
    off,
    machine,
    agent: agentId && !off.active ? await agentScope(agentId).catch(() => null) : null,
    diagnostics: machine.inspectable && machine.directory ? readModDiagnostics(machine.directory) : null,
    capabilities: LISTENER_MOD_CAPABILITIES,
    advertised,
    advertisedError,
    executionComputer: target?.name ?? null,
  };
}

/**
 * One mod file as text. Machine-scope files are read from disk; a companion's
 * are read through the runtime's own `read_memory_file`, which resolves inside
 * the memory root and rejects anything that escapes it. Neither path imports.
 */
export async function readModSource(input: { scope: ModScope; agentId: string | null; name: string }): Promise<ModSourceView> {
  if (input.scope === "machine") {
    const { directory } = machineModsDirectory(runtimeHome(), runtimeEnvironment());
    if (!runtimeIsLocal()) throw new Error("That folder is on the self-hosted server's machine; Hearthside can't read it from here.");
    const path = join(directory, input.name);
    const { source, bytes, truncated } = readModFile(path);
    return { scope: "machine", name: input.name, path, bytes, source, truncated };
  }
  const agentId = input.agentId;
  if (!agentId) throw new Error("Open a companion first.");
  const memoryPath = `mods/${input.name}`;
  const reply = await request<{ type: string; content?: string | null }>("read_memory_file", {
    agent_id: agentId,
    path: memoryPath,
  });
  const content = typeof reply.content === "string" ? reply.content : "";
  const truncated = content.length > MAX_SOURCE_BYTES;
  return {
    scope: "agent",
    name: input.name,
    path: memoryPath,
    bytes: Buffer.byteLength(content, "utf8"),
    source: truncated ? content.slice(0, MAX_SOURCE_BYTES) : content,
    truncated,
  };
}

/**
 * Where a newly added mod file goes, and what makes that destination the one
 * it is. The identity covers everything that could move the folder — the
 * connection and account, whether Hearthside is on the real Letta folder, the
 * resolved home, and any directory override in the runtime's environment — so
 * a preview taken before one of those changed cannot be confirmed afterwards.
 */
export function importContext(): ImportContext {
  if (!runtimeIsLocal()) throw new Error("Mod files can only be added to a runtime on this computer.");
  const home = runtimeHome();
  const env = runtimeEnvironment();
  const { directory, rule } = machineModsDirectory(home, env);
  const settings = getSettings();
  return {
    directory,
    identity: JSON.stringify([
      settings.backend,
      settings.serverUrl,
      settings.apiBaseUrl,
      // Changes on every sign-in, account switch and real-home change.
      settings.connectionRevision,
      settings.useRealLettaHome,
      resolveRuntimeHome().sandbox,
      home,
      rule,
      directory,
    ]),
  };
}

/**
 * Turn mods off (or on) for every runtime Hearthside starts. Takes effect when
 * the runtime restarts, which is why this reconnects; `/reload` cannot do it.
 */
export function setModsOffSetting(off: boolean): ModsOffState {
  const variable = externalModsDisable();
  const before = modsOffSetting();
  updateSettings({ modsOff: off });
  setModsOff(off);
  forgetModImport();
  if (variable) {
    // Saved anyway, so it applies if the variable goes away, but it changes
    // nothing now and the screen must not pretend otherwise.
    return { active: true, reason: "environment", variable, needsRestart: false };
  }
  // A restart is needed whichever way it changed: the gate is in the child's
  // environment, so turning mods back on needs a new runtime just as much as
  // turning them off does.
  return { active: off, reason: off ? "setting" : null, variable: null, needsRestart: before !== off };
}

/** Apply the saved switch at startup, before the runtime is started. */
export function applyModsSetting(): void {
  setModsOff(getSettings().modsOff);
}
