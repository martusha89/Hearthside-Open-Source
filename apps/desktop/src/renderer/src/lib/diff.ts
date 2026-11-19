// Splits a git unified diff (as `git show <sha>` prints it) into files and
// typed lines for display. Pure, for testing.

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string };

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/ b\/(.+)$/);
      current = { path: match?.[1] ?? raw.slice(11), added: 0, removed: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") || raw.startsWith("rename ")) {
      if (raw.startsWith("+++ b/")) current.path = raw.slice(6);
      continue;
    }
    if (raw.startsWith("@@")) current.lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1) });
      current.added++;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1) });
      current.removed++;
    } else if (raw.startsWith(" ")) current.lines.push({ kind: "ctx", text: raw.slice(1) });
    else if (raw === "\\ No newline at end of file") continue;
  }
  return files;
}
