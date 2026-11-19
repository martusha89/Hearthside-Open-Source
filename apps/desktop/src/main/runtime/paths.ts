import { app } from "electron";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Entry point of the pinned @letta-ai/letta-code runtime. */
export function resolveLettaCli(): string {
  // Unpackaged, the app may run from out/main (e2e, electron .) where getAppPath() is not
  // the package root: try the path relative to this file first, as channel-runtimes does.
  const prepared = [join(app.getAppPath(), "build", "patched-runtime"), ...(typeof __dirname === "string" ? [join(__dirname, "..", "..", "build", "patched-runtime")] : [])];
  const entry = app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@letta-ai", "letta-code", "letta.js")
    : join(prepared.find((dir) => existsSync(join(dir, "manifest.json"))) ?? prepared[0]!, "letta.js");
  const root = dirname(entry);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, string>;
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (manifest.version !== "0.34.36" ||
      manifest.upstreamSha256 !== "d32706d8852136c8a8a30ae4b587845417fbd1bfccc2b96d73675d1f25b09acc" ||
      // These pins live in the app bundle, not beside the mutable runtime files.
      // Update only with the source transform + policy contract tests.
      manifest.artifactSha256 !== "48ecc748e4019f48b3b098905e761b010d11eeafbe0c066ebc96f8bb1d30c177" ||
      manifest.policySha256 !== "6e3ca2413eaa3d15ad97d53cc076357b51b8c78102767cf4ad6a383d8418a809" ||
      hash(entry) !== manifest.artifactSha256 ||
      hash(join(root, "hearthside-runtime-policy.mjs")) !== manifest.policySha256) {
    throw new Error("Hearthside runtime policy integrity check failed; rebuild the validated runtime artifact");
  }
  return entry;
}

/**
 * Home directory the runtime treats as `~` (it keeps agents, memory, settings,
 * mods and channels under `~/.letta`).
 *
 * By default, Hearthside uses a separate home for its runtime state rather than
 * selecting an existing Letta home. This is not OS confinement and does not
 * prevent authorized tools or helpers from accessing other paths. Set
 * HEARTHSIDE_SOURCE_USE_REAL_LETTA_HOME=1 to use the real home directory.
 */
/** Hearthside: set from settings (useRealLettaHome) at startup and when it changes. */
let useRealHome = false;
export function setUseRealLettaHome(value: boolean): void {
  useRealHome = value;
}

export function resolveRuntimeHome(): { home: string | null; sandbox: boolean } {
  if (process.env.HEARTHSIDE_SOURCE_USE_REAL_LETTA_HOME === "1" || (useRealHome && process.env.HEARTHSIDE_SOURCE_USE_REAL_LETTA_HOME !== "")) return { home: null, sandbox: false };
  return { home: join(app.getPath("userData"), "sandbox-home"), sandbox: true };
}

export function runtimeStateDir(): string {
  return join(app.getPath("userData"), "runtime");
}
