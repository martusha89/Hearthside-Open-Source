import { type ChildProcess, spawn } from "node:child_process";
import { terminateGateway as terminateOwnedChild } from "./gateway-lifecycle";
import { runtimeChildEnv } from "../runtime/child-env";
import { resolveLettaCli } from "../runtime/paths";




export type ComputerState = "off" | "starting" | "connected" | "working" | "reconnecting" | "error";
export type ComputerStatus = { state: ComputerState; name: string | null; error?: string };

export type ComputerBackend = {
  env?: Record<string, string>;
  credentials?: { current: () => string; subscribe: (listener: (token: string) => void) => () => void };
};
export type ComputerIdentity = { name: string; deviceId: string | null; account?: string };

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

let closing = false;
// Keep retired children until actual exit, not until a kill request was sent.
const ownedChildren = new Set<ChildProcess>();
let backend: ComputerBackend | null = null;
let identity: ComputerIdentity | null = null;
type Entry = { proc: ChildProcess; unsubscribe?: () => void; bindCredentials: (target: ComputerBackend) => void };
let current: Entry | null = null;
let desiredKey: string | null = null;
const terminations = new Map<ChildProcess, Promise<void>>();
const failedTerminations = new Set<ChildProcess>();
let generation = 0;
let launchSequence = 0;
let launchIdentity: { deviceId: string; launch: number; account?: string } | null = null;

/** Identity actually supplied to our child, never inferred from a computer name.
 * CLI 0.34.8 lifecycle frames expose state only, not the registered lease ID. */
export function connectedDesktopIdentity(): { deviceId: string; launch: number; account?: string } | null {
  return current && (status.state === "connected" || status.state === "working") && launchIdentity
    ? { ...launchIdentity } : null;
}
let restartTimer: NodeJS.Timeout | null = null;
let backoff = MIN_BACKOFF_MS;
let status: ComputerStatus = { state: "off", name: null };
let stderrTail: string[] = [];
const listeners = new Set<(status: ComputerStatus) => void>();

/** For tests: how the listener process is started. */
let spawner: typeof spawn = spawn;
export function setComputerSpawnerForTests(next: typeof spawn | null): void {
  spawner = next ?? spawn;
  if (next) closing = false;
}

export function computerStatus(): ComputerStatus {
  return status;
}

export function onComputerStatus(listener: (status: ComputerStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: ComputerStatus): void {
  if (next.state === status.state && next.name === status.name && next.error === status.error) return;
  status = next;
  for (const listener of listeners) {
    try {
      listener(status);
    } catch (error) {
      console.warn(`[computer] status listener failed: ${String(error)}`);
    }
  }
}

/** Map one lifecycle line from the runtime to a state; null for anything else. */
export function lifecycleState(line: string): ComputerState | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as { lettaLifecycleProtocol?: unknown; state?: unknown };
    if (event.lettaLifecycleProtocol !== 1 || typeof event.state !== "string") return null;
    if (event.state === "connected" || event.state === "idle") return "connected";
    if (event.state === "working") return "working";
    if (event.state === "reconnecting") return "reconnecting";
    if (event.state === "error") return "error";
    return null;
  } catch {
    return null;
  }
}

/** The environment for the listener: the runtime's, this computer's device id, and never channels. */
export function listenerEnv(base: NodeJS.ProcessEnv, next: ComputerBackend, deviceId: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (deviceId) env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = deviceId;
  for (const name of ["LETTA_RESTORE_ENABLED_CHANNELS", "LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE", "LETTA_RESTORE_CHANNEL_AGENT_SCOPE", "LETTA_DEBUG", "DEBUG"]) delete env[name];
  if (next.credentials) {
    env.LETTA_DESKTOP_CREDENTIALS_IPC = "1";
    delete env.LETTA_API_KEY;
  }
  return env;
}

/**
 * Turn the listener on (with this backend and identity) or off. Called when the
 * connection changes and when the person flips the setting.
 */
export function setComputerListener(next: ComputerBackend | null, on: boolean, who: ComputerIdentity | null): void {
  if (closing) return;
  const enabled = !!next && on && !!who;
  // Compare values rather than wrapper identity; management reconnects recreate wrappers.
  const key = enabled ? JSON.stringify([who.name, who.deviceId, who.account ?? null,
    !!next.credentials, Object.entries(next.env ?? {}).filter(([key]) => !next.credentials || key !== "LETTA_API_KEY").sort(([a], [b]) => a.localeCompare(b))]) : null;
  backend = enabled ? { ...next, env: { ...next.env } } : null;
  identity = who ? { ...who } : null;
  if (key === desiredKey) {
    if (current && backend) current.bindCredentials(backend);
    return;
  }
  desiredKey = key;
  stopProcess();
  backoff = MIN_BACKOFF_MS;
  reconcile();
}

