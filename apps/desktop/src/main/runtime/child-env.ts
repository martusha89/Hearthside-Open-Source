import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { resolveRuntimeHome } from "./paths";
import { DISABLE_MODS_ENV, modsDisabledByEnvironment } from "../libs/mods/paths";

/**
 * Environment for any letta-code process Hearthside starts (the app server,
 * provider sign-in). Uses Electron's own binary as Node and, unless the user
 * opted into their real ~/.letta, an isolated sandbox home, so every process
 * shares the same agents, providers and settings.
 */


const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

export function withoutGitRedirects(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(out)) if (GIT_REDIRECTS.includes(name.toUpperCase())) delete out[name];
  return out;
}

/**
 * The launch hooks: variables that decide what code or which libraries a
 * process loads before reaching its own entry point. Node's `--require` and
 * `--import` hooks, the glibc/musl and dyld loader paths, and Electron's own
 * "run this instead" switches. Hearthside starts the runtime with Electron's
 * binary as Node, and the runtime then starts the agent's shell, so each one is
 * inherited twice over: a value left in the environment Hearthside was launched
 * from loads into the process that holds the person's keys and memory.
 *
 * This is a deliberate restriction, not a free cleanup. Several of these have
 * ordinary uses and are dropped anyway:
 *
 *  - NODE_OPTIONS carries real settings people rely on (`--max-old-space-size`,
 *    `--use-openssl-ca`, inspector flags). It is dropped whole rather than
 *    filtered, because deciding which flags in a string are safe is a second
 *    place to get the dangerous ones wrong, and the settings Hearthside needs
 *    it can set itself.
 *  - LD_LIBRARY_PATH and DYLD_LIBRARY_PATH / DYLD_FRAMEWORK_PATH are the normal
 *    way to point a tool at shared libraries it was built against, which is
 *    common on Linux and for anything compiled locally.
 *  - NODE_V8_COVERAGE is how a person profiling Node asks for coverage output.
 *
 * The tradeoff, stated plainly: a tool the agent's shell runs may find a
 * library or a Node setting in the person's own terminal that it does not find
 * under Hearthside, and the fix is for Hearthside to pass what that tool needs
 * explicitly, not to inherit these again. That is accepted because the value
 * alone cannot tell a person's library path from an attacker's, and the cost of
 * being wrong is asymmetric: a missing library is a visible error in a tool,
 * while a preloaded object is code running beside the keys with nothing to see.
 *
 * ELECTRON_RUN_AS_NODE is the exception that costs nothing — runtimeChildEnv
 * sets it to "1" immediately afterwards, so removing it here only stops an
 * inherited "0" from turning the runtime back into a window.
 */
const LAUNCH_HOOKS = [
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_V8_COVERAGE",
  // POSIX / glibc and musl dynamic loader hooks.
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  // macOS dyld equivalents.
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Electron's own "run this instead" hooks; Hearthside sets the one it wants.
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_EXTRA_LAUNCH_ARGS",
];

/**
 * Hearthside: drop the inherited launch hooks listed above, whatever they were
 * set for. Names are matched case-insensitively because Windows environments
 * are.
 */
export function withoutInjectedCode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(out)) if (LAUNCH_HOOKS.includes(name.toUpperCase())) delete out[name];
  return out;
}

/**
 * Hearthside decides where the runtime keeps its state. letta-code 0.34.36 reads
 * two overrides that would move it elsewhere: LETTA_CONFIG_DIR replaces `<home>/.letta`
 * (settings, agents, mods, channels) and LETTA_SECRETS_SERVICE_NAME renames the keyring
 * service its credentials are stored under. Either one inherited from the environment
 * Hearthside was launched from would put settings, mods and credentials outside the
 * home the app shows, backs up and mirrors (mods/paths.ts), silently. They are dropped
 * whether the runtime home is the sandbox or the real one; a person who set them for
 * the Letta CLI keeps them there. The source edition selects its own keyring service.
 */
const STATE_REDIRECTS = ["LETTA_CONFIG_DIR", "LETTA_SECRETS_SERVICE_NAME"];
export function withoutStateRedirects(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(out)) if (STATE_REDIRECTS.includes(name.toUpperCase())) delete out[name];
  return out;
}

/**
 * Hearthside: "turn mods off". The runtime checks LETTA_DISABLE_MODS (and the
 * legacy LETTA_DISABLE_EXTENSIONS) inside createModAdapter, before importing
 * any mod file, so setting it in the child's environment is the one verified
 * way to keep mods from loading at all — including an agent's own mods, which
 * the listener otherwise syncs and activates without asking the desktop.
 *
 * It only applies when the runtime starts; "/reload" cannot turn a disabled
 * adapter back on. And a flag already set outside Hearthside wins: it is never
 * overwritten, so someone who turned mods off in their environment keeps them
 * off whatever this switch says.
 */
let modsOff = false;
export function setModsOff(value: boolean): void {
  modsOff = value;
}
export function modsOffSetting(): boolean {
  return modsOff;
}

/**
 * The disable flag Hearthside *inherited*, captured once at load.
 *
 * It has to be read from the environment as it was before Hearthside put
 * anything in it. Asking the child environment instead would find Hearthside's
 * own injected flag and report the person's switch as an external override —
 * which then reads as "you can't change this" and blocks turning mods back on.
 */
