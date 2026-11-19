import { toolLabel, toolSummary } from "./format";

/**
 * Hearthside: plain-language descriptions of tool calls, written for people
 * who don't code. Unknown tools fall back to their name made readable.
 */

export type ToolDescription = {
  /** What happened, e.g. "Sent to Telegram". */
  label: string;
  /** The detail worth seeing at a glance (a file, a command, the message). */
  detail: string;
  /** A channel the call went through, for its icon. */
  channel?: string;
  /** The person's own name for that channel connection, when it isn't just the app's name. */
  account?: string;
  /** For channel messages: the text that was sent, shown as a message. */
  message?: string;
};

const CHANNEL_NAMES: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  whatsapp: "WhatsApp",
  signal: "Signal",
  imessage: "iMessage",
  email: "email",
};

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function fileName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}



export function channelApp(channel: string): { key: string; name: string } {
  const lower = channel.toLowerCase();
  const known = Object.keys(CHANNEL_NAMES).find((key) => lower === key || lower.split(/[^a-z0-9]+/).includes(key));
  if (known) return { key: known, name: CHANNEL_NAMES[known] as string };
  return { key: lower, name: channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : "a channel" };
}

export function channelName(channel: string): string {
  return channelApp(channel).name;
}

/** A one-line preview of a Markdown message. */
function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}



export function channelReply(toolName: string, input: unknown): { channel: string; message: string } | null {
  if (toolName !== "MessageChannel" && toolName !== "message_channel") return null;
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const action = str(record, "action").toLowerCase();
  if (action && action !== "send" && action !== "reply" && action !== "message") return null;
  const message = str(record, "message");
  if (!message.trim()) return null;
  return { channel: channelApp(str(record, "channel")).key, message };
}

function describeChannel(input: Record<string, unknown>): ToolDescription {
  const raw = str(input, "channel");
  const { key: channel, name: app } = channelApp(raw);
  const account = raw && raw.toLowerCase() !== channel ? raw : undefined;
  const extra = { channel, ...(account ? { account } : {}) };
  const action = str(input, "action").toLowerCase();
  if (action === "react") {
    const emoji = str(input, "emoji");
    return { label: input.remove === true ? `Removed a reaction on ${app}` : `Reacted on ${app}`, detail: emoji, ...extra };
  }
  if (action === "upload-file" || action === "upload_file") {
    const media = str(input, "filename") || fileName(str(input, "media"));
    return { label: `Sent a file to ${app}`, detail: media, ...extra };
  }
  const message = str(input, "message");
  return { label: `Sent to ${app}`, detail: plain(message), message, ...extra };
}

const MEMORY_TOOLS = new Set(["memory", "memory_apply_patch", "memory_rethink", "memory_replace", "memory_insert", "core_memory_append", "core_memory_replace"]);

export function describeTool(name: string, input: Record<string, unknown>): ToolDescription {
  const path = str(input, "file_path") || str(input, "path");
  switch (name) {
    case "MessageChannel":
    case "message_channel":
      return describeChannel(input);
    case "obsidian_search":
      return { label: "Searched your notes", detail: str(input, "query") };
    case "obsidian_read":
      return { label: "Read a note", detail: str(input, "path") };
    case "obsidian_recent":
      return { label: "Looked at recent notes", detail: "" };
    case "obsidian_write":
      return { label: input.mode === "append" ? "Added to a note" : input.mode === "replace" ? "Rewrote a note" : "Wrote a note", detail: str(input, "path") };
    case "calendar_list":
      return { label: "Checked the calendar", detail: "" };
    case "calendar_add":
      return { label: "Added to the calendar", detail: str(input, "title") };
    case "calendar_update":
      return { label: "Changed an event", detail: str(input, "title") };
    case "calendar_delete":
      return { label: "Deleted an event", detail: "" };
    case "generate_image":
      return { label: "Made an image", detail: str(input, "prompt") };
    case "set_my_picture":
      return { label: "Changed its picture", detail: "" };
    case "get_weather":
      return { label: "Checked the weather", detail: str(input, "place") };
    case "send_gif":
      return { label: "Sent a GIF", detail: str(input, "query") };
    case "AskUserQuestion":
    case "AskUserQuestionAsync":
    case "ask_user_question":
      return { label: "Asked you a question", detail: "" };
    case "Bash":
    case "exec_command":
    case "shell":
    case "shell_command":
    case "run_shell_command":
      return { label: "Ran a command", detail: str(input, "description") || toolSummary(input) };
    case "write_stdin":
      return { label: "Typed into a running command", detail: "" };
    case "Read":
    case "read_file":
    case "read_artifact_file":
      return { label: "Read a file", detail: path };
    case "Write":
    case "write_file":
    case "write_artifact_file":
      return { label: "Wrote a file", detail: path };
    case "Edit":
    case "MultiEdit":
    case "ApplyPatch":
    case "apply_patch":
    case "replace":
      return { label: "Edited a file", detail: path };
    case "Glob":
    case "LS":
    case "list_dir":
      return { label: "Looked through folders", detail: str(input, "pattern") || path };
    case "Grep":
    case "grep_files":
    case "search_file_content":
      return { label: "Searched inside files", detail: str(input, "pattern") };
    case "WebFetch":
    case "fetch_webpage":
    case "web_fetch":
      return { label: "Opened a web page", detail: str(input, "url") };
    case "WebSearch":
    case "web_search":
      return { label: "Searched the web", detail: str(input, "query") };
    case "conversation_search":
      return { label: "Searched past conversations", detail: str(input, "query") };
    case "archival_memory_search":
      return { label: "Searched long-term memory", detail: str(input, "query") };
    case "archival_memory_insert":
      return { label: "Saved to long-term memory", detail: "" };
    case "ViewImage":
    case "view_image":
      return { label: "Looked at an image", detail: path };
    case "Task":
    case "Agent":
    case "SendAgentMessage":
      return { label: "Asked a helper agent", detail: str(input, "description") };
    case "Skill":
      return { label: "Used a skill", detail: str(input, "skill") || str(input, "name") };
    case "UpdatePlan":
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { label: "Updated the to-do list", detail: "" };
    case "TaskGet":
    case "TaskList":
      return { label: "Checked the to-do list", detail: "" };
    case "Wake":
      return { label: "Set a reminder to check back", detail: str(input, "reason") || str(input, "message") };
    case "Monitor":
      return { label: "Started watching", detail: str(input, "description") };
    case "Memory":
      return { label: "Looked at memory", detail: path };
    case "SetWorkingDirectory":
      return { label: "Changed folder", detail: path };
  }
  if (MEMORY_TOOLS.has(name)) {
    return { label: "Updated memory", detail: path || str(input, "label") || str(input, "reason") };
  }

  if (name === "?" || !name.trim()) return { label: "Result of an earlier step", detail: "" };
  // Hearthside: connector tools arrive as mcp__<connector>__<tool>.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", tool = ""] = mcp;
    const label = /text_to_speech|^tts$|speak|voice_message|generate_speech/i.test(tool) ? "Made a voice message" : toolLabel(tool);
    return { label, detail: str(input, "text") || toolSummary(input), account: server.replace(/_/g, " ") };
  }
  return { label: toolLabel(name), detail: toolSummary(input) };
}
