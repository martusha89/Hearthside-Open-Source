import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { app, Notification, shell } from "electron";
import treeKill from "tree-kill";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { ImageEngine, ImageEngineStatus } from "@hearthside/ipc-contract";
import { resolveCodex } from "./codex-locate";
import { readLocalMedia } from "./local-media";




export const IMAGE_TOOL_NAME = "generate_image";
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TIMEOUT_MS = 5 * 60_000;

/**
 * How to start Codex: a Codex the person installed themselves, or the official
 * package Hearthside fetched for them (codex-locate). Both are started by
 * their full path, with the window hidden.
 */
const codexCommand = resolveCodex;

/** Signed in to Codex? Read from its own auth file, without starting anything. */
function codexSignedIn(): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8")) as { tokens?: unknown; OPENAI_API_KEY?: unknown };
    return Boolean(auth.tokens) || (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0);
  } catch {
    return false;
  }
}

/**
 * Which model to ask Codex for. Codex's own default (config.toml) can name a
 * model the CLI can't use with a ChatGPT login (the Codex app may set a newer
 * one). Codex keeps the list it can use in models_cache.json: keep the default
 * when it's listed, otherwise use the top listed model. Null = no flag.
 */
export function codexModel(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string | null {
  let listed: string[] = [];
  try {
    const cache = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as { models?: Array<{ slug?: string; visibility?: string; priority?: number }> };
    listed = (cache.models ?? [])
      .filter((model) => typeof model.slug === "string" && model.visibility === "list")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((model) => model.slug as string);
  } catch {
    return null; // No list: leave it to Codex.
  }
  if (listed.length === 0) return null;
  let configured: string | null = null;
  try {
    configured = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1] ?? null;
  } catch {
    // No config: Codex uses its own default, which may not be listed either.
  }
  return configured && listed.includes(configured) ? null : (listed[0] ?? null);
}

function grokBinary(): string | null {
  const candidates = [join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Run a program without a shell; resolves with its output, or rejects on failure/timeout. */
function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; job?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const began = Date.now();
    if (options.job) console.log(`[image] job ${options.job}: started the CLI (pid ${child.pid ?? "?"})`);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000)));
    child.stderr?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000)));
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid, "SIGTERM", () => {});
      reject(new Error("Making the image took too long (over 5 minutes)."));
    }, TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (options.job) console.log(`[image] job ${options.job}: CLI exited with code ${code} after ${Math.round((Date.now() - began) / 1000)}s`);
      if (code === 0) resolve(output);
      else reject(new Error(`The image tool stopped with an error (code ${code}). ${output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`));
    });
  });
}

/**
 * Installed and signed in? Read from files only: opening the page never starts
 * a program. The connection cards use `imageConnectStatus` instead, which asks
 * the CLI itself; this stays a cheap, synchronous look for callers that only
 * need to know whether an engine is worth offering.
 */
export async function engineStatus(): Promise<ImageEngineStatus> {
  const codex = resolveCodex();
  const grok = grokBinary();
  const grokSignedIn = Boolean(grok && existsSync(join(homedir(), ".grok", "auth.json")));
  return { codex: { installed: Boolean(codex), signedIn: Boolean(codex) && codexSignedIn() }, grok: { installed: Boolean(grok), signedIn: grokSignedIn } };
}

/** Image files changed since `since`, newest first (a few levels deep). */
export function newImages(dirs: string[], since: number, depth = 5): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (level < depth && stats.mtimeMs >= since - 60_000) walk(full, level + 1);
      } else if (IMAGE_EXT.has(extname(entry).toLowerCase()) && stats.mtimeMs >= since && stats.size > 0) {
        found.push({ path: full, mtime: stats.mtimeMs });
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).map((item) => item.path);
}

export function picturesFolder(): string {
  const folder = join(app.getPath("pictures"), "Hearthside");
  mkdirSync(folder, { recursive: true });
  return folder;
}

let queue: Promise<unknown> = Promise.resolve();

/** Make one image with the chosen CLI; returns where it was saved. */
export function generateImage(engine: ImageEngine, prompt: string, job = "-"): Promise<string> {
  const task = queue.then(() => generate(engine, prompt, job));
  queue = task.catch(() => undefined);
  return task;
}

type Job = { id: string; promise: Promise<string>; path?: string; finishedAt?: number; delivered: boolean };
/** Recent jobs by engine + prompt, so a retry after a dropped turn reuses the image. */
const jobs = new Map<string, Job>();
const REUSE_MS = 30 * 60_000;
let jobCount = 0;

function jobKey(engine: ImageEngine, prompt: string): string {
  return createHash("sha256").update(`${engine}\n${prompt}`).digest("hex");
}

