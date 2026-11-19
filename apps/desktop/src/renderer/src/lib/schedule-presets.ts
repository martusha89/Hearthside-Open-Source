/** Hearthside: friendly schedule choices, turned into cron patterns and back. */

export type Repeat =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "hours"; every: number; from: number; to: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export type ScheduleTiming =
  | { kind: "daily" | "weekly"; time: string; day: number }
  | { kind: "hours"; every: number; from: number; to: number }
  | { kind: "once"; onceAt: string }
  | { kind: "custom"; cron: string };

/** Form-level checks only. The runtime remains the authority on cron semantics. */
export function validateScheduleTiming(timing: ScheduleTiming): string | null {
  switch (timing.kind) {
    case "custom": {
      const cron = timing.cron.trim();
      if (/\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}/.test(cron)) {
        return "A time range is not a cron pattern. Choose Every day, Every week or Once for a start time. A schedule starts an agent turn; it does not enforce an end time or a work-session duration.";
      }
      if (/^\d{1,2}:\d{2}$/.test(cron)) {
        return "For a clock time, choose Every day, Every week or Once and enter the time there. Advanced cron needs five fields: for example, 15 16 * * * starts a turn daily at 16:15.";
      }
      if (cron.split(/\s+/).length !== 5 || cron.includes(":")) {
        return "Enter five space-separated cron fields: minute hour day-of-month month day-of-week. For example: 15 16 * * * (daily at 16:15).";
      }
      return null;
    }
    case "daily":
    case "weekly":
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time)) return "Choose a valid time (00:00–23:59).";
      if (timing.kind === "weekly" && (!Number.isInteger(timing.day) || timing.day < 0 || timing.day > 6)) return "Choose a day of the week.";
      return null;
    case "hours":
      if (![timing.from, timing.to].every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23) || !Number.isInteger(timing.every) || timing.every < 1 || timing.every > 23) return "Choose valid hours and an interval.";
      if (timing.from > timing.to) return "Until must be at or after From. For an overnight pattern, use advanced cron.";
      return null;
    case "once": {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(timing.onceAt);
      const at = new Date(timing.onceAt);
      if (!match || Number.isNaN(at.getTime()) || at.getFullYear() !== Number(match[1]) || at.getMonth() + 1 !== Number(match[2]) || at.getDate() !== Number(match[3]) || at.getHours() !== Number(match[4]) || at.getMinutes() !== Number(match[5])) return "Choose a valid date and time on this computer's local clock.";
      return null;
    }
  }
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function toCron(repeat: Repeat): string {
  switch (repeat.kind) {
    case "daily":
      return `${repeat.minute} ${repeat.hour} * * *`;
    case "weekly":
      return `${repeat.minute} ${repeat.hour} * * ${repeat.day}`;
    case "hours": {
      const hours = repeat.from === 0 && repeat.to === 23 ? `*/${repeat.every}` : `${repeat.from}-${repeat.to}/${repeat.every}`;
      return `0 ${hours} * * *`;
    }
    case "custom":
      return repeat.cron.trim();
  }
}

/** A cron for a one-off run at a moment (the runtime also gets scheduled_for). */
export function onceCron(when: Date): string {
  return `${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`;
}

function time(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Plain words for the patterns Hearthside creates; others are shown as they are. */
export function describeCron(cron: string, recurring: boolean, scheduledFor?: string | null): string {
  if (!recurring && scheduledFor) {
    const at = new Date(scheduledFor);
    if (!Number.isNaN(at.getTime())) return `Once, ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  }
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  const isNum = (value?: string) => value !== undefined && /^\d+$/.test(value);
  if (isNum(minute) && isNum(hour) && dom === "*" && month === "*" && dow === "*") return `Every day at ${time(+hour!, +minute!)}`;
  if (isNum(minute) && isNum(hour) && dom === "*" && month === "*" && isNum(dow)) return `Every ${DAYS[+dow! % 7]} at ${time(+hour!, +minute!)}`;
  const every = /^\*\/(\d+)$/.exec(hour ?? "");
  if (minute === "0" && every && dom === "*" && month === "*" && dow === "*") return `Every ${every[1]} hours`;
  const window = /^(\d+)-(\d+)\/(\d+)$/.exec(hour ?? "");
  if (minute === "0" && window && dom === "*" && month === "*" && dow === "*") {
    return `Every ${window[3]} hours, ${time(+window[1]!, 0)}–${time(+window[2]!, 0)}`;
  }
  return `Custom: ${cron}`;
}

export const HEARTBEAT_NAME = "Heartbeat";

/** The message a heartbeat sends. Optional instructions are added at the end. */
export function heartbeatPrompt(instructions: string): string {
  const base = [
    "Heartbeat: this is a scheduled check-in, not a message from the person you talk to.",
    "Take a moment to look at what's going on: your memory, recent chats, the time of day, anything you were waiting on.",
    "If there's something worth doing or saying, do it. You can reply here or reach out through a connected channel such as Telegram or Discord.",
    "If nothing needs doing, end quietly with a brief note to yourself and don't message anyone.",
  ].join("\n");
  const extra = instructions.trim();
  return extra ? `${base}\n\nInstructions for this heartbeat:\n${extra}` : base;
}

/**
 * Hearthside: where a schedule's result goes. "chat" leaves the reply in the
 * schedule's chat; a channel asks the agent to send it to the person on
 * Telegram or Discord as well (the runtime's MessageChannel tool), so
 * "wake up at 7 and message me" is a choice, not prompt-writing. The choice
 * lives in the prompt itself, as a last paragraph this module can read back.
 */
export type ScheduleDelivery = { kind: "chat" } | { kind: "channel"; channelId: string; name: string };

const DELIVERY_RE = /\n\n\[Deliver via (telegram|discord): "((?:[^"\\]|\\.)*)"\] ([^\n]*)$/;

export function channelDisplayName(channelId: string): string {
  return channelId === "telegram" ? "Telegram" : channelId === "discord" ? "Discord" : channelId;
}

/** The prompt with the delivery paragraph added (or removed, for "chat"). */
export function withDelivery(prompt: string, delivery: ScheduleDelivery): string {
  const base = stripDelivery(prompt).trimEnd();
  if (delivery.kind === "chat") return base;
  const name = delivery.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `When you're done, send what you have to say to the person on ${channelDisplayName(delivery.channelId)} (your "${delivery.name}" bot) with the MessageChannel tool, not only here. This run was started by a schedule, not by the person.`;
  return `${base}\n\n[Deliver via ${delivery.channelId}: "${name}"] ${line}`;
}

export function stripDelivery(prompt: string): string {
  return prompt.replace(DELIVERY_RE, "");
}

/** The delivery a prompt carries, read back from its last paragraph. */
export function parseDelivery(prompt: string): ScheduleDelivery {
  const match = DELIVERY_RE.exec(prompt);
  if (!match) return { kind: "chat" };
  return { kind: "channel", channelId: match[1]!, name: match[2]!.replace(/\\(["\\])/g, "$1") };
}
