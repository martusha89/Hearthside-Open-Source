import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Hearthside: clear a stale schedule claim before starting the runtime.
 *
 * The runtime records which process runs schedules ("scheduler_owner" in
 * ~/.letta/crons.json) and treats it as alive while that process id exists. On
 * Windows it can't record the process start time, so when the old runtime has
 * exited and Windows reuses its id for any other process, the new runtime thinks
 * someone else owns schedules, retries three times and gives up: no schedule
 * ever fires. Before launching, Hearthside drops claims whose process is gone or
 * isn't a Letta runtime; a real Letta runtime (e.g. Letta Code in a terminal)
 * keeps its claim.
 */

type Owner = { pid?: number } | null | undefined;
type Crons = { scheduler_owner?: Owner; scheduler_owners?: Record<string, Owner> } & Record<string, unknown>;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process's command line, or null if it can't be read. */
function commandLine(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf8", timeout: 8_000, windowsHide: true },
      ).trim();
    }
    if (existsSync(`/proc/${pid}/cmdline`)) return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

/** Is this claim held by a live Letta runtime? Unknown counts as yes (don't steal a real lease). */
export function ownerIsLive(owner: Owner, inspect: (pid: number) => { alive: boolean; command: string | null } = (pid) => ({ alive: alive(pid), command: alive(pid) ? commandLine(pid) : null })): boolean {
  const pid = owner?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const { alive: running, command } = inspect(pid);
  if (!running) return false;
  if (command === null) return true;
  // Match a Letta executable/script as a command token, not an incidental
  // directory such as Hearthside's own `.letta/worktrees/...` path.
  return /(?:^|[\\/\s"'=])letta(?:\.js|\.cmd|\.exe)?(?:[\s"']|$)|@letta-ai[\\/]letta-code/i.test(command);
}

/** Remove stale claims from crons.json in this home. Returns true if anything changed. */
export function clearStaleSchedulerLease(home: string, inspect?: (pid: number) => { alive: boolean; command: string | null }): boolean {
  const path = join(home, ".letta", "crons.json");
  if (!existsSync(path)) return false;
  let data: Crons;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Crons;
  } catch {
    return false;
  }
  // Inspection can take seconds on Windows. Never hold the runtime's write lock
  // while doing it; remember the full claim, not just a potentially reused PID.
  const staleOwner = data.scheduler_owner && !ownerIsLive(data.scheduler_owner, inspect) ? data.scheduler_owner : null;
  const staleScoped = Object.entries(data.scheduler_owners ?? {}).filter(([, owner]) => owner && !ownerIsLive(owner, inspect));
  if (!staleOwner && staleScoped.length === 0) return false;

  // Letta Code v0.34.36 src/cron/cron-file.ts: exclusive mkdir crons.lock,
  // owner.json {pid, token, acquired_at}, token-checked release. Identity fields
  // are optional. We deliberately never steal or wait for an existing lock:
  // startup cleanup is best effort and must not interfere with runtime writers.
  const lock = join(home, ".letta", "crons.lock");
  const token = randomBytes(16).toString("hex");
  try {
    mkdirSync(lock);
  } catch {
    return false;
  }
  const temp = `${path}.hearthside-${token}.tmp`;
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token, acquired_at: Date.now() }));
    // All writers following the runtime protocol are now excluded. Re-read so
    // task insertions/edits and replacement claims survive the earlier inspection.
    const current = JSON.parse(readFileSync(path, "utf8")) as Crons;
    let changed = false;
    if (staleOwner && isDeepStrictEqual(current.scheduler_owner, staleOwner)) {
      current.scheduler_owner = null;
      changed = true;
    }
    for (const [scope, owner] of staleScoped) {
      if (isDeepStrictEqual(current.scheduler_owners?.[scope], owner)) {
        delete current.scheduler_owners![scope];
        changed = true;
      }
    }
    if (!changed) return false;
    writeFileSync(temp, JSON.stringify(current, null, 2), { flush: true });
    renameSync(temp, path);
    return true;
  } catch {
    // Missing/malformed data or failed I/O: leave the persisted claims alone.
    return false;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best effort cleanup after an unsuccessful atomic replacement.
    }
    try {
      const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      if (owner.token === token) rmSync(lock, { recursive: true, force: true });
    } catch {
      // Do not remove a lock whose ownership we cannot prove.
    }
  }
}
