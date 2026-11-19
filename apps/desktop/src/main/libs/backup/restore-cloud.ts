import Letta from "@letta-ai/letta-client";
import { LettaAgentClient, RepositoriesClient } from "@letta-ai/letta-agent-sdk";
import { execFile, execFileSync } from "node:child_process";
import { AgentFileImportError, importAgentFile, validateAgentFile, type AgentFileClient } from "./cloud-agent-file";
import type { RecoveryReadback, RecoveryArtifact } from "./receipts";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudGitEnvironment, cloudGitUrl } from "./cloud-git";
import { RecoveryGitHistory } from "./git-history";
import { isSafeRestorePath, type RestoreDestination, type RestoreMapping } from "./restore";

export type CloudRestoreOptions = {
  baseUrl: string;
  token: string;
  /** Immutable account/organization identity captured when the preview was made. */
  connectionIdentity: string;
  assertConnection?: () => Promise<void>;
  onAllocated?: (id: string) => void | Promise<void>;
  /** Fresh read-only Cloud API snapshot; test injection only, never backup supplied. */
  readAgentData?: (id: string) => Promise<unknown>;
  /** Trusted test seams only; never supplied by backup data. */
  client?: Pick<LettaAgentClient, "createAgent">;
  agentFileClient?: AgentFileClient;
  transport?: (newAgentId: string, repository?: { id: string; name: string }) => { url: string; env: NodeJS.ProcessEnv };
  repositories?: {
    create(name: string): Promise<{ id: string; name: string }>;
    attach(agentId: string, repositoryId: string, permissions: "read" | "read_write"): Promise<void>;
    detach(agentId: string, repositoryId: string): Promise<void>;
    verify(agentId: string, repositoryId: string, permissions: "read" | "read_write"): Promise<void>;
  };
};
export type SharedRepositoryRestore = {
  originalId: string; name: string; permissions: "read" | "read_write";
  files: Array<{ path: string; bytes: Buffer }>; gitBundle?: Buffer;
};
export type SharedRepositoryMapping = { originalId: string; originalName: string; destinationId: string; destinationName: string; permissions: "read" | "read_write" };
export type CloudRestoreDestination = RestoreDestination & {
  abortRecovery(id: string): Promise<void>;
  readbackRecovery(id: string): Promise<RecoveryReadback>;
  restoreSharedRepository(id: string, input: SharedRepositoryRestore): Promise<SharedRepositoryMapping>;
};

/** Real Cloud destination. No local-runtime fallback, sessions, inference, or automation. */
export function createCloudRestoreDestination(options: CloudRestoreOptions): CloudRestoreDestination {
  return cloudDestination(options);
}

/** Restart-safe observation only. No allocation, import, or destination mutation. */
export async function readCloudRecoveryCopy(options: {
  agentId: string; baseUrl: string; token: string; connectionIdentity: string;
  shared: Array<{ id: string; name: string }>;
}): Promise<RecoveryReadback> {
  if (!/^agent-[a-zA-Z0-9-]+$/.test(options.agentId) || options.agentId.startsWith("agent-local-")) throw new Error("Invalid Cloud recovery agent ID");
  const seen = new Set<string>();
  for (const repository of options.shared) {
    if (!/^[a-zA-Z0-9-]+$/.test(repository.id) || !/^[a-zA-Z0-9_-]+$/.test(repository.name) || seen.has(repository.id)) throw new Error("Invalid Cloud recovery repository");
    seen.add(repository.id);
  }
  return cloudDestination(options, { id: options.agentId, shared: options.shared }).readbackRecovery(options.agentId);
}

