import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/** Flush directory entries where Node supports directory handles. Callers always
 * fsync the file before rename. Windows supports that process-restart boundary,
 * but Node cannot provide POSIX directory-fsync power-loss guarantees there. */
export function syncRecoveryDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}



export function writeDurable(path: string, bytes: Buffer | string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeSync(fd, typeof bytes === "string" ? Buffer.from(bytes) : bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  syncRecoveryDirectory(directory);
}
