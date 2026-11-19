import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { app } from "electron";
import type { ChannelServiceStatus } from "@hearthside/ipc-contract";
import { GatewayLeaseBlockedError, GatewayLeaseHeldError, acquireGatewayLease, gatewayLeasePath, reclaimStaleGatewayLease, recoverGatewayLease, terminateGateway, type GatewayLease } from "./gateway-lifecycle";
import { homedir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { runtimeChildEnv } from "../runtime/child-env";
import { resolveLettaCli, resolveRuntimeHome } from "../runtime/paths";
import { parkForeignBotsBeforeStart } from "./channel-prepark";
import { withoutBotContext } from "./channel-locks";

/**
 * Hearthside: the runtime's channel gateway (Telegram, Discord), run beside
 * Hearthside's own runtime. The gateway takes channel commands on its stdin
 * from whoever starts it (the runtime does this itself only in its listener
 * mode), and connects to the runtime as a client to deliver messages.
 *
 * The runtime requires its access token as a header, which the gateway can't
 * send, so the gateway connects through a small relay on this computer: a
 * secret, loopback-only address that adds the token on the way through.
 */

const CHANNELS = "telegram,discord";
const READY = "CHANNEL_GATEWAY_READY";
const RESPONSE = "CHANNEL_GATEWAY_RESPONSE ";
const EVENT = "CHANNEL_GATEWAY_EVENT ";

let eventListener: ((event: Record<string, unknown>) => void) | null = null;
/** Hearthside: told about channel service events (e.g. a new Discord channel chat). */
export function setGatewayEventListener(listener: (event: Record<string, unknown>) => void): void {
  eventListener = listener;
}
const START_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Where the channel service connects, and how it reaches the same backend as
 * the runtime: env (local mode, or a Cloud key and address) and, for "Sign in
 * with Letta", the access token handed over the private IPC channel the
 * runtime also uses. Without these it assumes Letta Cloud with no key.
 */
type Target = {
  url: string;
  token: string;
  env?: Record<string, string>;
  credentials?: { current: () => string; subscribe: (listener: (token: string) => void) => () => void };
};
type Pending = { resolve: (messages: Array<Record<string, unknown>>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let target: Target | null = null;
let running: Promise<Gateway> | null = null;
let wanted = false;
let generation = 0;
let cancelStarting: (() => void) | null = null;
let active: Gateway | null = null;
// A rejected barrier remains latched: no replacement may start after unverified death.
let stopping: Promise<void> = Promise.resolve();


let status: ChannelServiceStatus = { state: "off", revision: 0 };
const statusListeners = new Set<(status: ChannelServiceStatus) => void>();
export function channelServiceStatus(): ChannelServiceStatus {
  return status;
}
export function onChannelServiceStatus(listener: (status: ChannelServiceStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}
function setServiceStatus(next: Omit<ChannelServiceStatus, "revision">): void {
  const same = next.state === status.state && (next.reason ?? null) === (status.reason ?? null)
    && (next.nextRetryAt ?? null) === (status.nextRetryAt ?? null) && (next.recovered ?? null) === (status.recovered ?? null);
  if (same) return;
  status = { ...next, revision: status.revision + 1 };
  for (const listener of statusListeners) {
    try { listener(status); } catch (error) { console.warn(`[channels] status listener failed: ${String(error)}`); }
  }
}
/** Shown to the person: our own messages, bounded. */
const reasonText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

// One timer, one attempt in flight, fenced to the generation that scheduled it.
// A start is retried; channel commands that failed meanwhile are not resent.
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const BLOCKED_RETRY_MS = 300_000;
let retryTimer: NodeJS.Timeout | null = null;
let attempts = 0;
function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}
function scheduleRetry(epoch: number, error: unknown): void {
  cancelRetry();
  if (shuttingDown || !wanted || !target || epoch !== generation) return;
  const blocked = error instanceof GatewayLeaseBlockedError;
  const delay = blocked ? BLOCKED_RETRY_MS : (RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)] ?? BLOCKED_RETRY_MS);
  attempts += 1;
  setServiceStatus({ state: blocked ? "blocked" : "failed", reason: reasonText(error), nextRetryAt: Date.now() + delay });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (shuttingDown || !wanted || !target || epoch !== generation) return;
    // A failure here schedules the next attempt through ensureGateway's own path.
    void ensureGateway().catch(() => undefined);
  }, delay);
}

type Gateway = { proc: ChildProcess; relay: WebSocketServer; pending: Map<string, Pending>; closed: boolean; dispose: (error: Error) => void };