function cloudDestination(options: CloudRestoreOptions, observation?: { id: string; shared: Array<{ id: string; name: string }> }): CloudRestoreDestination {
  const { baseUrl, token, connectionIdentity, assertConnection, transport } = options;
  if (!token || !connectionIdentity) throw new Error("Cloud recovery requires a captured connection");
  // Validate before allocation. Neither URL nor repository config ever contains credentials.
  cloudGitUrl({ baseUrl, token, agentId: "validation", name: "memory", isPrimary: true });
  let createAttempted = false;
  const client = options.client ?? new LettaAgentClient({
    backend: "cloud", apiKey: token, apiBaseUrl: baseUrl,
    fetch: async (input, init) => {
      // The SDK retries transport failures by default. Never send a second allocation.
      if (createAttempted) throw new Error("Cloud recovery allocation cannot be retried");
      createAttempted = true;
      const response = await fetch(input, init);
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  });
  type Target = { temporary: string; root: string; git: RecoveryGitHistory; url: string; env: NodeJS.ProcessEnv; seed: string; paths: Set<string> };
  const targets = new Map<string, Target>();
  // Survives staging cleanup; only identities, never cached readback claims.
  const owned = new Map<string, Array<{ id: string; name: string }>>();
  async function allocatedFence(id: string) {
    if (owned.has(id)) return;
    owned.set(id, []);
    await options.onAllocated?.(id);
  }
  const canonical = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? "null");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  let allocated = false;
  const once = new Letta({ apiKey: token, baseURL: baseUrl, maxRetries: 0, timeout: 30_000 });
  const repositoryClient = new RepositoriesClient({ backend: "cloud", apiKey: token, apiBaseUrl: baseUrl }, once);
  const repositories = options.repositories ?? {
    create: (name: string) => repositoryClient.create({ name }),
    async attach(agentId: string, repositoryId: string, permissions: "read" | "read_write") {
      await once.post(`/v1/agents/${encodeURIComponent(agentId)}/repositories`, { body: { repository_id: repositoryId, permissions } });
    },
    async detach(agentId: string, repositoryId: string) {
      await once.delete(`/v1/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`);
    },
    async verify(agentId: string, repositoryId: string, permissions: "read" | "read_write") {
      const response = await once.get<{ repositories: Array<{ id: string; permissions: string }> }>(`/v1/agents/${encodeURIComponent(agentId)}/repositories`);
      if (!response.repositories.some((r) => r.id === repositoryId && r.permissions === permissions)) throw new Error("Cloud repository attachment permissions could not be verified");
    },
  };
  const readAgentData = options.readAgentData ?? (async (id: string) => {
    const configuration = await once.agents.retrieve(id);
    const attachments = await once.get(`/v1/agents/${encodeURIComponent(id)}/repositories`);
    const exportContext = async (conversationId?: string) => {
      const file = validateAgentFile(await once.agents.exportFile(id, { scrub_messages: false, use_legacy_format: false, ...(conversationId ? { conversation_id: conversationId } : {}) }, { maxRetries: 0 }));
      // Export generation time is an observation, not destination data.
      const { created_at: _createdAt, ...data } = file;
      return data;
    };
    const messages: unknown[] = [];
    for await (const message of once.agents.messages.list(id, { limit: 100 })) {
      if (messages.length >= 100_000) throw new Error("Recovery readback exceeds message limit");
      messages.push(message);
    }
    const conversations: unknown[] = [];
    let after: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await once.conversations.list({ agent_id: id, archive_status: "all", order: "asc", order_by: "created_at", limit: 100, ...(after ? { after } : {}) });
      if (!page.length) break;
      for (const conversation of page) {
        if (seen.has(conversation.id) || seen.size >= 5_000) throw new Error("Recovery readback conversation pagination is incomplete");
        seen.add(conversation.id);
        const history: unknown[] = [];
        for await (const message of once.conversations.messages.list(conversation.id, { limit: 100 })) {
          if (history.length + messages.length >= 100_000) throw new Error("Recovery readback exceeds message limit");
          history.push(message);
        }
        conversations.push({ configuration: conversation, context: await exportContext(conversation.id), messages: history });
      }
      after = page.at(-1)!.id;
      if (page.length < 100) break;
    }
    return { configuration, attachments, context: await exportContext(), messages, conversations };
  });
  function target(id: string) {
    const value = targets.get(id);
    if (!value) throw new Error("Unknown or completed Cloud recovery destination");
    return value;
  }
  function git(t: Target, args: string[], input?: Buffer): string {
    try {
      return execFileSync("git", ["--git-dir", join(t.root, ".git"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], {
        env: { ...t.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Hearthside Recovery", GIT_AUTHOR_EMAIL: "recovery@hearthside.local", GIT_COMMITTER_NAME: "Hearthside Recovery", GIT_COMMITTER_EMAIL: "recovery@hearthside.local" },
        input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      }).trim();
    } catch { throw new Error("Cloud recovery Git operation failed; destination retained, no automatic retry"); }
  }
  // Network Git must yield to Electron's event loop. Never include captured stderr
  // in errors: remote diagnostics may contain authentication material.
  function networkGit(t: Target, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", ["--git-dir", join(t.root, ".git"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
        env: { ...t.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" },
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      }, (error, stdout) => {
        if (error) reject(new Error("Cloud recovery Git operation failed; destination retained, no automatic retry"));
        else resolve(stdout.trim());
      });
    });
  }
  async function remoteHead(t: Target) {
    const output = await networkGit(t, ["ls-remote", "--refs", t.url, "refs/heads/main"]);
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/main$/.exec(output);
    if (!match) throw new Error("Cloud destination has no unambiguous main seed");
    return match[1]!;
  }
  function write(id: string, path: string, bytes: Buffer, internal = false) {
    const t = target(id);
    if (!isSafeRestorePath(path) || path.split("/").some((p) => p.toLowerCase() === ".git") || (!internal && path.split("/")[0]?.toLowerCase() === "recovery-archives")) throw new Error("Unsafe Cloud recovery path");
    const key = path.toLowerCase();
    if (t.paths.has(key)) throw new Error("Duplicate Cloud recovery path");
    let directory = t.root;
    for (const component of ["", ...path.split("/").slice(0, -1)]) {
      directory = join(directory, component);
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Cloud staging directory");
    }
    const fd = openSync(join(t.root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    t.paths.add(key);
  }
  const sharedAttempts = new Set<string>();
  const adapter: CloudRestoreDestination = {
    capabilities: { gitHistory: "ancestry", agentFile: true },
    async readbackRecovery(id) {
      const shared = observation?.id === id ? observation.shared : owned.get(id);
      if (!shared) throw new Error("Recovery readback requires an owned destination");
      await assertConnection?.();
      const artifacts: RecoveryArtifact[] = [];
      const add = (path: string, bytes: Buffer) => {
        if (bytes.length > 256 * 1024 * 1024) throw new Error("Recovery readback artifact exceeds limit");
        artifacts.push({ path, hash: hash(bytes), size: bytes.length });
      };
      const initialData = canonical(await readAgentData(id));
      add("agent/configuration-and-context.json", initialData);
      for (const repository of [undefined, ...shared]) {
        const temporary = mkdtempSync(join(tmpdir(), "hearthside-cloud-readback-"));
        try {
          const root = join(temporary, "memory"); mkdirSync(root, { mode: 0o700 });
          const url = cloudGitUrl({ baseUrl, token, agentId: id, name: repository?.name ?? "memory", isPrimary: !repository });
          const access = transport?.(id, repository) ?? { url, env: cloudGitEnvironment(url, token) };
          const t: Target = { temporary, root, git: new RecoveryGitHistory(root), ...access, seed: "", paths: new Set() };
          git(t, ["init", "--bare", "--template=", join(root, ".git")]);
          const refs = await networkGit(t, ["ls-remote", "--refs", t.url]);
          const remoteHeadState = await networkGit(t, ["ls-remote", "--symref", t.url, "HEAD"]);
          const main = refs.split("\n").find((line) => line.endsWith("\trefs/heads/main"))?.split("\t")[0];
          if (!main || !/^[a-f0-9]{40}$/.test(main)) throw new Error("Recovery readback lacks a supported primary commit");
          await networkGit(t, ["fetch", "--no-recurse-submodules", "--no-write-fetch-head", t.url, "refs/*:refs/readback/*"]);
          if (git(t, ["rev-parse", "refs/readback/heads/main^{commit}"]) !== main) throw new Error("Recovery repository changed during readback");
          const advertisedHead = remoteHeadState.split("\n").find((line) => /^[a-f0-9]{40}\s+HEAD$/.test(line))?.split(/\s+/)[0];
          if (advertisedHead) {
            await networkGit(t, ["fetch", "--no-recurse-submodules", "--no-write-fetch-head", t.url, "HEAD:refs/readback-head/observed"]);
            if (git(t, ["rev-parse", "refs/readback-head/observed"]) !== advertisedHead) throw new Error("Recovery repository changed during readback");
          }
          git(t, ["fsck", "--connectivity-only", "--no-reflogs"]);
          const prefix = repository ? `repositories/shared-${hash(Buffer.from(repository.id))}` : "repositories/primary";
          add(`${prefix}/refs.json`, canonical({ refs: refs.split("\n").sort(), head: remoteHeadState.split("\n").sort() }));
          const tree = git(t, ["ls-tree", "-r", "-z", "--full-tree", main]);
          for (const entry of tree.split("\0").filter(Boolean)) {
            const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
            if (!match || !isSafeRestorePath(match[3]!)) throw new Error("Recovery readback contains an unsafe tree entry");
            const bytes = execFileSync("git", ["--git-dir", join(root, ".git"), "cat-file", "blob", match[2]!], { env: { ...t.env, GIT_NO_REPLACE_OBJECTS: "1" }, timeout: 30_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
            add(`${prefix}/files/${match[3]}`, bytes);
            if (artifacts.length > 100_000) throw new Error("Recovery readback exceeds file limit");
          }
          if (await networkGit(t, ["ls-remote", "--refs", t.url]) !== refs || await networkGit(t, ["ls-remote", "--symref", t.url, "HEAD"]) !== remoteHeadState) throw new Error("Recovery repository changed during readback");
        } finally { rmSync(temporary, { recursive: true, force: true }); }
      }
      if (hash(canonical(await readAgentData(id))) !== hash(initialData)) throw new Error("Recovery agent changed during readback");
      await assertConnection?.();
      artifacts.sort((a, b) => a.path.localeCompare(b.path));
      const dataMark = hash(canonical(artifacts));
      return { artifacts, dataMark, fingerprint: hash(canonical({ destinationAgentId: id, connectionIdentity, dataMark })) };
    },
    async restoreSharedRepository(id, input) {
      target(id); // Only this operation's newly allocated agent may receive an attachment.
      if (!input.originalId || !input.name || !["read", "read_write"].includes(input.permissions)) throw new Error("Invalid shared repository recovery metadata");
      const attemptKey = `${id}:${input.originalId}`;
      if (sharedAttempts.has(attemptKey)) throw new Error("Shared repository recovery cannot be retried automatically");
      const seen = new Set<string>();
      for (const file of input.files) {
        const key = file.path.toLowerCase();
        if (!isSafeRestorePath(file.path) || file.path.split("/").some((p) => p.toLowerCase() === ".git") || seen.has(key)) throw new Error("Unsafe shared repository recovery path");
        seen.add(key);
      }
      await assertConnection?.();
      sharedAttempts.add(attemptKey);
      const operation = randomUUID();
      // Never reuse the original repository or collide with its name.
      const name = `recovery-${operation}`;
      let created: { id: string; name: string };
      try { created = await repositories.create(name); }
      catch { throw new Error(`Shared repository allocation outcome unknown; no automatic retry. Inspect repository ${name}`); }
      const stagingId = `shared-staging-${operation}`;
      let temporary: string | undefined;
      let attached = false;
      try {
        if (!created.id || created.id === input.originalId || created.name !== name) throw new Error("Cloud did not allocate a fresh shared repository");
        owned.get(id)!.push({ id: created.id, name: created.name });
        // An attach can land even if its response is lost; restore read access in that case too.
        attached = true;
        await repositories.attach(id, created.id, "read_write");
        await repositories.verify(id, created.id, "read_write");
        temporary = mkdtempSync(join(tmpdir(), "hearthside-cloud-shared-recovery-"));
        const root = join(temporary, "memory"); mkdirSync(root, { mode: 0o700 });
        const url = cloudGitUrl({ baseUrl, token, agentId: id, name: created.name, isPrimary: false });
        const access = transport?.(id, created) ?? { url, env: cloudGitEnvironment(url, token) };
        const t: Target = { temporary, root, git: new RecoveryGitHistory(root), ...access, seed: "", paths: new Set() };
        git(t, ["init", "--bare", "--template=", join(root, ".git")]);
        t.seed = await remoteHead(t);
        rmSync(join(root, ".git"), { recursive: true });
        targets.set(stagingId, t);
        for (const file of input.files) write(stagingId, file.path, file.bytes, true);
        if (input.gitBundle) await t.git.importBundle(input.gitBundle);
        await adapter.finalizeRecovery!(stagingId);
        const mapping: SharedRepositoryMapping = { originalId: input.originalId, originalName: input.name, destinationId: created.id, destinationName: created.name, permissions: input.permissions };
        write(id, `recovery-archives/shared-${operation}.json`, Buffer.from(JSON.stringify(mapping)), true);
        return mapping;
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : "Shared recovery failed; partial repository retained"), { destinationAgentId: id, destinationRepositoryId: created.id });
      } finally {
        targets.delete(stagingId);
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        // Never leave a formerly read-only attachment writable, including after failure.
        if (attached && input.permissions === "read") {
          try {
            await repositories.detach(id, created.id);
            await repositories.attach(id, created.id, "read");
            await repositories.verify(id, created.id, "read");
          } catch {
            throw Object.assign(new Error("Shared repository permission restoration failed; inspect retained destination attachment before use"), { destinationAgentId: id, destinationRepositoryId: created.id });
          }
        }
      }
    },
    async abortRecovery(id) {
      const t = targets.get(id);
      if (!t) return;
      targets.delete(id);
      rmSync(t.temporary, { recursive: true, force: true });
    },
    async createInactiveAgent(input) {
      if (allocated) throw new Error("Cloud recovery allocation cannot be retried");
      await assertConnection?.();
      allocated = true;
      const operationTag = `recovery-operation:${randomUUID()}`;
      let id: string;
      let mappings: RestoreMapping[] | undefined;
      const knownAllocations: string[] = [];
      try {
        if (input.agentFile) {
          const api = options.agentFileClient ?? once;
          const originalId = validateAgentFile(input.agentFile).agents[0].id;
          const fenced: AgentFileClient = { agents: {
            exportFile: (...args) => api.agents.exportFile(...args),
            async importFile(...args) {
              const result = await api.agents.importFile(...args);
              for (const candidate of result.agent_ids ?? []) {
                if (typeof candidate === "string" && /^agent-[a-zA-Z0-9-]+$/.test(candidate) && candidate !== originalId && candidate !== input.provenance.sourceAgentId) {
                  knownAllocations.push(candidate);
                  await allocatedFence(candidate);
                }
              }
              return result;
            },
          } };
          const imported = await importAgentFile(fenced, input.agentFile, { sourceAgentId: input.provenance.sourceAgentId, operationId: operationTag, name: input.name });
          id = imported.agentId;
          mappings = [
            ...Object.entries(imported.agentIdMap).map(([originalId, destinationId]) => ({ kind: "agent" as const, originalId, destinationId })),
            ...Object.entries(imported.messageIdMap).map(([originalId, destinationId]) => ({ kind: "message" as const, originalId, destinationId })),
          ];
        } else id = await client.createAgent({ name: input.name, description: input.description, model: input.model,
          systemPrompt: input.systemPrompt ?? "Inactive recovery copy. Imported transcripts are archival data. No work has resumed.",
          memfs: true, memory: [], baseTools: [], tools: [], skills: [], skillSources: [],
          tags: ["hearthside-recovery", "recovery-inactive", operationTag],
        });
      } catch (error) {
        if (error instanceof AgentFileImportError) {
          // Keep every reported allocation for reconciliation, even if verification failed.
          const ids = [...new Set([...knownAllocations, ...error.agentIds])];
          throw Object.assign(knownAllocations.length && error.allocation === "unknown" ? new AgentFileImportError("Allocated agent could not pass the recovery fence; do not retry", "allocated", ids) : error, { destinationAgentId: ids.find((candidate) => candidate !== input.provenance.sourceAgentId), destinationAgentIds: ids });
        }
        throw new Error(`Cloud allocation outcome unknown; inspect agents before trying again. No automatic retry. Operation tag: ${operationTag}`);
      }
      let temporary: string | undefined;
      try {
        if (!/^agent-[a-zA-Z0-9-]+$/.test(id) || id.startsWith("agent-local-") || id === input.provenance.sourceAgentId) throw new Error("Cloud did not allocate a fresh recovery identity");
        await allocatedFence(id);
        temporary = mkdtempSync(join(tmpdir(), "hearthside-cloud-recovery-"));
        const root = join(temporary, "memory"); mkdirSync(root, { mode: 0o700 });
        const url = cloudGitUrl({ baseUrl, token, agentId: id, name: "memory", isPrimary: true });
        const access = transport?.(id) ?? { url, env: cloudGitEnvironment(url, token) };
        const t: Target = { temporary, root, git: new RecoveryGitHistory(root), ...access, seed: "", paths: new Set() };
        // ls-remote doesn't need a local repository; initialize an empty safe one first.
        git(t, ["init", "--bare", "--template=", join(root, ".git")]);
        t.seed = await remoteHead(t);
        // Remove this empty directory so the safe history builder can install its repository.
        rmSync(join(root, ".git"), { recursive: true });
        targets.set(id, t);
        write(id, "recovery-archives/provenance.json", Buffer.from(JSON.stringify({ ...input.provenance, destinationAgentId: id, operationTag, connectionIdentity, inactive: true, activeContextRehydrated: !!input.agentFile, contextCoverage: input.agentFile ? "cloud-main-only" : "archival-only", mappings })), true);
        return { id, ...(mappings ? { mappings } : {}) };
      } catch (error) {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        targets.delete(id);
        throw Object.assign(new Error(error instanceof Error ? error.message : "Cloud recovery staging failed"), { destinationAgentId: id });
      }
    },
    async writeMemoryFile(id, path, bytes) { write(id, path, bytes); },
    async importConversationArchive(id, archive) {
      const archiveId = `archive-${randomUUID()}`;
      const prefix = `recovery-archives/${archiveId}`;
      write(id, `${prefix}/messages.jsonl`, Buffer.from(archive.messages.map((m) => JSON.stringify(m)).join("\n") + (archive.messages.length ? "\n" : "")), true);
      for (const attachment of archive.attachments) {
        if (!/^[a-f0-9]{64}$/.test(attachment.hash) || createHash("sha256").update(attachment.bytes).digest("hex") !== attachment.hash) throw new Error("Archive attachment integrity failure");
        write(id, `${prefix}/attachments/${attachment.hash}`, attachment.bytes, true);
      }
      write(id, `${prefix}/index.json`, Buffer.from(JSON.stringify({ id: archiveId, originalId: archive.originalId, metadata: archive.metadata, provenance: archive.provenance, attachments: archive.attachments.map((a) => a.hash), activeContextRehydrated: false })), true);
      return { id: archiveId };
    },
    async importGitHistory(id, bytes) { await target(id).git.importBundle(bytes); },
    async finalizeRecovery(id) {
      const t = target(id);
      try {
        await assertConnection?.();
        const original = t.git.ancestry;
        await t.git.finalize();
        await networkGit(t, ["fetch", "--no-recurse-submodules", "--no-write-fetch-head", t.url, "refs/heads/main:refs/recovery/cloud-seed"]);
        if (git(t, ["rev-parse", "refs/recovery/cloud-seed^{commit}"]) !== t.seed || await remoteHead(t) !== t.seed) throw new Error("Cloud recovery destination changed; refusing to overwrite it");
        // A fresh agent has exactly one bootstrap commit. Existing histories are not targets.
        if (git(t, ["rev-list", "--count", t.seed]) !== "1") throw new Error("Cloud recovery destination is not a fresh root commit");
        const tree = git(t, ["rev-parse", "HEAD^{tree}"]);
        const commit = git(t, ["commit-tree", tree, "-p", t.seed, ...(original ? ["-p", original] : [])], Buffer.from("Recover validated memory and inert archives\n"));
        await assertConnection?.();
        if (await remoteHead(t) !== t.seed) throw new Error("Cloud recovery destination changed; refusing to overwrite it");
        // Normal fast-forward push only. A concurrent advance fails server-side, never force.
        const historyRefs = git(t, ["for-each-ref", "--format=%(refname)", "refs/recovery/original/"]).split("\n").filter(Boolean);
        await networkGit(t, ["push", t.url, `${commit}:refs/heads/main`, ...historyRefs.map((ref) => `${ref}:${ref}`)]);
        for (const ref of historyRefs) {
          const expected = git(t, ["rev-parse", ref]);
          if (await networkGit(t, ["ls-remote", "--refs", t.url, ref]) !== `${expected}\t${ref}`) throw new Error("Cloud recovery historical reference verification failed");
        }
        await networkGit(t, ["fetch", "--no-recurse-submodules", "--no-write-fetch-head", t.url, "refs/heads/main:refs/recovery/readback"]);
        if (await remoteHead(t) !== commit || git(t, ["rev-parse", "refs/recovery/readback^{commit}"]) !== commit || git(t, ["rev-parse", "refs/recovery/readback^{tree}"]) !== tree) throw new Error("Cloud recovery publication could not be verified; inspect retained destination");
      } finally {
        targets.delete(id);
        rmSync(t.temporary, { recursive: true, force: true });
      }
    },
  };
  return adapter;
}
