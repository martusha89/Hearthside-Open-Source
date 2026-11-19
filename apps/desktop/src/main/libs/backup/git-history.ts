import { execFile } from "node:child_process";
import { lstatSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** A separate, trusted Git directory: repository config, attributes, hooks and
 * working-tree executables are never consulted. No checkout or network operation. */
export class RecoveryGitHistory {
  private temporary: string;
  private gitDir: string;
  private originalHead?: string;
  private initialized = false;
  private finished = false;
  private bootstrap?: { dev: number; ino: number };
  constructor(private root: string) {
    this.temporary = mkdtempSync(join(root, "..", "hearthside-recovery-git-"));
    this.gitDir = join(this.temporary, "repo");
    const path = join(root, ".git");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe recovery Git scaffold");
      this.bootstrap = stat;
    }
    mkdirSync(join(this.temporary, "hooks"));
    writeFileSync(join(this.temporary, "config"), "");
  }


  private git(args: string[], input?: Buffer): Promise<string> {
    // Deliberate allowlist: do not inherit GIT_CONFIG_*, object alternates,
    // executable helpers, signing, pager, askpass or repository redirects.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: this.temporary, USERPROFILE: this.temporary, XDG_CONFIG_HOME: this.temporary,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(this.temporary, "config"),
      GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_AUTHOR_NAME: "Hearthside Recovery", GIT_AUTHOR_EMAIL: "recovery@hearthside.local",
      GIT_COMMITTER_NAME: "Hearthside Recovery", GIT_COMMITTER_EMAIL: "recovery@hearthside.local",
      LC_ALL: "C",
    };
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["--git-dir", this.gitDir, "-c", `core.hooksPath=${join(this.temporary, "hooks")}`, "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", "-c", "commit.gpgSign=false", ...args], {
        env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  }
  private async init(format = "sha1") {
    if (this.initialized) return;
    await this.git(["init", `--object-format=${format}`, "--template=", this.gitDir]);
    await this.git(["symbolic-ref", "HEAD", "refs/heads/recovered"]);
    this.initialized = true;
  }
  async importBundle(bytes: Buffer): Promise<void> {
    if (this.finished || this.originalHead) throw new Error("Git recovery already imported or finalized");
    if (bytes.length > 256 * 1024 * 1024) throw new Error("Recovery Git bundle exceeds 256 MiB limit");
    const end = bytes.indexOf(Buffer.from("\n\n"));
    if (end < 0 || end > 1024 * 1024) throw new Error("Invalid Git bundle header");
    const header = bytes.subarray(0, end).toString("utf8");
    if (!/^# v[23] git bundle\n/.test(header) || header.split("\n").some((line) => line.startsWith("-"))) throw new Error("Recovery requires a complete Git bundle without prerequisites");
    await this.init(header.includes("@object-format=sha256") ? "sha256" : "sha1");
    const bundle = join(this.temporary, "history.bundle");
    writeFileSync(bundle, bytes, { flag: "wx", mode: 0o600 });
    await this.git(["bundle", "verify", bundle]);
    const refs = (await this.git(["bundle", "unbundle", bundle])).split("\n").map((line) => {
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (HEAD|refs\/[^\s]+)$/.exec(line);
      if (!match) throw new Error("Invalid Git bundle reference");
      return { oid: match[1]!, ref: match[2]! };
    });
    const head = refs.find(({ ref }) => ref === "HEAD")?.oid;
    if (!head || (await this.git(["cat-file", "-t", head])) !== "commit") throw new Error("Git bundle does not identify its original HEAD commit");
    await this.git(["fsck", "--full", "--no-reflogs", "--no-dangling"]);
    for (const { oid, ref } of refs) {
      const name = ref === "HEAD" ? "refs/recovery/original/HEAD" : `refs/recovery/original/${ref.slice(5)}`;
      await this.git(["check-ref-format", name]);
      await this.git(["update-ref", name, oid]);
    }
    // Attach ancestry only. Never reset/read-tree/checkout the source tree.
    await this.git(["update-ref", "refs/heads/recovered", head]);
    this.originalHead = head;
  }
  get ancestry() { return this.originalHead ?? null; }
  async finalize(): Promise<void> {
    if (this.finished) throw new Error("Git recovery already finalized");
    await this.init();
    const index: string[] = [];
    let totalBytes = 0;
    const deadline = Date.now() + 120_000;
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const name of readdirSync(directory).sort()) {
        if (!prefix && name === ".git") continue;
        if (Date.now() > deadline || index.length >= 100_000) throw new Error("Recovery Git tree exceeds time/file limit");
        const path = join(directory, name); const relative = prefix + name;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Unsafe recovery Git tree: ${relative}`);
        if (stat.isDirectory()) { await walk(path, `${relative}/`); continue; }
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) throw new Error(`Unsafe recovery Git file: ${relative}`);
        totalBytes += stat.size;
        if (totalBytes > 1024 * 1024 * 1024) throw new Error("Recovery Git tree exceeds 1 GiB limit");
        // Plumbing bypasses all clean filters, attributes, ignored files and executable bits.
        const oid = await this.git(["hash-object", "-w", "--stdin"], readFileSync(path));
        index.push(`100644 ${oid}\t${relative}\0`);
      }
    };
    await walk(this.root);
    const input = Buffer.from(index.join(""));
    if (input.length > 16 * 1024 * 1024) throw new Error("Recovery Git index exceeds limit");
    await this.git(["read-tree", "--empty"]);
    await this.git(["update-index", "-z", "--index-info"], input);
    const tree = await this.git(["write-tree"]);
    const commit = await this.git(["commit-tree", tree, ...(this.originalHead ? ["-p", this.originalHead] : [])], Buffer.from(`Recover validated memory and archival data\n\nOriginal ancestry: ${this.originalHead ?? "unavailable (no Git bundle)"}\nSee recovery-archives/provenance.json for snapshot identity.\n`));
    await this.git(["update-ref", "refs/heads/recovered", commit]);
    await this.git(["config", "core.bare", "false"]);
    const destination = join(this.root, ".git");
    let preservedBootstrap: string | undefined;
    if (this.bootstrap) {
      const stat = lstatSync(destination);
      if (stat.isSymbolicLink() || stat.dev !== this.bootstrap.dev || stat.ino !== this.bootstrap.ino) throw new Error("Recovery Git scaffold was replaced");
      // Preserve the newly allocated runtime scaffold, outside the restored tree.
      preservedBootstrap = join(this.root, "..", `recovery-bootstrap-git-${randomUUID()}`);
      renameSync(destination, preservedBootstrap);
    } else if (existsSync(destination)) throw new Error("Recovery Git destination already exists");
    try { renameSync(this.gitDir, destination); } catch (error) {
      if (preservedBootstrap && !existsSync(destination)) renameSync(preservedBootstrap, destination);
      throw error;
    }
    this.finished = true;
    await rm(this.temporary, { recursive: true, force: true });
  }
}