function forgetOldJobs(): void {
  for (const [key, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > REUSE_MS) jobs.delete(key);
}

/**
 * Generate, or reuse: a job already running for this prompt is awaited; one that
 * finished but never reached the agent is returned. `delivered` says whether the
 * result can still reach the chat; if not, the image is kept for a retry.
 */
export async function imageFor(
  engine: ImageEngine,
  prompt: string,
  delivered: () => boolean,
  generator: (engine: ImageEngine, prompt: string, job: string) => Promise<string> = generateImage,
): Promise<{ path: string; reused: boolean }> {
  forgetOldJobs();
  const key = jobKey(engine, prompt);
  const existing = jobs.get(key);
  if (existing && !existing.path) {
    console.log(`[image] job ${existing.id}: asked again while still running; waiting for it`);
    const path = await existing.promise;
    existing.delivered ||= delivered();
    return { path, reused: true };
  }
  if (existing?.path && !existing.delivered && existsSync(existing.path)) {
    console.log(`[image] job ${existing.id}: asked again; returning the image it already made`);
    existing.delivered = delivered();
    return { path: existing.path, reused: true };
  }
  const id = `${Date.now().toString(36)}-${++jobCount}`;
  console.log(`[image] job ${id}: queued (${engine})`);
  const job: Job = { id, promise: generator(engine, prompt, id), delivered: false };
  jobs.set(key, job);
  try {
    const path = await job.promise;
    job.path = path;
    job.finishedAt = Date.now();
    job.delivered = delivered();
    console.log(`[image] job ${id}: saved ${basename(path)}${job.delivered ? "" : " (the chat turn had already ended)"}`);
    if (!job.delivered) lateImage(path);
    return { path, reused: false };
  } catch (error) {
    jobs.delete(key);
    console.warn(`[image] job ${id}: failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** The turn ended before the image was ready: tell the person where it is. */
function lateImage(path: string): void {
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: "Your image is ready", body: "The chat was interrupted, but the image finished. Click to show it." });
    notification.on("click", () => shell.showItemInFolder(path));
    notification.show();
  } catch {
    // No notifications; the image is still in Pictures\Hearthside.
  }
}

async function generate(engine: ImageEngine, prompt: string, job: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "hearthside-image-"));
  const target = join(out, "result.png");
  const started = Date.now() - 2_000;
  try {
    if (engine === "codex") {
      const codex = codexCommand();
      if (!codex) throw new Error("ChatGPT images aren't set up yet. In Hearthside, open Connectors and choose “Set up image generation” on the ChatGPT card.");
      const instruction = `Use image_gen.imagegen to generate one image of: ${prompt}\nSave the PNG to ${target} and report its path.`;
      const model = codexModel();
      if (model) console.log(`[image] job ${job}: using Codex model ${model}`);
      await run(codex.command, [...codex.prefix, "exec", ...(model ? ["-m", model] : []), "--skip-git-repo-check", "--sandbox", "workspace-write", "--add-dir", out, "-o", join(out, "result.txt"), "--", instruction], {
        cwd: out,
        env: codex.env,
        job,
      });
    } else if (engine === "grok") {
      const grok = grokBinary();
      if (!grok) throw new Error("Grok isn't installed. Install the Grok CLI, then sign in with `grok login`.");
      // Without a sign-in Grok fails after starting; say how to sign in instead (it's often not on PATH).
      if (!existsSync(join(homedir(), ".grok", "auth.json"))) throw new Error(`Grok isn't signed in. Open a terminal and run: "${grok}" login`);
      const env: NodeJS.ProcessEnv = { ...process.env, GROK_IMAGE_GEN_HARNESS: "1" };
      delete env.XAI_API_KEY;
      delete env.GROK_CODE_XAI_API_KEY;
      const instruction = `Use image_gen to generate one image of: ${prompt}\nReport its path.`;
      await run(grok, ["-p", instruction, "--cwd", out, "--output-format", "json", "--always-approve", "--max-turns", "4"], { cwd: out, env, job });
    } else {
      // Anything that isn't a named engine (the setting's "off" included) makes nothing.
      throw new Error(IMAGES_OFF);
    }
    const places = [out, join(homedir(), ".codex", "generated_images"), join(homedir(), ".grok", "sessions")];
    const image = existsSync(target) ? target : newImages(places, started)[0];
    if (!image) throw new Error("The image tool finished, but no new image could be found.");
    const saved = join(picturesFolder(), `image-${new Date().toISOString().replace(/[:.]/g, "-")}${extname(image).toLowerCase() || ".png"}`);
    copyFileSync(image, saved);
    return saved;
  } finally {
    removeLater(out);
  }
}

/**
 * Delete the job's scratch folder without ever failing the job: Codex's Windows
 * sandbox can hold the folder for a moment after exiting (EPERM), which once
 * replaced a finished image with an error. Try again in the background.
 */
export function removeLater(dir: string, attempts = 5): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    if (attempts > 1) setTimeout(() => removeLater(dir, attempts - 1), 15_000).unref?.();
  }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** An image an agent made, as a data: URL for the chat (images only, up to 25 MB). */
export function readImageFile(path: string): Promise<string> {
  return readLocalMedia(path, IMAGE_TYPES, 25 * 1024 * 1024, { kind: "an image", gone: "That image is gone.", tooBig: "That image is too big to show here." });
}

const IMAGES_OFF = "Image generation is turned off in Hearthside's settings, so no image was made.";

/**
 * `engine` is read on every call, and the setting can change while a turn that
 * was given this tool is still running. Turned off mid-turn it used to fall
 * through to Grok and spend that allowance (or report that Grok isn't installed).
 */
export function createImageTool(engine: () => ImageEngine | "off", turnLive: () => boolean = () => true): AnyAgentTool {
  return {
    name: IMAGE_TOOL_NAME,
    label: "Make an image",
    description:
      "Make one image from a description and show it to the user in the chat. Describe the subject, style, mood and composition in detail. It takes a minute or two and uses the user's image allowance, so make one at a time and only when it's wanted. If an earlier attempt was interrupted, calling again with the same prompt returns the finished image without making a new one.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "A detailed description of the image." } }, required: ["prompt"] },
    execute: async (_id, args) => {
      const prompt = String((args as { prompt?: unknown })?.prompt ?? "").trim().slice(0, 4_000);
      if (!prompt) return { content: [{ type: "text", text: "Describe the image to make." }], isError: true };
      const chosen = engine();
      if (chosen !== "codex" && chosen !== "grok") return { content: [{ type: "text", text: IMAGES_OFF }], isError: true };
      try {
        const { path, reused } = await imageFor(chosen, prompt, turnLive);
        const note = reused ? "This image was already made for this request; no new image was generated.\n" : "";
        return { content: [{ type: "text", text: `${note}Image saved as: ${path}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
