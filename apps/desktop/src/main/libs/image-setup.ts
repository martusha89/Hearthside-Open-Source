import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import treeKill from "tree-kill";
import type { AppEvent, ImageConnectStatus, ImageSetupMode, ImageSetupState, ImageSetupStep } from "@hearthside/ipc-contract";
import { CodexInstallError, installCodex } from "./codex-install";
import { resolveCodex, managedCodexRoot } from "./codex-locate";
import { type CodexStatus, readCodexLogin, readCodexStatus } from "./codex-login-output";
import { codexTriple } from "./codex-release";

/**
 * Hearthside: connecting the person's ChatGPT account so agents can make
 * images, without a terminal.
 *
 * Two steps, kept apart on purpose:
 *
 *  1. install — fetch the official Codex package for this user (codex-install);
 *  2. sign in — run Codex's *own* login, the same one its users run, and relay
 *     what it prints to the window.
 *
 * Hearthside never asks for a ChatGPT password or a token and never registers
 * an OAuth client of its own: the sign-in happens in OpenAI's pages and the
 * credentials land in Codex's own store, which is also where Codex reads them
 * from when it makes an image. The only things shown here are the sign-in page
 * (checked against OpenAI's hosts) and the one-time code, and neither is
 * written to the log.
 *
 * Choosing an engine for images stays a separate, explicit choice: connecting
 * an account does not switch image generation on, and nothing here ever makes
 * an image.
 */

/** Codex's own device-code sign-in gives up after 15 minutes; outlast it slightly. */
const LOGIN_LIMIT_MS = 16 * 60_000;
const INSTALL_LIMIT_MS = 20 * 60_000;
const STATUS_LIMIT_MS = 30_000;

type Session = {
  id: string;
  step: ImageSetupStep;
  mode: ImageSetupMode | null;
  /** The sign-in's child process; installs use the controller instead. */
  child: ChildProcess | null;
  controller: AbortController;
  timer: NodeJS.Timeout;
  lines: string[];
  state: ImageSetupState;
  /** Set when this session has already reported its outcome. */
  settled: boolean;
};

/** One setup at a time: a second click joins the one already running. */
let session: Session | null = null;
let emit: (event: AppEvent) => void = () => {};
let counter = 0;

export function initImageSetup(emitter: (event: AppEvent) => void): void {
  emit = emitter;
}

function publish(active: Session, patch: Partial<ImageSetupState>): void {
  active.state = { ...active.state, ...patch };
  if (session?.id !== active.id) return; // Cancelled or replaced: its updates no longer belong to anyone.
  emit({ type: "imagesetup.update", sessionId: active.id, state: active.state });
}

function settle(active: Session, ok: boolean, error?: string): void {
  if (active.settled) return;
  active.settled = true;
  clearTimeout(active.timer);
  const current = session?.id === active.id;
  if (current) session = null;
  stopChild(active);
  if (current) emit({ type: "imagesetup.finished", sessionId: active.id, ok, ...(error ? { error } : {}) });
}

/**
 * End only what this session started. Codex's own sign-ins, a Codex the person
 * is running themselves and the Letta server are left alone: cancelling a
 * Hearthside setup must never sign anybody out or stop their programs.
 */
function stopChild(active: Session): void {
  active.controller.abort();
  const child = active.child;
  active.child = null;
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) treeKill(child.pid);
}

// --- What the cards show -----------------------------------------------------

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = "";
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8_000));
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid, "SIGTERM", () => {});
      resolve({ code: null, output: `${output}\nTimed out.` });
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Whether Codex is signed in, as Codex itself reports it. The sign-in file
 * existing is not the question: it can hold an expired or revoked sign-in, or
 * an API key rather than a ChatGPT account, so the CLI is asked.
 */
export async function codexSignInStatus(program = resolveCodex()): Promise<CodexStatus> {
  if (!program) return { signedIn: false, authMode: null, detail: "Codex isn't installed." };
  const { code, output } = await run(program.command, [...program.prefix, "login", "status"], program.env, STATUS_LIMIT_MS);
  return readCodexStatus(output, code);
}

function grokStatus(): { installed: boolean; signedIn: boolean } {
  const binary = join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  const installed = existsSync(binary);
  return { installed, signedIn: installed && existsSync(join(homedir(), ".grok", "auth.json")) };
}

