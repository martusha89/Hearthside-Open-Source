// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
/** Path and header helpers for an agent's memory files. */

export function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Index files list what a folder holds. They are the one file type without a header. */
/**
 * Hearthside: the path a new memory file is saved at. Letta only treats .md
 * files as memory, so a name typed without an extension gets ".md".
 */
export function newFilePath(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const last = path.split("/").pop() ?? "";
  return path && !last.includes(".") ? `${path}.md` : path;
}

/**
 * Hearthside: the file a new one would land on, if any. Capitals are ignored:
 * on Windows and most Macs "Persona.md" and "persona.md" are one file, so
 * creating the first replaced the second with the new note.
 */
export function clashingPath(paths: readonly string[], path: string): string | null {
  const wanted = path.toLowerCase();
  return paths.find((existing) => existing.toLowerCase() === wanted) ?? null;
}

export function isIndexFile(path: string): boolean {
  return /(^|\/)MEMORY\.md$/.test(path);
}

/**
 * Letta requires every memory file except an index to start with a header
 * naming and describing it. The new-file form writes that header for the user.
 */
export function withHeader(path: string, description: string, body: string): string {
  if (isIndexFile(path) || body.startsWith("---")) return body;
  const name = fileName(path).replace(/\.[^.]+$/, "");
  // The runtime reads these as plain single-line values, so they are not quoted.
  const summary = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${summary}\n---\n\n${body}`;
}
