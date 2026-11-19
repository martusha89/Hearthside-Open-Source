import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

/**
 * Hearthside: an Obsidian vault for agents. A vault is a folder of Markdown
 * notes, so this works straight on the files (no Obsidian plugin or community
 * server). Reading and searching need no approval; writing a note goes through
 * the usual approval. Every path stays inside the vault, and only .md notes are
 * touched; Obsidian's own folders (.obsidian, .trash) are left alone.
 */

export const OBSIDIAN_READ_TOOLS = ["obsidian_search", "obsidian_read", "obsidian_recent"] as const;
const SKIP = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_FILES = 20_000;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_DEPTH = 20;

type Note = { path: string; mtime: number; size: number };

/** A vault-relative path, or null if it would leave the vault or isn't a note. */
export function notePath(vault: string, input: string): string | null {
  const cleaned = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return null;
  const withExt = cleaned.toLowerCase().endsWith(".md") ? cleaned : `${cleaned}.md`;
  const full = resolve(vault, withExt);
  const rel = relative(resolve(vault), full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return null;
  if (rel.split(sep).some((part) => SKIP.has(part))) return null;
  return full;
}



export function insideVaultOnDisk(vault: string, full: string): boolean {
  let root: string;
  try {
    root = realpathSync.native(vault);
  } catch {
    return false;
  }
  const rel = relative(resolve(vault), full);
  const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (outside(rel)) return false;
  let current = resolve(vault);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      // Not there yet (a note or folder about to be created): nothing further to follow.
      break;
    }
    if (info.isSymbolicLink()) return false;
    try {
      const real = realpathSync.native(current);
      const within = relative(root, real);
      if (outside(within)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function listNotes(vault: string): Note[] {
  const notes: Note[] = [];
  const walk = (dir: string, depth = 0) => {
    if (notes.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let stats;
      try {
        // lstat: links and junctions are skipped, never followed out of the vault.
        stats = lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walk(full, depth + 1);
      else if (entry.toLowerCase().endsWith(".md")) notes.push({ path: relative(vault, full).split(sep).join("/"), mtime: stats.mtimeMs, size: stats.size });
    }
  };
  walk(vault);
  return notes;
}

/** Notes whose name or text contains every word, best first, with a short snippet. */
export function searchVault(vault: string, query: string, limit = 15): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Give some words to search for.";
  const hits: Array<{ path: string; score: number; snippet: string }> = [];
  for (const note of listNotes(vault)) {
    const name = note.path.toLowerCase();
    let text = "";
    if (note.size <= MAX_NOTE_BYTES) {
      try {
        text = readFileSync(join(vault, note.path), "utf8");
      } catch {
        continue;
      }
    }
    const lower = text.toLowerCase();
    if (!words.every((word) => name.includes(word) || lower.includes(word))) continue;
    const score = words.reduce((sum, word) => sum + (name.includes(word) ? 5 : 0) + Math.min(5, lower.split(word).length - 1), 0);
    const at = lower.indexOf(words[0]!);
    const snippet = at >= 0 ? text.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, " ").trim() : "";
    hits.push({ path: note.path, score, snippet });
  }
  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) return `No notes match "${query}".`;
  return hits
    .slice(0, limit)
    .map((hit) => `- ${hit.path}${hit.snippet ? `\n  …${hit.snippet}…` : ""}`)
    .join("\n");
}

export function recentNotes(vault: string, limit = 15): string {
  const notes = listNotes(vault).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  if (notes.length === 0) return "The vault has no notes yet.";
  return notes.map((note) => `- ${note.path} (changed ${new Date(note.mtime).toISOString().slice(0, 16).replace("T", " ")})`).join("\n");
}

export function readNote(vault: string, path: string): string {
  const full = notePath(vault, path);
  if (!full || !insideVaultOnDisk(vault, full)) throw new Error("That isn't a note inside the vault.");
  if (!existsSync(full)) throw new Error(`There's no note called ${path}.`);
  const info = lstatSync(full);
  if (!info.isFile()) throw new Error("That isn't a note inside the vault.");
  if (info.size > MAX_NOTE_BYTES) throw new Error("That note is too long to read in one go.");
  return readFileSync(full, "utf8");
}

export function writeNote(vault: string, path: string, content: string, mode: "create" | "append" | "replace"): string {
  const full = notePath(vault, path);
  if (!full || !insideVaultOnDisk(vault, full)) throw new Error("That isn't a note inside the vault.");
  const exists = existsSync(full);
  if (exists && !lstatSync(full).isFile()) throw new Error("That isn't a note inside the vault.");
  if (mode === "create" && exists) throw new Error(`A note called ${path} already exists. Append to it or choose another name.`);
  if (mode !== "create" && !exists && mode === "replace") throw new Error(`There's no note called ${path} to replace.`);
  mkdirSync(dirname(full), { recursive: true });
  // Checked again once the folders exist, in case one appeared as a link meanwhile.
  if (!insideVaultOnDisk(vault, full)) throw new Error("That isn't a note inside the vault.");
  if (mode === "append" && exists) {
    const current = readFileSync(full, "utf8");
    appendFileSync(full, `${current.endsWith("\n") || current === "" ? "" : "\n"}${content}`);
  } else {
    writeFileSync(full, content);
  }
  const rel = relative(vault, full).split(sep).join("/");
  return `${mode === "append" && exists ? "Added to" : mode === "replace" ? "Replaced" : "Created"} ${rel}.`;
}

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

export function createObsidianTools(vault: () => string): AnyAgentTool[] {
  const run = (work: (dir: string) => string) => {
    const dir = vault();
    if (!dir || !existsSync(dir)) return text("The Obsidian vault folder isn't set or can't be found. Ask the user to choose it on the Connectors page.", true);
    try {
      return text(work(dir));
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  };
  return [
    {
      name: "obsidian_search",
      label: "Search notes",
      description: "Search the user's Obsidian notes by words in their name or text. Returns matching notes with a short snippet.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Words to look for." } }, required: ["query"] },
      execute: async (_id, args) => run((dir) => searchVault(dir, String((args as { query?: unknown })?.query ?? ""))),
    },
    {
      name: "obsidian_read",
      label: "Read a note",
      description: "Read one note from the user's Obsidian vault by its path, e.g. 'Journal/2026-10-11' (.md is optional).",
      parameters: { type: "object", properties: { path: { type: "string", description: "The note's path inside the vault." } }, required: ["path"] },
      execute: async (_id, args) => run((dir) => readNote(dir, String((args as { path?: unknown })?.path ?? ""))),
    },
    {
      name: "obsidian_recent",
      label: "Recent notes",
      description: "List the notes the user changed most recently in their Obsidian vault.",
      parameters: { type: "object", properties: {} },
      execute: async () => run((dir) => recentNotes(dir)),
    },
    {
      name: "obsidian_write",
      label: "Write a note",
      description:
        "Create a new note, add to the end of a note, or replace a note in the user's Obsidian vault. The user approves each write. Use Markdown, and [[links]] to other notes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note's path inside the vault, e.g. 'Ideas/Garden'." },
          content: { type: "string", description: "Markdown text." },
          mode: { type: "string", enum: ["create", "append", "replace"], description: "create a new note, append to the end, or replace it." },
        },
        required: ["path", "content", "mode"],
      },
      execute: async (_id, args) => {
        const input = (args ?? {}) as { path?: unknown; content?: unknown; mode?: unknown };
        const mode = input.mode === "append" || input.mode === "replace" ? input.mode : "create";
        return run((dir) => writeNote(dir, String(input.path ?? ""), String(input.content ?? ""), mode));
      },
    },
  ];
}
