import { spawn } from "node:child_process";
import treeKill from "tree-kill";
import { mkdtemp, readdir, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CloudGitSource {
  baseUrl: string; token: string; agentId: string; name: string; isPrimary: boolean;
  maxBytes?: number; maxFiles?: number; timeoutMs?: number;
}

/** Routes and Basic identity verified against the pinned letta-code Git transport. */
export function cloudGitUrl(source: CloudGitSource): string {
  const base = new URL(source.baseUrl);
  if (base.username || base.password || base.search || base.hash || !["https:", "http:"].includes(base.protocol)) throw new Error("Invalid Cloud base URL");
  if (!/^[a-zA-Z0-9_-]+$/.test(source.agentId)) throw new Error("Invalid agent identity");
  return `${base.href.replace(/\/+$/, "")}/v1/git/${source.agentId}/${source.isPrimary ? "state.git" : `repositories/${encodeURIComponent(source.name)}.git`}`;
}

/** No inherited Git configuration, hooks, credential helpers, proxy rewrites or trace logs. */
export function cloudGitEnvironment(url: string, token: string): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"], ["credential.helper", ""], ["core.askPass", ""],
    ["http.followRedirects", "false"], ["protocol.allow", "never"],
    ["protocol.http.allow", "always"], ["protocol.https.allow", "always"],
    ["http.extraHeader", ""], [`http.${url}.extraHeader`, `Authorization: Basic ${Buffer.from(`letta:${token}`).toString("base64")}`],
    ["gc.auto", "0"], ["maintenance.auto", "false"],
  ];
  if (process.env.LETTA_MEMFS_BACKEND === "hosted") config.push([`http.${url}.extraHeader`, "x-letta-memfs-backend: hosted"]);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(config.length), GIT_LFS_SKIP_SMUDGE: "1" };
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
}

async function diskBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? await diskBytes(path) : (await stat(path)).size;
    } catch (error) {
      // Hearthside: Git renames and removes its lock and temporary pack files while it works; one that
      // went between listing and measuring isn't a failure (on Windows this killed the fetch at random).
      if (!["ENOENT", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return total;
}

/** Fetch has no checkout, filters or hooks. A watchdog bounds the entire temporary repository. */
export async function captureCloudGit(source: CloudGitSource) {
  const maxBytes = Math.min(source.maxBytes ?? 200 * 1024 * 1024, 200 * 1024 * 1024);
  const maxFiles = Math.min(source.maxFiles ?? 5_000, 5_000);
  const url = cloudGitUrl(source);
  const env = cloudGitEnvironment(url, source.token);
  const dir = await mkdtemp(join(tmpdir(), "hearthside-cloud-git-"));
  const deadline = Date.now() + Math.min(source.timeoutMs ?? 120_000, 120_000);
  const run = (args: string[], outputLimit = maxBytes): Promise<Buffer> => new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0; let failed = false; let checking = false;
    // Kill git's helpers too: on Windows, killing git.exe alone leaves git-remote-https holding
    // the pipes, so "close" never fires and the backup waits for ever.
    const stop = () => {
      failed = true;
      if (child.pid) treeKill(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    const watchdog = setInterval(() => {
      if (checking) return;
      checking = true;
      void diskBytes(dir).then((bytes) => { if (bytes > maxBytes) stop(); }, stop).finally(() => { checking = false; });
    }, 50);
    child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > outputLimit) stop(); else chunks.push(data); });
    child.stderr.on("data", () => { /* Never retain server error bodies or credentials. */ });
    child.on("error", () => { clearTimeout(timer); clearInterval(watchdog); reject(new Error("Cloud Git process unavailable")); });
    child.on("close", (code) => { clearTimeout(timer); clearInterval(watchdog); if (failed || code !== 0) reject(new Error("Cloud Git capture failed or exceeded limits")); else resolve(Buffer.concat(chunks)); });
  });
  try {
    await run(["init", "--bare", "--template=", "."]);
    // Explicit HEAD plus all advertised branches and tags: never a shallow clone.
    await run(["fetch", "--no-recurse-submodules", "--no-write-fetch-head", url, "HEAD:refs/backup/captured-head", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
    const revision = (await run(["rev-parse", "refs/backup/captured-head^{commit}"], 128)).toString().trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid Git revision");
    await run(["update-ref", "HEAD", revision]);
    const tree = await run(["ls-tree", "-r", "-z", "--full-tree", revision], 4 * 1024 * 1024);
    const files: Array<{ path: string; content: string; bytes: Buffer }> = [];
    let bytes = 0;
    for (const record of tree.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1]!)) throw new Error("Unsupported repository tree entry");
      const path = match[4]!;
      if (path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\") || path.includes("\ufffd")) throw new Error("Unsupported repository path");
      if (files.length >= maxFiles) throw new Error("Repository file limit exceeded");
      const content = await run(["cat-file", "blob", match[3]!], maxBytes - bytes);
      bytes += content.length;
      files.push({ path, content: content.toString("utf8"), bytes: content });
    }
    await run(["bundle", "create", "capture.bundle", "--all"]);
    if (await diskBytes(dir) > maxBytes) throw new Error("Repository disk limit exceeded");
    const gitBundle = await readFile(join(dir, "capture.bundle"));
    const refs = (await run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"], 1024 * 1024)).toString().trim().split("\n").filter(Boolean).map((line) => {
      const [name, revision] = line.split(" ");
      return { name: name!, revision: revision! };
    });
    return { revision, gitBundle, files, refs };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
