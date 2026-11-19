/**
 * Hearthside: audio an agent's tools made (ElevenLabs and friends), found in a
 * tool result: files saved on this computer, web links, or inline data.
 */

export type AudioSource = { kind: "file" | "url" | "data"; value: string };

const DATA = /data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const URL_AUDIO = /https?:\/\/[^\s"'<>)\]]+?\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)(?:\?[^\s"'<>)\]]*)?(?=[\s"'<>)\],.]|$)/gi;

const EXTENSION = "(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)";
// Where a file path can start: a drive letter standing alone (C:\…, D:/…) or a
// slash at the top of the disk. "Standing alone" matters — without it the "s:/"
// inside "https://…/a.mp3" reads as a drive, and a web link arrives as a file
// that isn't there. A network path (//server/share/…) is left out as well; the
// app checks again before opening anything. And "./out/a.mp3", "out/a.mp3" or
// "~/voice/a.mp3" name somewhere only the tool that wrote them knows, so none
// of them is a place this computer can open — dropping the "./" or the "~"
// would invent a path from the top of the disk.
const ROOT = "(?:(?<![\\w~])[A-Za-z]:[\\\\/]|(?<![\\w:/\\\\.~])/(?![/\\\\]))";
// Folder names hold spaces ("…/tts hello.mp3"), so the rest of the path can't
// simply stop at the first one. It stops instead at what prose brings and
// paths don't — a quote, a semicolon, a comma, a colon, a newline — and at a
// space that runs straight into another path, which is how "ran in /srv/app
// audio saved to /home/a.mp3" used to come back as one impossible file.
// Keep parsing bounded without rejecting ordinary deeply nested paths. This
// is a parser budget, not a claim about every operating system's path limit.
const REST = "(?:[^\\n\\t\"'<>|*?:;, ]| (?![/\\\\])){0,4096}?";
const ENDS = "(?=[\\s\"'<>),.;:]|$)";

const FILE_AUDIO = new RegExp(`${ROOT}${REST}\\.${EXTENSION}${ENDS}`, "gi");
// Inside quotes a path may hold anything but the quote itself, so this is the
// one way a saved file with a comma or a colon in its name survives.
const QUOTED_AUDIO = new RegExp(`["'](${ROOT}[^\\n"']{0,4096}\\.${EXTENSION})["']`, "gi");
const SAVED_FILE = new RegExp(`^(?:["'](${ROOT}[^\\n"']{0,4096}\\.${EXTENSION})["']|(${ROOT}${REST}\\.${EXTENSION}${ENDS}))`, "i");

export function findAudio(text: string): AudioSource[] {
  if (!text) return [];
  const found: AudioSource[] = [];
  const seen = new Set<string>();
  const add = (source: AudioSource) => {
    if (seen.has(source.value)) return;
    seen.add(source.value);
    found.push(source);
  };
  for (const match of text.matchAll(DATA)) add({ kind: "data", value: match[0] });
  for (const match of text.matchAll(URL_AUDIO)) add({ kind: "url", value: match[0] });
  const quoted: { from: number; to: number }[] = [];
  for (const match of text.matchAll(QUOTED_AUDIO)) {
    quoted.push({ from: match.index, to: match.index + match[0].length });
    add({ kind: "file", value: match[1]! });
  }
  for (const match of text.matchAll(FILE_AUDIO)) {
    if (quoted.some((span) => match.index >= span.from && match.index < span.to)) continue;
    add({ kind: "file", value: match[0].trim() });
  }
  return found.slice(0, 6);
}

/**
 * Hearthside: the file a tool named right after saying it saved one — read
 * from the start of `text`, in quotes or not. Nothing comes back if what
 * follows isn't a path this computer can open, because a tool that said where
 * it put the file has already told us; guessing at some other path in the
 * same sentence would offer the wrong recording.
 */
export function savedAudioFile(text: string): string | null {
  const match = SAVED_FILE.exec(text);
  if (!match) return null;
  return (match[1] ?? match[2])?.trim() ?? null;
}
