import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { app } from "electron";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import yauzl from "yauzl";
import { ATTRIBUTION_NOTE, BRANCH_NOTE } from "@hearthside/ipc-contract";
import type { HistoryImportPreview, HistoryImportResult } from "@hearthside/ipc-contract";
import { resolveRuntimeHome } from "../runtime/paths";
import { gitHooksHint, withoutGitRedirects } from "../runtime/child-env";




export type Speaker = "human" | "assistant";
export interface ImportedMessage {
  speaker: Speaker;
  text: string;
  /** Milliseconds since 1970, when known. */
  at: number | null;
}
export interface ImportedConversation {
  id: string;
  title: string;
  createdAt: number | null;
  messages: ImportedMessage[];
  /** Marked archived in the export (ChatGPT's is_archived); included unless the person says otherwise. */
  archived?: boolean;
}
export interface ParsedExport {
  source: "chatgpt" | "claude";
  conversations: ImportedConversation[];
  omitted: { systemOrTool: number; hidden: number; images: number; empty: number; otherBranches: number };
}

export const SOURCE_LABEL: Record<ParsedExport["source"], string> = { chatgpt: "ChatGPT", claude: "Claude" };

const MAX_JSON_BYTES = 1024 * 1024 * 1024;
/** Letta's default per-file limit (maxFileCharacters) and folder depth (maxDepth). */
export const DEFAULT_LIMITS = { maxFileCharacters: 20_000, maxDepth: 2 };
/** Room left for the header of each conversation file. */
const HEADER_ROOM = 2_000;
/** For the tests: the default size of one conversation chunk. */
export const MAX_FILE_CHARS = DEFAULT_LIMITS.maxFileCharacters - HEADER_ROOM;

/** The memory's own limits, from .memfs.config.json when it has one. */
export function memoryLimits(memoryDir: string | null): { maxFileCharacters: number; maxDepth: number } {
  if (!memoryDir) return DEFAULT_LIMITS;
  try {
    const config = JSON.parse(readFileSync(join(memoryDir, ".memfs.config.json"), "utf8")) as { maxFileCharacters?: unknown; maxDepth?: unknown };
    return {
      maxFileCharacters: typeof config.maxFileCharacters === "number" && config.maxFileCharacters > 4_000 ? config.maxFileCharacters : DEFAULT_LIMITS.maxFileCharacters,
      maxDepth: typeof config.maxDepth === "number" ? config.maxDepth : DEFAULT_LIMITS.maxDepth,
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null);
const isoTime = (value: unknown) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/** Which export this is, from its shape. */
export function detectSource(data: unknown): ParsedExport["source"] | null {
  const first = Array.isArray(data) ? data.find(isRecord) : null;
  if (!first) return null;
  if (isRecord(first.mapping)) return "chatgpt";
  if (Array.isArray(first.chat_messages)) return "claude";
  return null;
}

/**
 * Said text on a mapping node: a human or assistant message the person would
 * have seen, had this node been on the shown branch. Used to count what an
 * edit or a regeneration replaced, so the same rules decide "a message" here
 * and in the import (hidden, system/tool and empty nodes are not counted twice).
 */
function isSaidMessage(node: Json): boolean {
  const message = isRecord(node.message) ? node.message : null;
  if (!message) return false;
  const role = str(isRecord(message.author) ? message.author.role : "");
  if (role !== "user" && role !== "assistant") return false;
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  if (metadata.is_visually_hidden_from_conversation === true) return false;
  const content = isRecord(message.content) ? message.content : {};
  const type = str(content.content_type);
  if (type && type !== "text" && type !== "multimodal_text") return false;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.some((part) => (typeof part === "string" ? part.trim().length > 0 : isRecord(part) && (typeof part.text === "string" ? part.text.trim().length > 0 : /image/.test(str(part.content_type) || str(part.asset_pointer)))));
}

/** ChatGPT: follow the shown branch (current_node back to the root). */
export function parseChatGpt(data: unknown[]): ParsedExport {
  const omitted = { systemOrTool: 0, hidden: 0, images: 0, empty: 0, otherBranches: 0 };
  const conversations: ImportedConversation[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || !isRecord(raw.mapping)) continue;
    const mapping = raw.mapping as Record<string, Json>;
    const chain: Json[] = [];
    let nodeId = str(raw.current_node);
    const seen = new Set<string>();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      chain.push(mapping[nodeId]!);
      nodeId = str(mapping[nodeId]!.parent);
    }
    chain.reverse();
    // Everything the mapping holds that this conversation's shown branch doesn't:
    // the prompts and replies an edit or a regeneration left behind. Counted only
    // once the conversation itself is kept, so a skipped export entry adds nothing.
    let otherBranches = 0;
    for (const [id, node] of Object.entries(mapping)) {
      if (!seen.has(id) && isRecord(node) && isSaidMessage(node)) otherBranches += 1;
    }
    const messages: ImportedMessage[] = [];
    for (const node of chain) {
      const message = isRecord(node.message) ? node.message : null;
      if (!message) continue;
      const role = str(isRecord(message.author) ? message.author.role : "");
      const metadata = isRecord(message.metadata) ? message.metadata : {};
      if (role !== "user" && role !== "assistant") {
        if (role) omitted.systemOrTool += 1;
        continue;
      }
      if (metadata.is_visually_hidden_from_conversation === true) {
        omitted.hidden += 1;
        continue;
      }
      const content = isRecord(message.content) ? message.content : {};
      const type = str(content.content_type);
      if (type && type !== "text" && type !== "multimodal_text") {
        // Code run by tools, browsing results and the like: not what was said.
        omitted.systemOrTool += 1;
        continue;
      }
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const pieces: string[] = [];
      for (const part of parts) {
        if (typeof part === "string") pieces.push(part);
        else if (isRecord(part) && /image/.test(str(part.content_type) || str(part.asset_pointer))) {
          pieces.push("[image]");
          omitted.images += 1;
        } else if (isRecord(part) && typeof part.text === "string") pieces.push(part.text);
      }
      const text = pieces.join("\n").trim();
      if (!text) {
        omitted.empty += 1;
        continue;
      }
      messages.push({ speaker: role === "user" ? "human" : "assistant", text, at: seconds(message.create_time) });
    }
    if (messages.length === 0) continue;
    omitted.otherBranches += otherBranches;
    conversations.push({
      id: str(raw.conversation_id) || str(raw.id) || hashId(str(raw.title), seconds(raw.create_time)),
      title: str(raw.title).trim() || "Untitled conversation",
      createdAt: seconds(raw.create_time) ?? messages[0]!.at,
      messages,
      ...(raw.is_archived === true ? { archived: true } : {}),
    });
  }
  return { source: "chatgpt", conversations, omitted };
}