/**
 * What the connection cards need. Deliberately says nothing about whether the
 * account has image generation left: that belongs to the account, Codex does
 * not report it, and the first image is what finds out.
 */
export async function imageConnectStatus(): Promise<ImageConnectStatus> {
  const program = resolveCodex();
  const status = program ? await codexSignInStatus(program) : { signedIn: false, authMode: null, detail: "Codex isn't installed." };
  return {
    codex: {
      supported: codexTriple() !== null,
      installed: Boolean(program),
      source: program?.source ?? null,
      version: program?.version ?? null,
      signedIn: status.signedIn,
      authMode: status.authMode,
      detail: status.detail,
      busy: session !== null,
    },
    grok: grokStatus(),
  };
}

// --- Setting it up -----------------------------------------------------------

export async function startImageSetup(step: ImageSetupStep, mode: ImageSetupMode = "browser"): Promise<{ sessionId: string }> {
  // A second click (or a double-click) joins the running setup instead of
  // starting a rival one that would fight over the same files.
  if (session) return { sessionId: session.id };

  if (step === "install" && codexTriple() === null) {
    throw new Error(`OpenAI doesn't publish Codex for this kind of computer (${process.platform} ${process.arch}), so Hearthside can't set it up here.`);
  }
  if (step === "login" && !resolveCodex()) throw new Error("Set up image generation first: Codex isn't installed yet.");

  const id = `${Date.now().toString(36)}-${++counter}`;
  const controller = new AbortController();
  const active: Session = {
    id,
    step,
    mode: step === "login" ? mode : null,
    child: null,
    controller,
    timer: setTimeout(() => settle(active, false, step === "install" ? "The download took too long and was stopped." : "The sign-in timed out. Try again."), step === "install" ? INSTALL_LIMIT_MS : LOGIN_LIMIT_MS),
    lines: [],
    state: {
      step,
      phase: "working",
      progress: step === "install" ? 0 : null,
      url: null,
      code: null,
      message: step === "install" ? "Getting Codex ready…" : "Starting the ChatGPT sign-in…",
    },
    settled: false,
  };
  active.timer.unref?.();
  session = active;
  console.log(`[image-setup] ${id}: ${step} started`);
  if (step === "install") void install(active);
  else void login(active, mode);
  return { sessionId: id };
}

async function install(active: Session): Promise<void> {
  try {
    await installCodex({
      root: managedCodexRoot(),
      signal: active.controller.signal,
      onProgress: (fraction) => publish(active, { progress: fraction, message: fraction === null ? "Downloading Codex…" : `Downloading Codex… ${Math.round(fraction * 100)}%` }),
    });
    if (active.settled) return;
    publish(active, { phase: "done", progress: 1, message: "Codex is ready. Next, sign in with ChatGPT." });
    console.log(`[image-setup] ${active.id}: install finished`);
    settle(active, true);
  } catch (error) {
    const message = error instanceof CodexInstallError ? error.message : `Codex couldn't be set up: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[image-setup] ${active.id}: install failed`);
    publish(active, { phase: "error", message });
    settle(active, false, message);
  }
}

