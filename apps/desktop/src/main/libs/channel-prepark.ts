import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeHome } from "../runtime/paths";
import { channelBot, connectionKey, setChannelBot } from "./settings";




const CHANNELS = ["telegram", "discord"];
type Account = Record<string, unknown>;

/** Hearthside's own channels folder, or null when the runtime uses the shared ~/.letta. */
export function ownedChannelsRoot(): string | null {
  const { home, sandbox } = resolveRuntimeHome();
  return sandbox && home ? join(home, ".letta", "channels") : null;
}

const accountIdOf = (account: Account) => String(account.account_id ?? account.accountId ?? "");

/** A lock older than this with no live owner was left behind by a crash, not held. */
const STALE_LOCK_MS = 60_000;

/** Whether the process that took a lock is still there. No readable owner counts as gone. */
function lockOwnerAlive(lock: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    if (owner.pid === process.pid) return true;
    process.kill(owner.pid, 0); // Existence check only; throws when the process is gone.
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM"; // Alive, but not ours to signal.
  }
}

/**
 * Take the accounts file's write lock, the same way the runtime's own account
 * writer does (scripts/runtime-policy.mjs, `locked`): the lock is a directory,
 * and whoever holds it writes its process id inside.
 *
 * A lock someone holds blocks start-up, as before. But the channel service can
 * be killed mid-save — a forced stop on Windows, a power cut — and the lock it
 * held then stays behind for ever. The runtime's writer clears such a leftover
 * itself, yet it never got the chance: this check runs first, failed on the
 * leftover, and the service never started again, with nothing on screen able
 * to clear it. So the same rule is applied here: a lock is only a leftover when
 * its owner is gone AND it is old enough not to be a write in progress. It is
 * claimed by renaming it, so a lock someone retook in the meantime is left
 * alone.
 */
function takeAccountsLock(lock: string, channel: string): void {
  const busy = () => new Error(`Cannot lock ${channel} accounts before gateway startup`);
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw busy();
    let age = 0;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = 0; }
    if (lockOwnerAlive(lock) || age < STALE_LOCK_MS) throw busy();
    const claimed = `${lock}.stale.${randomUUID()}`;
    try { renameSync(lock, claimed); } catch { throw busy(); }
    rmSync(claimed, { recursive: true, force: true });
    try { mkdirSync(lock); } catch { throw busy(); }
    console.warn(`[channels:accounts] cleared a ${channel} accounts lock left behind by a process that is no longer running`);
  }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    rmSync(lock, { recursive: true, force: true });
    throw busy();
  }
}

/** Switch off, in the accounts files, bots that aren't known to belong to this connection. Returns their ids. */
export function parkForeignBotsBeforeStart(root: string | null = ownedChannelsRoot(), current = connectionKey()): string[] {
  const parked: string[] = [];
  if (!root) return parked;
  for (const channel of CHANNELS) {
    const path = join(root, channel, "accounts.json");
    if (!existsSync(path)) continue;
    // Same exclusive directory protocol as the packaged account writer. A lock
    // someone holds blocks startup; only a crash's leftover is cleared.
    const lock = `${path}.hearthside-write-lock`;
    takeAccountsLock(lock, channel);
    try {
      let file: { accounts?: Account[] } & Record<string, unknown>;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as typeof file;
      } catch {
        // A partial/corrupt account file is not evidence that no foreign bot exists.
        // Do not include parse errors: they can contain account tokens.
        throw new Error(`Cannot verify ${channel} accounts before gateway startup`);
      }
      if (!file || !Array.isArray(file.accounts) || file.accounts.some((account) => !account || typeof account !== "object" || Array.isArray(account))) {
        throw new Error(`Cannot verify ${channel} accounts before gateway startup`);
      }
      let changed = 0;
      for (const account of file.accounts) {
        const id = accountIdOf(account);
        if (!id || account.enabled !== true) continue;
        const record = channelBot(id);
        // Only a bot known to belong to a companion on THIS connection may stay on,
        // and only if it isn't part-way through a move to another companion. An
        // unclaimed bot is held too: nothing answers for a companion nobody named.
        if (record?.connection === current && record.agentId && !record.transfer) continue;
        account.enabled = false;
        changed += 1;
        parked.push(id);
        // Claimed on another connection: still wanted, so it runs again once
        // Hearthside is back there. Anything else — unclaimed, or a move that
        // didn't finish — stays off AND unwanted, so only a person starts it again.
        const wantedElsewhere = record !== null && Boolean(record.agentId) && !record.transfer && record.connection !== current;
        setChannelBot(id, record ? { ...record, wanted: wantedElsewhere } : { connection: null, owner: "hearthside", wanted: false });
      }
      if (changed) {
        const temp = `${path}.hearthside-${process.pid}-${randomUUID()}.tmp`;
        try {
          writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx", flush: true });
          renameSync(temp, path);
        } finally { rmSync(temp, { force: true }); }
        console.log(`[channels:accounts] ${JSON.stringify({ pid: process.pid, reason: "park-before-start", channel, changed, before: { enabled: true }, after: { enabled: false } })}`);
      }
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  return parked;
}
