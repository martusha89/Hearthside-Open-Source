import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { nativeImage } from "electron";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { Looks } from "@hearthside/ipc-contract";
import { setLookImage } from "./looks";

/**
 * Hearthside: the agent can change its own picture ("make it yours", from
 * the agent's side): an image it just made with generate_image, or a file the
 * person named. The person is asked first (it isn't on the no-permission
 * list), with "always allow" there like for any other tool. The picture goes
 * where the person's choice would go (looks.ts): the sidebar, beside replies,
 * on notifications. Nothing is written to the agent's memory.
 */

export const AVATAR_TOOL_NAME = "set_my_picture";
const TYPES: Record<string, "png" | "jpeg" | "webp"> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const SIZE = 256;

/** Why a path can't be used as a picture, or null when it can. */
export function checkPicturePath(path: string): string | null {
  if (!path.trim()) return "Give the path of an image file (PNG, JPEG or WebP).";
  if (!existsSync(path)) return `There's no file at ${path}.`;
  if (!TYPES[extname(path).toLowerCase()]) return "The picture must be a PNG, JPEG or WebP file.";
  if (statSync(path).size > MAX_FILE_BYTES) return "That image is too large (12 MB at most).";
  return null;
}

/** The file as a small square PNG data URL (WebP, which Electron can't decode, is sent as it is when small). */
function pictureDataUrl(path: string): string {
  const type = TYPES[extname(path).toLowerCase()]!;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) {
    const bytes = readFileSync(path);
    if (type === "webp" && bytes.length <= 600_000) return `data:image/webp;base64,${bytes.toString("base64")}`;
    throw new Error("That image couldn't be read.");
  }
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = side === width && side === height ? image : image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const small = side > SIZE ? square.resize({ width: SIZE, height: SIZE, quality: "best" }) : square;
  return `data:image/png;base64,${small.toPNG().toString("base64")}`;
}

export function createAvatarTool(agentId: string, onChanged: (looks: Looks) => void): AnyAgentTool {
  return {
    name: AVATAR_TOOL_NAME,
    label: "Change my picture",
    description:
      "Change your own profile picture in Hearthside (shown in the sidebar, beside your replies and on notifications) to an image file: one you just made with generate_image (use the saved path it returned) or one the user named. Square-cropped and scaled down for you. The user is asked before it changes.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Full path of a PNG, JPEG or WebP file on this computer." } },
      required: ["path"],
    },
    execute: async (_toolCallId, args) => {
      const path = String((args as { path?: unknown })?.path ?? "").trim();
      const problem = checkPicturePath(path);
      if (problem) return { content: [{ type: "text", text: problem }], isError: true };
      try {
        onChanged(setLookImage(agentId, "avatar", pictureDataUrl(path)));
        return { content: [{ type: "text", text: "Done: that's your picture now." }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
