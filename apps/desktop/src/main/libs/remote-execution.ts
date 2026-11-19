import { LettaAgentClient, type Computer } from "@letta-ai/letta-agent-sdk";
import type { ExecutionComputer } from "@hearthside/ipc-contract";
import { currentLettaAccessToken } from "./letta-signin";
import { getConnectionConfig, getSettings } from "./settings";
import { HelperAwareWebSocket } from "./helper-feed";
import { connectedDesktopIdentity } from "./computer-listener";

/** Cloud state and execution location are separate. Never omit an explicit
 * computer on a remote session: the SDK would otherwise create a sandbox. */
export function executionTarget() {
  return getConnectionConfig().backend === "cloud" ? getSettings().executionComputer ?? null : null;
}

export async function executionClient(): Promise<LettaAgentClient> {
  const config = getConnectionConfig();
  if (config.backend !== "cloud") throw new Error("Connected computers are available with Letta Cloud.");
  const token = config.lettaSignedIn ? await currentLettaAccessToken() : config.apiKey;
  if (!token) throw new Error("Sign in to Letta Cloud before choosing a computer.");
  return new LettaAgentClient({
    backend: "cloud",
    apiKey: token,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    WebSocket: HelperAwareWebSocket as never,
    webSocketAuth: "header",
  });
}

/** Explicit per-chat opt-in only. Never enables or starts Remote Access. */
export async function prepareDesktopListenerExecution(signal: AbortSignal) {
  const revision = getSettings().connectionRevision;
  const source = connectedDesktopIdentity();
  const assertSource = () => {
    signal.throwIfAborted();
    const current = connectedDesktopIdentity();
    if (getConnectionConfig().backend !== "cloud" || getSettings().reachableComputer !== true ||
        revision !== getSettings().connectionRevision || !source || !current ||
        source.account !== revision || current.account !== revision ||
        source.deviceId !== current.deviceId || source.launch !== current.launch) {
      throw new Error("This computer's opted-in listener is unavailable or changed. Nothing was sent elsewhere.");
    }
  };
  assertSource();
  const client = await executionClient();
  try {
    assertSource();
    const computer = await client.computers.get(source!.deviceId);
    assertSource();
    if (computer.deviceId !== source!.deviceId || computer.status !== "online" ||
        !computer.connectionId?.startsWith("conn-")) {
      throw new Error("This computer's registered listener could not be verified online. Nothing was sent elsewhere.");
    }
    const connectionId = computer.connectionId;
    // Repeat immediately before admission: preparation can include asynchronous
    // approval recovery and busy-owner waits. Never silently follow a new lease.
    const validateSource = async () => {
      assertSource();
      const latest = await client.computers.get(source!.deviceId);
      assertSource();
      if (latest.deviceId !== source!.deviceId || latest.status !== "online" || latest.connectionId !== connectionId) {
        throw new Error("This computer's listener lease changed. Retry explicitly; nothing was sent elsewhere.");
      }
    };
    return { client, computer: { connectionId }, connectionId, name: computer.name, sameMachine: true as const, validateSource };
  } catch (error) {
    await client.close();
    throw error;
  }
}

function summary(computer: Computer): ExecutionComputer {
  return {
    deviceId: computer.deviceId,
    name: computer.name,
    status: computer.status,
    ...(typeof computer.metadata?.workingDirectory === "string"
      ? { workingDirectory: computer.metadata.workingDirectory }
      : {}),
  };
}

/** Historical registrations share a device ID. Never let API/page order make
 * an old offline name replace the live listener. Keep the complete winner so
 * its name, status and metadata all describe the same registration. */
function preferRegistration(candidate: Computer, current: Computer): boolean {
  const live = (computer: Computer) => computer.status === "online" && Boolean(computer.connectionId);
  if (live(candidate) !== live(current)) return live(candidate);
  const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : -1;
  for (const field of ["lastSeenAt", "connectedAt"] as const) {
    const next = timestamp(candidate[field]);
    const previous = timestamp(current[field]);
    if (next !== previous) return next > previous;
  }
  // No freshness evidence distinguishes these registrations. Use a stable
  // tie-break rather than silently depending on which page arrived last.
  return candidate.id < current.id;
}

export async function listExecutionComputers(): Promise<ExecutionComputer[]> {
  const client = await executionClient();
  try {
    const devices = new Map<string, Computer>();
    const cursors = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await client.computers.list({ limit: 100, onlineOnly: false, ...(after ? { after } : {}) });
      for (const computer of page.computers) {
        if (!computer.deviceId) continue;
        const current = devices.get(computer.deviceId);
        if (!current || preferRegistration(computer, current)) devices.set(computer.deviceId, computer);
      }
      if (!page.hasNextPage) break;
      const cursor = page.computers.at(-1)?.id;
      if (!cursor || cursors.has(cursor)) throw new Error("Letta's computer list did not advance. Refresh and try again.");
      cursors.add(cursor);
      after = cursor;
    }
    return [...devices.values()].map(summary).sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
  }
}

/** A fresh client uses current credentials; a fresh device lookup follows lease
 * rotation. The caller owns cleanup after a successful preparation. */
export async function prepareRemoteExecution(signal: AbortSignal, target = executionTarget()) {
  if (!target) return null;
  const revision = getSettings().connectionRevision;
  const client = await executionClient();
  const assertAccount = () => {
    signal.throwIfAborted();
    if (revision !== getSettings().connectionRevision || getConnectionConfig().backend !== "cloud") throw new Error("Account changed before execution admission.");
  };
  try {
    assertAccount();
    const computer = await client.computers.get(target.deviceId);
    signal.throwIfAborted();
    if (computer.deviceId !== target.deviceId) throw new Error("Letta returned a different computer. Select the intended computer again.");
    if (computer.status !== "online" || !computer.connectionId) {
      throw new Error(`${target.name} is offline. Start its Letta listener or explicitly choose another computer. Nothing was sent elsewhere.`);
    }
    assertAccount();
    const connectionId = computer.connectionId;
    const validateSource = async () => {
      assertAccount();
      const latest = await client.computers.get(target.deviceId);
      assertAccount();
      if (latest.deviceId !== target.deviceId || latest.status !== "online" || latest.connectionId !== connectionId) {
        throw new Error("The selected computer's listener lease changed. Retry explicitly; nothing was sent elsewhere.");
      }
    };
    return {
      client, validateSource,
      computer: { connectionId },
      connectionId,
      name: computer.name,
      // Never pass this desktop's folder to a different operating system.
      cwd: typeof computer.metadata?.workingDirectory === "string" ? computer.metadata.workingDirectory : undefined,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
