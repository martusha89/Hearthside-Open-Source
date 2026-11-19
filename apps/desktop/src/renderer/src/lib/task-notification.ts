import { findAudio, savedAudioFile } from "./audio";

/**
 * Hearthside: the runtime reports a tool that finished in the background (one
 * that took over 10 seconds, like making an image) as a message to the agent:
 * <task-notification><status>…</status><summary>External tool X completed</summary><result>…</result></task-notification>.
 * The chat shows it as a note (and the image, if one was made), not as raw XML.
 */
export type TaskNotification = { status: string; summary: string; result: string; toolName: string | null; image: string | null; audio: string | null };

/** "Audio saved to", "Audio saved as:", "File saved as:" — how tools say where it went. */
const SAVED_MARKER = /\b(?:audio|voice|speech|sound|file|output)\s+saved\s+(?:to|as|at)\s*:?\s*/gi;

/**
 * Hearthside: the voice message a background tool saved, when it saved one on
 * this computer. Only a file: a provider's own link can expire or need its
 * key, and a path relative to wherever the tool ran can't be found from here,
 * so neither becomes a player.
 *
 * The file is the one the tool named where it said it saved it. A result often
 * mentions more than one — "read /home/me/source.mp3 for the voice, audio
 * saved to /home/me/out.mp3" — and the first is as likely to be what the tool
 * listened to as what it wrote, so an unmarked result with several files
 * stays text rather than offering the wrong recording.
 */
function savedAudio(result: string): string | null {
  let marked = false;
  for (const marker of result.matchAll(SAVED_MARKER)) {
    marked = true;
    const saved = savedAudioFile(result.slice(marker.index + marker[0].length));
    if (saved) return saved;
  }
  if (marked) return null;
  const files = findAudio(result).filter((source) => source.kind === "file");
  return files.length === 1 ? files[0]!.value : null;
}

const unescape = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const field = (block: string, name: string) => unescape(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim() ?? "");

export function parseTaskNotifications(text: string): TaskNotification[] {
  if (!text.includes("<task-notification>")) return [];
  const found: TaskNotification[] = [];
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const block = match[1] ?? "";
    const summary = field(block, "summary");
    const result = field(block, "result");
    found.push({
      status: field(block, "status"),
      summary,
      result,
      toolName: /^External tool (\S+) /.exec(summary)?.[1] ?? null,
      image: /Image saved as: (.+\.(?:png|jpe?g|webp))\s*$/im.exec(result)?.[1]?.trim() ?? null,
      audio: savedAudio(result),
    });
  }
  return found;
}