function closeRelay(server: WebSocketServer): void {
  for (const client of server.clients) client.terminate();
  server.close();
}

/** Where the gateway's bundled Telegram/Discord libraries are. */
function channelRuntimeRoot(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "channel-runtimes")]
    : // Development: out/main/ sits two levels below apps/desktop/.
      [join(__dirname, "..", "..", "build", "channel-runtimes"), join(app.getAppPath(), "build", "channel-runtimes")];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

/** The runtime to use; restarts the gateway when it changes. */
export function setGatewayTarget(next: Target | null, startNow: boolean): void {
  target = next;
  void stopGateway().catch((error: Error) => console.warn(`[channels] ${error.message}`));
  attempts = 0;
  wanted = startNow;
  if (next && startNow) void ensureGateway().catch((error: Error) => console.warn(`[channels] ${error.message}`));
}

/**
 * Hearthside: a person's answer to a blocked or stopped service. Moves a lease
 * aside only when nothing that could own it is running (gateway-lifecycle.ts),
 * then starts the service again and waits for it.
 */
export async function recoverChannelService(): Promise<ChannelServiceStatus> {
  if (shuttingDown) throw new Error("Hearthside is closing.");
  if (!target) throw new Error("Not connected to the runtime.");
  if (active && !active.closed) throw new Error("The channel service is running.");
  // Inspection takes time. A stop or a new connection meanwhile wins: nothing
  // is moved and nothing is started for the world this request came from.
  const epoch = generation;
  const upstream = target;
  const home = resolveRuntimeHome().home ?? homedir();
  const current = () => !shuttingDown && epoch === generation && target === upstream && (resolveRuntimeHome().home ?? homedir()) === home;
  const stopped = () => new Error("The channel service was stopped.");
  const path = gatewayLeasePath(home);
  if (existsSync(path)) {
    const moved = await recoverGatewayLease(path, undefined, undefined, { beforeMove: () => { if (!current()) throw stopped(); } });
    console.warn(`[channels] the channel service lease was moved aside by request: ${basename(moved)}`);
  }
  if (!current()) throw stopped();
  cancelRetry();
  attempts = 0;
  wanted = true;
  await ensureGateway();
  return status;
}

function startRelay(upstream: Target): Promise<{ server: WebSocketServer; url: string }> {
  const secret = randomBytes(24).toString("hex");
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (info: { req: { url?: string } }) => info.req.url === `/${secret}`,
    });
    server.on("error", reject);
    server.on("connection", (client) => {
      const remote = new WebSocket(upstream.url, { headers: { Authorization: `Bearer ${upstream.token}` } });
      const queued: Array<WebSocket.RawData> = [];
      client.on("message", (data, isBinary) => {
        if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary: isBinary });
        else queued.push(data);
      });
      remote.on("open", () => {
        for (const data of queued.splice(0)) remote.send(data);
      });
      remote.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
      const closeBoth = () => {
        client.terminate();
        remote.terminate();
      };
      client.on("close", closeBoth);
      remote.on("close", closeBoth);
      client.on("error", closeBoth);
      remote.on("error", closeBoth);
    });
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `ws://127.0.0.1:${port}/${secret}` });
    });
  });
}

