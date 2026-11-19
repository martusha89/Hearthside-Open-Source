import type { RuntimeEndpoint, StartOptions } from "../runtime/runtime-manager";
import { RuntimeManager } from "../runtime/runtime-manager";

/**
 * The letta-code app server Hearthside owns (Local and Letta Cloud modes).
 * Wraps RuntimeManager: token-protected loopback server, sandbox home,
 * crash recovery. The first start resolves once it is listening.
 */
export interface OwnedServer {
  readonly endpoint: RuntimeEndpoint;
  close(): void;
  /** The runtime died unexpectedly; RuntimeManager is already recovering it. */
  onLost(listener: (reason: string) => void): void;
  /** The runtime is listening again, at a new endpoint. */
  onRecovered(listener: (endpoint: RuntimeEndpoint) => void): void;
  /** Recovery gave up; a manual reconnect is needed. */
  onStuck(listener: (reason: string) => void): void;
}

const manager = new RuntimeManager();
manager.setMaxListeners(20);

/** Hearthside: wait (up to `limitMs`) for a stopped runtime process to exit. */
export function runtimeStopped(limitMs: number): Promise<void> {
  return manager.whenStopped(limitMs);
}
export function runtimeStoppedStrict(limitMs: number): Promise<void> {
  return manager.whenStoppedStrict(limitMs);
}

export function runtimeLog(listener: (entry: { level: "info" | "error"; line: string }) => void): () => void {
  manager.on("log", listener);
  return () => manager.off("log", listener);
}

export function startOwnedServer(options: StartOptions, signal?: AbortSignal): Promise<OwnedServer> {
  if (signal?.aborted) return Promise.reject(new Error("The runtime connection was cancelled."));
  return new Promise((resolve, reject) => {
    let current: RuntimeEndpoint | null = null;
    let closed = false;
    let lost: ((reason: string) => void) | null = null;
    let recovered: ((endpoint: RuntimeEndpoint) => void) | null = null;
    let stuckListener: ((reason: string) => void) | null = null;

    const detach = () => {
      manager.off("ready", onReady);
      manager.off("exited", onExited);
      manager.off("stuck", onStuck);
      signal?.removeEventListener("abort", onAbort);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      detach();
      manager.stop();
    };
    const onAbort = () => {
      close();
      reject(new Error("The runtime connection was cancelled."));
    };
    const onReady = (endpoint: RuntimeEndpoint) => {
      if (closed) return;
      const first = current === null;
      current = endpoint;
      if (first) {
        resolve({
          get endpoint() {
            return current as RuntimeEndpoint;
          },
          close,
          onLost: (listener) => {
            lost = listener;
          },
          onRecovered: (listener) => {
            recovered = listener;
          },
          onStuck: (listener) => {
            stuckListener = listener;
          },
        });
      } else {
        recovered?.(endpoint);
      }
    };
    // Why the runtime last died before it was ever listening. Nobody is told
    // at the time (it is retried), so it is kept for the give-up message.
    let startFailure: string | null = null;
    const onExited = ({ expected, reason }: { expected: boolean; reason?: string }) => {
      if (closed || expected) return;
      if (current === null) {
        startFailure = reason ?? null;
        return;
      }
      lost?.(reason ?? "The runtime stopped unexpectedly.");
    };
    const onStuck = (reason: string) => {
      if (closed) return;
      if (current === null) {
        close();
        // "Failed 5 times in a row" alone gave nothing to act on; add what
        // the runtime said as it went (its exit and last lines of output).
        reject(new Error(startFailure ? `${reason}\n${startFailure}` : reason));
      } else {
        stuckListener?.(reason);
      }
    };

    manager.on("ready", onReady);
    manager.on("exited", onExited);
    manager.on("stuck", onStuck);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      manager.start(options);
    } catch (error) {
      close();
      reject(error);
    }
  });
}