async function login(active: Session, mode: ImageSetupMode): Promise<void> {
  const program = resolveCodex();
  if (!program) {
    const message = "Codex isn't installed any more, so there's nothing to sign in to.";
    publish(active, { phase: "error", message });
    settle(active, false, message);
    return;
  }
  // Codex's own login: a browser sign-in on this computer, or a one-time code
  // when the browser is elsewhere or the loopback callback is blocked.
  const args = [...program.prefix, "login", ...(mode === "device" ? ["--device-auth"] : [])];
  let child: ChildProcess;
  try {
    child = spawn(program.command, args, { env: program.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    const message = `The ChatGPT sign-in couldn't be started: ${error instanceof Error ? error.message : String(error)}`;
    publish(active, { phase: "error", message });
    settle(active, false, message);
    return;
  }
  active.child = child;

  /**
   * A chunk is not a line. The address and the one-time code arrive in
   * whatever pieces the pipe hands over, and splitting each chunk on its own
   * would lose any of them that straddled a boundary, so each stream keeps its
   * unfinished last line until the rest of it turns up.
   */
  const partial: Record<"out" | "err", string> = { out: "", err: "" };

  const show = () => {
    // The unfinished line counts too: Codex prints the code and then waits, so
    // a trailing line with no newline yet is often the very thing to show.
    const view = readCodexLogin([...active.lines, partial.out, partial.err].filter((line) => line !== ""));
    publish(active, {
      // Codex prints the page and the code, then waits for the person.
      phase: view.error ? "error" : "waiting",
      url: view.url,
      code: view.code,
      message: view.message,
    });
  };

  const onData = (stream: "out" | "err") => (chunk: Buffer | string) => {
    const combined = partial[stream] + String(chunk);
    const parts = combined.split(/\r?\n/);
    // Whatever follows the last newline is unfinished; hold it for the next chunk.
    partial[stream] = parts.pop() ?? "";
    // A single line that never ends must not grow without bound.
    if (partial[stream].length > 4_000) {
      active.lines.push(partial[stream].slice(0, 4_000));
      partial[stream] = "";
    }
    active.lines.push(...parts);
    active.lines = active.lines.slice(-200);
    show();
  };
  child.stdout?.on("data", onData("out"));
  child.stderr?.on("data", onData("err"));
  child.once("error", (error) => {
    const message = `The ChatGPT sign-in couldn't be started: ${error.message}`;
    publish(active, { phase: "error", message });
    settle(active, false, message);
  });
  child.once("exit", (code) => {
    // Anything still held back is a complete line now that the stream has ended.
    for (const stream of ["out", "err"] as const) {
      if (partial[stream] !== "") active.lines.push(partial[stream]);
      partial[stream] = "";
    }
    active.lines = active.lines.slice(-200);
    // Nothing the CLI printed is logged: its output can carry a sign-in
    // address, a one-time code, or a credential in a form Hearthside doesn't
    // know to redact. Only what this app did is recorded.
    console.log(`[image-setup] ${active.id}: sign-in command exited with code ${code}`);
    void finishLogin(active, code);
  });
}

/**
 * Decide the outcome by asking Codex, not by trusting an exit code: a login
 * that exits 0 is confirmed with `codex login status`, and a ChatGPT
 * connection that turned out to be an API key is reported as what it is.
 */
async function finishLogin(active: Session, code: number | null): Promise<void> {
  if (active.settled) return;
  active.child = null;
  const view = readCodexLogin(active.lines);
  if (code !== 0) {
    const message = view.error ?? (active.controller.signal.aborted ? "The sign-in was cancelled." : "The sign-in didn't finish. Try again.");
    publish(active, { phase: "error", message });
    settle(active, false, message);
    return;
  }
  publish(active, { phase: "working", url: null, code: null, message: "Checking the connection…" });
  const status = await codexSignInStatus();
  if (active.settled) return;
  if (!status.signedIn) {
    const message = "Codex finished the sign-in but still reports no account, so images aren't connected yet. Try again.";
    publish(active, { phase: "error", message });
    settle(active, false, message);
    return;
  }
  if (status.authMode !== "chatgpt") {
    // Honest about what is connected: an API key bills per image instead of
    // using a ChatGPT plan, and it is a different account.
    const message =
      status.authMode === "api-key"
        ? "Codex is now signed in with an OpenAI API key, not a ChatGPT account. Images will be billed to that key rather than using a ChatGPT plan. Sign out of Codex and sign in again to use a ChatGPT account."
        : `Codex is signed in, but not with a ChatGPT account (${status.detail}).`;
    publish(active, { phase: "error", message });
    settle(active, false, message);
    return;
  }
  publish(active, { phase: "done", url: null, code: null, message: "ChatGPT is connected." });
  console.log(`[image-setup] ${active.id}: sign-in confirmed`);
  settle(active, true);
}

export function cancelImageSetup(sessionId: string): void {
  if (!session || session.id !== sessionId) return;
  const active = session;
  session = null;
  console.log(`[image-setup] ${active.id}: cancelled`);
  active.settled = true;
  clearTimeout(active.timer);
  stopChild(active);
}

/** End any setup, e.g. when the app quits. Nothing is signed out. */
export function cancelAllImageSetup(): void {
  if (session) cancelImageSetup(session.id);
}

/** For tests: forget any session left behind. */
export function resetImageSetup(): void {
  cancelAllImageSetup();
  session = null;
}