/**
 * Claude: chat_messages is read as the flat, ordered list it is presented as, so
 * this importer reconstructs no alternative versions here and counts none
 * (otherBranches stays 0). That is what the importer does, not a claim that a
 * Claude export can never carry any.
 */
export function parseClaude(data: unknown[]): ParsedExport {
  const omitted = { systemOrTool: 0, hidden: 0, images: 0, empty: 0, otherBranches: 0 };
  const conversations: ImportedConversation[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || !Array.isArray(raw.chat_messages)) continue;
    const messages: ImportedMessage[] = [];
    for (const item of raw.chat_messages) {
      if (!isRecord(item)) continue;
      const sender = str(item.sender);
      if (sender !== "human" && sender !== "assistant") {
        omitted.systemOrTool += 1;
        continue;
      }
      const pieces: string[] = [];
      if (Array.isArray(item.content) && item.content.length > 0) {
        for (const part of item.content) {
          if (!isRecord(part)) continue;
          if (part.type === "text" && typeof part.text === "string") pieces.push(part.text);
          else if (part.type === "image") {
            pieces.push("[image]");
            omitted.images += 1;
          } else omitted.systemOrTool += 1;
        }
      } else if (typeof item.text === "string") pieces.push(item.text);
      for (const list of [item.attachments, item.files]) {
        if (!Array.isArray(list)) continue;
        for (const file of list) if (isRecord(file) && str(file.file_name)) pieces.push(`[attachment: ${str(file.file_name)}]`);
      }
      const text = pieces.join("\n").trim();
      if (!text) {
        omitted.empty += 1;
        continue;
      }
      messages.push({ speaker: sender, text, at: isoTime(item.created_at) });
    }
    if (messages.length === 0) continue;
    conversations.push({
      id: str(raw.uuid) || hashId(str(raw.name), isoTime(raw.created_at)),
      title: str(raw.name).trim() || "Untitled conversation",
      createdAt: isoTime(raw.created_at) ?? messages[0]!.at,
      messages,
    });
  }
  return { source: "claude", conversations, omitted };
}

function hashId(title: string, at: number | null): string {
  return createHash("sha256").update(`${title}\u0000${at ?? ""}`).digest("hex").slice(0, 16);
}

export function parseExport(data: unknown): ParsedExport {
  const source = detectSource(data);
  if (!source || !Array.isArray(data)) {
    throw new Error("This doesn't look like a ChatGPT or Claude export. Choose the .zip you downloaded, or the conversations.json inside it.");
  }
  return source === "chatgpt" ? parseChatGpt(data) : parseClaude(data);
}

// --- Rendering --------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, "0");
function utc(at: number): { date: string; time: string; year: string; month: string } {
  const d = new Date(at);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    year: String(d.getUTCFullYear()),
    month: pad(d.getUTCMonth() + 1),
  };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (at: number) => {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export function slug(value: string, fallback = "conversation"): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || fallback
  );
}
const idPart = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "x";
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export interface RenderedFile {
  path: string;
  content: string;
  /** For the indexes. */
  title: string;
  at: number | null;
  messages: number;
}