async function startGateway(upstream: Target, epoch: number): Promise<Gateway> {
  await stopping;
  if (epoch !== generation || shuttingDown) throw new Error("The channel service was stopped.");
  setServiceStatus({ state: "starting" });
  const { server, url } = await startRelay(upstream);
  if (epoch !== generation) {
    closeRelay(server);
    throw new Error("The channel service was stopped.");
  }

  let lease: GatewayLease | null = null;
  let recovered: string | null = null;
  try {
    const path = gatewayLeasePath(resolveRuntimeHome().home ?? homedir());
    try {
      lease = acquireGatewayLease(path);
    } catch (error) {
      if (!(error instanceof GatewayLeaseHeldError)) throw error;
      // A lease left behind by an unclean exit: reclaimed only when its record
      // is complete and both its processes are positively gone (inspection is
      // asynchronous; the service may have been stopped meanwhile).
      recovered = await reclaimStaleGatewayLease(path);
      if (epoch !== generation || shuttingDown) throw new Error("The channel service was stopped.");
      lease = acquireGatewayLease(path);
      console.warn(`[channels] recovered the channel service lease: ${recovered}`);
    }
    const parked = parkForeignBotsBeforeStart();
    if (parked.length) console.log(`[channels] ${parked.length} bot(s) held until their connection is confirmed`);
  } catch (error) {
    closeRelay(server);
    lease?.(); lease = null;
    // The lease verdict keeps its type: a blocked lease is retried slowly and shown as such.
    if (error instanceof GatewayLeaseBlockedError) throw error;
    throw new Error(`The channel service didn't start: couldn't check which bots belong here (${error instanceof Error ? error.message : String(error)}).`);
  }
  let proc: ChildProcess;
  const credentials = upstream.credentials;
  try {
    const root = channelRuntimeRoot();
    const env = runtimeChildEnv({ ...upstream.env, ...(root ? { LETTA_CHANNEL_RUNTIME_ROOT: root } : {}) });
    if (credentials) {
      env.LETTA_DESKTOP_CREDENTIALS_IPC = "1";
      delete env.LETTA_API_KEY;
    }
    proc = spawn(
      process.execPath,
      [resolveLettaCli(), "channel-gateway", "--app-server-url", url, "--channels", CHANNELS, "--allow-startup-errors"],
      { env, stdio: credentials ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  } catch (error) {
    closeRelay(server);
    lease?.(); lease = null;
    throw error;
  }
  const owned = lease;
  let unsubscribe: (() => void) | undefined;
  return new Promise((resolve, reject) => {
    const gateway: Gateway = { proc, relay: server, pending: new Map(), closed: false, dispose };
    active = gateway;
    let terminationFailed = false;
    let ready = false;
    function dispose(error: Error): void {
      if (gateway.closed) return;
      gateway.closed = true;
      // Establish the death barrier before invoking any fallible cleanup hook.
      stopping = terminateGateway(proc).then(() => {
        owned?.();
        if (active === gateway) active = null;
      });
      // Keep the rejection on the barrier for shutdown/start callers, but avoid
      // an unhandled rejection when disposal came from a stream callback.
      void stopping.catch((failure: Error) => { terminationFailed = true; console.warn(`[channels] ${failure.message}`); });
      clearTimeout(timer);
      for (const cleanup of [() => unsubscribe?.(), () => closeRelay(server)]) {
        try { cleanup(); } catch (failure) { console.warn(`[channels] Cleanup failed: ${String(failure)}`); }
      }
      for (const pending of gateway.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      gateway.pending.clear();
      if (epoch === generation) {
        running = null;
        cancelStarting = null;
      }
      reject(error);
      // A service that was up and died is started again while it is wanted;
      // a start that failed is handled by ensureGateway. Stops change the
      // generation first, so they never schedule anything.
      if (ready) scheduleRetry(epoch, error);
    }
    const timer = setTimeout(() => dispose(new Error("The channel service didn't start in time.")), START_TIMEOUT_MS);
    cancelStarting = () => dispose(new Error("The channel service was stopped."));
    proc.once("error", dispose);
    proc.stdin?.on("error", dispose);
    try { if (proc.pid !== undefined) owned?.recordChild(proc.pid); } catch (error) {
      dispose(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (credentials) {
      const send = (accessToken: string) => {
        try {
          if (!gateway.closed && proc.connected) proc.send({ type: "desktop_credentials", accessToken }, (error) => { if (error) dispose(error); });
        } catch (error) {
          dispose(error instanceof Error ? error : new Error(String(error)));
        }
      };
      proc.on("message", (message: unknown) => {
        if (gateway.closed || (message as { type?: unknown } | null)?.type !== "desktop_credentials_ready") return;
        try { send(credentials.current()); } catch (error) { dispose(error instanceof Error ? error : new Error(String(error))); }
      });
      try {
        unsubscribe = credentials.subscribe(send);
        if (gateway.closed) unsubscribe();
      } catch (error) {
        dispose(error instanceof Error ? error : new Error(String(error)));
      }
    }
    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (gateway.closed || epoch !== generation) return;
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === READY) {
          if (ready) continue;
          ready = true;
          cancelStarting = null;
          clearTimeout(timer);
          attempts = 0;
          setServiceStatus({ state: "running", recovered });
          resolve(gateway);
          // Maintenance can issue gateway requests. Publish readiness first;
          // never make startup depend on completion of that maintenance.
          try { withoutBotContext(() => eventListener?.({ type: "hearthside_gateway_ready" })); } catch (error) {
            console.warn(`[channels] Gateway-ready listener failed: ${String(error)}`);
          }
        } else if (line.startsWith(EVENT)) {
          try {
            withoutBotContext(() => eventListener?.(JSON.parse(line.slice(EVENT.length)) as Record<string, unknown>));
          } catch {
            // Not an event line.
          }
        } else if (line.startsWith(RESPONSE)) {
          try {
            const { requestId, response, error } = JSON.parse(line.slice(RESPONSE.length)) as {
              requestId: string;
              response?: { messages?: Array<Record<string, unknown>> };
              error?: string;
            };
            const pending = gateway.pending.get(requestId);
            if (!pending) continue;
            gateway.pending.delete(requestId);
            clearTimeout(pending.timer);
            if (error) pending.reject(new Error(error));
            else pending.resolve(response?.messages ?? []);
          } catch {
            // Not a response line.
          }
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => console.log(`[channels] ${chunk.toString("utf8").trim().slice(0, 500)}`));
    proc.once("exit", (code) => {
      if (terminationFailed && active === gateway) {
        // A late exit can recover a failed stop, but never retroactively turns
        // the rejected shutdown/update attempt into success.
        stopping = Promise.resolve().then(() => {
          owned?.(); active = null;
        });
        void stopping.catch((error: Error) => console.warn(`[channels] ${error.message}`));
      }
      dispose(new Error(`The channel service stopped (code ${code}).`));
    });
  });
}

/** Hearthside: the app is closing; the channel service must not start again. */
let shuttingDown = false;
export async function shutdownGateway(): Promise<void> {
  shuttingDown = true;
  await stopGateway();
}

/** The shutdown did not finish and the app is staying open. */
export function reopenGatewayAfterFailedQuit(): void {
  shuttingDown = false;
}

function ensureGateway(): Promise<Gateway> {
  if (shuttingDown) return Promise.reject(new Error("Hearthside is closing."));
  if (!target) return Promise.reject(new Error("Not connected to the runtime."));
  const epoch = generation;
  const upstream = target;
  // A bot operation may lazily start this shared service. Its IO callbacks and
  // background readiness work must not inherit that operation's reentrant lock.
  running ??= withoutBotContext(() => startGateway(upstream, epoch)).catch((error: Error) => {
    if (epoch === generation) {
      running = null;
      scheduleRetry(epoch, error);
    }
    throw error;
  });
  return running;
}

export async function stopGateway(): Promise<void> {
  generation += 1;
  const current = running;
  running = null;
  wanted = false;
  cancelRetry();
  setServiceStatus({ state: "off" });
  cancelStarting?.();
  cancelStarting = null;
  active?.dispose(new Error("The channel service was stopped."));
  await current?.catch(() => undefined);
  await stopping;
}

/** Send one channel command; returns the runtime's reply message. */
export async function gatewayRequest<T extends Record<string, unknown>>(type: string, body: Record<string, unknown>): Promise<T> {
  wanted = true;
  // A start that failed is waiting for its retry. A command must not start
  // another one in the meantime: the Channels page asks every five seconds, so
  // "Retrying in 300s" was really a full start attempt (a relay, a lease
  // inspection, process probes) every five seconds, with the status flickering
  // between "starting" and "blocked" and the Recover button coming and going.
  // The retry timer, and a person pressing "Try now" or "Recover", are what
  // start it again; until then a command fails at once and says why.
  if (!running && retryTimer) {
    throw new Error(`The channel service isn't running${status.reason ? ` (${status.reason})` : ""}. Hearthside will try again shortly; you can also start it from Channels.`);
  }
  const gateway = await ensureGateway();
  if (gateway.closed) throw new Error("The channel service was stopped.");
  const requestId = randomUUID();
  const command = { kind: "protocol", command: { type, request_id: `${type}-${requestId}`, ...body } };
  const messages = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      gateway.pending.delete(requestId);
      reject(new Error(`The channel service didn't answer (${type}).`));
    }, COMMAND_TIMEOUT_MS);
    gateway.pending.set(requestId, { resolve, reject, timer });
    try {
      if (!gateway.proc.stdin?.writable) throw new Error("The channel service input is closed.");
      gateway.proc.stdin.write(`${JSON.stringify({ type: "command", requestId, command })}\n`, (error) => {
        if (error) gateway.dispose(error);
      });
    } catch (error) {
      clearTimeout(timer);
      gateway.pending.delete(requestId);
      reject(error);
    }
  });
  const reply = messages.find((message) => message.type === `${type}_response`) ?? messages[0];
  if (!reply) throw new Error(`No reply to ${type}.`);
  if (reply.success === false) throw new Error(typeof reply.error === "string" ? reply.error : `${type} failed.`);
  return reply as T;
}

export function gatewayWanted(): boolean {
  return wanted;
}
