import { useCallback, useEffect, useId, useState } from "react";
import {
  DAYS,
  HEARTBEAT_NAME,
  type Repeat,
  describeCron,
  heartbeatPrompt,
  onceCron,
  toCron,
  validateScheduleTiming,
} from "../lib/schedule-presets";
import { relativeTime } from "../lib/format";
import { useAppStore } from "../store";
import type { ChannelAccount, Schedule, ScheduleRun } from "../types";
import { channelDisplayName, parseDelivery, type ScheduleDelivery, withDelivery } from "../lib/schedule-presets";
import { Spinner } from "./icons";
import { LaterActions } from "./LaterActions";
import { BackToChat } from "./BackToChat";
import { TimezoneSelect, ZonedDateTime } from "./ZonedDateTime";
import { isExplicitInstant } from "../lib/zoned-date";

/**
 * Hearthside: schedules. Messages the agent gets on a timetable, from "every
 * morning at 9" to a heartbeat that lets it check in by itself. They run while
 * the runtime runs: on this computer (keep Hearthside in the tray) or on your
 * own server.
 */

type Kind = "daily" | "hours" | "weekly" | "once" | "custom";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ranAgo(iso: string): string {
  const ago = relativeTime(new Date(iso).getTime());
  return ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : `on ${ago}`;
}

function hourOptions() {
  return Array.from({ length: 24 }, (_, hour) => (
    <option key={hour} value={hour}>
      {String(hour).padStart(2, "0")}:00
    </option>
  ));
}