/** One conversation as one or more Markdown files (split at message boundaries). */
export function renderConversation(conversation: ImportedConversation, source: ParsedExport["source"], personName: string, chunk = MAX_FILE_CHARS): RenderedFile[] {
  const label = SOURCE_LABEL[source];
  const human = personName.trim() || "User";
  const at = conversation.createdAt ?? conversation.messages[0]?.at ?? null;
  const when = at === null ? null : utc(at);
  const folder = when ? `history/${source}-${when.year}-${when.month}` : `history/${source}-undated`;
  const stem = `${when ? `${when.date.slice(8)}-` : ""}${slug(conversation.title, "chat").slice(0, 30).replace(/-+$/, "")}-${idPart(conversation.id)}`;

  // Messages, grouped into parts no longer than the chunk size; a single very
  // long message is itself split at line breaks (or, failing that, anywhere).
  const blocks = conversation.messages.flatMap((message) => {
    const stamp = message.at === null ? "" : ` · ${utc(message.at).date} ${utc(message.at).time} UTC`;
    const who = `**${message.speaker === "human" ? human : label}**${stamp}`;
    const text = message.text.trim();
    if (text.length + who.length + 4 <= chunk) return [`${who}\n\n${text}\n`];
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > 0) {
      let cut = Math.min(rest.length, chunk - who.length - 40);
      const newline = rest.lastIndexOf("\n", cut);
      if (cut < rest.length && newline > cut / 2) cut = newline;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, "");
    }
    return pieces.map((piece, index) => `${who}${index > 0 ? " (continued)" : ""}\n\n${piece}\n`);
  });
  const parts: string[][] = [[]];
  let size = 0;
  for (const block of blocks) {
    if (size > 0 && size + block.length > chunk) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1]!.push(block);
    size += block.length;
  }

  const total = parts.length;
  const fileFor = (index: number) => (total === 1 ? `${stem}.md` : `${stem}-part-${index + 1}.md`);
  return parts.map((part, index) => {
    const name = fileFor(index).replace(/\.md$/, "");
    const partNote = total > 1 ? ` (part ${index + 1} of ${total})` : "";
    const description = oneLine(
      `${label} conversation${at === null ? "" : ` from ${longDate(at)}`}: "${conversation.title}"${partNote}, ${conversation.messages.length} messages`,
    ).replace(/[\r\n]/g, " ");
    const header = [
      `# ${conversation.title}${partNote}`,
      "",
      `Imported from ${label}${at === null ? "" : `. Started ${longDate(at)}`}. ${conversation.messages.length} messages. ${label} id: ${conversation.id}`,
      ...(index > 0 ? ["", `Continues from [[${folder}/${fileFor(index - 1)}]].`] : []),
      "",
    ];
    const footer = index < total - 1 ? ["", `Continues in [[${folder}/${fileFor(index + 1)}]].`] : [];
    const content = [`---`, `name: ${name}`, `description: ${description}`, `---`, "", ...header, part.join("\n"), ...footer].join("\n").trimEnd() + "\n";
    return { path: `${folder}/${fileFor(index)}`, content, title: `${conversation.title}${partNote}`, at, messages: conversation.messages.length };
  });
}

export function renderAll(parsed: ParsedExport, personName: string, chunk = MAX_FILE_CHARS): RenderedFile[] {
  const files: RenderedFile[] = [];
  const used = new Set<string>();
  for (const conversation of parsed.conversations) {
    for (const file of renderConversation(conversation, parsed.source, personName, chunk)) {
      // Two conversations that collide on date, title and id prefix: keep both.
      let path = file.path;
      for (let n = 2; used.has(path); n++) path = file.path.replace(/\.md$/, `-${n}.md`);
      used.add(path);
      files.push({ ...file, path });
    }
  }
  return files;
}

// --- Indexes -------------------------------------------------------------------

const INDEX_HEADER = (title: string, text: string) => `# ${title}\n\n${text}\n`;
const FOLDER = /^(chatgpt|claude)-(\d{4})-(\d{2})$|^(chatgpt|claude)-undated$/;
const LATER_PART = /-part-([2-9]|\d{2,})\.md$/;



export function staleImportFiles(existing: Iterable<string>, rendered: ReadonlyArray<{ path: string }>, source: string): string[] {
  const ending = /-([a-z0-9]{1,8})(?:-part-\d+)?\.md$/;
  const fresh = new Set(rendered.map((file) => file.path.replace(/^history\//, "")));
  const ids = new Set(rendered.map((file) => ending.exec(file.path)?.[1]).filter((id): id is string => Boolean(id)));
  return [...existing].filter((path) => {
    const relative = path.replace(/^history\//, "");
    if (fresh.has(relative)) return false;
    const match = /^([a-z]+)-[^/]+\/[^/]+$/.exec(relative);
    const id = ending.exec(relative)?.[1];
    return Boolean(match && match[1] === source && id && ids.has(id));
  });
}

/** Every file under a local memory's history folder, as "history/<folder>/<name>". */
function localHistoryFiles(memoryDir: string): string[] {
  const root = join(memoryDir, "history");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const folder of readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(root, folder.name))) out.push(`history/${folder.name}/${name}`);
  }
  return out;
}

/** One listed conversation, its path relative to the history folder ("chatgpt-2025-02/03-x.md"). */
export interface IndexEntry {
  path: string;
  title: string;
  messages: number;
}

/** Lines that fit within a size budget; the rest summed up in one line. */
function fitLines(lines: string[], budget: number, more: (count: number) => string): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    if (size + line.length + 1 > budget) return [...kept, more(lines.length - index)];
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
}

/**
 * The MEMORY.md indexes for a history folder: one per month folder and one for
 * the whole history. Paths are relative to the history folder ("MEMORY.md",
 * "chatgpt-2025-02/MEMORY.md"); `records` are the sources with an import record.
 */
