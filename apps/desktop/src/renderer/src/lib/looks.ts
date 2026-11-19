import type { CSSProperties } from "react";
import type { Look } from "@hearthside/ipc-contract";

/**
 * Hearthside: "make it yours". Pictures are resized here, in the window,
 * before they go to the main process (any format the browser can decode), and
 * a background picture is blurred and veiled so the chat stays easy to read.
 * The theme colour itself is applied by App.tsx through CSS (see index.css,
 * `[data-themed]`).
 */

export const AVATAR_SIZE = 256;
export const BACKGROUND_MAX = 1920;
export const MAX_BLUR = 40;

/** A picked file as a small data URL: pictures are square-cropped, backgrounds just scaled down. */
export async function imageToDataUrl(file: File, kind: "avatar" | "background"): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose a picture (PNG, JPEG, WebP or GIF).");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be read.");
  });
  try {
    const canvas = document.createElement("canvas");
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    if (kind === "avatar") {
      const side = Math.min(sw, sh);
      sx = Math.floor((sw - side) / 2);
      sy = Math.floor((sh - side) / 2);
      sw = side;
      sh = side;
      canvas.width = canvas.height = Math.max(1, Math.min(AVATAR_SIZE, side));
    } else {
      const scale = Math.min(1, BACKGROUND_MAX / Math.max(sw, sh));
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The picture couldn't be drawn.");
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    // A PNG picture keeps its transparency; everything else becomes a JPEG.
    if (kind === "avatar" && file.type === "image/png") return canvas.toDataURL("image/png");
    return canvas.toDataURL("image/jpeg", kind === "avatar" ? 0.88 : 0.82);
  } finally {
    bitmap.close();
  }
}

const PALETTE = ["#0f766e", "#b45309", "#6d28d9", "#be185d", "#1d4ed8", "#15803d", "#c2410c", "#4338ca"];

/** The colour of a lettered circle: the same for the same name. */
export function initialColour(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** Inline style for the layer behind the chat: the picture, blurred, under a light veil of the page colour. */
export function backgroundStyle(look: Look | undefined): CSSProperties | undefined {
  if (!look?.background) return undefined;
  const blur = Math.max(0, Math.min(MAX_BLUR, look.blur));
  const veil = "color-mix(in srgb, var(--color-surface) 55%, transparent)";
  return {
    backgroundImage: `linear-gradient(${veil}, ${veil}), url("${look.background}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    ...(blur ? { filter: `blur(${blur}px)`, transform: `scale(${1 + blur / 150})` } : {}),
  };
}