function ScheduleForm({ agentId, onSaved, heartbeat }: { agentId: string; onSaved: () => void; heartbeat: boolean }) {
  const conversations = useAppStore((state) => state.conversations);
  const [name, setName] = useState(heartbeat ? HEARTBEAT_NAME : "");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<Kind>(heartbeat ? "hours" : "daily");
  const [time, setTime] = useState("09:00");
  const [every, setEvery] = useState(4);
  const [from, setFrom] = useState(heartbeat ? 9 : 0);
  const [to, setTo] = useState(heartbeat ? 22 : 23);
  const [day, setDay] = useState(1);
  const [onceAt, setOnceAt] = useState("");
  const [onceZone, setOnceZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [cron, setCron] = useState("0 9 * * *");
  const [chat, setChat] = useState<string>("main");
  // Hearthside: where the result goes: the chat, or the person on Telegram/Discord via one of this agent's bots.
  const [bots, setBots] = useState<ChannelAccount[]>([]);
  const [deliverTo, setDeliverTo] = useState<string>("chat");
  useEffect(() => {
    let cancelled = false;
    // Switched companion with the form open: the bot chosen a moment ago belongs
    // to the companion that was on screen then, so the choice is cleared rather
    // than left pointing at a bot this companion doesn't own. Without this the
    // delivery quietly fell back to the chat while the box still named the bot.
    setBots([]);
    setDeliverTo("chat");
    // Only this companion's own bots: a schedule must not be delivered through a
    // bot that answers for someone else (docs/AGENT-OWNED-BOTS.md).
    void Promise.all(["telegram", "discord"].map((channelId) => window.bridge.listChannelAccounts(channelId, agentId).catch(() => [] as ChannelAccount[])))
      .then((lists) => !cancelled && setBots(lists.flat().filter((bot) => bot.here && bot.mine)));
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  const delivery: ScheduleDelivery = (() => {
    const bot = bots.find((item) => item.accountId === deliverTo);
    return bot ? { kind: "channel", channelId: bot.channelId, name: bot.name } : { kind: "chat" };
  })();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const repeat: Repeat | null =
    kind === "daily"
      ? { kind: "daily", hour, minute }
      : kind === "weekly"
        ? { kind: "weekly", day, hour, minute }
        : kind === "hours"
          ? { kind: "hours", every, from, to }
          : kind === "custom"
            ? { kind: "custom", cron }
            : null;
  const message = withDelivery(heartbeat ? heartbeatPrompt(prompt) : prompt, delivery);
  const timingError = kind === "once" ? (!isExplicitInstant(onceAt) || Date.parse(onceAt) <= Date.now() ? "Choose a future date and time with a confirmed timezone offset." : null) : validateScheduleTiming(
    kind === "daily" || kind === "weekly" ? { kind, time, day }
      : kind === "hours" ? { kind, every, from, to }
        : { kind, cron },
  );
  const timingId = useId();
  const timingHelp = `${timingId}-help`;
  const timingErrorId = `${timingId}-error`;
  const timingAccessibility = {
    "aria-invalid": Boolean(timingError),
    "aria-describedby": `${timingHelp}${timingError ? ` ${timingErrorId}` : ""}`,
  };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const complete = name.trim() && (heartbeat || prompt.trim()) && !timingError;

  const save = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const once = kind === "once" ? new Date(onceAt) : null;
      if (once && Number.isNaN(once.getTime())) throw new Error("Choose a date and time.");
      await window.bridge.addSchedule({
        agentId,
        conversationId: chat === "main" ? null : chat,
        name: name.trim(),
        description: heartbeat ? "Heartbeat check-in" : "",
        cron: once ? onceCron(once) : toCron(repeat!),
        recurring: !once,
        prompt: message,
        ...(once ? { scheduledFor: once.toISOString() } : {}),
      });
      onSaved();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const select = "field py-1.5 text-sm";
  return (
    <form
      className="grid gap-3 rounded-2xl border border-border bg-surface-secondary p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void save();
      }}
    >
      <h3 className="text-sm font-semibold text-ink-900">{heartbeat ? "Add a heartbeat" : "New schedule"}</h3>
      <LaterActions current="schedules" />
      <p className="text-xs text-muted">Saving authorizes a model turn at these times using the instructions and destination below. Your companion's model may use credits.</p>
      {heartbeat && (
        <p className="text-xs text-muted">
          At the times you choose, your agent gets a quiet nudge to check in: look at its memory and recent chats, and reach out if there's
          something worth saying (in the chat, or on Telegram or Discord). Otherwise it stays quiet.
        </p>
      )}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-ink-700">Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning check-in" className="field text-sm" />
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-ink-700">{heartbeat ? "Extra instructions (optional)" : "Message to the agent"}</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          placeholder={heartbeat ? "For example: remind me to drink water; don't message me after 10pm." : "Good morning! Look at my calendar notes and plan the day with me."}
          className="field resize-y text-sm"
        />
      </label>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-ink-700">When</span>
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-800">
          <select value={kind} onChange={(event) => setKind(event.target.value as Kind)} className={select} {...timingAccessibility} aria-label="Repeat">
            <option value="daily">Every day</option>
            <option value="hours">Every few hours</option>
            <option value="weekly">Every week</option>
            <option value="once">Once</option>
            <option value="custom">Custom (advanced cron)</option>
          </select>
          {(kind === "daily" || kind === "weekly") && (
            <>
              {kind === "weekly" && (
                <select value={day} onChange={(event) => setDay(Number(event.target.value))} className={select} {...timingAccessibility} aria-label="Day">
                  {DAYS.map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              at
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className={select} {...timingAccessibility} aria-label="Time" />
            </>
          )}
          {kind === "hours" && (
            <>
              every
              <select value={every} onChange={(event) => setEvery(Number(event.target.value))} className={select} {...timingAccessibility} aria-label="Hours between">
                {[1, 2, 3, 4, 6, 8, 12].map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "hour" : "hours"}
                  </option>
                ))}
              </select>
              between
              <select value={from} onChange={(event) => setFrom(Number(event.target.value))} className={select} {...timingAccessibility} aria-label="From">
                {hourOptions()}
              </select>
              and
              <select value={to} onChange={(event) => setTo(Number(event.target.value))} className={select} {...timingAccessibility} aria-label="Until">
                {hourOptions()}
              </select>
            </>
          )}
          {kind === "once" && (
            <div className="grid w-full gap-2"><TimezoneSelect value={onceZone} onChange={setOnceZone} /><ZonedDateTime key={onceZone} label="Date and time" required value={onceAt} onChange={setOnceAt} timezone={onceZone} /></div>
          )}
          {kind === "custom" && (
            <input value={cron} onChange={(event) => setCron(event.target.value)} className={`${select} font-mono`} {...timingAccessibility} aria-label="Cron pattern" />
          )}
        </div>
        <div id={timingHelp} className="grid gap-1 text-xs text-muted">
          <p>{kind === "once" ? `This date and time is interpreted in ${onceZone} and saved as an explicit instant.` : `Recurring times use this computer's local clock (${timezone}); named-timezone recurrence is not supported by the current scheduler.`} A schedule starts an agent turn, not a timed work session; it does not enforce an end time.</p>
          {kind === "custom" && <p>Five fields: minute hour day-of-month month day-of-week. Example: <code>15 16 * * *</code> starts daily at 16:15. Use Every day for a clock time. The runtime validates advanced cron rules when you save.</p>}
        </div>
        {timingError && <p id={timingErrorId} role="alert" className="text-xs text-error">{timingError}</p>}
        {repeat && !timingError && <span className="text-[11px] text-muted">{describeCron(toCron(repeat), true)}</span>}
      </div>

      <label className="grid gap-1">
        <span className="text-xs font-medium text-ink-700">In which chat</span>
        <select value={chat} onChange={(event) => setChat(event.target.value)} className={select}>
          <option value="main">Main chat</option>
          {conversations
            .filter((conversation) => !conversation.main)
            .map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title || "Untitled chat"}
              </option>
            ))}
        </select>
      </label>
      {bots.length > 0 && (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-ink-700">Send the result to</span>
          <select value={deliverTo} onChange={(event) => setDeliverTo(event.target.value)} className={select} aria-label="Send the result to">
            <option value="chat">This chat only</option>
            {bots.map((bot) => (
              <option key={bot.accountId} value={bot.accountId}>
                {channelDisplayName(bot.channelId)} · {bot.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted">So a morning check-in can reach your phone, not just this window.</span>
        </label>
      )}
      {error && <p role="alert" className="break-words text-xs text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="button-secondary" onClick={onSaved}>
          Cancel
        </button>
        <button type="submit" className="button-primary" disabled={!complete || busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </form>
  );
}

function ScheduleCard({ schedule, onChanged }: { schedule: Schedule; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const paused = schedule.status === "paused";
  const done = schedule.status === "fired" || schedule.status === "cancelled";

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-2 rounded-xl border border-border px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-ink-900">
            {schedule.name}
            {paused && <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-[11px] font-normal text-muted">Paused</span>}
            {done && <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-[11px] font-normal text-muted">Done</span>}
          </span>
          <span className="block text-xs text-ink-700">
            {describeCron(schedule.cron, schedule.recurring, schedule.scheduledFor)}
            {(() => {
              const to = parseDelivery(schedule.prompt);
              return to.kind === "channel" ? ` · sends to ${channelDisplayName(to.channelId)} (${to.name})` : "";
            })()}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted">
            {schedule.lastRunAt
              ? `Last ran ${ranAgo(schedule.lastRunAt)}${schedule.lastRunOutcome && schedule.lastRunOutcome !== "queued" ? ` (${schedule.lastRunOutcome})` : ""}`
              : "Hasn't run yet"}
            {schedule.lastRunError && <span className="text-error"> · {schedule.lastRunError}</span>}
          </span>
        </span>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => void act("run", () => window.bridge.runScheduleNow(schedule.id))}>
            {busy === "run" && <Spinner className="h-3.5 w-3.5" />}
            Run now
          </button>
          {!done && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy !== null}
              onClick={() => void act("pause", () => window.bridge.setSchedulePaused(schedule.id, !paused))}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          )}
        </div>
      </div>
      <details
        className="text-xs"
        onToggle={(event) => {
          if ((event.target as HTMLDetailsElement).open && runs === null) {
            void window.bridge.listScheduleRuns(schedule.id).then(setRuns).catch((failure: unknown) => setError(errorText(failure)));
          }
        }}
      >
        <summary className="cursor-pointer text-muted hover:text-ink-700">Message and history</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-tertiary px-3 py-2 text-ink-700">{schedule.prompt}</p>
        {runs === null ? (
          <Spinner className="mt-2 h-3.5 w-3.5 text-muted" />
        ) : runs.length === 0 ? (
          <p className="mt-2 text-muted">No runs yet.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {runs.map((run, index) => (
              <li key={index} className="text-ink-700">
                {new Date(run.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}: {run.status}
                {run.error && <span className="text-error"> ({run.error})</span>}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="mt-2 text-error hover:underline"
          disabled={busy !== null}
          onClick={() => void act("delete", () => window.bridge.deleteSchedule(schedule.id))}
        >
          Delete this schedule
        </button>
      </details>
      {error && <p role="alert" className="break-words text-xs text-error">{error}</p>}
    </div>
  );
}

export function SchedulesView() {
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name ?? "Your agent");
  const backend = useAppStore((state) => state.connection?.backend);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"none" | "schedule" | "heartbeat">("none");

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      setSchedules(await window.bridge.listSchedules(agentId));
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [agentId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-border px-6">
        <BackToChat />
        <span className="truncate text-sm font-medium text-ink-700">{agentName}'s schedules</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-6">
          <p className="text-sm text-muted">
            Messages {agentName} gets on a timetable.{" "}
            {backend === "remote"
              ? "They run on your server."
              : "They run while Hearthside is running on this computer. Closing the window keeps it running."}
          </p>
          <p className="text-xs text-muted">Closing the window may leave Hearthside running in the tray. Quitting does not cancel work already accepted by the runtime; server-owned schedules may continue on your server.</p>
          {error && <p role="alert" className="rounded-xl bg-error-light px-3.5 py-2.5 text-sm text-error">{error}</p>}
          {form === "none" && agentId && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button-primary" onClick={() => setForm("schedule")}>
                New schedule
              </button>
              <button type="button" className="button-secondary" onClick={() => setForm("heartbeat")}>
                Add a heartbeat
              </button>
            </div>
          )}
          {form !== "none" && agentId && (
            <ScheduleForm
              key={form}
              agentId={agentId}
              heartbeat={form === "heartbeat"}
              onSaved={() => {
                setForm("none");
                void refresh();
              }}
            />
          )}
          {!schedules && !error && <Spinner className="h-4 w-4 text-muted" />}
          {schedules?.length === 0 && form === "none" && <p className="text-sm text-muted">No schedules yet.</p>}
          {schedules?.map((schedule) => (
            <ScheduleCard key={schedule.id} schedule={schedule} onChanged={() => void refresh()} />
          ))}
        </div>
      </div>
    </main>
  );
}