export function buildIndexes(entries: IndexEntry[], records: string[], maxFileCharacters = DEFAULT_LIMITS.maxFileCharacters): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const budget = maxFileCharacters - 600;
  const byFolder = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const [folder, name] = entry.path.split("/");
    if (!folder || !name || !FOLDER.test(folder) || LATER_PART.test(name)) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
  }
  // Newest first, per source.
  const folders = [...byFolder.keys()].sort((a, b) => a.split("-")[0]!.localeCompare(b.split("-")[0]!) || b.localeCompare(a));
  const folderLines: string[] = [];
  for (const folder of folders) {
    const match = FOLDER.exec(folder)!;
    const label = SOURCE_LABEL[(match[1] ?? match[4]) as ParsedExport["source"]];
    const period = match[2] ? `${MONTHS[Number(match[3]) - 1]} ${match[2]}` : "undated";
    const list = [...byFolder.get(folder)!].sort((a, b) => a.path.localeCompare(b.path));
    const lines = list.map((entry) => {
      const name = entry.path.split("/")[1]!;
      const day = /^\d{2}-/.test(name) ? `${name.slice(0, 2)} · ` : "";
      return `- [${day}${entry.title.slice(0, 60)}](${name}): ${entry.messages} messages`;
    });
    out.push({
      path: `${folder}/MEMORY.md`,
      content: INDEX_HEADER(
        `${label}: ${period}`,
        `${list.length} conversations from ${period}, by day. Search this folder for anything not listed.\n\n${fitLines(lines, budget - 200, (count) => `- …and ${count} more in this folder`).join("\n")}`,
      ),
    });
    folderLines.push(`- [${label} · ${period}](${folder}/): ${list.length} conversations`);
  }
  const recordLinks = ["chatgpt", "claude"]
    .filter((source) => records.includes(source))
    .map((source) => `[${SOURCE_LABEL[source as ParsedExport["source"]]}](imports-${source}.md)`)
    .join(", ");
  out.push({
    path: "MEMORY.md",
    content: INDEX_HEADER(
      "History",
      `Past conversations imported from other apps, one folder per app and month. A searchable record of what was said, not memories: search here before saying you don't remember something. Import records: ${recordLinks || "none yet"}.\n\n${fitLines(folderLines, budget - 600, (count) => `- …and ${count} more folders`).join("\n")}`,
    ),
  });
  return out;
}

/** Title and message count from a file this importer wrote. */
function entryFromText(path: string, text: string): IndexEntry {
  return { path, title: /^# (.+)$/m.exec(text)?.[1] ?? basename(path, ".md"), messages: Number(/(\d+) messages\./.exec(text)?.[1] ?? 0) };
}

/** The conversations already in a local agent's history/ folder. */
function scanEntries(historyDir: string): IndexEntry[] {
  if (!existsSync(historyDir)) return [];
  const entries: IndexEntry[] = [];
  for (const folder of readdirSync(historyDir)) {
    const dir = join(historyDir, folder);
    if (!FOLDER.test(folder) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || name === "MEMORY.md" || LATER_PART.test(name)) continue;
      entries.push(entryFromText(`${folder}/${name}`, readFileSync(join(dir, name), "utf8")));
    }
  }
  return entries;
}

/** Rebuild the MEMORY.md indexes under a local agent's history/ (paths under history/). */
export function rebuildIndexes(memoryDir: string, maxFileCharacters = DEFAULT_LIMITS.maxFileCharacters): Array<{ path: string; content: string }> {
  const historyDir = join(memoryDir, "history");
  const records = ["chatgpt", "claude"].filter((source) => existsSync(join(historyDir, `imports-${source}.md`)));
  return buildIndexes(scanEntries(historyDir), records, maxFileCharacters).map((index) => ({ ...index, path: `history/${index.path}` }));
}

const SIGNPOST = "- [History](history/): Past conversations imported from other apps. Search here before saying you don't remember something.";

/** The root MEMORY.md with the history signpost, or null if it's already there. */
export function withSignpost(rootIndex: string): string | null {
  if (/\]\(history\/\)/.test(rootIndex)) return null;
  return `${rootIndex.trimEnd() || "# Memory"}\n${SIGNPOST}\n`;
}

/** The import record for a source: this import first, then up to 19 earlier ones. */
function importRecord(previous: string | null, job: Pending, files: number): string {
  const label = SOURCE_LABEL[job.parsed.source];
  const earlier = previous ? previous.split("\n## ").slice(1, 20).map((entry) => `## ${entry.trimEnd()}`) : [];
  const o = job.parsed.omitted;
  const entry = [
    `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${job.parsed.conversations.length} conversations`,
    "",
    `- File: ${basename(job.file)} (sha256 ${job.sha256.slice(0, 16)}…)`,
    `- Conversations: ${job.parsed.conversations.length}; messages: ${job.parsed.conversations.reduce((sum, item) => sum + item.messages.length, 0)}; files: ${files}`,
    `- Left out: ${o.systemOrTool} system or tool messages, ${o.hidden} hidden messages, ${o.empty} empty messages; ${o.images} images noted as [image]`,
    ...(o.otherBranches > 0
      ? [`- Not imported: ${o.otherBranches} messages on branches that were edited or regenerated away. ${BRANCH_NOTE}`]
      : [`- Branches: none left out; this import found a single version of every conversation. ${BRANCH_NOTE}`]),
    `- Attribution: ${ATTRIBUTION_NOTE}`,
  ].join("\n");
  return `---\nname: imports-${job.parsed.source}\ndescription: Record of each import from ${label}: when, which file, what was left out, and what the import does not carry across.\n---\n\n# Imports from ${label}\n\n${[entry, ...earlier].join("\n\n")}\n`;
}

// --- Reading the export file --------------------------------------------------

function readZipEntry(file: string, wanted: (name: string) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("Couldn't open that zip file."));
      let found = false;
      // A damaged zip reports its problem here, sometimes after the first
      // entry. With nothing listening the import never finished: the dialog
      // spun for good and could not be closed.
      zip.on("error", () => reject(new Error("That zip file is damaged and can't be read. Download the export again and choose the new file.")));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!wanted(entry.fileName)) return zip.readEntry();
        found = true;
        if (entry.uncompressedSize > MAX_JSON_BYTES) {
          zip.close();
          return reject(new Error("The conversations file in that export is too large (over 1 GB)."));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(new Error("Couldn't read the conversations file in that zip."));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", () => reject(new Error("Couldn't read the conversations file in that zip.")));
        });
      });
      zip.on("end", () => {
        if (!found) reject(new Error("That zip has no conversations.json. Choose the export you downloaded from ChatGPT or Claude."));
      });
      zip.readEntry();
    });
  });
}

