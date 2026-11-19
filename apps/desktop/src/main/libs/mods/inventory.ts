import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { ModDiagnosticsInfo, ModFileInfo, ModPackageInfo } from "@hearthside/ipc-contract";
import { PACKAGES_REGISTRY_FILENAME, diagnosticsFile, isModFileName } from "./paths";

/**
 * What is in a mods folder, read with the filesystem only. Nothing here
 * imports a mod file: importing one runs it (that is what the runtime does on
 * load, deliberately), so Hearthside reads bytes and shows them.
 */

/** The most Hearthside will read of one mod file, for the source view. */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** The most Hearthside will accept when a person imports a file. */
export const MAX_IMPORT_BYTES = 64 * 1024;
/** A `packages.json` or diagnostics file bigger than this is treated as unusable rather than parsed. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** The runtime loads every matching file; the list shown is capped so one folder can't flood the window. */
const MAX_LISTED_FILES = 200;

/**
 * The files the runtime would load from one folder: files directly in it, no
 * dotfiles, no recursion, `.js` / `.mjs` / `.ts` / `.tsx` only — the same rule
 * as the runtime's `listModFiles`.
 *
 * A symlink is listed with its target but marked, and is never read through or
 * imported by Hearthside. The runtime would still load it; saying so is the
 * honest thing, hiding it is not.
 */
export function listModFiles(directory: string): ModFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const files: ModFileInfo[] = [];
  for (const name of entries.filter(isModFileName).sort((a, b) => a.localeCompare(b))) {
    const path = join(directory, name);
    let link: string | null = null;
    let bytes = 0;
    let modifiedAt = 0;
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        try {
          link = readlinkSync(path);
        } catch {
          link = "(unreadable link)";
        }
        // Size and date of the link itself say nothing useful; leave them at 0.
      } else if (!stats.isFile()) {
        continue;
      } else {
        bytes = stats.size;
        modifiedAt = stats.mtimeMs;
      }
    } catch {
      continue;
    }
    files.push({
      name,
      path,
      bytes,
      modifiedAt,
      linkTarget: link,
      tooLarge: link === null && bytes > MAX_SOURCE_BYTES,
    });
    // The cap covers links too: a folder of links must not get past it.
    if (files.length >= MAX_LISTED_FILES) break;
  }
  return files;
}

type RegistryEntry = { source?: unknown; version?: unknown; enabled?: unknown; entries?: unknown; root?: unknown };

/**
 * Managed packages as `<mods>/packages.json` records them, read-only.
 * Hearthside shows `enabled` as the registry has it and never writes the file:
 * the native way to change it is `letta mods enable|disable` (see docs/MODS.md).
 *
 * The runtime's own validator requires `source`, `version`, `root` (a safe
 * relative path) and a boolean `enabled` on every entry, and ignores the
 * package otherwise. Entries that fail those checks are reported as a problem
 * rather than shown as if they worked.
 */
export function listModPackages(directory: string): { packages: ModPackageInfo[]; problem: string | null } {
  let read: ReturnType<typeof readBoundedFile>;
  const path = join(directory, PACKAGES_REGISTRY_FILENAME);
  try {
    read = readBoundedFile(path, MAX_JSON_BYTES);
  } catch {
    // No registry at all is the normal case, not a problem.
    return { packages: [], problem: null };
  }
  if (read.truncated) {
    return { packages: [], problem: `${PACKAGES_REGISTRY_FILENAME} is too large to read.` };
  }
  const raw = read.bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { packages: [], problem: `${PACKAGES_REGISTRY_FILENAME} is not valid JSON, so the runtime loads no packages.` };
  }
  const list = (parsed as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) {
    return { packages: [], problem: `${PACKAGES_REGISTRY_FILENAME} has no "packages" list, so the runtime loads no packages.` };
  }
  const packages: ModPackageInfo[] = [];
  let skipped = 0;
  for (const item of list.slice(0, 100)) {
    const entry = item as RegistryEntry | null;
    const safeRoot = typeof entry?.root === "string" && entry.root.length > 0
      && !entry.root.split(/[\\/]/).includes("..") && !/^([a-zA-Z]:)?[\\/]/.test(entry.root);
    if (!entry || typeof entry.source !== "string" || typeof entry.version !== "string"
      || typeof entry.enabled !== "boolean" || !safeRoot) {
      skipped += 1;
      continue;
    }
    packages.push({
      source: entry.source,
      version: entry.version,
      enabled: entry.enabled,
      entries: Array.isArray(entry.entries)
        ? entry.entries.filter((value): value is string => typeof value === "string").slice(0, 50)
        : [],
      root: join(directory, entry.root as string),
    });
  }
  return {
    packages,
    problem: skipped > 0
      ? `${skipped} ${skipped === 1 ? "entry" : "entries"} in ${PACKAGES_REGISTRY_FILENAME} ${skipped === 1 ? "is" : "are"} incomplete; the runtime ignores ${skipped === 1 ? "it" : "them"}.`
      : null,
  };
}

