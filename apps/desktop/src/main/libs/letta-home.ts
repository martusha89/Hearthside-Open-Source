import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Hearthside: before running on someone's own ~/.letta (Letta Code's folder),
 * copy it to ~/.letta-backups/hearthside-<date>, so nothing can be lost.
 * Only Letta's own throwaway folders are left out: its caches, logs and
 * temporary files directly inside ~/.letta, and downloaded packages
 * (node_modules) wherever they are. A folder a companion happens to call
 * "logs" or "cache" inside its memory is its own writing and is copied.
 */
const SKIP_AT_TOP = new Set(["cache", ".cache", "logs", "tmp"]);

export function keptInBackup(source: string, path: string): boolean {
  const name = basename(path);
  if (name === "node_modules") return false;
  return !(SKIP_AT_TOP.has(name) && resolve(dirname(path)) === resolve(source));
}

/**
 * Copies without blocking the app (a large home took the whole window with
 * it). A copy that stops part-way, for example at a file another program has
 * locked, is removed and reported: a partial folder would look like a backup.
 */
export async function backupLettaHome(home: string = homedir(), now: Date = new Date()): Promise<string | null> {
  const source = join(home, ".letta");
  if (!existsSync(source)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = join(home, ".letta-backups", `hearthside-${stamp}`);
  await mkdir(target, { recursive: true });
  try {
    await cp(source, target, { recursive: true, filter: (path) => keptInBackup(source, path) });
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`Hearthside could not make a safety copy of your Letta folder, so nothing was switched. Close other programs that use it and try again. (${detail})`, { cause: error });
  }
  return target;
}
