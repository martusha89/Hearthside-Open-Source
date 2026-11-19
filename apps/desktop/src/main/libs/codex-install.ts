import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CODEX_PACKAGE_SHA256, CODEX_VERSION, type CodexTriple, codexEntryPoint, codexPackageName, codexPackageUrl, codexTriple, isOfficialDownloadUrl } from "./codex-release";

/**
 * Hearthside: fetching the official Codex package for the person who asked, so
 * "Set up image generation" is a button rather than a terminal session.
 *
 * What this deliberately does not do:
 *
 *  - install anything globally, change PATH, or ask for administrator rights:
 *    the package goes under this user's Hearthside folder and is started by
 *    its full path, as Hearthside already starts the Codex it finds;
 *  - need Node or npm: OpenAI publishes a self-contained package per platform,
 *    so there is nothing to build and no package manager involved;
 *  - pipe a script into a shell: the download is one file, checked against a
 *    checksum that shipped inside Hearthside, and unpacked by the operating
 *    system's own tar;
 *  - touch the person's Codex sign-in or configuration (~/.codex). Installing
 *    and signing in are separate steps, and this one only writes its own folder.
 */

/** Parts that reach outside the process, so a test can run the whole install without either. */
export type InstallDeps = {
  fetch: typeof fetch;
  /** Unpack `archive` into the existing, empty `dest`. */
  extract: (archive: string, dest: string, signal: AbortSignal) => Promise<void>;
  /** Entry names inside `archive`, for checking before anything is written. */
  list: (archive: string, signal: AbortSignal) => Promise<string[]>;
};

export class CodexInstallError extends Error {}

/**
 * tar, as the operating system ships it. Taken from System32 by its full path
 * on Windows rather than from PATH, so the program that unpacks a download
 * can't be something else that happens to be called tar. Windows has included
 * it since Windows 10 1803; older versions have no tar, which is reported as
 * itself instead of failing part-way through an install.
 */
function systemTar(): string {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const bundled = join(root, "System32", "tar.exe");
  return existsSync(bundled) ? bundled : "tar";
}

function runTar(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemTar(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-2_000)));
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new CodexInstallError(
          error.name === "AbortError"
            ? "Setup was cancelled."
            : error.code === "ENOENT"
              ? "This version of Windows doesn't include the tar program Hearthside needs to unpack the download. Update Windows, or install Codex yourself and Hearthside will use it."
              : `The download couldn't be unpacked: ${error.message}`,
        ),
      ),
    );
    child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new CodexInstallError(`The download couldn't be unpacked. ${err.trim().split("\n").slice(-2).join(" ")}`.trim()))));
  });
}

/**
 * Entry names that must not be unpacked: anything that would land outside the
 * folder being written to. The system tar already refuses most of these; it is
 * checked first anyway, because the cost of being wrong is a file written
 * somewhere else on the person's computer.
 */
export function unsafeEntries(entries: readonly string[]): string[] {
  return entries.filter((raw) => {
    const entry = raw.trim();
    if (!entry) return false;
    if (entry.startsWith("/") || entry.startsWith("\\") || isAbsolute(entry)) return true;
    if (/^[a-zA-Z]:/.test(entry)) return true; // A Windows drive letter.
    const parts = normalize(entry).split(/[\\/]/);
    return parts.includes("..");
  });
}

const defaultDeps: InstallDeps = {
  fetch: (...args) => fetch(...args),
  list: async (archive, signal) => (await runTar(["-tzf", archive], signal)).split(/\r?\n/).filter((line) => line.trim() !== ""),
  extract: async (archive, dest, signal) => {
    await runTar(["-xzf", archive, "-C", dest], signal);
  },
};

/**
 * Delete a leftover, whatever it turned out to be, without ever throwing:
 * clearing up must not replace the error that explains what actually failed.
 */
function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Nothing more can be done here, and the real failure matters more.
  }
}

/** Where a finished install lives: one folder per version and platform, so an old one is never half-replaced. */
export function codexInstallDir(root: string, triple: CodexTriple): string {
  return join(root, `${CODEX_VERSION}-${triple}`);
}

/** The program inside an app-managed install, if that install is complete. */
export function managedCodexBinary(root: string, triple: CodexTriple | null = codexTriple()): string | null {
  if (!triple) return null;
  const binary = join(codexInstallDir(root, triple), ...codexEntryPoint(triple).split("/"));
  return existsSync(binary) ? binary : null;
}

/** The package is ~150 MB; well past this and something is wrong, so stop writing. */
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
/** GitHub sends release downloads on to its storage; a handful of hops is plenty. */
const MAX_REDIRECTS = 5;

/**
 * Ask for the package, following redirects by hand so that **every** address
 * is checked against the official hosts *before* it is requested. Letting
 * fetch follow them and checking afterwards would mean the request — headers
 * and all — had already reached whatever host the redirect named.
 */
