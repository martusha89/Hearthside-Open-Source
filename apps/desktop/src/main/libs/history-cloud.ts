import Letta from "@letta-ai/letta-client";
import { LettaAgentClient, RepositoriesClient } from "@letta-ai/letta-agent-sdk";
import { type HistoryCloud, cloudErrorInfo } from "./history-import";
import { currentLettaAccessToken } from "./letta-signin";
import { getConnectionConfig } from "./settings";
import { captureCloudGit } from "./backup/cloud-git";
import { BackupSourceError, backupSourceFailure } from "./backup/diagnostics";

// The Cloud repository API caps depth at 10. History files are only
// two levels deep; requesting 50 fails before resume can inspect uploaded files.
const REPOSITORY_LIST_DEPTH = 10;




/** Reads and listings: wait and try again on a rate limit, a passing server error or a dropped connection. */
async function readWithRetry<T>(work: () => Promise<T>, attempts = 6): Promise<T> {
  let wait = 1_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const info = cloudErrorInfo(error);
      if ((info.kind !== "busy" && info.kind !== "unknown") || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, info.retryAfterMs ?? wait));
      wait = Math.min(wait * 2, 20_000);
    }
  }
}

/**
 * The credential for the account the chats are on: the Letta sign-in first, the
 * saved key only when not signed in. (This used to prefer the key, so with both
 * present an import or a backup went to the key's account while the chats ran on
 * the sign-in's, where the result could not be seen.) While signed in, a sign-in
 * that can't be renewed this minute is an error to retry, never a reason to use
 * the key instead.
 */
async function cloudToken(config: ReturnType<typeof getConnectionConfig>): Promise<string | null> {
  const token = await currentLettaAccessToken();
  if (token) return token;
  if (config.lettaSignedIn) throw new Error("Hearthside couldn't renew your Letta sign-in just now. Check your connection and try again in a moment.");
  return config.apiKey || null;
}

export async function historyCloudAccess(): Promise<HistoryCloud | null> {
  const config = getConnectionConfig();
  if (config.backend !== "cloud") return null;
  const token = await cloudToken(config);
  if (!token) return null;
  const sdk = new LettaAgentClient({ backend: "cloud", apiKey: token, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}) });
  // The same repository API, through a client that never re-sends by itself.
  const once = new Letta({ apiKey: token, maxRetries: 0, ...(config.apiBaseUrl ? { baseURL: config.apiBaseUrl.replace(/\/+$/, "") } : {}) });
  const repositories = new RepositoriesClient({ backend: "cloud", apiKey: token }, once);
  return {
    findRepository: async (name) => {
      for (let offset = 0; offset < 5_000; offset += 100) {
        const page = await readWithRetry(() => sdk.repositories.list({ limit: 100, offset }));
        const match = page.repositories.find((repository) => repository.name === name);
        if (match) return match.id;
        if (!page.hasNextPage) return null;
      }
      return null;
    },
    createRepository: async (name) => (await sdk.repositories.create({ name })).id,
    listPaths: async (repositoryId) => {
      const listed = await readWithRetry(() => repositories.files.list(repositoryId, { depth: REPOSITORY_LIST_DEPTH }));
      return new Set(listed.files.filter((item) => item.type === "file").map((item) => item.path));
    },
    readFile: async (repositoryId, path) => {
      try {
        return (await readWithRetry(() => repositories.files.read(repositoryId, { path }))).content;
      } catch (error) {
        if (cloudErrorInfo(error).kind === "missing") return null;
        throw error;
      }
    },
    createFile: async (repositoryId, path, content) => {
      await repositories.files.create(repositoryId, { path, content });
    },
    updateFile: async (repositoryId, path, content) => {
      await repositories.files.update(repositoryId, { path, content });
    },
    deleteFile: async (repositoryId, path) => {
      await readWithRetry(() => repositories.files.delete(repositoryId, { path }));
    },
    isAttached: async (agentId, repositoryId) => (await readWithRetry(() => sdk.agents.repositories.list(agentId))).some((item) => item.id === repositoryId),
    attach: async (agentId, repositoryId) => {
      // Read-only; attaching also refreshes the agent's prompt so it sees the history.
      await sdk.agents.repositories.attach(agentId, repositoryId, { permissions: "read" });
    },
  };
}

/** Hearthside: caps for one backup's copy of attached repositories. */
const MAX_REPOSITORY_FILES = 5_000;
const MAX_REPOSITORY_BYTES = 200 * 1024 * 1024;



export async function attachedRepositoryFiles(agentId: string): Promise<Array<{ id: string; name: string; isPrimary: boolean; permissions: string; revision: string | null; gitBundle: Buffer | null; refs?: Array<{ name: string; revision: string }>; files: Array<{ path: string; content: string; bytes?: Buffer }>; error?: string }>> {
  const config = getConnectionConfig();
  if (config.backend !== "cloud") return [];
  const token = await cloudToken(config);
  if (!token) throw new Error("Repository capture unavailable: Cloud credentials are missing.");
  const sdk = new LettaAgentClient({ backend: "cloud", apiKey: token, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}) });
  const attached = await readWithRetry(() => sdk.agents.repositories.list(agentId));
  const out: Awaited<ReturnType<typeof attachedRepositoryFiles>> = [];
  let count = 0;
  let bytes = 0;
  for (const repository of attached) {
    const identity = { id: repository.id, name: repository.name, isPrimary: repository.isPrimary, permissions: repository.permissions };
    try {
      if (count >= MAX_REPOSITORY_FILES || bytes >= MAX_REPOSITORY_BYTES) throw new BackupSourceError({ operation: "repository.read", count }, "capture_limit");
      const capture = await captureCloudGit({
        baseUrl: config.apiBaseUrl || "https://api.letta.com", token, agentId,
        name: repository.name, isPrimary: repository.isPrimary,
        maxFiles: MAX_REPOSITORY_FILES - count, maxBytes: MAX_REPOSITORY_BYTES - bytes,
      });
      count += capture.files.length;
      bytes += capture.gitBundle.length + capture.files.reduce((sum, file) => sum + file.bytes.length, 0);
      if (bytes > MAX_REPOSITORY_BYTES) throw new BackupSourceError({ operation: "repository.read", count }, "capture_limit");
      out.push({ ...identity, ...capture });
    } catch (error) {
      // Never persist upstream bodies/URLs or credentials. No partial tree is called
      // complete. The classified message says which way it failed — our own cap reads
      // differently from a 404 or a timeout — in this build's words only.
      out.push({ ...identity, revision: null, gitBundle: null, files: [], error: backupSourceFailure(error, { operation: "repository.read" }).message });
    }
  }
  return out;
}

