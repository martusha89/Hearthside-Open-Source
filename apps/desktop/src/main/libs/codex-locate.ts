import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { CODEX_VERSION } from "./codex-release";
import { managedCodexBinary } from "./codex-install";

/**
 * Hearthside: finding the Codex program to run.
 *
 * Two kinds of install count, and one the person already has is always
 * preferred: Hearthside should not download a second copy of something that is
 * sitting on the computer, and it should keep working for people who installed
 * Codex themselves with npm.
 *
 *  - the person's own: npm's global folder, as Codex's own launcher lays it out;
 *  - Hearthside's: the pinned package this app downloaded for this user.
 */

export type CodexSource = "user" | "managed";
export type CodexProgram = { command: string; prefix: string[]; env: NodeJS.ProcessEnv; source: CodexSource; version: string | null };

/** Folder Hearthside keeps its own Codex installs in. Per user; never on PATH. */
export function managedCodexRoot(): string {
  return join(app.getPath("userData"), "codex");
}

/** The npm global install of @openai/codex, if there is one. */
export function codexPackageRoot(): string | null {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const candidates = [join(appData, "npm", "node_modules", "@openai", "codex"), "/usr/local/lib/node_modules/@openai/codex", "/opt/homebrew/lib/node_modules/@openai/codex"];
  return candidates.find((path) => existsSync(join(path, "bin", "codex.js"))) ?? null;
}

/**
 * The real program inside an npm install. Codex's npm launcher (codex.js)
 * starts the platform binary it keeps under node_modules/@openai/codex-*;
 * Hearthside starts that binary itself (hidden) so Windows doesn't flash a
 * console window, with the two settings the launcher would have set.
 */
function userInstall(): CodexProgram | null {
  const root = codexPackageRoot();
  if (!root) return null;
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const scoped = join(root, "node_modules", "@openai");
  try {
    for (const dir of readdirSync(scoped)) {
      if (!dir.startsWith("codex-")) continue;
      const vendor = join(scoped, dir, "vendor");
      if (!existsSync(vendor)) continue;
      for (const triple of readdirSync(vendor)) {
        const binary = join(vendor, triple, "bin", binaryName);
        if (existsSync(binary)) {
          return { command: binary, prefix: [], env: { ...process.env, CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: "1" }, source: "user", version: null };
        }
      }
    }
  } catch {
    // Fall back to the launcher below.
  }
  return { command: process.execPath, prefix: [join(root, "bin", "codex.js")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, source: "user", version: null };
}

/**
 * Hearthside's own install. The published package is self-contained — it finds
 * its resources next to the program — so it needs none of npm's settings.
 */
function managedInstall(root: string): CodexProgram | null {
  const binary = managedCodexBinary(root);
  return binary ? { command: binary, prefix: [], env: { ...process.env }, source: "managed", version: CODEX_VERSION } : null;
}

/** How to start Codex on this computer, or null when it isn't installed either way. */
export function resolveCodex(managedRoot: string = managedCodexRoot()): CodexProgram | null {
  return userInstall() ?? managedInstall(managedRoot);
}
