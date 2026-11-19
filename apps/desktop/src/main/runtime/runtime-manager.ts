import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** Which letta-code backend the runtime uses: local storage or Letta Cloud. */
export type Backend = "local" | "api";
import treeKill from "tree-kill";
import { RestartPolicy } from "./restart-policy";
import { runtimeChildEnv } from "./child-env";
import { resolveLettaCli, resolveRuntimeHome, runtimeStateDir } from "./paths";
import { clearStaleSchedulerLease } from "./scheduler-lease";

// Launch approach follows the Agent SDK's public `startLocalAppServer`
// (Apache-2.0): run letta.js with `server --listen`, wait for the
// "Listening on ws://…" line, then connect. We add capability-token auth,
// an isolated home, process-tree shutdown and automatic recovery.

/** Same readiness line the Agent SDK waits for. */
const LISTENING_LINE = /^Listening on\s+(ws:\/\/\S+)\s*$/m;
const STARTUP_LIMIT_MS = 120_000;
/** Keep only the end of the output for error messages. */
const OUTPUT_TAIL_CHARS = 4_000;

export interface RuntimeEndpoint {
  url: string;
  token: string;
}

export interface StartOptions {
  backend: Backend;
  /** Extra environment for the runtime, e.g. LETTA_API_KEY in Cloud mode. */
  env?: Record<string, string>;
  /**
   * "Sign in with Letta": hand the runtime an OAuth access token over its
   * desktop-credentials IPC channel instead of an API key, and push refreshed
   * tokens as they arrive (letta-code src/auth/desktop-credentials.ts).
   */
  credentials?: CredentialSource;
}

export interface CredentialSource {
  current(): string;
  subscribe(listener: (accessToken: string) => void): () => void;
}

type Events = {
  /** Listening; connect to it. Fires again after every recovery. */
  ready: [RuntimeEndpoint];
  /** The process ended. `expected` is true when we asked it to stop. */
  exited: [{ expected: boolean; reason?: string }];
  recovering: [{ delayMs: number; attempt: number }];
  /** Recovery budget exhausted; needs a manual start. */
  stuck: [string];
  log: [{ level: "info" | "error"; line: string }];
};

function stopTree(pid: number): void {
  treeKill(pid, "SIGTERM", (error) => {
    // Fall back to a hard kill if the polite signal could not be delivered.
    if (error) treeKill(pid, "SIGKILL");
  });
}

export class RuntimeManager extends EventEmitter<Events> {
  private process: ChildProcess | null = null;
  private config: StartOptions | null = null;
  private readonly policy = new RestartPolicy();
  private recoveryTimer: NodeJS.Timeout | null = null;
  private readonly stopping = new WeakSet<ChildProcess>();
  private recoveries = 0;
  private clearStartup: (() => void) | null = null;
  private cleanupAuth: (() => void) | null = null;
  private unsubscribeCredentials: (() => void) | null = null;
  private exiting: Promise<void> = Promise.resolve();

  get restartCount(): number {
    return this.recoveries;
  }

  start(options: StartOptions): void {
    this.stop();
    this.config = options;
    if (options.credentials) {
      // Push every refreshed token to whichever runtime process is current.
      this.unsubscribeCredentials = options.credentials.subscribe((accessToken) => {
        const proc = this.process;
        if (proc) this.sendCredentials(proc, accessToken);
      });
    }
    this.policy.clear();
    this.recoveries = 0;
    this.launch();
  }

  stop(): void {
    this.cleanupAuth?.();
    this.cleanupAuth = null;
    this.clearStartup?.();
    this.clearStartup = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.unsubscribeCredentials?.();
    this.unsubscribeCredentials = null;
    this.config = null;
    const proc = this.process;
    this.process = null;
    if (proc) this.stopping.add(proc);
    if (proc?.pid !== undefined && proc.exitCode === null) {
      this.exiting = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      stopTree(proc.pid);
    }
  }

  /**
   * Hearthside: resolves once the last stopped runtime process has exited (or
   * after `limitMs`). Installing an update must wait for it: Windows can't
   * replace Hearthside.exe while a runtime started from it is still running.
   */
  whenStopped(limitMs: number): Promise<void> {
    return Promise.race([this.exiting, new Promise<void>((resolve) => setTimeout(resolve, limitMs).unref?.())]);
  }

