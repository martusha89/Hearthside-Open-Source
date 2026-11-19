import { isAbsolute, join, normalize, relative } from "node:path";
import { request } from "./control.js";

/**
 * Hearthside: browse the agent's working folder through the runtime. Paths are
 * given relative to the folder and checked to stay inside it.
 */

const MAX_FILE_CHARS = 2_000_000;

function inside(root: string, relativePath: string): string {
  if (!isAbsolute(root)) throw new Error("Choose a working folder first.");
  const target = normalize(join(root, relativePath || "."));
  const rel = relative(normalize(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("That's outside the working folder.");
  return target;
}

export async function listDirectory(root: string, relativePath: string): Promise<{ folders: string[]; files: string[] }> {
  const reply = await request<{ type: string; folders?: string[]; files?: string[] }>("list_in_directory", {
    path: inside(root, relativePath),
    include_files: true,
    limit: 500,
  });
  const name = (entry: string) => entry.split(/[\\/]/).filter(Boolean).pop() ?? entry;
  const visible = (entry: string) => !entry.startsWith(".git") && entry !== "node_modules";
  return {
    folders: (reply.folders ?? []).map(name).filter(visible).sort((a, b) => a.localeCompare(b)),
    files: (reply.files ?? []).map(name).filter(visible).sort((a, b) => a.localeCompare(b)),
  };
}

export async function readWorkingFile(root: string, relativePath: string): Promise<string> {
  const reply = await request<{ type: string; content?: string | null }>("read_file", { path: inside(root, relativePath), encoding: "utf8" });
  const content = reply.content ?? "";
  return content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n\n(File cut short.)` : content;
}