type DiagnosticsFileShape = {
  generatedAt?: unknown;
  report?: {
    diagnostics?: unknown;
    errorCount?: unknown;
    warningCount?: unknown;
  };
};

/**
 * The runtime's diagnostics file for the machine mods folder. A record of
 * problems at one moment: a mod that loaded cleanly leaves no entry, and agent
 * adapters are created without their own diagnostics root, so this is never
 * read as an inventory or as per-agent truth.
 */
export function readModDiagnostics(modsDirectory: string): ModDiagnosticsInfo | null {
  const path = diagnosticsFile(modsDirectory);
  let read: ReturnType<typeof readBoundedFile>;
  try {
    read = readBoundedFile(path, MAX_JSON_BYTES);
  } catch {
    return null;
  }
  if (read.truncated) return null;
  let parsed: DiagnosticsFileShape;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8")) as DiagnosticsFileShape;
  } catch {
    return null;
  }
  const report = parsed.report;
  if (!report) return null;
  const entries = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  return {
    path,
    generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : 0,
    errors: typeof report.errorCount === "number" ? report.errorCount : 0,
    warnings: typeof report.warningCount === "number" ? report.warningCount : 0,
    entries: entries.slice(0, 50).map((item) => {
      const entry = item as {
        mod?: { id?: unknown; path?: unknown; scope?: unknown };
        phase?: unknown;
        severity?: unknown;
        message?: unknown;
        hint?: unknown;
        timestamp?: unknown;
        capability?: { id?: unknown; kind?: unknown };
      } | null;
      const capability = entry?.capability;
      return {
        modId: typeof entry?.mod?.id === "string" ? entry.mod.id : "",
        modPath: typeof entry?.mod?.path === "string" ? entry.mod.path : "",
        modScope: typeof entry?.mod?.scope === "string" ? entry.mod.scope : "",
        phase: typeof entry?.phase === "string" ? entry.phase : "",
        severity: entry?.severity === "warning" ? "warning" : "error",
        message: typeof entry?.message === "string" ? entry.message.slice(0, 2_000) : "",
        capability: capability && typeof capability.id === "string"
          ? `${String(capability.kind ?? "")} ${capability.id}`.trim()
          : null,
        hint: typeof entry?.hint === "string" ? entry.hint.slice(0, 1_000) : null,
        at: typeof entry?.timestamp === "number" ? entry.timestamp : 0,
      };
    }),
  };
}

/**
 * Read at most `limit` bytes of a file, and say whether there was more.
 *
 * One descriptor does the checking and the reading, so the thing measured is
 * the thing read, and `O_NOFOLLOW` means a link cannot be read through even if
 * it is swapped in between the check and the open. The cap is applied to the
 * read itself — reading the whole file first and trimming afterwards would
 * block the main process and could exhaust memory on a huge file, which is the
 * opposite of a cap.
 */
export function readBoundedFile(path: string, limit: number): { bytes: Buffer; size: number; truncated: boolean } {
  // Checked before opening: opening a FIFO for reading blocks until a writer
  // appears, which would hang the main process before `fstat` could reject it.
  // `O_NONBLOCK` closes the gap between this check and the open — it is a
  // no-op for a regular file, and makes opening a FIFO fail instead of wait.
  const seen = lstatSync(path);
  if (seen.isSymbolicLink()) throw new Error("That mod file is a link. Hearthside won't read through links.");
  if (!seen.isFile()) throw new Error("That isn't a mod file.");
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Linux reports ELOOP for a symlink opened with O_NOFOLLOW; macOS/BSD EMLINK.
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error("That mod file is a link. Hearthside won't read through links.");
    }
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("That isn't a mod file.");
    // One byte past the limit, so "there is more" is known without reading it all.
    const buffer = Buffer.allocUnsafe(Math.min(limit + 1, stats.size + 1));
    const read = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    const truncated = read > limit;
    return { bytes: buffer.subarray(0, Math.min(read, limit)), size: stats.size, truncated };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * One mod file as text. Refuses a symlink rather than following it, caps what
 * it reads, and never imports.
 */
export function readModFile(path: string, limit = MAX_SOURCE_BYTES): { source: string; bytes: number; truncated: boolean } {
  const { bytes, size, truncated } = readBoundedFile(path, limit);
  return { source: bytes.toString("utf8"), bytes: size, truncated };
}
