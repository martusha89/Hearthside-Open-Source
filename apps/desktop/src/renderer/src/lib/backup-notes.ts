


type Rule = [RegExp, string];

/** The note main puts first on a backup that didn't pass its check when it was made (backup.ts). */
const FAILED_CHECK = /^This backup didn't pass its own check/;
export const isFailedCheckNote = (line: string): boolean => FAILED_CHECK.test(line.trim());

/** What each closed failure code (backup/diagnostics.ts) means. */
const CODES: Record<string, string> = {
  request_failed: "Letta answered this request with an error.",
  request_timeout: "Letta took too long to answer.",
  connection_failed: "The connection to Letta dropped partway through.",
  invalid_response: "Letta sent back something the backup couldn't make sense of.",
  cursor_missing: "Letta's list came back without the markers the backup uses to page through it.",
  cursor_repeated: "Letta's list started repeating itself, so the backup stopped rather than save something incomplete.",
  cursor_stalled: "Letta's list stopped moving forward, so the backup stopped rather than save something incomplete.",
  page_limit: "This was longer than the backup's safety limit.",
  capture_limit: "This was bigger than the backup's safety limit.",
  group_split: "One message had more parts than fit in a single page from Letta, so the backup couldn't read it whole and stopped rather than save part of it.",
};

const TRY_AGAIN = "The rest of the backup is fine. The next backup tries again.";