  /** Unlike the updater's best-effort wait, recovery must prove process exit. */
  whenStoppedStrict(limitMs: number): Promise<void> {
    if (this.process || this.config) return Promise.reject(new Error("Runtime has not been stopped."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime did not exit; native recovery was not published.")), limitMs);
      this.exiting.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private sendCredentials(proc: ChildProcess, accessToken: string): void {
    if (this.process !== proc || !proc.connected) return;
    const report = (error: unknown) => this.emit("log", { level: "error", line: `Could not hand the runtime its sign-in: ${String(error)}` });
    try {
      proc.send({ type: "desktop_credentials", accessToken }, (error) => { if (error) report(error); });
    } catch (error) {
      report(error);
    }
  }

  private launch(): void {
    const config = this.config;
    if (!config) return;

    // A fresh capability token per launch; only main and the runtime see it.
    const stateDir = runtimeStateDir();
    mkdirSync(stateDir, { recursive: true });
    const token = randomBytes(32).toString("hex");
    // Never reuse the legacy ws-token path or follow an existing token symlink.
    // mkdtemp creates a private POSIX directory; Windows still relies on inherited ACLs.
    const authDir = mkdtempSync(join(stateDir, "ws-auth-"));
    const tokenPath = join(authDir, "token");
    let cleaned = false;
    const cleanupAuth = () => {
      if (cleaned) return;
      try {
        // Only remove this launch's newly-created scratch directory.
        rmSync(authDir, { recursive: true, force: true });
        cleaned = true;
      } catch (error) {
        this.emit("log", { level: "error", line: `Could not remove runtime authentication scratch files: ${String(error)}` });
      }
    };
    this.cleanupAuth = cleanupAuth;
    const credentials = config.credentials;
    let proc: ChildProcess;
    try {
      writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });

      // Hearthside: a stale schedule claim (process id reused on Windows) would stop schedules firing.
      try {
        if (clearStaleSchedulerLease(resolveRuntimeHome().home ?? homedir())) {
          this.emit("log", { level: "info", line: "Cleared a stale schedule claim so schedules can run." });
        }
      } catch (error) {
        this.emit("log", { level: "error", line: `Couldn't check the schedule claim: ${String(error)}` });
      }
      const env = runtimeChildEnv(config.env);
      if (credentials) {
        env.LETTA_DESKTOP_CREDENTIALS_IPC = "1";
        delete env.LETTA_API_KEY;
      }

      proc = spawn(
        process.execPath,
        [
          resolveLettaCli(),
          "--backend", config.backend,
          "server",
          "--listen", "ws://127.0.0.1:0",
          "--ws-auth", "capability-token",
          "--ws-token-file", tokenPath,
        ],
        { env, stdio: credentials ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      cleanupAuth();
      throw error;
    }
    this.process = proc;
    if (credentials) {
      // The runtime asks for its first token at startup, then accepts updates.
      proc.on("message", (message: unknown) => {
        if (this.process !== proc || (message as { type?: unknown } | null)?.type !== "desktop_credentials_ready") return;
        try {
          this.sendCredentials(proc, credentials.current());
        } catch (error) {
          this.emit("log", { level: "error", line: `Could not hand the runtime its sign-in: ${String(error)}` });
        }
      });
    }
    const launchedAt = Date.now();
    let tail = "";
    let listening = false;

    const record = (level: "info" | "error", chunk: string) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.emit("log", { level, line });
    };

    const startupGuard = setTimeout(() => {
      if (this.process !== proc || listening || proc.pid === undefined) return;
      cleanupAuth();
      this.emit("log", { level: "error", line: `Runtime was not ready after ${STARTUP_LIMIT_MS / 1000}s; stopping it.` });
      stopTree(proc.pid);
    }, STARTUP_LIMIT_MS);
    this.clearStartup = () => clearTimeout(startupGuard);

    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      record("info", chunk);
      if (listening || this.process !== proc || this.stopping.has(proc)) return;
      const url = tail.match(LISTENING_LINE)?.[1];
      if (url) {
        listening = true;
        clearTimeout(startupGuard);
        // The CLI resolves token-file authentication before announcing readiness.
        cleanupAuth();
        this.emit("ready", { url, token });
      }
    });
    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => record("error", chunk));
    let ended = false;
    const onEnded = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return;
      ended = true;
      cleanupAuth();
      clearTimeout(startupGuard);
      if (this.process !== proc) return;
      this.process = null;
      const expected = this.stopping.has(proc);
      if (expected) {
        this.emit("exited", { expected: true });
        return;
      }
      const lastLines = tail.trim().split(/\r?\n/).slice(-5).join("\n");
      this.emit("exited", {
        expected: false,
        reason: `The runtime stopped unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}).${lastLines ? `\n${lastLines}` : ""}`,
      });
      if (this.config === config) this.recover(Date.now() - launchedAt);
    };
    proc.once("exit", onEnded);
    proc.once("error", (error) => {
      this.emit("log", { level: "error", line: `Could not start the runtime: ${error.message}` });
      // Failed spawns emit error and close, but never exit.
      if (proc.pid === undefined) onEnded(null, null);
    });
  }

  private recover(uptimeMs: number): void {
    const decision = this.policy.decide(Date.now(), uptimeMs);
    if (decision.action === "give-up") {
      this.emit("stuck", `The runtime failed ${decision.failures} times in a row. Check the log, then start it again.`);
      return;
    }
    this.recoveries += 1;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      try {
        this.launch();
      } catch (error) {
        this.emit("stuck", `Could not restart the runtime: ${String(error)}`);
      }
    }, decision.delayMs);
    this.emit("recovering", { delayMs: decision.delayMs, attempt: decision.attempt });
  }
}
