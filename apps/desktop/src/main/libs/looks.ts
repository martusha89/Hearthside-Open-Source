import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Look, LookStyle, Looks } from "@hearthside/ipc-contract";

/**
 * Hearthside: "make it yours". A picture for each companion and for the
 * person, a theme colour per companion (the whole app takes it on while that
 * companion is selected), and a blurred picture behind the companion's chats.
 * Pictures are files under userData/looks, listed in looks.json; the renderer
 * sends them already resized, as data URLs, and gets them back the same way.
 * None of this touches the agent's memory, and it stays on this computer.
 */

export type LookKind = "avatar" | "background";
type StoredLook = { avatar?: string; background?: string; accent?: string; blur?: number };
type Stored = { me?: { avatar?: string }; agents?: Record<string, StoredLook> };

/** The target that means the person themselves. */
export const ME = "me";
/** Blur of a background picture, in pixels. */
export const DEFAULT_BLUR = 14;
const MAX_BLUR = 40;
// The renderer resizes first (256 px pictures, 1920 px backgrounds); these are safety nets.
const LIMITS: Record<LookKind, number> = { avatar: 600_000, background: 3_000_000 };
const EXTENSIONS: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };

let dirOverride: string | null = null;
let cache: Stored | null = null;
let snapshot: Looks | null = null;

/** Tests: keep the files in a folder of their own. */
export function setLooksDir(dir: string | null): void {
  dirOverride = dir;
  cache = null;
  snapshot = null;
}

function dir(): string {
  return dirOverride ?? join(app.getPath("userData"), "looks");
}

/** The first 0.1.6 build kept a colour or picture background per chat; a colour becomes the theme colour. */
function upgrade(stored: Stored): Stored {
  for (const look of Object.values(stored.agents ?? {})) {
    const legacy = look as StoredLook & { background?: unknown; soften?: number };
    if (legacy.background && typeof legacy.background === "object") {
      const old = legacy.background as { kind?: string; color?: string; file?: string };
      delete legacy.background;
      if (old.kind === "image" && old.file) look.background = old.file;
      if (old.kind === "color" && old.color && !look.accent) look.accent = old.color;
    }
    delete legacy.soften;
  }
  return stored;
}

function load(): Stored {
  if (cache) return cache;
  try {
    cache = upgrade(JSON.parse(readFileSync(join(dir(), "looks.json"), "utf8")) as Stored);
  } catch {
    cache = {};
  }
  return cache;
}

function save(next: Stored): Looks {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), "looks.json"), JSON.stringify(next, null, 2));
  cache = next;
  snapshot = null;
  return getLooks();
}

/** The bytes of an image data URL, or an error for anything else. */
export function decodeImage(dataUrl: string, kind: LookKind): { bytes: Buffer; ext: string } {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw new Error("That isn't a picture Hearthside can use.");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) throw new Error("The picture is empty.");
  if (bytes.length > LIMITS[kind]) throw new Error("That picture is too large.");
  return { bytes, ext: EXTENSIONS[match[1]!]! };
}

function fileDataUrl(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const ext = file.slice(file.lastIndexOf(".") + 1);
    return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${readFileSync(join(dir(), file)).toString("base64")}`;
  } catch {
    return null;
  }
}

function safeName(target: string): string {
  return target.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function writeImage(target: string, kind: LookKind, dataUrl: string): string {
  const { bytes, ext } = decodeImage(dataUrl, kind);
  mkdirSync(dir(), { recursive: true });
  // A new name each time, so nothing ever shows a half-written file.
  // Millisecond names collide during quick replacements; removing the old file
  // then deletes the new image too. Each write needs its own identity.
  const file = `${safeName(target)}-${kind}-${randomUUID()}.${ext}`;
  writeFileSync(join(dir(), file), bytes);
  return file;
}

function removeFile(file: string | undefined): void {
  if (file) rmSync(join(dir(), file), { force: true });
}

/** Every picture, theme colour and background, with the pictures as data URLs. */
export function getLooks(): Looks {
  if (snapshot) return snapshot;
  const stored = load();
  const agents: Record<string, Look> = {};
  for (const [id, look] of Object.entries(stored.agents ?? {})) {
    const avatar = fileDataUrl(look.avatar);
    const background = fileDataUrl(look.background);
    const accent = look.accent ?? null;
    if (avatar || background || accent) agents[id] = { avatar, accent, background, blur: look.blur ?? DEFAULT_BLUR };
  }
  snapshot = { me: { avatar: fileDataUrl(stored.me?.avatar) }, agents };
  return snapshot;
}

/** Set a picture for an agent or the person (`target` "me"), or an agent's background picture. */
export function setLookImage(target: string, kind: LookKind, dataUrl: string): Looks {
  if (target === ME && kind !== "avatar") throw new Error("Only a picture can be set for you.");
  const stored = structuredClone(load());
  const file = writeImage(target, kind, dataUrl);
  if (target === ME) {
    removeFile(stored.me?.avatar);
    stored.me = { avatar: file };
  } else {
    const look = ((stored.agents ??= {})[target] ??= {});
    removeFile(look[kind]);
    look[kind] = file;
  }
  return save(stored);
}

export function clearLookImage(target: string, kind: LookKind): Looks {
  const stored = structuredClone(load());
  if (target === ME) {
    removeFile(stored.me?.avatar);
    delete stored.me;
  } else {
    const look = stored.agents?.[target];
    if (look) {
      removeFile(look[kind]);
      delete look[kind];
    }
  }
  return save(stored);
}

/** The theme colour (or none) and how much the background picture is blurred. */
export function setLookStyle(agentId: string, style: LookStyle): Looks {
  const stored = structuredClone(load());
  const look = ((stored.agents ??= {})[agentId] ??= {});
  if (style.accent !== undefined) {
    if (style.accent === null) delete look.accent;
    else look.accent = style.accent;
  }
  if (style.blur !== undefined) look.blur = Math.round(Math.min(MAX_BLUR, Math.max(0, style.blur)));
  return save(stored);
}

/** Drop everything kept for an agent (when it is deleted). */
export function forgetLook(agentId: string): void {
  const stored = structuredClone(load());
  const look = stored.agents?.[agentId];
  if (!look) return;
  removeFile(look.avatar);
  removeFile(look.background);
  delete stored.agents![agentId];
  save(stored);
}

/** The agent's picture as a file, for a notification's icon. */
export function avatarFileFor(agentId: string): string | null {
  const file = load().agents?.[agentId]?.avatar;
  const path = file ? join(dir(), file) : null;
  return path && existsSync(path) ? path : null;
}
