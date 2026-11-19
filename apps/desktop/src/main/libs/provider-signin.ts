import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AppEvent } from "@hearthside/ipc-contract";
import treeKill from "tree-kill";
import { runtimeChildEnv } from "../runtime/child-env";
import { resolveLettaCli } from "../runtime/paths";
import { cloudAuth } from "./cloud-providers";
import { listProviders } from "./providers";
import { getConnectionConfig } from "./settings";
import { readSignInOutput } from "./signin-output";

/**
 * Subscription sign-in for model providers (ChatGPT, Claude, Copilot, Grok…)
 * on the local backend. Rather than re-implementing each provider's OAuth,
 * Hearthside runs the runtime's own `letta connect <provider>` with the same
 * home directory as the app server, relays what it prints (a page, a code,
 * a question) to the window, and passes typed answers back. On success the
 * credentials land in the runtime's provider store, where the server reads them.
 */

const SIGN_IN_LIMIT_MS = 15 * 60_000;

/** Providers whose CLI flow needs a specific method; everything else uses its own id. */
const CONNECT_ARGS: Record<string, string[]> = {
  // Device code: no local callback port, works when the browser is elsewhere.
  "openai-codex-oauth": ["codex", "--method", "device-code"],
};

/** Listed by the runtime but not usable from here yet. */
const UNSUPPORTED = new Set(["openai-oauth"]);

type Session = { proc: ChildProcess; output: string[]; providerId: string; timer: NodeJS.Timeout };

const sessions = new Map<string, Session>();
let emit: (event: AppEvent) => void = () => {};

export function initProviderSignIn(emitter: (event: AppEvent) => void): void {
  emit = emitter;
}

export async function startProviderSignIn(providerId: string): Promise<{ sessionId: string }> {
  // Only providers the runtime itself reports as subscription sign-ins.
  const provider = (await listProviders()).find((item) => item.id === providerId);
  if (!provider?.oauth || provider.unavailable || UNSUPPORTED.has(providerId)) {
    throw new Error("This provider can't be signed in to from Hearthside yet.");
  }
  for (const session of sessions.values()) {
    if (session.providerId === providerId) stop(session);
  }

  const sessionId = randomUUID();
  // Hearthside: on Letta Cloud the runtime saves the sign-in to the Letta account.
  const cloud = getConnectionConfig().backend === "cloud";
  const auth = cloud ? await cloudAuth() : null;
  const args = cloud ? [providerId] : (CONNECT_ARGS[providerId] ?? [providerId]);
  const proc = spawn(process.execPath, [resolveLettaCli(), "--backend", cloud ? "api" : "local", "connect", ...args], {
    env: auth ? { ...runtimeChildEnv(), LETTA_API_KEY: auth.token, LETTA_BASE_URL: auth.baseUrl } : runtimeChildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const session: Session = {
    proc,
    output: [],
    providerId,
    timer: setTimeout(() => {
      emit({ type: "signin.finished", sessionId, ok: false, error: "Sign-in timed out. Try again." });
      stop(session);
    }, SIGN_IN_LIMIT_MS),
  };
  sessions.set(sessionId, session);

  const onData = (chunk: Buffer | string) => {
    session.output.push(...String(chunk).split(/\r?\n/));
    session.output = session.output.slice(-200);
    emit({ type: "signin.update", sessionId, state: { providerId, ...readSignInOutput(session.output) } });
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.once("error", (error) => finish(sessionId, false, `Could not start sign-in: ${error.message}`));
  proc.once("exit", (code) => {
    if (code === 0) {
      finish(sessionId, true);
      return;
    }
    const failure = [...session.output].reverse().find((line) => /fail|error/i.test(line));
    finish(sessionId, false, failure?.trim() || "Sign-in did not complete.");
  });
  return { sessionId };
}

export function answerProviderSignIn(sessionId: string, text: string): void {
  const session = sessions.get(sessionId);
  if (!session?.proc.stdin?.writable) throw new Error("This sign-in has already ended.");
  session.proc.stdin.write(`${text}\n`);
}

export function cancelProviderSignIn(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  stop(session);
}

/** End every sign-in, e.g. when the app quits. */
export function cancelAllProviderSignIns(): void {
  for (const [sessionId, session] of sessions) {
    sessions.delete(sessionId);
    stop(session);
  }
}

function finish(sessionId: string, ok: boolean, error?: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  clearTimeout(session.timer);
  emit({ type: "signin.finished", sessionId, ok, ...(error ? { error } : {}) });
}

function stop(session: Session): void {
  clearTimeout(session.timer);
  if (session.proc.pid !== undefined && session.proc.exitCode === null) treeKill(session.proc.pid);
}
