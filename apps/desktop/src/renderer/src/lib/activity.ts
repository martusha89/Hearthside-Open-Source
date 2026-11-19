import type { TurnActivityPhase } from "@hearthside/ipc-contract";
import type { ChatRow } from "../types";

/**
 * Hearthside: what the agent is doing right now, in plain (sometimes silly)
 * words, for the line under the chat while a reply is coming. The runtime
 * reports a phase (Thinking, Responding, Running tool…); the chat rows say
 * which tool is running. Wording rotates every few seconds so a long wait
 * doesn't feel frozen, and the seconds are shown once it's been a while.
 */

/**
 * The runtime's phases, plus `"other"` for a label this build doesn't recognise.
 *
 * Several of the runtime's phases — `sending`, `held`, `elsewhere`, `moving` —
 * mean this window isn't the one working. None of them is ever shown as
 * "thinking": nothing is being thought about here, and saying so would misstate
 * who is in charge of the turn.
 */
export type Phase = TurnActivityPhase | "other";

export const ROTATE_EVERY_S = 7;
export const SHOW_SECONDS_AFTER_S = 3;
/** Longer than this on one line crowds the composer; the rest goes in the details. */
const MAX_LINE = 72;

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");

/** What a tool is doing, as "…ing" words. */
export function toolVerb(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "generate_image":
      return "making an image";
    case "set_my_picture":
      return "changing its picture";
    case "get_weather":
      return "checking the weather";
    case "send_gif":
      return "hunting for the perfect GIF";
    case "calendar_list":
      return "checking the calendar";
    case "calendar_add":
    case "calendar_update":
    case "calendar_delete":
      return "updating the calendar";
    case "obsidian_search":
    case "obsidian_read":
    case "obsidian_recent":
      return "reading your notes";
    case "obsidian_write":
      return "writing in your notes";
    case "Bash":
    case "exec_command":
    case "shell":
    case "shell_command":
    case "run_shell_command":
    case "write_stdin":
      return "running a command";
    case "Read":
    case "read_file":
    case "read_artifact_file":
      return "reading a file";
    case "Write":
    case "write_file":
    case "write_artifact_file":
    case "Edit":
    case "MultiEdit":
    case "ApplyPatch":
    case "apply_patch":
    case "replace":
      return "editing a file";
    case "Glob":
    case "LS":
    case "list_dir":
    case "Grep":
    case "grep_files":
    case "search_file_content":
      return "searching files";
    case "WebFetch":
    case "WebSearch":
    case "web_search":
    case "web_fetch":
    case "fetch":
      return "looking online";
    case "conversation_search":
    case "recall":
    case "recall_memory":
      return "remembering";
    case "Agent":
      return "sending a helper off to look";
    case "Monitor":
    case "Wake":
      return "setting itself a reminder";
    case "TaskStop":
      return "tidying up";
    case "MessageChannel":
    case "message_channel": {
      const channel = str(input, "channel") || str(input, "channel_id");
      return channel ? `sending a message on ${channel}` : "sending a message";
    }
    default:
      break;
  }
  if (/^memory_|_memory$|^memfs/.test(name)) return "rummaging through memory";
  if (/voice|speech|tts|elevenlabs/i.test(name)) return "finding its voice";
  if (/spotify|music|play/i.test(name)) return "sorting out the music";
  if (/notion|todoist|linear|jira|asana|trello|github/i.test(name)) return `talking to ${name.split(/[_-]/)[0]}`;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
  return words ? `using ${words}` : "working on it";
}

/** The phases with their own wording. Anything outside this speaks for itself. */
type PhrasePhase = Exclude<Phase, "tool" | "retry" | "other" | "sending" | "held" | "elsewhere" | "moving">;
const PHRASES: Record<PhrasePhase, string[]> = {
  starting: ["Waking up…", "Clearing the throat…", "Stretching…", "Reading the room…"],
  thinking: ["Thinking…", "Mulling it over…", "Chewing on that…", "Connecting the dots…", "Pondering…", "Gathering thoughts…", "Brewing an answer…", "Lost in thought, the good kind…"],
  writing: ["Writing…", "Typing…", "Putting it into words…", "Nearly there…"],
  approval: ["Waiting for your say-so…", "Ready when you are…"],
  question: ["Waiting for your answer…", "Over to you…"],
  stopping: ["Wrapping up…", "Putting the pen down…"],
};
const LONG_THINKING = ["Still thinking… this one's chewy", "Deep in it…", "Taking the scenic route…", "Worth the wait, hopefully…", "Still at it, promise…"];
const LONG_AFTER_S = 40;
const hasPhrases = (phase: Phase): phase is PhrasePhase => phase in PHRASES;

/** The opening sentence, trimmed to a line's worth; the whole text still shows in the details. */
export function firstClause(text: string): string {
  const stop = text.search(/[.;](\s|$)/);
  const first = (stop > 0 ? text.slice(0, stop) : text).trim();
  if (first.length <= MAX_LINE) return first;
  const cut = first.lastIndexOf(" ", MAX_LINE);
  return `${first.slice(0, cut > 24 ? cut : MAX_LINE).trimEnd()}…`;
}