export async function readExport(file: string): Promise<{ data: unknown; sha256: string }> {
  const raw = file.toLowerCase().endsWith(".zip")
    ? await readZipEntry(file, (name) => /(^|\/)conversations\.json$/i.test(name))
    : (() => {
        if (statSync(file).size > MAX_JSON_BYTES) throw new Error("That file is too large (over 1 GB).");
        return readFileSync(file);
      })();
  const sha256 = createHash("sha256").update(raw).digest("hex");
  try {
    return { data: JSON.parse(raw.toString("utf8")), sha256 };
  } catch (error) {
    throw new Error(exportReadFailure(error));
  }
}

/**
 * Why an export could not be read. A conversations file of roughly 500 MB or
 * more is too long to hold as one piece of text; that used to be reported as
 * "isn't valid JSON", which sent people looking for damage that was not there.
 */
export function exportReadFailure(error: unknown): string {
  return (error as { code?: string } | null)?.code === "ERR_STRING_TOO_LONG"
    ? "That export is too large for Hearthside to read (its conversations file is over about 500 MB)."
    : "That file isn't valid JSON.";
}

// --- Letta Cloud: a read-only repository attached to the agent -------------------

/**
 * What a Cloud import needs from Letta (injected, so tests can use a fake).
 * The history goes into a repository of its own, attached to the agent with
 * read permission (attaching also refreshes the agent's prompt), the way
 * Continuity Studio does it: the agent's own synced memory is never touched.
 */
export interface HistoryCloud {
  findRepository(name: string): Promise<string | null>;
  createRepository(name: string): Promise<string>;
  readFile(repositoryId: string, path: string): Promise<string | null>;
  /** Every file path in the repository (one listing). */
  listPaths(repositoryId: string): Promise<Set<string>>;
  /** Sent once each: no retries underneath; ensureFile decides. */
  createFile(repositoryId: string, path: string, content: string): Promise<void>;
  updateFile(repositoryId: string, path: string, content: string): Promise<void>;
  /** Remove a file (an earlier version of an imported conversation); a missing file is fine. */
  deleteFile(repositoryId: string, path: string): Promise<void>;
  isAttached(agentId: string, repositoryId: string): Promise<boolean>;
  attach(agentId: string, repositoryId: string): Promise<void>;
}

/** Inside the repository: what's there, so re-imports and indexes don't re-read every file. */
const MANIFEST_PATH = ".hearthside/history.json";
type Manifest = { version: 1; files: Record<string, { sha: string; title?: string; messages?: number }>; records: string[] };
const emptyManifest = (): Manifest => ({ version: 1, files: {}, records: [] });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export const repositoryName = (agentId: string) => `hearthside-history-${agentId.replace(/[^a-zA-Z0-9-]/g, "").slice(-40)}`;

async function readManifest(cloud: HistoryCloud, repositoryId: string): Promise<Manifest> {
  const text = await cloud.readFile(repositoryId, MANIFEST_PATH);
  if (!text) return emptyManifest();
  try {
    const parsed = JSON.parse(text) as Manifest;
    return parsed.version === 1 && parsed.files ? { ...emptyManifest(), ...parsed } : emptyManifest();
  } catch {
    return emptyManifest();
  }
}



export type CloudErrorInfo = { kind: "busy" | "conflict" | "unknown" | "missing" | "other"; status?: number; requestId?: string; retryAfterMs?: number; message: string };

export function cloudErrorInfo(error: unknown): CloudErrorInfo {
  const shape = (error ?? {}) as { status?: unknown; statusCode?: unknown; headers?: unknown; message?: unknown; name?: unknown };
  const status = typeof shape.status === "number" ? shape.status : typeof shape.statusCode === "number" ? shape.statusCode : undefined;
  const header = (name: string): string | undefined => {
    const headers = shape.headers as { get?: (key: string) => string | null } | Record<string, string> | undefined;
    if (!headers) return undefined;
    if (typeof (headers as { get?: unknown }).get === "function") return (headers as { get: (key: string) => string | null }).get(name) ?? undefined;
    return (headers as Record<string, string>)[name] ?? undefined;
  };
  const message = String(shape.message ?? error).slice(0, 300);
  const requestId = header("x-request-id") ?? header("request-id") ?? header("cf-ray");
  const seconds = Number(header("retry-after"));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 120_000) : undefined;
  const base = { ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}), ...(retryAfterMs ? { retryAfterMs } : {}), message };
  if (status === 429 || (status !== undefined && status >= 500)) return { kind: "busy", ...base };
  if (status === 409 || /repository changed|already exists/i.test(message)) return { kind: "conflict", ...base };
  if (status === 404 || /\b404\b|not found/i.test(message)) return { kind: "missing", ...base };
  if (status === undefined && /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|timed? ?out|aborted|connection/i.test(`${String(shape.name)} ${message}`)) return { kind: "unknown", ...base };
  return { kind: "other", ...base };
}

export type ImportPacing = { sleep?: (ms: number) => Promise<void>; gapMs?: number; maxAttempts?: number };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Make one file in the repository hold exactly `content`. Every failure is
 * followed by reading the file back: an earlier attempt may have landed even
 * though no answer came. Only a real difference is written again, with growing
 * waits. Returns whether this call wrote it.
 */
