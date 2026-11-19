/**
 * Telling one mod command's frames from another's.
 *
 * `execute_command` is declared to answer with `execute_command_response`, and
 * that is what Hearthside's `request()` helper waits for. But in letta-code
 * 0.34.8 a command that resolves to a loaded mod is handled by
 * `handleModCommand` (letta.js 456556), which emits only a canonical
 * `slash_command_end` stream delta and returns — no response frame at all.
 * Built-ins and unknown command ids do send the response. So waiting for the
 * response alone hangs for exactly the commands this feature is about, and the
 * frame that does arrive carries **no request id** (letta.js 456674).
 *
 * Scope and the command line the runtime echoes are therefore the whole of the
 * available identity. These two helpers rebuild both exactly as the runtime
 * does; `command-observer.ts` uses them, and `command-run.ts` adds the
 * guarantees that correlation alone cannot give (one command at a time per
 * chat, and a chat held after an unknown outcome).
 */

/**
 * The line the runtime builds for a send, which it echoes on both lifecycle
 * frames (letta.js 456433). Recomputing it makes the frame's `input` usable as
 * correlation instead of being ignored.
 */
export function commandInputLine(commandId: string, args: string): string {
  const trimmed = args.trim();
  return trimmed ? `/${commandId} ${trimmed}` : `/${commandId}`;
}

/**
 * The exact line the runtime emits for a `prompt` result (letta.js 456585).
 * The end frame has no field saying which of the three result types a mod
 * returned, so this literal is the only hint — and it is only a hint, since an
 * `output` command could return the same text. Whether a reply actually
 * started is observed from the runtime's own state, never concluded from this.
 */
export function announcesPrompt(commandId: string, output: string): boolean {
  return output === `Running /${commandId}...`;
}
