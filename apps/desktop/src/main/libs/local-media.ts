import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, resolve, win32 } from "node:path";




export class MediaPathRefused extends Error {}

const NETWORK_OR_DEVICE = /^(?:[\\/]{2}|\\\?\?\\)/;

let networkDrives: { letters: Set<string>; at: number } | null = null;
let asking: Promise<Set<string>> | null = null;

/**
 * Mapped network drive letters. Asked of Windows again after a few seconds (a
 * drive letter can be remapped), with previews opening at the same moment
 * sharing one question.
 */
function mappedNetworkDrives(): Promise<Set<string>> {
  if (networkDrives && Date.now() - networkDrives.at < 5_000) return Promise.resolve(networkDrives.letters);
  asking ??= askWindows().finally(() => {
    asking = null;
  });
  return asking;
}

function askWindows(): Promise<Set<string>> {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Network' } | ForEach-Object { $_.Name.Substring(0,1) }"],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        // If Windows can't be asked, no drive letter is treated as network-free: only the
        // system drive is allowed until the next try.
        const letters = error ? null : new Set(String(stdout).split(/\s+/).filter(Boolean).map((letter) => letter.toUpperCase()));
        if (letters) networkDrives = { letters, at: Date.now() };
        done(letters ?? new Set("ABDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((letter) => letter !== (process.env.SystemDrive ?? "C:")[0]!.toUpperCase())));
      },
    );
  });
}

/** The path, made absolute, if it may be previewed; otherwise MediaPathRefused. */
export async function checkLocalPath(path: string, platform: NodeJS.Platform = process.platform, drives: () => Promise<Set<string>> = mappedNetworkDrives): Promise<string> {
  const raw = path.trim();
  if (!raw || raw.includes("\0")) throw new MediaPathRefused("That isn't a file path.");
  if (NETWORK_OR_DEVICE.test(raw)) throw new MediaPathRefused("Files on network shares aren't opened here.");
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(raw)) throw new MediaPathRefused("Only files on this computer are shown.");
    const full = win32.resolve(raw);
    if (NETWORK_OR_DEVICE.test(full) || !/^[A-Za-z]:\\/.test(full)) throw new MediaPathRefused("Files on network shares aren't opened here.");
    if ((await drives()).has(full[0]!.toUpperCase())) throw new MediaPathRefused("Files on network drives aren't opened here.");
    return full;
  }
  if (!isAbsolute(raw)) throw new MediaPathRefused("Only files on this computer are shown.");
  return resolve(raw);
}

/**
 * Follow the path one part at a time without letting Windows follow anything:
 * a link or junction is read (readlink reads the link itself, never its
 * target), and where it points must pass the same check, so a folder on a local
 * drive can't lead to a network share. Links to other local folders (a moved
 * profile folder, say) still work. Returns the real path to read.
 */
export async function resolveWithoutNetwork(full: string, check: (path: string) => Promise<string> = checkLocalPath, hops = 0): Promise<string> {
  const root = parse(full).root;
  const parts = full.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const info = await lstat(current).catch(() => null);
    if (!info) return full; // Missing from here on: reported as gone by the caller.
    if (!info.isSymbolicLink()) continue;
    if (hops >= 8) throw new MediaPathRefused("That path goes through too many links.");
    const target = await readlink(current);
    const next = await check(isAbsolute(target) || NETWORK_OR_DEVICE.test(target) ? target : resolve(dirname(current), target));
    return resolveWithoutNetwork(join(next, ...parts.slice(index + 1)), check, hops + 1);
  }
  return full;
}

/** Read a checked local media file as a data: URL. */
export async function readLocalMedia(path: string, types: Record<string, string>, maxBytes: number, what: { kind: string; gone: string; tooBig: string }): Promise<string> {
  const type = types[extname(path).toLowerCase()];
  if (!type) throw new Error(`That isn't ${what.kind}.`);
  const full = await resolveWithoutNetwork(await checkLocalPath(path));
  const info = await lstat(full).catch(() => null);
  if (!info) throw new Error(what.gone);
  if (!info.isFile()) throw new MediaPathRefused("Only files are opened here.");
  if (info.size > maxBytes) throw new Error(what.tooBig);
  const bytes = await readFile(full);
  if (bytes.length > maxBytes) throw new Error(what.tooBig);
  return `data:${type};base64,${bytes.toString("base64")}`;
}