const inheritedModsDisable = modsDisabledByEnvironment(process.env);
export function externalModsDisable(): string | null {
  return overriddenInherited === undefined ? inheritedModsDisable : overriddenInherited;
}

export function modsDisableEnv(env: NodeJS.ProcessEnv, off = modsOff): Record<string, string> {
  // An inherited flag is left exactly as it is, never rewritten.
  if (modsDisabledByEnvironment(env)) return {};
  return off ? { [DISABLE_MODS_ENV]: "1" } : {};
}

/** Tests only: pretend Hearthside was started with (or without) an inherited flag. */
export function __setInheritedModsDisable(variable: string | null): () => void {
  const previous = overriddenInherited;
  overriddenInherited = variable;
  return () => {
    overriddenInherited = previous;
  };
}
let overriddenInherited: string | null | undefined;

/**
 * The runtime child still inherits the rest of Hearthside's environment, on
 * purpose: the agent's shell is meant to find the person's own PATH, proxy,
 * locale and signed-in tools (see realHomeHints). What it no longer inherits is
 * the two sets above: the git location variables, and the launch hooks that
 * decide what gets loaded before a process starts — dropped even where they had
 * a legitimate use, for the reasons set out on LAUNCH_HOOKS. Narrowing the
 * remainder to an allowlist is a separate, larger change: it would need every
 * variable the agent's shell legitimately uses enumerated per platform first.
 */
export function runtimeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...withoutStateRedirects(withoutInjectedCode(withoutGitRedirects(process.env))), ...extra, LETTA_SECRETS_SERVICE_NAME: "org.hearthside.sourceedition.runtime", ELECTRON_RUN_AS_NODE: "1" };
  Object.assign(env, modsDisableEnv(env));
  // Hearthside: Diagnostics → "Detailed runtime log": the runtime's own debug lines go to a file next to Hearthside's log.
  if (runtimeDebugLogPath) {
    env.LETTA_DEBUG = "1";
    env.LETTA_DEBUG_TIMINGS = "1";
    env.LETTA_DEBUG_FILE = runtimeDebugLogPath;
  }
  const { home } = resolveRuntimeHome();
  if (home) {
    mkdirSync(home, { recursive: true });
    Object.assign(env, realHomeHints(homedir(), env));
    env.HOME = home;
    env.USERPROFILE = home;
    const noHooks = join(home, "git-no-hooks");
    const hooks = gitHooksHint(env, noHooks);
    if (Object.keys(hooks).length > 0) {
      mkdirSync(noHooks, { recursive: true });
      Object.assign(env, hooks);
      if (!warnedAboutHooks) {
        warnedAboutHooks = true;
        console.warn("[git] no bash found for git hooks; the runtime's memory hooks are turned off (install Git for Windows to have them)");
      }
    }
  }
  return env;
}

let warnedAboutHooks = false;



export function gitHooksHint(env: NodeJS.ProcessEnv, noHooksDir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32" || hasUsableBash(env)) return {};
  const count = env.GIT_CONFIG_COUNT && /^\d+$/.test(env.GIT_CONFIG_COUNT) ? Number(env.GIT_CONFIG_COUNT) : 0;
  return { [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath", [`GIT_CONFIG_VALUE_${count}`]: noHooksDir, GIT_CONFIG_COUNT: String(count + 1) };
}

function hasUsableBash(env: NodeJS.ProcessEnv): boolean {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  for (const entry of (env[pathKey] ?? "").split(delimiter).filter(Boolean)) {
    // Git for Windows: git.exe under cmd\, bin\ or mingw64\bin\, and bash under usr\bin.
    if (existsSync(join(entry, "git.exe"))) {
      for (const root of [dirname(entry), dirname(dirname(entry))]) {
        if (existsSync(join(root, "usr", "bin", "bash.exe"))) return true;
      }
    }
    // A real bash on PATH; not Windows' store alias or the WSL launcher, which can't run from here.
    if (!/WindowsApps|System32$/i.test(entry) && existsSync(join(entry, "bash.exe"))) return true;
  }
  return false;
}



/** Set by the main process from the "Detailed runtime log" setting; null when off. */
let runtimeDebugLogPath: string | null = null;
export function setRuntimeDebugLog(path: string | null): void {
  runtimeDebugLogPath = path;
}

export function realHomeHints(realHome: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hints: NodeJS.ProcessEnv = { HEARTHSIDE_SOURCE_USER_HOME: realHome };
  const codex = join(realHome, ".codex");
  if (!env.CODEX_HOME && existsSync(codex)) hints.CODEX_HOME = codex;
  const grok = join(realHome, ".grok");
  if (!env.GROK_HOME && existsSync(grok)) hints.GROK_HOME = grok;
  const gitConfig = join(realHome, ".gitconfig");
  if (!env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) hints.GIT_CONFIG_GLOBAL = gitConfig;
  // Grok's installer puts it here without adding it to PATH.
  const grokBin = join(grok, "bin");
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const path = env[pathKey] ?? "";
  if (existsSync(grokBin) && !path.split(delimiter).includes(grokBin)) hints[pathKey] = path ? `${path}${delimiter}${grokBin}` : grokBin;
  return hints;
}
