// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import type { MemoryCommit, MemoryFile, MemoryOverview } from "@hearthside/ipc-contract";
import { request, requestChunks } from "./control.js";

// Wire shapes from the app server protocol (protocol_v2 in @letta-ai/letta-code),
// declared here because the package's type export for them does not resolve
// under Node module resolution.
type ListMemoryReply = {
  type: string;
  done: boolean;
  memfs_enabled?: boolean;
  entries: Array<{
    relative_path: string;
    is_system: boolean;
    description: string | null;
    content: string;
    size: number;
    kind?: "markdown" | "image";
    references?: string[];
  }>;
};

type MemoryHistoryReply = {
  type: string;
  commits: Array<{ sha: string; message: string; timestamp: string; author_name: string | null }>;
};

type MemoryFileAtRefReply = { type: string; content: string | null };

type MemoryFileReply = { type: string; content: string | null };

/**
 * An agent's memory: a git-backed folder of files (MemFS) that the agent reads
 * and maintains. Every write here is a commit, so history is always available.
 */

export async function listMemory(agentId: string): Promise<MemoryOverview> {
  const chunks = await requestChunks<ListMemoryReply>("list_memory", {
    agent_id: agentId,
    // Hearthside: the runtime resolves [[path]] links for the memory web.
    include_references: true,
  });
  const entries = chunks.flatMap((chunk) => chunk.entries).map((entry) => ({
    ...entry,
    relative_path: entry.relative_path.replace(/\\/g, "/"),
    references: entry.references?.map((path) => path.replace(/\\/g, "/")),
  }));
  // Letta Code 0.34.8 (native probe) and 0.34.16 (published source, line
  // 266186) hardcode list_memory's is_system to system/, even for v2 MemFS.
  // Mirror their actual compilation predicate instead: a root MEMORY.md
  // selects v2 root Markdown; without that marker, v1 compiles system/**/*.md.
  // Collect every chunk first: the format marker may arrive in the last one.
  const v2 = entries.some((entry) => entry.relative_path === "MEMORY.md");
  const files: MemoryFile[] = entries
    .map((entry) => ({
      path: entry.relative_path,
      system: entry.kind !== "image" && entry.relative_path.endsWith(".md") && (
        v2 ? !entry.relative_path.includes("/") : entry.relative_path.startsWith("system/")
      ),
      description: entry.description,
      // The body without its header. Image bytes are not sent to the UI.
      content: entry.kind === "image" ? "" : entry.content,
      size: entry.size,
      kind: entry.kind ?? "markdown",
      references: entry.references ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { enabled: chunks[0]?.memfs_enabled !== false, files };
}

/**
 * The runtime checks every commit against its memory rules (a header on each
 * file, a MEMORY.md index in each folder, size limits, read-only files). Its
 * error is the raw git output; keep only the part that says what to fix.
 */
function describeMemoryError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const start = message.indexOf("Memory validation");
  if (start < 0) return new Error(message);

  const detail = message.slice(start);
  const problems = (
    detail.split("Fix these problems:")[1] ?? detail.replace(/^Memory validation failed:/, "")
  )
    .trim()
    // The problem list ends at the first blank line; advice for the agent follows.
    .split(/\n\s*\n/)[0]
    ?.trim();
  return new Error(`Letta's memory rules blocked this change. ${problems}`);
}

async function readCurrent(agentId: string, path: string): Promise<string | null> {
  try {
    const reply = await request<MemoryFileReply>("read_memory_file", { agent_id: agentId, path });
    if (reply.content !== null && typeof reply.content !== "string") throw new Error("The runtime did not return the memory file's original content.");
    return reply.content;
  } catch (error) {
    // Only an explicit missing-file response establishes absence. A failed read
    // is not permission to delete the file if a later write is rejected.
    const message = error instanceof Error ? error.message : String(error);
    if (/^ENOENT: no such file or directory, open\b/.test(message) || /^File not found(?::|$)/i.test(message)) return null;
    throw error;
  }
}

/**
 * The whole file, including its header. `listMemory` returns only the body, so
 * this is what an editor must load and save.
 */
export async function readMemoryFile(agentId: string, path: string): Promise<string> {
  const reply = await request<MemoryFileReply>("read_memory_file", { agent_id: agentId, path });
  return reply.content ?? "";
}

/** Committing to a large memory repo can be slow, especially on Windows. */
const MEMORY_COMMIT_TIMEOUT_MS = 120_000;

export async function writeMemoryFile(agentId: string, rawPath: string, content: string, expected?: string | null): Promise<void> {
  const path = rawPath.trim();
  const previous = await readCurrent(agentId, path);
  // An editor saves the whole file. If the companion (or a dream) has written
  // to it since the editor opened, saving would put the older text back over
  // theirs with nothing said; the lines could only be found again in History.
  if (expected === null && previous !== null) throw new Error(`${path} already exists. Choose another name.`);
  if (typeof expected === "string" && previous === null) throw new Error("This memory file no longer exists. Your edit has not been saved.");
  if (typeof expected === "string" && previous !== expected) {
    throw new Error("This memory file changed while you were editing it (your companion or a dream updated it), so your edit has not been saved. Copy your changes, reopen the file to see the new version, and add them again.");
  }
  try {
    const started = Date.now();
    await request(
      "write_memory_file",
      { agent_id: agentId, path, content, commit_message: `Edit ${path} in Hearthside` },
      MEMORY_COMMIT_TIMEOUT_MS,
    );
    console.log(`[hearthside] wrote ${path} in ${Date.now() - started} ms`);
  } catch (error) {
    // A timeout/disconnect leaves the write's outcome unknown; compensating may
    // overwrite a successful commit or another writer. Only undo a confirmed
    // validation rejection, which explicitly leaves an uncommitted edit.
    if (!/Memory validation (?:failed|blocked)/.test(String(error))) throw describeMemoryError(error);
    // A rejected commit leaves the change in the working tree, where it would
    // ride along with the agent's next commit. Put the file back as it was.
    await (
      previous === null
        ? request("delete_memory_file", { agent_id: agentId, path })
        : request("write_memory_file", { agent_id: agentId, path, content: previous })
    ).catch(() => undefined);
    throw describeMemoryError(error);
  }
}

export async function deleteMemoryFile(agentId: string, path: string): Promise<void> {
  const previous = await readCurrent(agentId, path);
  try {
    await request("delete_memory_file", {
      agent_id: agentId,
      path,
      commit_message: `Delete ${path} in Hearthside`,
    });
  } catch (error) {
    // A file that was never committed is removed from disk, but then there is
    // nothing for git to record. The delete itself succeeded.
    if (/did not match any files/.test(String(error))) return;
    if (previous !== null && /Memory validation (?:failed|blocked)/.test(String(error))) {
      await request("write_memory_file", { agent_id: agentId, path, content: previous }).catch(
        () => undefined,
      );
    }
    throw describeMemoryError(error);
  }
}

export async function listMemoryHistory(agentId: string, path: string): Promise<MemoryCommit[]> {
  const reply = await request<MemoryHistoryReply>("memory_history", {
    agent_id: agentId,
    file_path: path,
    limit: 50,
  });
  return reply.commits.map((commit) => ({
    sha: commit.sha,
    message: commit.message,
    timestamp: Date.parse(commit.timestamp) || 0,
    author: commit.author_name,
  }));
}

export async function readMemoryFileAt(agentId: string, path: string, sha: string): Promise<string> {
  const reply = await request<MemoryFileAtRefReply>("memory_file_at_ref", {
    agent_id: agentId,
    file_path: path,
    ref: sha,
  });
  return reply.content ?? "";
}

/** Hearthside: recent commits across every memory file, newest first. */
export async function listMemoryActivity(agentId: string, limit: number): Promise<MemoryCommit[]> {
  const reply = await request<MemoryHistoryReply>("memory_history", { agent_id: agentId, limit });
  return reply.commits.map((commit) => ({
    sha: commit.sha,
    message: commit.message,
    timestamp: Date.parse(commit.timestamp) || 0,
    author: commit.author_name,
  }));
}

/** Hearthside: the unified diff of one memory commit. */
export async function readMemoryCommitDiff(agentId: string, sha: string): Promise<string> {
  const { readOwnedMemoryCommitDiff } = await import("./memory-commit-diff");
  return readOwnedMemoryCommitDiff(agentId, sha);
}
