import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveRuntimeHome } from "../runtime/paths";
import { getConnectionConfig } from "./settings";
import { controlGeneration, request } from "./control.js";

const exec = promisify(execFile);

/** The tree change introduced by a commit, not Git's default combined merge diff. */
export async function readGitMemoryCommitDiff(directory: string, sha: string): Promise<string> {
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new Error("Invalid memory commit SHA.");
  const { stdout } = await exec("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.alternateRefsCommand=", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    "-c", "protocol.allow=never",
    "show", "--patch", "--format=", "--no-color", "--no-ext-diff", "--no-textconv",
    "--src-prefix=a/", "--dst-prefix=b/", "--no-relative",
    "--diff-merges=first-parent", "--root", sha, "--",
  ], {
    cwd: directory, windowsHide: true,
    // Match backup capture's read-only boundary: no inherited config, helpers,
    // repository redirects, tracing, replacement objects, or lazy network fetch.
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C",
    },
    timeout: 10_000, maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function readOwnedMemoryCommitDiff(agentId: string, sha: string): Promise<string> {
  const generation = controlGeneration();
  const assertCurrent = () => {
    if (controlGeneration() !== generation) throw new Error("Hearthside reconnected while reading memory changes. Try again.");
  };
  if (!/^agent-[a-z0-9-]+$/i.test(agentId)) throw new Error("Invalid memory agent ID.");
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new Error("Invalid memory commit SHA.");
  const { backend } = getConnectionConfig();
  // The pinned runtime's protocol uses combined merge diffs. An empty reply
  // cannot prove that a Dream changed nothing; never silently fall back to it.
  if (backend === "remote") {
    const reply = await request<{ type: string; diff: string | null }>("memory_commit_diff", { agent_id: agentId, sha });
    assertCurrent();
    if (!reply.diff || !/^diff --git /m.test(reply.diff) || /^diff --(?:cc|combined) /m.test(reply.diff)) {
      throw new Error("This remote runtime cannot reliably show merge or empty memory changes yet.");
    }
    return reply.diff;
  }
  const home = resolveRuntimeHome().home ?? homedir();
  const directory = backend === "local"
    ? join(process.env.LETTA_LOCAL_BACKEND_DIR ?? join(home, ".letta", "lc-local-backend"), "memfs", agentId, "memory")
    : join(home, ".letta", "agents", agentId, "memory");
  if (!existsSync(join(directory, ".git"))) throw new Error("This memory repository is not available on this computer. Refresh Memory and try again.");
  // Dream merges are compared with the memory state before the merge (parent 1).
  // --root preserves initial commits; a genuinely empty tree change stays empty.
  const diff = await readGitMemoryCommitDiff(directory, sha);
  assertCurrent();
  return diff;
}
