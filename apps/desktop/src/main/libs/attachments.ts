import type { MessageContentItem, SendMessage } from "@letta-ai/letta-agent-sdk";
import type { Attachment } from "@hearthside/ipc-contract";

/**
 * Hearthside: turn a message and its attachments into what the runtime sends
 * to the model. Text files go inline as <attached-file> blocks; images go as
 * image parts, with an <attached-image> marker so the transcript (which keeps
 * only text) can still show that an image was there. The renderer parses both
 * back out in lib/attachments.ts.
 */

function attributeValue(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function messageText(text: string, attachments: readonly Attachment[] = []): string {
  const parts = text.trim() ? [text.trim()] : [];
  for (const item of attachments) {
    if (item.kind === "pdf") {
      // Converted to text by resolvePdfs before sending.
      parts.push(`<attached-file name="${attributeValue(item.name)}">\n</attached-file>`);
    } else if (item.kind === "text") {
      parts.push(`<attached-file name="${attributeValue(item.name)}">\n${item.text}\n</attached-file>`);
    } else {
      parts.push(`<attached-image name="${attributeValue(item.name)}" />`);
    }
  }
  return parts.join("\n\n");
}

export function messageContent(text: string, attachments: readonly Attachment[] = []): SendMessage {
  const body = messageText(text, attachments);
  const images = attachments.filter((item) => item.kind === "image");
  if (images.length === 0) return body;
  const content: MessageContentItem[] = [{ type: "text", text: body }];
  for (const image of images) {
    content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  }
  return content;
}

/** A title for a new chat whose first message may be only attachments. */
export function titleText(text: string, attachments: readonly Attachment[] = []): string {
  // A GIF someone sent reads as its title.
  const plain = text.replace(/<sent-gif title="([^"]*)"[^>]*\/>/g, (_, title: string) => `GIF: ${title}`).trim();
  return plain || attachments.map((item) => item.name).join(", ") || "New chat";
}
