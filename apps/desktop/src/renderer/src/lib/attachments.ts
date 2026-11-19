import type { Attachment, ImageMediaType } from "../types";

/** Hearthside: reading attachments in, and finding them again in sent messages. */

export const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Hearthside: photos are sent no larger than this on their long side, as JPEG; models see no more detail, and four full-size ones stalled a chat. */
const IMAGE_MAX_SIDE = 1568;
const IMAGE_SHRINK_FROM_BYTES = 700 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "html", "htm", "css", "yaml", "yml", "toml", "ini",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cs", "php", "sh", "ps1", "sql",
]);

function extension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** A big photo (in pixels or bytes) comes back scaled down and re-encoded as JPEG; others unchanged. */
async function shrinkImage(file: File): Promise<{ mediaType: ImageMediaType; data: string }> {
  const asIs = async () => ({ mediaType: file.type as ImageMediaType, data: base64(await file.arrayBuffer()) });
  // Small files stay as they are; GIFs stay animated.
  if (file.type === "image/gif" || file.size < IMAGE_SHRINK_FROM_BYTES) return asIs();
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size < 2 * IMAGE_SHRINK_FROM_BYTES) return asIs();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return asIs();
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    } finally {
      bitmap.close();
    }
  } catch {
    return asIs();
  }
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Read picked, pasted or dropped files. Returns what could be attached and a
 * plain explanation for anything that couldn't.
 */
export async function readAttachments(files: Iterable<File>): Promise<{ attachments: Attachment[]; problems: string[] }> {
  const attachments: Attachment[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = file.name || (file.type.startsWith("image/") ? `pasted-image.${file.type.split("/")[1] ?? "png"}` : "pasted.txt");
    if (IMAGE_TYPES.includes(file.type)) {
      if (file.size > MAX_IMAGE_BYTES) problems.push(`${name} is too big (images can be up to 5 MB).`);
      else attachments.push({ kind: "image", name, ...(await shrinkImage(file)) });
    } else if (file.type === "application/pdf" || extension(name) === "pdf") {
      if (file.size > MAX_PDF_BYTES) problems.push(`${name} is too big (PDFs can be up to 20 MB).`);
      else attachments.push({ kind: "pdf", name, data: base64(await file.arrayBuffer()) });
    } else if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(name))) {
      if (file.size > MAX_TEXT_BYTES) problems.push(`${name} is too big (text files can be up to 200 KB).`);
      else attachments.push({ kind: "text", name, text: await file.text() });
    } else {
      problems.push(`${name} can't be attached. Images (PNG, JPEG, GIF, WebP), PDFs and text files work.`);
    }
  }
  return { attachments, problems };
}

export type ParsedUserText = { text: string; files: Array<{ name: string; text: string }>; images: string[]; gifs: Array<{ title: string; url: string }> };

/** Hearthside: how a GIF the person picked travels in their message (the agent reads the title). */
export function gifTag(title: string, url: string): string {
  const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<sent-gif title="${attr(title)}" url="${attr(url)}" />`;
}

/** Hearthside: a message that came in from Telegram or Discord (the runtime wraps it). */
export type ChannelAttachment = { kind: string; name: string; path: string | null; mimeType: string | null; size: number | null };
export type ChannelMessage = { source: string; sender: string | null; text: string; attachments: ChannelAttachment[] };

export function parseChannelMessages(text: string): ChannelMessage[] {
  const found: ChannelMessage[] = [];
  for (const match of text.matchAll(/<channel-notification\b([^>]*)>\n?([\s\S]*?)\n?<\/channel-notification>/g)) {
    const attrs = match[1] ?? "";
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const attachments: ChannelAttachment[] = [];
    // Hearthside: a photo, video or file sent on Telegram/Discord arrives as an <attachment … /> tag; show it, not the tag.
    const body = (match[2] ?? "").replace(/<attachment\b([^>]*?)\/?>/g, (_tag, inner: string) => {
      const field = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(inner)?.[1] ?? null;
      const size = Number(field("size_bytes"));
      attachments.push({
        kind: field("kind") ?? "file",
        name: decode(field("name") ?? field("local_path")?.split(/[\\/]/).pop() ?? "attachment"),
        path: field("local_path") ? decode(field("local_path")!) : null,
        mimeType: field("mime_type"),
        size: Number.isFinite(size) && size > 0 ? size : null,
      });
      return "";
    });
    found.push({ source: decode(attr("source") ?? "channel"), sender: attr("sender_name") ? decode(attr("sender_name")!) : null, text: decode(body).trim(), attachments });
  }
  return found;
}

function decode(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Split a sent message back into what was typed and what was attached (see main/libs/attachments.ts). */
export function parseUserText(text: string): ParsedUserText {
  const files: ParsedUserText["files"] = [];
  const images: string[] = [];
  const gifs: ParsedUserText["gifs"] = [];
  const rest = text
    .replace(/<sent-gif title="([^"]*)" url="([^"]*)" \/>/g, (_, title: string, url: string) => {
      gifs.push({ title: decode(title), url: decode(url) });
      return "";
    })
    .replace(/<attached-file name="([^"]*)">\n?([\s\S]*?)\n?<\/attached-file>/g, (_, name: string, body: string) => {
      files.push({ name: decode(name), text: body });
      return "";
    })
    .replace(/<attached-image name="([^"]*)" \/>/g, (_, name: string) => {
      images.push(decode(name));
      return "";
    });
  return { text: rest.trim(), files, images, gifs };
}