export async function ensureFile(cloud: HistoryCloud, repositoryId: string, path: string, content: string, existsHint: boolean, pacing: ImportPacing = {}): Promise<"written" | "already"> {
  const sleep = pacing.sleep ?? realSleep;
  const maxAttempts = pacing.maxAttempts ?? 8;
  const digest = sha(content);
  let exists = existsHint;
  let wait = 2_000;
  let last: CloudErrorInfo | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const operation = exists ? "update" : "create";
    try {
      if (exists) await cloud.updateFile(repositoryId, path, content);
      else await cloud.createFile(repositoryId, path, content);
      return "written";
    } catch (error) {
      last = cloudErrorInfo(error);
      console.warn(`[history] ${operation} ${path}: ${last.status ?? last.kind}${last.requestId ? ` (request ${last.requestId})` : ""}: ${last.message}`);
      if (last.kind === "other") break;
      // "missing" here means an update of a file that isn't there: create it next time.
      if (last.kind === "busy" || last.kind === "unknown") await sleep(last.retryAfterMs ?? wait);
      const remote = await cloud.readFile(repositoryId, path);
      if (remote !== null && sha(remote) === digest) return "already";
      exists = remote !== null;
      if (last.kind === "conflict" || last.kind === "missing") await sleep(last.retryAfterMs ?? wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }
  const detail = last ? `${last.status ? `${last.status} ` : ""}${last.message}${last.requestId ? ` (Letta request ${last.requestId})` : ""}` : "unknown error";
  throw new Error(`Letta kept refusing ${path}: ${detail}`);
}

/**
 * Progress kept on this computer while an import runs, so a stopped import
 * picks up where it was: which files are confirmed on Letta, with their
 * content's hash. Tied to the repository and the export file; a file is only
 * skipped when this says so AND it is in the repository's listing.
 */
type Checkpoint = { version: 1; repositoryId: string; files: Record<string, string> };

function checkpointPath(dir: string, repositoryId: string, exportSha: string): string {
  return join(dir, `${sha(`${repositoryId}\n${exportSha}`).slice(0, 32)}.json`);
}

function loadCheckpoint(path: string, repositoryId: string): Checkpoint {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
    if (parsed.version === 1 && parsed.repositoryId === repositoryId && parsed.files) return parsed;
  } catch {
    // None yet, or unreadable: start from what the repository holds.
  }
  return { version: 1, repositoryId, files: {} };
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(checkpoint));
  renameSync(temp, path);
}

/** One import per history at a time, across every window and retry. */
const importing = new Set<string>();

