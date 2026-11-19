import { lstat } from "node:fs/promises";
import { checkLocalPath, MediaPathRefused, resolveWithoutNetwork } from "./local-media";
import { extname, isAbsolute, resolve } from "node:path";
import { shell } from "electron";

/**
 * Hearthside: links to files in an agent's reply, e.g. the runtime's
 * "#letta-sandbox-download/<path>" ("Download the full audit report"), or a
 * plain path. Opened when the file is on this computer: documents and
 * pictures in their usual app, anything else — including pages and drawings,
 * which carry scripts — shown in its folder (never run).
 * When the agent's tools ran elsewhere (a bot on a server), the file isn't
 * here, and the person is told so instead of the click doing nothing.
 */

const SAFE_TO_OPEN = new Set([".md", ".txt", ".pdf", ".json", ".csv", ".log", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg", ".docx", ".xlsx", ".pptx", ".odt", ".rtf", ".zip"]);

/**
 * Hearthside: a page or drawing an agent wrote (.html, .svg and friends) can
 * carry scripts, and the computer's associated application for it is usually a
 * browser, which runs them. They are deliberately not in SAFE_TO_OPEN: a click
 * shows the file in its folder, so opening it is the person's own next click.
 */
const ACTIVE_CONTENT = new Set([".htm", ".html", ".xhtml", ".xht", ".mht", ".mhtml", ".svg", ".svgz", ".xml", ".xsl", ".xslt"]);

/** Handed to the computer's usual app for it, rather than shown in its folder. */
export function opensInItsApp(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return SAFE_TO_OPEN.has(extension) && !ACTIVE_CONTENT.has(extension);
}

/** The file path a link points at, or null for anything that isn't a file link. */
export function filePathFromLink(href: string): string | null {
  let value = href.trim();
  const sandbox = /^#?letta-sandbox-download\/+(.*)$/i.exec(value);
  if (sandbox) value = `/${sandbox[1]!.replace(/^\/+/, "")}`;
  else if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname) return null;
      value = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1");
    } catch {
      return null;
    }
  } else if (!/^([a-zA-Z]:[\\/]|\/)/.test(value)) return null;
  if (/^(?:[\\/]{2}|\\\?\?\\)/.test(value) || value.includes("\0")) return null;
  return value;
}

export type FileLinkResult = { opened: boolean; path: string; message: string | null };

/** For a sandbox download link whose file isn't here: fetch it from the chat's Cloud sandbox (null: not possible). */
export type SandboxFetch = (sandboxPath: string) => Promise<string>;

export async function openFileLink(href: string, cwd: string | null, fromSandbox?: SandboxFetch | null): Promise<FileLinkResult> {
  const linked = filePathFromLink(href);
  if (!linked) return { opened: false, path: href, message: "That link isn't a file." };
  const candidates = [linked];
  // "/root/x" on Windows is C:\root\x; tools sometimes mean it relative to the chat's folder.
  if (process.platform === "win32" && linked.startsWith("/")) {
    candidates.splice(0, 1, resolve(linked));
    if (cwd) candidates.push(resolve(cwd, `.${linked}`));
  } else if (!isAbsolute(linked) && cwd) candidates.push(resolve(cwd, linked));
  let found: string | undefined;
  for (const path of candidates) {
    try {
      const checked = await resolveWithoutNetwork(await checkLocalPath(path));
      if ((await lstat(checked)).isFile()) {
        found = checked;
        break;
      }
    } catch (error) {
      if (!(error instanceof MediaPathRefused)) continue;
      return { opened: false, path: linked, message: "Only files on this computer can be opened." };
    }
  }
  if (!found && fromSandbox && /letta-sandbox-download/i.test(href)) {
    // The tools ran in the chat's Letta Cloud sandbox: bring the file here (Downloads), then show it.
    try {
      const saved = await resolveWithoutNetwork(await checkLocalPath(await fromSandbox(linked)));
      if (!(await lstat(saved)).isFile()) throw new Error("That download isn't a file.");
      shell.showItemInFolder(saved);
      return { opened: true, path: saved, message: null };
    } catch (error) {
      return { opened: false, path: linked, message: `Couldn't download ${linked} from your agent's Cloud sandbox: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!found) {
    return {
      opened: false,
      path: linked,
      message: `That file (${linked}) isn't on this computer: your agent's tools ran somewhere else, such as its server. Ask your agent to paste it into the chat or send it to you.`,
    };
  }
  if (opensInItsApp(found)) {
    const error = await shell.openPath(found);
    if (!error) return { opened: true, path: found, message: null };
  }
  shell.showItemInFolder(found);
  return { opened: true, path: found, message: null };
}
