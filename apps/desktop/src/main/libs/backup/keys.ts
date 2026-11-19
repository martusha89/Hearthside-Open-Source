import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import { protectedStorageMessage, protectedStorageProblem } from "../protected-storage";

/**
 * Hearthside backups: the data key of each backup store this computer knows,
 * kept in userData encrypted with the OS keychain (safeStorage), so daily
 * backups and same-machine restores need no recovery code. The recovery code
 * (shown once when the folder is set up) opens the store on another computer.
 */

type Keyring = Record<string, string>;



export class BackupKeyStorageError extends Error {}

function path(): string {
  return join(app.getPath("userData"), "backup-keys.json");
}

/**
 * The keyring as it is on disk. `problem` set means the file is there but this
 * process cannot make sense of it (truncated, wrong shape, unreadable) — which is
 * not the same as there being no keys, and must never be reported as absence:
 * writing a fresh keyring over it would destroy every other folder's key.
 */
type RingState = { ring: Keyring; problem: null } | { ring: null; problem: string };

/** Keys are opaque strings here (`enc:` / legacy `plain:`); anything else is corruption. */
function asKeyring(parsed: unknown): Keyring | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== "string")) return null;
  return Object.fromEntries(entries) as Keyring;
}

function readRing(): RingState {
  let text: string;
  try {
    text = readFileSync(path(), "utf8");
  } catch (error) {
    // No file is the ordinary first run. Anything else (EACCES, EIO, a directory
    // in its place) is a read we cannot conclude anything from.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ring: {}, problem: null };
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return { ring: null, problem: `this computer's list of backup keys could not be read (${code})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ring: null, problem: "this computer's list of backup keys is damaged" };
  }
  const ring = asKeyring(parsed);
  return ring ? { ring, problem: null } : { ring: null, problem: "this computer's list of backup keys is not in the expected form" };
}

/**
 * Why the keyring cannot be used, or null when it can. Exported so callers can say
 * "we can't tell" instead of "there is no key".
 */
export function backupKeyringProblem(): string | null {
  return readRing().problem;
}

/**
 * Keep the whole keyring or none of it: a half-written file loses other folders'
 * keys. The replacement is written to a temp file, flushed, then renamed over the
 * old one; a failure anywhere leaves the previous file exactly as it was and takes
 * the temp file with it.
 */
function writeRing(ring: Keyring): void {
  const target = path();
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(handle, JSON.stringify(ring, null, 2));
      // Without this a crash can leave a renamed but empty file: every key lost,
      // which is worse than the write having failed outright.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new BackupKeyStorageError("This computer couldn't save its list of backup keys, so nothing was changed. Check free space and permissions in Hearthside's app data folder.", { cause: error });
  }
  syncDirectory(dirname(target));
}

/** Make the rename itself durable. Not supported everywhere (Windows); harmless there. */
function syncDirectory(directory: string): void {
  try {
    const handle = openSync(directory, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // Directory fsync is a best effort: the file contents are already flushed.
  }
}

/**
 * Keep a store's data key for this computer. Throws `BackupKeyStorageError`
 * when the OS keychain cannot protect it; nothing is written in that case, so
 * the caller can leave the folder alone (see `BackupStore.create`).
 */
export function rememberBackupKey(storeId: string, key: Buffer): void {
  const problem = protectedStorageProblem();
  if (problem) throw new BackupKeyStorageError(protectedStorageMessage(problem, "this backup's key"));
  // Read before encrypting: there is no point sealing a key we are not allowed to store.
  const existing = readRing();
  if (existing.ring === null) {
    throw new BackupKeyStorageError(`Hearthside didn't save this backup's key, because ${existing.problem}. Saving a new one would have thrown away the keys for every other backup folder on this computer. Nothing was changed.`);
  }
  let sealed: string;
  try {
    sealed = `enc:${safeStorage.encryptString(key.toString("base64")).toString("base64")}`;
  } catch {
    throw new BackupKeyStorageError("This computer's protected storage refused to keep this backup's key. Nothing was saved in the clear.");
  }
  writeRing({ ...existing.ring, [storeId]: sealed });
}

export function backupKeyFor(storeId: string): Buffer | null {
  const stored = readRing().ring?.[storeId];
  if (typeof stored !== "string" || !stored) return null;
  try {
    if (stored.startsWith("enc:")) return Buffer.from(safeStorage.decryptString(Buffer.from(stored.slice(4), "base64")), "base64");
    // Legacy: keys written before plaintext fallback was removed stay readable, so
    // existing backups keep opening. They are never rewritten here; migration is a
    // deliberate step, not a silent one.
    if (stored.startsWith("plain:")) return Buffer.from(stored.slice(6), "base64");
  } catch {
    // The keychain changed (another Windows account); the recovery code is the way back in.
  }
  return null;
}

/**
 * A key for this store is kept here but cannot be opened — a different thing
 * from never having had one, and the person needs to be told which it is.
 */
export function backupKeyUnreadable(storeId: string): boolean {
  const state = readRing();
  // An unusable keyring may well hold this store's key; either way we cannot open
  // it, and "unlock with the recovery code" is the right thing to say.
  if (state.ring === null) return true;
  const stored = state.ring[storeId];
  return typeof stored === "string" && stored.length > 0 && backupKeyFor(storeId) === null;
}

export function storeIdAt(folder: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(folder, "hearthside-backup.json"), "utf8")) as { storeId?: string }).storeId ?? null;
  } catch {
    return null;
  }
}

export function isBackupFolder(folder: string): boolean {
  return existsSync(join(folder, "hearthside-backup.json"));
}