const RULES: Rule[] = [
  // Each backup's own check failing is said first, whatever else the backup notes.
  [FAILED_CHECK,
    "Right after this backup was written, Hearthside read it back and something didn't match: a piece was missing or damaged, often because the folder was still syncing or the disk was full. It's kept because most of it is usually fine, but don't rely on it alone. The last backup that did pass, if there is one, is kept as well."],
  [/^This backup holds no memory files/,
    "Chats and settings were saved, but none of this companion's memory files. Hearthside reads memory from the companion's folder on this computer, or downloads it from Letta Cloud. This companion had nothing to read in either place, which is usual when it runs on your own server. To keep its memory safe, back the memory up on that server as well."],
  // This used to end "Nothing is missing", which isn't true for a companion on your own
  // server: nothing is downloaded for it at all. The count is what says which it is.
  [/^Memory files aren't on this computer/,
    "This companion's memory isn't kept in a folder on this computer. If it lives in Letta Cloud, the backup downloads it from there instead, with its history: those are the \"repository files\" in the summary above. If that says 0, this backup has no memory files, and another note here says so."],
  [/pictures? left out \(pictures are switched off/,
    "Images from chats weren't saved, because \"Include pictures\" is off below. Turn it on if you want them kept; backups get bigger."],
  [/^Configuration coverage:/,
    "The backup saves what's needed to rebuild this companion: its model, instructions, tools and other settings. A few things can't be copied, such as passwords and API keys, so you may need to enter those again after a restore. This note is on every backup."],
  [/^Capture observations: .*changed while the backup ran/,
    "Your companion was busy, usually replying, while the backup ran. The backup keeps everything as it was when it started; anything newer goes into the next backup."],
  [/^Capture is non-atomic/,
    "Letta can't pause a companion while it's being backed up. If something changed during the backup, some parts may be a moment newer than others. The next backup catches up; this is normally nothing to worry about."],
  [/^Incremental backup:/,
    "To save time, this backup reused chats from the last backup and fetched only new messages. If you edited or deleted older messages, press \"Full backup\" to pick that up. A full backup also runs by itself once a week."],
  [/^archival\/passages\.json:/,
    "Archival memory is the long-term notes your companion files away with its archival tools. It couldn't be read in full this time, so it was left out rather than saved half-done."],
  [/^agent-files\/.*\[unsupported\]/,
    "A \"context export\" is an optional single file Letta can make of a companion's whole setup. Letta Cloud doesn't offer it, for anyone. Nothing is missing because of this: chats, memory and settings are backed up separately."],
  [/^agent-files\/.*\[not-found\]/,
    "A \"context export\" is an optional single file Letta can make of a companion's whole setup. Letta had none for this companion. Chats, memory and settings are still backed up separately; this file is only an extra."],
  [/^agent-files\//,
    "A \"context export\" is an optional single file Letta can make of a companion's whole setup. It couldn't be fetched this time. Chats, memory and settings are backed up separately. " + TRY_AGAIN],
  [/^Attached history \(repositories on Letta Cloud\) couldn't be read/,
    "This companion's memory couldn't be downloaded from Letta Cloud this time, so this backup has no memory files. Try \"Back up now\" again; if it keeps happening, let us know."],
  [/^Part of repository ".*" couldn't be read/,
    "Some of this companion's memory couldn't be downloaded from Letta Cloud this time, so it was left out rather than saved half-done. Try \"Back up now\" again; if it keeps happening, let us know."],
  [/^Repository ".*" Git history is unavailable/,
    "The memory files themselves were saved, but not their history of earlier versions. A restore brings back the files as they are now."],
  [/^Repository ".*" identity\/primary\/permissions\/revision metadata is incomplete/,
    "Letta didn't say everything about this memory store (for example which version it's at). Its files were saved; a restore may need you to confirm where they belong."],
  [/^Attached repository inventory was not supplied/,
    "This connection doesn't list memory stores in Letta Cloud, so none were downloaded. That's normal when the companion runs on this computer or your own server."],
  [/^Schedules couldn't be read/,
    "This companion's scheduled tasks couldn't be listed this time, so they aren't in this backup. " + TRY_AGAIN],
  [/attachments could not be captured/,
    "Some files attached to messages couldn't be downloaded. The messages themselves are saved; only those attachments are missing. " + TRY_AGAIN],
  [/^Active context for .* was not supplied/,
    "The whole chat is saved, but not Letta's exact list of what the companion currently has in mind for it. After a restore it picks up from its recent messages instead."],
  [/^Not followed in the memory folder/,
    "These items in the memory folder point somewhere else on this computer, so the backup didn't follow them, for safety. Everything else in the folder was saved."],
  [/^Memory history \(git\) couldn't be read/,
    "The memory files were saved, but their history of earlier versions couldn't be read this time. " + TRY_AGAIN],
  [/^Local memory Git history is unavailable/,
    "The memory files were saved, but there's no history of earlier versions to save with them."],
  [/^Local memory working tree and Git bundle were read separately/,
    "The memory files and their history are read one after the other. If the companion changed its memory in between, the two can differ slightly. This note is on every backup of a companion whose memory is on this computer."],
  [/no artifact data was returned/,
    "Letta answered but sent nothing for this part, so it isn't in the backup. " + TRY_AGAIN],
  [/incremental capture built on an earlier backup/,
    "This chat was saved by adding new messages to an earlier backup. Messages edited or deleted before then appear as they were. A full backup refreshes everything."],
  [/legacy capture has no full-history freshness provenance/,
    "This chat was saved by an older version of Hearthside, which didn't record how complete the history was. It's still restorable; a new backup records it properly."],
  [/^Legacy snapshot header is not authenticated/,
    "This backup was made by an older version of Hearthside, which didn't seal its summary. Its contents are still checked; only the totals shown can't be vouched for."],
  [/^No conversation metadata is available/,
    "This backup doesn't say how complete its chats are, so a restore can't promise every message is there."],
  [/^Integrity checks do not prove/,
    "The check confirms every saved piece is intact and unchanged. It can't prove the backup holds everything that was ever in Letta, or that a restored companion will pick up exactly where it left off."],
];

/** The plain explanation for one note, or null when there is nothing to say. */
export function explainBackupNote(line: string): string | null {
  const text = line.trim();
  if (!text) return null;
  for (const [pattern, explanation] of RULES) if (pattern.test(text)) return explanation;
  const code = /code=([a-z_]+)/.exec(text)?.[1];
  if (code && CODES[code]) return `${CODES[code]} ${TRY_AGAIN}`;
  return "Part of this companion couldn't be included in this backup. " + TRY_AGAIN;
}

/** The same for "the last backup failed" messages, which carry a failure code. */
export function explainBackupFailure(message: string): string {
  // A file's name is the cause, and trying again can't help: say what will.
  if (/has a name a backup can't hold|has the same name as another one apart from capitals/.test(message)) {
    return "One file in this companion's memory has a name that can't be stored safely in a backup, so the backup stopped rather than leave the file out or rename it for you. Rename that file (the message says which one), then press \"Back up now\". Backups of this companion will keep failing until then; your earlier backups are untouched.";
  }
  const code = /code=([a-z_]+)/.exec(message)?.[1];
  const what = code && CODES[code] ? CODES[code] : "Something went wrong partway through.";
  // A routine backup picks up where the last one stopped. When that place can't be
  // found any more, only a full read gets past it.
  const next = code && code.startsWith("cursor_")
    ? "Try \"Back up now\" again; if it keeps failing, press \"Full backup\", which reads every chat again from the start."
    : "Try \"Back up now\" again; if it keeps failing, let us know.";
  return `${what} This attempt didn't become a backup, and your earlier backups are untouched. ${next}`;
}

/**
 * The restored copies made from one companion's backups, newest first, for the
 * "restored copies" list under that companion (the list itself comes from main).
 */
export function copiesOf<T extends { sourceAgentId: string; createdAt: string }>(copies: T[], agentId: string): T[] {
  return copies.filter((copy) => copy.sourceAgentId === agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}



export type GroupedNote = { text: string; source: string; count: number };
const ITEM_NOTE = /^([A-Za-z0-9_.-]+)\/[^\s:]+: (.+)$/s;
const noun = (folder: string, count: number) => (folder === "agent-files" || folder === "conversations" ? (count === 1 ? "chat" : "chats") : count === 1 ? "file" : "files");

export function groupBackupNotes(lines: string[]): GroupedNote[] {
  const groups = new Map<string, { folder: string; message: string; lines: string[] }>();
  const order: Array<string | { line: string }> = [];
  for (const line of lines) {
    const match = ITEM_NOTE.exec(line.trim());
    if (!match) { order.push({ line }); continue; }
    const key = `${match[1]}\u0000${match[2]}`;
    const group = groups.get(key);
    if (group) group.lines.push(line);
    else { groups.set(key, { folder: match[1]!, message: match[2]!, lines: [line] }); order.push(key); }
  }
  return order.map((item) => {
    if (typeof item !== "string") return { text: item.line, source: item.line, count: 1 };
    const group = groups.get(item)!;
    if (group.lines.length === 1) return { text: group.lines[0]!, source: group.lines[0]!, count: 1 };
    return { text: `${group.lines.length.toLocaleString()} ${noun(group.folder, group.lines.length)}: ${group.message}`, source: group.lines[0]!, count: group.lines.length };
  });
}

/** Pieces a restore doesn't apply, one line per reason. */
export function groupUnrestoredParts(parts: Array<{ path: string; reason: string }>): Array<{ text: string; count: number }> {
  const byReason = new Map<string, string[]>();
  for (const part of parts) byReason.set(part.reason, [...(byReason.get(part.reason) ?? []), part.path]);
  return [...byReason].map(([reason, paths]) => paths.length === 1
    ? { text: `${paths[0]}: ${reason}`, count: 1 }
    : { text: `${paths.length.toLocaleString()} pieces: ${reason}`, count: paths.length });
}

/** Pieces a restore applies, one line per kind. */
export function groupPartsByKind(parts: Array<{ path: string; kind: string }>): Array<{ text: string; count: number }> {
  const byKind = new Map<string, string[]>();
  for (const part of parts) byKind.set(part.kind, [...(byKind.get(part.kind) ?? []), part.path]);
  return [...byKind].map(([kind, paths]) => paths.length === 1 ? { text: `${paths[0]} · ${kind}`, count: 1 } : { text: `${paths.length.toLocaleString()} pieces · ${kind}`, count: paths.length });
}
