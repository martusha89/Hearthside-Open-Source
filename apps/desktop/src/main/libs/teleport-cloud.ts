import type { TeleportTransport } from "./teleport-control";

/**
 * Resolving "Letta Cloud" to a connection a conversation can be moved to.
 *
 * A move is addressed by registered connection ID, and Letta Cloud is not a
 * connection — it is a sandbox that has to exist first. The same maintained
 * endpoints the Agent SDK uses for its own managed sandboxes are used here,
 * over the transport the rest of the teleport code already has:
 *
 * | Step | Call |
 * |---|---|
 * | Provision | `POST /v1/agents/{agentId}/sandboxes` with `{ conversationId? }` |
 * | Keep alive | `POST /v1/sandboxes/{sandboxId}/refresh` with `{ ttlMinutes }` |
 * | Address | resolve the sandbox's `deviceId` to its online connection |
 *
 * The keepalive is not optional and is the reason this is a module rather than
 * one call. A sandbox is created with a short TTL — five minutes — on the
 * understanding that whoever asked for it is about to open a session and keep
 * refreshing it. A teleport destination has no such session: the sandbox sits
 * idle through `waiting_for_source` while the source drains its accepted work,
 * and expires underneath the move unless something refreshes it. So the lease
 * is held here, from the moment the sandbox is provisioned until the move
 * settles, and handed over to the destination session once one exists.
 *
 * Nothing in this module is called unless the person picks Letta Cloud. It
 * provisions real Cloud resources, which is why the only thing the module's
 * tests exercise is its contract against a scripted transport.
 */

/** The SDK's own default: a five-minute lease, refreshed at 80% of it. */
const DEFAULT_TTL_MINUTES = 5;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 1_000;

export type CloudSandbox = {
  sandboxId: string;
  /** The companion it was made for. An agent-scoped sandbox is renewed under this, not under its own ID. */
  agentId: string;
  deviceId: string;
  connectionName: string;
  /** Echoed by Letta; null for an agent-scoped sandbox with no conversation. */
  conversationId: string | null;
  ttlMinutes: number;
};

