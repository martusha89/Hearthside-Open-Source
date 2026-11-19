import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

/**
 * A plain-text log in <userData>/logs/hearthside.log, so problems can be
 * diagnosed after the fact (the dev terminal's output is gone once closed).
 * Main-process console output, the runtime's output and crashes go here.
 * Rotates at 2 MB, keeping one previous file. Never log secrets.
 */

const MAX_BYTES = 2 * 1024 * 1024;
let logPath: string | null = null;

export function logFilePath(): string {
  logPath ??= join(app.getPath("userData"), "logs", "hearthside.log");
  return logPath;
}

function rotateIfNeeded(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best effort.
  }
}

export function writeLog(level: "info" | "warn" | "error", message: string): void {
  try {
    const path = logFilePath();
    mkdirSync(join(path, ".."), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  } catch {
    // Logging must never break the app.
  }
}

/** Mirror console output and crashes into the log file. Call once at startup. */
export function installLogFile(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      writeLog(level === "log" ? "info" : level, format(...args));
    };
  }
  process.on("uncaughtException", (error) => writeLog("error", `Uncaught exception: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (reason) => writeLog("error", `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
  app.on("render-process-gone", (_event, _contents, details) => writeLog("error", `Window crashed: ${details.reason} (exit ${details.exitCode})`));
  app.on("child-process-gone", (_event, details) => writeLog("error", `Child process gone: ${details.type} ${details.reason}`));
  writeLog("info", `Hearthside ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform})`);
}