async function requestOfficial(url: string, deps: InstallDeps, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isOfficialDownloadUrl(current)) {
      throw new CodexInstallError(
        hop === 0 ? "Hearthside only downloads Codex from its official release page." : "The download was redirected somewhere unofficial, so it was stopped before anything was requested.",
      );
    }
    const response = await deps.fetch(current, { redirect: "manual", signal, headers: { Accept: "application/octet-stream" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new CodexInstallError("The release page redirected the download without saying where, so it was stopped.");
      // Relative redirects are resolved against the hop they came from.
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new CodexInstallError("The download was redirected too many times, so it was stopped.");
}

/** A friendly reason for the ways writing a 150 MB file goes wrong. */
function writeFailure(error: unknown): CodexInstallError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC") return new CodexInstallError("There isn't enough space on this computer to download Codex. Free some up and try again.");
  if (code === "EACCES" || code === "EPERM") return new CodexInstallError("Hearthside isn't allowed to write to its own folder on this computer, so Codex couldn't be downloaded.");
  if (error instanceof CodexInstallError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message) || (error as Error | null)?.name === "AbortError") return new CodexInstallError("Setup was cancelled.");
  return new CodexInstallError(`The download couldn't be saved: ${message}`);
}

async function download(url: string, target: string, deps: InstallDeps, signal: AbortSignal, onProgress: (fraction: number | null) => void): Promise<string> {
  const response = await requestOfficial(url, deps, signal);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new CodexInstallError(`Codex couldn't be downloaded (the release page answered ${response.status}). Check your internet connection and try again.`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  let written = 0;
  // Hashed as it passes through, so the file is never read a second time and a
  // file changed on disk afterwards can't be what was checked.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > MAX_DOWNLOAD_BYTES) {
        callback(new CodexInstallError("The download was far larger than a Codex package should be, so it was stopped."));
        return;
      }
      hash.update(chunk);
      onProgress(total > 0 ? Math.min(written / total, 1) : null);
      callback(null, chunk);
    },
  });
  try {
    // pipeline carries an error from any stage — a full disk, a folder that
    // can't be written to, a dropped connection — out to the caller, and
    // destroys every stream on the way out, including on cancellation.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(target), { signal });
  } catch (error) {
    throw writeFailure(error);
  }
  return hash.digest("hex");
}

/**
 * Put the pinned Codex package in place for this user, and return the program's
 * path. An install that is already there is reused rather than downloaded again.
 */
export async function installCodex(options: {
  /** Folder Hearthside keeps its Codex installs in (under this user's app data). */
  root: string;
  triple?: CodexTriple | null;
  signal: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  deps?: Partial<InstallDeps>;
}): Promise<string> {
  const deps = { ...defaultDeps, ...options.deps };
  const onProgress = options.onProgress ?? (() => {});
  const triple = options.triple === undefined ? codexTriple() : options.triple;
  if (!triple) {
    throw new CodexInstallError(
      `OpenAI doesn't publish Codex for this kind of computer (${process.platform} ${process.arch}), so Hearthside can't set it up here. Grok can still make images.`,
    );
  }

  const existing = managedCodexBinary(options.root, triple);
  if (existing) return existing;

  const dir = codexInstallDir(options.root, triple);
  try {
    mkdirSync(options.root, { recursive: true });
  } catch (error) {
    // The folder Hearthside keeps its installs in can't be made at all.
    throw writeFailure(error);
  }
  const staging = `${dir}.part`;
  const archive = `${dir}.tar.gz`;
  discard(staging);
  discard(archive);
  try {
    onProgress(0);
    const digest = await download(codexPackageUrl(triple), archive, deps, options.signal, onProgress);
    const expected = CODEX_PACKAGE_SHA256[triple];
    if (digest !== expected) {
      throw new CodexInstallError(
        `The downloaded Codex didn't match the checksum Hearthside expects, so it wasn't installed. This usually means the download was interrupted; trying again normally fixes it.`,
      );
    }
    options.signal.throwIfAborted();

    const entries = await deps.list(archive, options.signal);
    const unsafe = unsafeEntries(entries);
    if (unsafe.length > 0) throw new CodexInstallError("The download contained unexpected file paths, so nothing was unpacked.");
    if (!entries.some((entry) => entry.trim().replace(/\\/g, "/") === codexEntryPoint(triple))) {
      throw new CodexInstallError("The download didn't contain the Codex program, so it wasn't installed.");
    }
    // Cancelled while the archive was being checked: nothing is unpacked.
    options.signal.throwIfAborted();

    mkdirSync(staging, { recursive: true });
    await deps.extract(archive, staging, options.signal);
    const binary = join(staging, ...codexEntryPoint(triple).split("/"));
    if (!existsSync(binary)) throw new CodexInstallError("Codex was unpacked but the program isn't where it should be, so it wasn't installed.");
    if (!triple.includes("windows")) await chmod(binary, 0o755).catch(() => {});
    // Only now does the finished folder appear, so a cancelled or failed
    // install never leaves something that looks installed.
    renameSync(staging, dir);
    onProgress(1);
    return join(dir, ...codexEntryPoint(triple).split("/"));
  } catch (error) {
    discard(staging);
    if (error instanceof CodexInstallError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))) throw new CodexInstallError("Setup was cancelled.");
    throw new CodexInstallError(`Codex couldn't be set up: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    discard(archive);
  }
}

/** Installs from older pins, which nothing uses once a newer one is in place. */
export function supersededInstalls(root: string, triple: CodexTriple | null = codexTriple()): string[] {
  if (!triple) return [];
  const keep = `${CODEX_VERSION}-${triple}`;
  try {
    return readdirSync(root)
      .filter((entry) => entry !== keep && entry.endsWith(`-${triple}`))
      .map((entry) => join(root, entry));
  } catch {
    return [];
  }
}

export { codexPackageName };