export type CloudSandboxEnvironment = {
  transport: TeleportTransport;
  /**
   * Resolve a device to the connection it is online on.
   *
   * Injected rather than built here: the app already owns a Cloud client for
   * exactly this, and a second one would be a second set of credentials to get
   * wrong.
   */
  resolveDevice: (deviceId: string) => Promise<{ connectionId: string }>;
  /** Overridable so tests do not wait two minutes for a sandbox that will never appear. */
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
  ttlMinutes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The create response, validated exactly as the SDK validates its own. */
function readSandbox(raw: unknown, ttlMinutes: number, agentId: string, conversationId: string | undefined): CloudSandbox {
  if (!record(raw) || typeof raw.sandboxId !== "string" || typeof raw.deviceId !== "string" || typeof raw.connectionName !== "string") {
    throw new Error("Letta Cloud did not say which sandbox it made, so nothing was moved.");
  }
  const echoed = typeof raw.conversationId === "string" ? raw.conversationId : null;
  // A sandbox made for a different conversation is not this conversation's
  // destination, whatever else the response says.
  if (echoed !== null && echoed !== (conversationId ?? null)) {
    throw new Error("Letta Cloud answered with a sandbox for a different conversation, so nothing was moved.");
  }
  return {
    sandboxId: raw.sandboxId,
    agentId,
    deviceId: raw.deviceId,
    connectionName: raw.connectionName,
    conversationId: echoed,
    ttlMinutes,
  };
}

function refreshIntervalMs(ttlMinutes: number): number {
  return Math.max(1_000, Math.floor(ttlMinutes * 60_000 * 0.8));
}

/** A sandbox lease is retryable while Cloud has not finished starting it. */
function stillStarting(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Remote environment is offline")
    || message.toLowerCase().includes("not found")
    || message.includes("(404)");
}

export type CloudDestination = {
  connectionId: string;
  name: string;
  sandbox: CloudSandbox;
  /**
   * Stop refreshing the sandbox's lease.
   *
   * Called when the move settles, whichever way it settled. Releasing the lease
   * does **not** terminate the sandbox: by then the conversation may be running
   * in it, and this app is not what keeps it alive any more.
   */
  release: () => void;
};

/**
 * Provision this conversation's Cloud sandbox and address it.
 *
 * Returns once the sandbox is online and resolvable, with its lease being held.
 * Every failure path leaves the keepalive stopped.
 */
export async function resolveCloudDestination(
  env: CloudSandboxEnvironment,
  scope: { agentId: string; conversationId: string },
): Promise<CloudDestination> {
  const ttlMinutes = env.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  // "default" is Letta's stand-in for a main chat, not a conversation ID, so an
  // agent-scoped sandbox is what a main chat gets — exactly as the SDK does it.
  const conversationId = scope.conversationId && scope.conversationId !== "default" ? scope.conversationId : undefined;

  const created = await env.transport.post(
    `/v1/agents/${encodeURIComponent(scope.agentId)}/sandboxes`,
    { ...(conversationId ? { conversationId } : {}) },
  );
  const sandbox = readSandbox(created, ttlMinutes, scope.agentId, conversationId);

  let timer: NodeJS.Timeout | null = null;
  const release = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };
  try {
    // Refresh once before waiting: the lease has to outlive the wait for the
    // sandbox to come online, which can take two minutes.
    await refreshCloudSandbox(env, sandbox);
    timer = setInterval(() => {
      void refreshCloudSandbox(env, sandbox).catch(() => {
        // A lease that cannot be renewed is not something to keep retrying
        // against; the move's own status is what reports the outcome.
        release();
      });
    }, refreshIntervalMs(ttlMinutes));
    timer.unref?.();
    const connectionId = await waitForCloudConnection(env, sandbox);
    return { connectionId, name: sandbox.connectionName || "Letta Cloud", sandbox, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Renew a sandbox's lease once. */
export async function refreshCloudSandbox(env: CloudSandboxEnvironment, sandbox: CloudSandbox): Promise<void> {
  // Conversation-scoped and agent-scoped sandboxes are refreshed through
  // different endpoints; the SDK draws the same distinction.
  const path = sandbox.conversationId
    ? `/v1/sandboxes/${encodeURIComponent(sandbox.sandboxId)}/refresh`
    : `/v1/agents/${encodeURIComponent(sandbox.agentId)}/sandboxes/refresh`;
  const raw = await env.transport.post(path, { ttlMinutes: sandbox.ttlMinutes });
  if (!record(raw) || raw.success !== true || typeof raw.sandboxId !== "string") {
    throw new Error("Letta Cloud did not confirm the sandbox lease.");
  }
  if (raw.sandboxId !== sandbox.sandboxId) {
    // Something else now owns this agent's sandbox. Refreshing it further would
    // be keeping someone else's alive while this move expires.
    throw new Error("The Letta Cloud sandbox for this conversation changed owner.");
  }
}

/** Wait for the sandbox to be online, and return the connection it is on. */
async function waitForCloudConnection(env: CloudSandboxEnvironment, sandbox: CloudSandbox): Promise<string> {
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const deadline = now() + (env.readyTimeoutMs ?? READY_TIMEOUT_MS);
  const interval = env.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS;
  let last: unknown;
  for (;;) {
    try {
      const resolved = await env.resolveDevice(sandbox.deviceId);
      if (!resolved.connectionId.startsWith("conn-")) {
        throw new Error("Letta Cloud answered with something that is not a connection ID.");
      }
      return resolved.connectionId;
    } catch (error) {
      last = error;
      if (!stillStarting(error) || now() >= deadline) break;
      await sleep(Math.min(interval, Math.max(0, deadline - now())));
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(`The Letta Cloud sandbox did not come online, so nothing was moved: ${detail}`);
}