function start(epoch: number): void {
  if (closing || ownedChildren.size || epoch !== generation || !backend || !identity) return;
  const target = backend;
  const who = identity;
  setStatus({ state: "starting", name: who.name });
  stderrTail = [];
  let proc: ChildProcess;
  try {
    const env = listenerEnv(runtimeChildEnv({ ...target.env }), target, who.deviceId);
    proc = spawner(process.execPath, [resolveLettaCli(), "server", "--computer-name", who.name, "--lifecycle-output", "jsonl"], {
      env,
      stdio: target.credentials ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    setStatus({ state: "error", name: who.name, error: error instanceof Error ? error.message : String(error) });
    scheduleRestart(epoch);
    return;
  }
  ownedChildren.add(proc);
  proc.once("exit", () => {
    ownedChildren.delete(proc);
    failedTerminations.delete(proc);
    terminations.delete(proc);
  });
  proc.once("error", () => {
    if (proc.pid === undefined) {
      ownedChildren.delete(proc);
      if (epoch !== generation) reconcile();
    }
  });
  const entry: Entry = { proc, bindCredentials: () => {} };
  current = entry;
  launchIdentity = who.deviceId ? { deviceId: who.deviceId, launch: ++launchSequence, ...(who.account !== undefined ? { account: who.account } : {}) } : null;
  let connectedAt = 0;

  let credentials = target.credentials;
  const send = (accessToken: string) => {
    if (epoch !== generation || current !== entry) return;
    try {
      if (proc.connected) proc.send({ type: "desktop_credentials", accessToken });
    } catch (error) {
      console.warn(`[computer] couldn't pass the sign-in: ${String(error)}`);
    }
  };
  entry.bindCredentials = (next) => {
    const changed = credentials !== next.credentials;
    entry.unsubscribe?.();
    credentials = next.credentials;
    const bound = credentials;
    entry.unsubscribe = bound?.subscribe((token) => { if (credentials === bound) send(token); });
    if (changed && credentials) send(credentials.current());
  };
  proc.on("message", (message: unknown) => {
    if (credentials && (message as { type?: unknown } | null)?.type === "desktop_credentials_ready") send(credentials.current());
  });
  entry.bindCredentials(target);

  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (epoch !== generation || current !== entry) return;
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const state = lifecycleState(line);
      if (!state) continue;
      if (state === "connected" && !connectedAt) connectedAt = Date.now();
      setStatus({ state, name: who.name, ...(state === "error" ? { error: stderrTail.at(-1) ?? "The Letta listener reported an error." } : {}) });
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    if (epoch !== generation || current !== entry) return;
    for (const line of chunk.toString("utf8").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      stderrTail = [...stderrTail, line].slice(-5);
      console.warn(`[computer] ${line}`);
    }
  });
  proc.once("error", (error) => {
    if (epoch !== generation || current !== entry) return;
    setStatus({ state: "error", name: who.name, error: error.message });
    if (proc.pid === undefined) {
      entry.unsubscribe?.();
      current = null;
      scheduleRestart(epoch);
    }
  });
  proc.once("exit", (code) => {
    entry.unsubscribe?.();
    if (current === entry) current = null;
    if (epoch !== generation) { reconcile(); return; }
    // A run that stayed connected for a while starts the waiting over.
    if (connectedAt && Date.now() - connectedAt > 60_000) backoff = MIN_BACKOFF_MS;
    setStatus({ state: "reconnecting", name: who.name, error: stderrTail.at(-1) ?? `The Letta listener stopped (${code ?? "signal"}).` });
    scheduleRestart(epoch);
  });
}

function scheduleRestart(epoch: number): void {
  if (restartTimer) clearTimeout(restartTimer);
  const wait = backoff;
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start(epoch);
  }, wait);
}

function stopProcess(): void {
  generation += 1;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const old = current;
  current = null;
  if (!old) return;
  old.unsubscribe?.();
  terminate(old.proc);
}

function terminate(proc: ChildProcess): Promise<void> {
  const existing = terminations.get(proc);
  if (existing) return existing;
  const pending = terminateOwnedChild(proc);
  terminations.set(proc, pending);
  void pending.then(() => { terminations.delete(proc); }, () => {
    if (!ownedChildren.has(proc)) return;
    failedTerminations.add(proc);
    reconcile();
  });
  return pending;
}

function reconcile(): void {
  if (current) return;
  if (failedTerminations.size) {
    setStatus({ state: "error", name: identity?.name ?? status.name,
      error: "The owned computer listener did not exit; replacement and shutdown are blocked." });
  } else if (ownedChildren.size) {
    setStatus({ state: "reconnecting", name: identity?.name ?? status.name });
  } else if (closing || !backend || !identity) {
    setStatus({ state: "off", name: identity?.name ?? null });
  } else {
    start(generation);
  }
}

/** Hearthside is closing: stop for good. */
export function shutdownComputerListener(): void {
  closing = true;
  backend = null;
  desiredKey = null;
  stopProcess();
  reconcile();
}

/** Quit/update barrier also covers retired listeners from an earlier rename or
 * connection switch. It never signals processes not spawned by this module. */
export async function computerListenerStopped(): Promise<void> {
  if (!closing) throw new Error("The computer listener must be shut down before waiting for exit.");
  try { await Promise.all([...ownedChildren].map((proc) => terminate(proc))); }
  catch { throw new Error("The owned computer listener did not exit; shutdown and installation are blocked."); }
}
