import type { Schedule, ScheduleInput, ScheduleRun } from "@hearthside/ipc-contract";
import { request } from "./control.js";

/**
 * Hearthside: schedules, the runtime's cron. A schedule sends a message to the
 * agent at a set time (once) or on a repeating pattern. The runtime runs them
 * while it's running: on this computer, or on your own server.
 */

type WireTask = Record<string, unknown>;

function toSchedule(task: WireTask): Schedule {
  const text = (key: string) => (typeof task[key] === "string" ? (task[key] as string) : null);
  return {
    id: String(task.id),
    agentId: String(task.agent_id),
    conversationId: text("conversation_id"),
    name: text("name") ?? "Schedule",
    description: text("description") ?? "",
    cron: text("cron") ?? "",
    timezone: text("timezone") ?? "",
    recurring: task.recurring === true,
    prompt: text("prompt") ?? "",
    status: (text("status") ?? "active") as Schedule["status"],
    scheduledFor: text("scheduled_for"),
    lastRunAt: text("last_run_at") ?? text("last_fired_at"),
    lastRunOutcome: text("last_run_outcome"),
    lastRunError: text("last_run_error"),
    fireCount: typeof task.fire_count === "number" ? task.fire_count : 0,
  };
}

const runtimeConversation = (conversationId: string | null | undefined) =>
  conversationId && !conversationId.startsWith("main:") ? conversationId : "default";

export async function listSchedules(agentId: string): Promise<Schedule[]> {
  const reply = await request<{ type: string; tasks?: WireTask[] }>("cron_list", { agent_id: agentId });
  return (reply.tasks ?? []).map(toSchedule).sort((a, b) => a.name.localeCompare(b.name));
}

export async function addSchedule(input: ScheduleInput): Promise<Schedule> {
  const reply = await request<{ type: string; task?: WireTask }>("cron_add", {
    agent_id: input.agentId,
    conversation_id: runtimeConversation(input.conversationId),
    name: input.name.trim() || "Schedule",
    description: input.description ?? "",
    cron: input.cron,
    timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    recurring: input.recurring,
    prompt: input.prompt,
    ...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}),
  });
  if (!reply.task) throw new Error("The runtime didn't create the schedule.");
  return toSchedule(reply.task);
}

export async function updateSchedule(id: string, input: Partial<ScheduleInput>): Promise<Schedule> {
  const reply = await request<{ type: string; task?: WireTask }>("cron_update", {
    task_id: id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.conversationId !== undefined ? { conversation_id: runtimeConversation(input.conversationId) } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.scheduledFor !== undefined ? { scheduled_for: input.scheduledFor } : {}),
  });
  if (!reply.task) throw new Error("The runtime didn't update the schedule.");
  return toSchedule(reply.task);
}

export async function setSchedulePaused(id: string, paused: boolean): Promise<void> {
  await request(paused ? "cron_pause" : "cron_resume", { task_id: id });
}

export async function runScheduleNow(id: string): Promise<void> {
  await request("cron_trigger", { task_id: id });
}

export async function deleteSchedule(id: string): Promise<void> {
  await request("cron_delete", { task_id: id });
}

export async function listScheduleRuns(id: string): Promise<ScheduleRun[]> {
  const reply = await request<{ type: string; page?: { entries?: Array<Record<string, unknown>> } }>("cron_runs", { task_id: id, limit: 20 });
  const entries = reply.page?.entries ?? [];
  return entries.map((entry) => ({
    at: typeof entry.ts === "number" ? entry.ts : Date.now(),
    status: typeof entry.status === "string" ? entry.status : (typeof entry.outcome === "string" ? entry.outcome : "unknown"),
    error: typeof entry.error === "string" ? entry.error : null,
    summary: typeof entry.summary === "string" ? entry.summary : null,
  }));
}