async function runCloudImport(
  job: Pending,
  personName: string,
  cloud: HistoryCloud,
  onProgress: (done: number, total: number) => void,
  options: { pacing?: ImportPacing; checkpointDir?: string } = {},
): Promise<HistoryImportResult> {
  const pacing = options.pacing ?? {};
  const sleep = pacing.sleep ?? realSleep;
  const gap = pacing.gapMs ?? 300;
  const name = repositoryName(job.agentId);
  const repositoryId = (await cloud.findRepository(name)) ?? (await cloud.createRepository(name));
  if (importing.has(repositoryId)) throw new Error("This history is already being imported. Wait for that to finish.");
  importing.add(repositoryId);
  try {
    const manifest = await readManifest(cloud, repositoryId);
    const remote = await cloud.listPaths(repositoryId);
    const progressFile = checkpointPath(options.checkpointDir ?? join(app.getPath("userData"), "history-import-progress"), repositoryId, job.sha256);
    const checkpoint = loadCheckpoint(progressFile, repositoryId);
    const files = renderAll(job.parsed, personName, MAX_FILE_CHARS).map((file) => ({ ...file, path: file.path.replace(/^history\//, "") }));
    let written = 0;
    let unchanged = 0;
    let first = true;
    const put = async (path: string, content: string, entry?: { title: string; messages: number }) => {
      const digest = sha(content);
      const confirmed = checkpoint.files[path] === digest || manifest.files[path]?.sha === digest;
      if (confirmed && remote.has(path)) {
        unchanged += 1;
      } else {
        // Paced: each write is a commit, and commits right after each other are what Letta refuses.
        if (!first) await sleep(gap);
        first = false;
        const outcome = await ensureFile(cloud, repositoryId, path, content, remote.has(path), pacing);
        remote.add(path);
        if (outcome === "written") written += 1;
        else unchanged += 1;
        checkpoint.files[path] = digest;
        saveCheckpoint(progressFile, checkpoint);
      }
      manifest.files[path] = { sha: digest, ...(entry ?? manifest.files[path] ?? {}) };
    };

    let done = 0;
    const total = files.length + 3;
    onProgress(0, total);
    // One at a time, in order: each upload is a commit to the repository.
    for (const file of files) {
      await put(file.path, file.content, { title: file.title, messages: file.messages });
      onProgress(++done, total);
    }
    // Earlier versions of these conversations under other names go (renamed, grown, shrunk).
    for (const stale of staleImportFiles(new Set([...remote, ...Object.keys(manifest.files)]), files, job.parsed.source)) {
      await sleep(gap);
      try {
        if (remote.has(stale)) await cloud.deleteFile(repositoryId, stale);
      } catch (error) {
        if (cloudErrorInfo(error).kind !== "missing") throw error;
      }
      remote.delete(stale);
      delete manifest.files[stale];
      delete checkpoint.files[stale];
      written += 1;
    }
    // The import record, then the indexes, then the manifest (last: it vouches for the rest).
    const recordPath = `imports-${job.parsed.source}.md`;
    await put(recordPath, importRecord(await cloud.readFile(repositoryId, recordPath), job, files.length));
    if (!manifest.records.includes(job.parsed.source)) manifest.records.push(job.parsed.source);
    onProgress(++done, total);
    const entries: IndexEntry[] = Object.entries(manifest.files)
      .filter(([, value]) => value.title !== undefined)
      .map(([path, value]) => ({ path, title: value.title!, messages: value.messages ?? 0 }));
    for (const index of buildIndexes(entries, manifest.records)) await put(index.path, index.content);
    onProgress(++done, total);
    await sleep(gap);
    await ensureFile(cloud, repositoryId, MANIFEST_PATH, `${JSON.stringify(manifest, null, 1)}\n`, remote.has(MANIFEST_PATH), pacing);
    if (!(await cloud.isAttached(job.agentId, repositoryId))) await cloud.attach(job.agentId, repositoryId);
    // Finished: the manifest on Letta now vouches for everything.
    rmSync(progressFile, { force: true });
    onProgress(total, total);
    return { written, unchanged, conversations: job.parsed.conversations.length, files: files.length };
  } finally {
    importing.delete(repositoryId);
  }
}

// --- Preview and import -------------------------------------------------------

/** The local memory folder for an agent, when this computer holds it. */
export function localMemoryDir(agentId: string): string | null {
  const home = resolveRuntimeHome().home ?? homedir();
  // The runtime (and the memory diff) honour LETTA_LOCAL_BACKEND_DIR; without it
  // here an import into a store kept elsewhere reported "isn't available".
  const dir = join(process.env.LETTA_LOCAL_BACKEND_DIR ?? join(home, ".letta", "lc-local-backend"), "memfs", agentId, "memory");
  return existsSync(join(dir, ".git")) ? dir : null;
}

type Pending = { agentId: string; file: string; sha256: string; parsed: ParsedExport; at: number };
const pending = new Map<string, Pending>();

/** How a preview or import reaches Letta Cloud, when the agent lives there (null: it doesn't). */
export type CloudAccess = () => Promise<HistoryCloud | null>;

export async function previewHistoryImport(agentId: string, file: string, cloudAccess: CloudAccess = async () => null): Promise<HistoryImportPreview> {
  const { data, sha256 } = await readExport(file);
  const parsed = parseExport(data);
  for (const [key, item] of pending) if (Date.now() - item.at > 30 * 60_000) pending.delete(key);
  const token = randomUUID();
  pending.set(token, { agentId, file, sha256, parsed, at: Date.now() });
  const dates = parsed.conversations.map((item) => item.createdAt).filter((at): at is number => at !== null).sort((a, b) => a - b);
  const memoryDir = localMemoryDir(agentId);
  const cloud = memoryDir ? null : await cloudAccess().catch(() => null);
  const files = renderAll(parsed, "", (memoryDir ? memoryLimits(memoryDir).maxFileCharacters : DEFAULT_LIMITS.maxFileCharacters) - HEADER_ROOM);
  // One per conversation: a split conversation counts once.
  const firsts = files.filter((item) => !LATER_PART.test(item.path));
  let already = 0;
  if (memoryDir) already = firsts.filter((item) => existsSync(join(memoryDir, item.path))).length;
  else if (cloud) {
    const repositoryId = await cloud.findRepository(repositoryName(agentId)).catch(() => null);
    if (repositoryId) {
      const manifest = await readManifest(cloud, repositoryId).catch(() => emptyManifest());
      already = firsts.filter((item) => manifest.files[item.path.replace(/^history\//, "")]).length;
    }
  }
  return {
    token,
    source: parsed.source,
    sourceLabel: SOURCE_LABEL[parsed.source],
    fileName: basename(file),
    conversations: parsed.conversations.length,
    messages: parsed.conversations.reduce((sum, item) => sum + item.messages.length, 0),
    firstDate: dates.length ? utc(dates[0]!).date : null,
    lastDate: dates.length ? utc(dates[dates.length - 1]!).date : null,
    files: files.length,
    alreadyImported: already,
    archived: parsed.conversations.filter((item) => item.archived).length,
    archivedMessages: parsed.conversations.filter((item) => item.archived).reduce((sum, item) => sum + item.messages.length, 0),
    omitted: parsed.omitted,
    attributionNote: ATTRIBUTION_NOTE,
    branchNote: BRANCH_NOTE,
    sample: [...parsed.conversations]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 5)
      .map((item) => ({ title: item.title, date: item.createdAt === null ? null : utc(item.createdAt).date, messages: item.messages.length })),
    supported: memoryDir !== null || cloud !== null,
    destination: memoryDir ? "local" : cloud ? "cloud" : null,
  };
}

/**
 * The runtime's memory repositories carry bash hooks. Its own git runs with
 * them turned off when Windows has no usable bash (child-env.ts); this git has
 * to as well, or the import's commit fails with "Permission denied" on the
 * same computers where the companion's own memory writes work.
 */
function importGitEnv(): NodeJS.ProcessEnv {
  const env = withoutGitRedirects();
  const { home } = resolveRuntimeHome();
  if (!home) return env;
  const noHooks = join(home, "git-no-hooks");
  const hooks = gitHooksHint(env, noHooks);
  if (Object.keys(hooks).length === 0) return env;
  mkdirSync(noHooks, { recursive: true });
  return { ...env, ...hooks };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: importGitEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${String(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`));
      else resolve(stdout);
    });
  });
}

export async function runHistoryImport(
  token: string,
  options: { personName?: string; includeArchived?: boolean; agentBusy: (agentId: string) => boolean; cloudAccess?: CloudAccess; onProgress?: (done: number, total: number) => void; pacing?: ImportPacing; checkpointDir?: string },
): Promise<HistoryImportResult> {
  const previewed = pending.get(token);
  if (!previewed) throw new Error("That preview has expired. Choose the file again.");
  // Archived chats come along unless the person unticked them.
  const job: Pending = options.includeArchived === false
    ? { ...previewed, parsed: { ...previewed.parsed, conversations: previewed.parsed.conversations.filter((item) => !item.archived) } }
    : previewed;
  const memoryDir = localMemoryDir(job.agentId);
  if (!memoryDir) {
    const cloud = options.cloudAccess ? await options.cloudAccess() : null;
    if (!cloud) throw new Error("Importing history into this agent isn't available: it works for agents on This computer and on Letta Cloud.");
    try {
      const result = await runCloudImport(job, options.personName ?? "", cloud, options.onProgress ?? (() => undefined), { ...(options.pacing ? { pacing: options.pacing } : {}), ...(options.checkpointDir ? { checkpointDir: options.checkpointDir } : {}) });
      pending.delete(token);
      return result;
    } catch (error) {
      // Nothing to undo on Letta: files already uploaded are reused by the next try.
      throw new Error(`The import stopped part-way: ${error instanceof Error ? error.message : String(error)}. Try again: what's already uploaded won't be sent twice.`);
    }
  }
  if (options.agentBusy(job.agentId)) throw new Error("This agent is replying right now. Try again when it has finished.");
  // Hearthside: a memory in the older layout keeps its always-read files in
  // system/ and has no MEMORY.md at the top. That file is what tells the
  // runtime which layout it is looking at, so creating one here (for the
  // signpost) silently switched the companion to the newer layout: its
  // persona stopped being read and its own memory saves were then refused.
  // Such a memory gets the history folder and its indexes, and no signpost.
  const rootPath = join(memoryDir, "MEMORY.md");
  const hadRoot = existsSync(rootPath);
  const signpostRoot = hadRoot || !existsSync(join(memoryDir, "system"));
  // The import's own paths. Git refuses a path it has never heard of, which
  // would stop the add (and the undo) for history/ as well.
  const own = signpostRoot ? ["history", "MEMORY.md"] : ["history"];
  // Never sweep up someone else's unsaved edits: history/ and MEMORY.md must be clean.
  const dirty = (await git(memoryDir, ["status", "--porcelain", "--", "history", "MEMORY.md"])).trim();
  if (dirty) throw new Error("This agent's memory has unsaved changes in history/ or MEMORY.md. Let it finish (or save them) and try again.");

  const limits = memoryLimits(memoryDir);
  if (limits.maxDepth < 2) throw new Error("This agent's memory allows only one folder level (.memfs.config.json), so history can't be imported into it.");
  const files = renderAll(job.parsed, options.personName ?? "", limits.maxFileCharacters - HEADER_ROOM);
  let written = 0;
  let unchanged = 0;
  const write = (relative: string, content: string) => {
    const full = join(memoryDir, ...relative.split("/"));
    if (existsSync(full) && readFileSync(full, "utf8") === content) {
      unchanged += 1;
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    written += 1;
  };
  try {
    for (const stale of staleImportFiles(localHistoryFiles(memoryDir), files, job.parsed.source)) {
      rmSync(join(memoryDir, ...stale.split("/")), { force: true });
      written += 1;
    }
    for (const file of files) write(file.path, file.content);
    const recordFull = join(memoryDir, "history", `imports-${job.parsed.source}.md`);
    mkdirSync(dirname(recordFull), { recursive: true });
    writeFileSync(recordFull, importRecord(existsSync(recordFull) ? readFileSync(recordFull, "utf8") : null, job, files.length));
    for (const index of rebuildIndexes(memoryDir, limits.maxFileCharacters)) write(index.path, index.content);
    const signposted = signpostRoot ? withSignpost(hadRoot ? readFileSync(rootPath, "utf8") : "") : null;
    if (signposted !== null) writeFileSync(rootPath, signposted);

    await git(memoryDir, ["add", "--", ...own]);
    const staged = (await git(memoryDir, ["diff", "--cached", "--name-only", "--", ...own])).trim();
    if (staged) {
      await git(memoryDir, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Hearthside",
        "-c",
        `user.email=${job.agentId}@letta.com`,
        "commit",
        "-m",
        `Import ${job.parsed.conversations.length} conversations from ${SOURCE_LABEL[job.parsed.source]}`,

        "--only",
        "--",
        ...own,
      ]);
    }
    pending.delete(token);
    return { written, unchanged, conversations: job.parsed.conversations.length, files: files.length };
  } catch (error) {
    // Put history/ and MEMORY.md back exactly as they were (they were clean).
    // One path at a time: a path git does not know (a first import's history/,
    // or a MEMORY.md this import created) must not stop the other being restored.
    for (const path of own) {
      await git(memoryDir, ["reset", "-q", "--", path]).catch(() => undefined);
      await git(memoryDir, ["checkout", "--", path]).catch(() => undefined);
    }
    await git(memoryDir, ["clean", "-fdq", "--", "history"]).catch(() => undefined);
    if (!hadRoot) rmSync(rootPath, { force: true });
    throw new Error(`The import was undone: ${error instanceof Error ? error.message : String(error)}`);
  }
}