/**
 * The runtime's short activity label → a phase. Only the labels it has always
 * sent are known here. Anything else is `"other"`: an unrecognised line is never
 * guessed into a phase, because every guess would be a claim — that the agent is
 * thinking here, or that this window is the one that can stop it. The phase for
 * those states comes from the runtime itself, alongside the sentence.
 */
export function phaseOf(activity: string): Phase {
  switch (activity) {
    case "Starting":
      return "starting";
    case "Thinking":
      return "thinking";
    case "Responding":
      return "writing";
    case "Running tool":
    case "Running command":
      return "tool";
    case "Waiting for approval":
    // The slash-command path says it the longer way (runtime.ts); same waiting.
    case "Waiting for your approval":
      return "approval";
    case "Waiting for your answer":
      return "question";
    case "Stopping":
      return "stopping";
    default:
      break;
  }
  return activity.startsWith("Retrying") ? "retry" : "other";
}

/** Phases where the agent is at work in this window, and the playful wording fits. */
const WORKING: ReadonlySet<Phase> = new Set<Phase>(["starting", "thinking", "writing", "tool", "retry"]);
export const isWorkingPhase = (phase: Phase): boolean => WORKING.has(phase);

/** The tool still running in this turn, if any: the last call without a result. */
export function runningTool(rows: readonly ChatRow[]): { name: string; input: Record<string, unknown> } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind !== "tool_call") continue;
    if (row.result) return null;
    return { name: row.toolName, input: row.toolInput };
  }
  return null;
}

/** A stable key for "the same thing is still happening": the elapsed time resets when it changes. */
export function activityKey(activity: string, rows: readonly ChatRow[], reported: ReportedActivity = {}): string {
  const phase = reported.phase ?? phaseOf(activity);
  if (phase === "tool") return `tool:${runningTool(rows)?.name ?? ""}`;
  if (phase === "retry" || phase === "other") return `${phase}:${activity}`;
  // A wait keeps its clock while the runtime refines what it says about it: how
  // long it has been waiting is the number worth watching.
  return phase;
}

export function elapsedLabel(seconds: number): string | null {
  if (seconds < SHOW_SECONDS_AFTER_S) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const trail = (line: string) => (/[…?!]$/.test(line) ? line : `${line}…`);

/** What the status line says, and the full sentence behind it when there is more to it. */
export type Activity = { phase: Phase; text: string; detail: string | null };

/** What the runtime said about this turn: its own phase, and the long version. */
export type ReportedActivity = { phase?: Phase | null; detail?: string | null };

/**
 * The line to show, for this phase, after `seconds`, with `offset` varying the
 * start. `reported` is the runtime's own phase and long sentence when it sends
 * them; without a phase only the short labels it has always sent are understood,
 * and anything else shows as itself rather than being guessed into a phase.
 */
export function describeActivity(activity: string, rows: readonly ChatRow[], seconds: number, offset: number, reported: ReportedActivity = {}): Activity {
  const phase = reported.phase ?? phaseOf(activity);
  const step = Math.floor(seconds / ROTATE_EVERY_S) + offset;
  if (phase === "tool") {
    const tool = runningTool(rows);
    const verb = tool ? toolVerb(tool.name, tool.input) : activity === "Running command" ? "running a command" : "working on it";
    const first = verb.charAt(0).toUpperCase() + verb.slice(1);
    const options = [`${first}…`, `Still ${verb}…`, `Busy ${verb}…`];
    return { phase, text: seconds < ROTATE_EVERY_S ? options[0]! : options[step % options.length]!, detail: reported.detail ?? null };
  }
  if (phase === "retry") return { phase, text: trail(activity), detail: reported.detail ?? null };
  if (!hasPhrases(phase)) {
    // The agent isn't at work in this window, so none of the playful wording
    // applies. Say what the runtime said, shortened to a line, and keep the
    // rest — the part about what not to do — in the details underneath.
    const line = firstClause(activity);
    const rest = line === activity.trim() ? null : activity;
    return { phase, text: trail(line), detail: reported.detail ?? rest };
  }
  if (phase === "thinking" && seconds >= LONG_AFTER_S) return { phase, text: LONG_THINKING[step % LONG_THINKING.length]!, detail: reported.detail ?? null };
  const list = PHRASES[phase];
  // The plain phrase first, then the variations.
  return { phase, text: seconds < ROTATE_EVERY_S ? list[0]! : list[step % list.length]!, detail: reported.detail ?? null };
}

/** The words to show, for this phase, after `seconds`, with `offset` varying the start. */
export function activityText(activity: string, rows: readonly ChatRow[], seconds: number, offset: number): string {
  return describeActivity(activity, rows, seconds, offset).text;
}
