import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncRecoveryDirectory } from "./durable-io";
import { randomUUID } from "node:crypto";
import { setSchedulePaused } from "../schedules";
import { setRecoveryBotRunning } from "../channels";
import { channelBot, connectionKey, forgetDiscordChatTargets, getSettings, setAgentId } from "../settings";
import { setBotOwner } from "../channel-owners";
import { withBot } from "../channel-locks";
import { fenceAgentForRecovery, unfenceAgentForRecovery, isAgentRecoveryFenced } from "../runtime";
import { request } from "../control";
import { gatewayRequest } from "../channel-gateway";
import { channelBinding } from "./channel-inventory";

/** Channel protocol belongs to the dedicated gateway, never the agent control socket. */
export async function cutoverChannelRequest<T extends Record<string, unknown>>(type: string, body: Record<string, unknown>): Promise<T> {
  const reply = await gatewayRequest<Record<string, unknown>>(type, body);
  if (!reply || reply.type !== `${type}_response` || reply.success !== true || reply.error) throw new Error("Channel gateway did not return a verified successful response");
  return reply as T;
}
import type { CutoverAction, CutoverAdapter, CutoverJournal, CutoverObservation, CutoverReceipt } from "./cutover";

/** Trusted, receipt-bound inventory. No secrets or schedule prompts are persisted. */
export type AppCutoverPlan = {
  sourceSchedules: string[];
  targetSchedules: string[];
  scheduleCopies?: Array<{ sourceId: string; conversationId: string; active: boolean; config: { name: string; description: string; cron: string; timezone: string; recurring: boolean; prompt: string; scheduledFor: string | null } }>;
  accounts: Array<{ channelId: string; accountId: string; originallyRunning?: boolean; sourceBinding?: { agentId: string; conversationId: string }; targetBinding?: { agentId: string; conversationId: string } }>;
  routes: Array<{ channelId: string; accountId: string; chatId: string; sourceConversationId: string; targetConversationId: string }>;
};
export type AppCutoverMutation =
  | { kind: "fence"; agentId: string; fenced: boolean }
  | { kind: "schedule"; id: string; paused: boolean }
  | { kind: "stage-schedule"; sourceId: string }
  | { kind: "configure-schedule"; sourceId: string }
  | { kind: "copy-schedule-state"; sourceId: string; paused: boolean }
  | { kind: "account"; channelId: string; accountId: string; running: boolean }
  | { kind: "route"; channelId: string; accountId: string; chatId: string; agentId: string; conversationId: string }
  | { kind: "binding"; channelId: string; accountId: string; agentId: string; conversationId: string }
  | { kind: "select"; agentId: string };
type Mutation = AppCutoverMutation;
type Entry = { mutation: Mutation; outcome: "intent" | "applied" | "unknown" | "not-applied" };
type Operation = { action: CutoverAction; entries: Entry[]; complete: boolean };
export type AppCutoverHooks = {
  receipt(id: string): Promise<CutoverReceipt>;
  /** Read-only, fail-closed census, including external listeners, pending queues and helpers. */
  inspect(receipt: CutoverReceipt): Promise<CutoverObservation>;
  /** Must be immutable and bound to the verified receipt; lists ONLY source-owned resources.
   * sourceSchedules are originally active; targetSchedules must already exist paused.
   * Accounts must exclusively serve this source. Foreign/shared accounts are blockers.
   */
  plan(receipt: CutoverReceipt): Promise<AppCutoverPlan>;
  /** Persistent admission fence, restored before runtime startup, including manual sends. */
  setFence?(agentId: string, fenced: boolean): Promise<void>;
  /** Authoritative readback, returning unknown on transport failure, never mutating to probe. */
  verify?(mutation: Mutation, receipt: CutoverReceipt): Promise<"applied" | "not-applied" | "unknown">;
};

/** Concrete app-managed operations. Missing authoritative ownership/fence hooks are a blocker,
 * not an acknowledgement. This adapter never changes backend or creates/deletes an agent.
 */
export function createAppCutoverAdapter(directory: string, hooks: AppCutoverHooks): CutoverAdapter {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation ID"); return join(directory, `${id}.operation.json`); }
  function write(id: string, operation: Operation) {
    const dest = path(id), temp = `${dest}.${randomUUID()}.tmp`, fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(operation)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, dest); syncRecoveryDirectory(directory);
  }
  function read(id: string): Operation | null { return existsSync(path(id)) ? JSON.parse(readFileSync(path(id), "utf8")) as Operation : null; }
  async function assertOwned(j: CutoverJournal, action?: CutoverAction) {
    if (j.receipt.source.connection !== j.receipt.target.connection || connectionKey() !== j.receipt.source.connection) throw new Error("Cross-connection handover ownership cannot be verified by this runtime");
    const o = await hooks.inspect(j.receipt);
    if (o.blockers.length) throw new Error("Writer ownership is unknown or unavailable");
    if (action) {
      if (o.sourceFingerprint !== j.receipt.sourceFingerprint || o.targetDataMark !== j.receipt.targetDataMark) throw new Error("Source or target data changed during handover; both copies retained");
      if (["configure-target", "select-target", "enable-target"].includes(action) && (!o.sourceFenced || !o.sourceIdle)) throw new Error("Source is not fenced and idle");
      if (action === "restore-source" && (!o.targetFenced || !o.targetIdle)) throw new Error("Target is not fenced and idle");
    }
    if (o.source.agentId !== j.receipt.source.agentId || o.target.agentId !== j.receipt.target.agentId || o.source.connection !== connectionKey() || o.target.connection !== connectionKey()) throw new Error("Runtime identity changed");
  }
  async function mutations(action: CutoverAction, j: CutoverJournal): Promise<Mutation[]> {
    const p = await hooks.plan(j.receipt), source = j.receipt.source.agentId, target = j.receipt.target.agentId;
    const accounts = (running: boolean): Mutation[] => p.accounts.filter(a => !running || a.originallyRunning !== false).map(a => ({ kind: "account", channelId: a.channelId, accountId: a.accountId, running }));
    const schedules = (ids: string[], paused: boolean): Mutation[] => ids.map(id => ({ kind: "schedule", id, paused }));
    const routes = (toTarget: boolean): Mutation[] => p.routes.map(r => ({ kind: "route", channelId: r.channelId, accountId: r.accountId, chatId: r.chatId, agentId: toTarget ? target : source, conversationId: toTarget ? r.targetConversationId : r.sourceConversationId }));
    const bindings = (toTarget: boolean): Mutation[] => p.accounts.flatMap(a => {
      // A listener bound one way only could not be put back: binding it to the
      // target with nothing to restore would leave a rolled-back handover with
      // the bot still answering for the target. Refused instead of invented.
      // (cutover-app-hooks' plan already rejects an unknown source binding; this
      // keeps the adapter safe whatever hooks it is given.)
      if (a.targetBinding && !a.sourceBinding) throw new Error("Source listener has no binding to restore; handover refused");
      const binding = toTarget ? a.targetBinding : a.sourceBinding;
      return binding ? [{ kind: "binding" as const, channelId: a.channelId, accountId: a.accountId, ...binding }] : [];
    });
    switch (action) {
      case "fence-source": return [{ kind: "fence", agentId: source, fenced: true }, ...schedules(p.sourceSchedules, true), ...accounts(false)];
      case "configure-target": return [...(p.scheduleCopies ?? []).flatMap(c => [{ kind: "stage-schedule" as const, sourceId: c.sourceId }, { kind: "copy-schedule-state" as const, sourceId: c.sourceId, paused: true }, { kind: "configure-schedule" as const, sourceId: c.sourceId }]), ...bindings(true), ...routes(true)];
      case "select-target": return [{ kind: "select", agentId: target }];
      case "enable-target": return [
        ...(j.approvedCapabilities.includes("manual") ? [{ kind: "fence" as const, agentId: target, fenced: false }] : []),
        ...(j.approvedCapabilities.includes("schedules") ? [...schedules(p.targetSchedules, false), ...(p.scheduleCopies ?? []).filter(c => c.active).map(c => ({ kind: "copy-schedule-state" as const, sourceId: c.sourceId, paused: false }))] : []),
        ...(j.approvedCapabilities.includes("channels") ? accounts(true) : []),
      ];
      case "fence-target": {
        const copies: Mutation[] = [];
        for (const c of p.scheduleCopies ?? []) if (await findCopy(j.receipt, c.sourceId)) copies.push({ kind: "copy-schedule-state", sourceId: c.sourceId, paused: true });
        return [{ kind: "fence", agentId: target, fenced: true }, ...schedules(p.targetSchedules, true), ...copies, ...accounts(false)];
      }
      case "restore-source": return [...bindings(false), ...routes(false), { kind: "select", agentId: source }, ...schedules(p.sourceSchedules, false), ...accounts(true), { kind: "fence", agentId: source, fenced: false }];
    }
  }
  const marker = (r: CutoverReceipt, sourceId: string) => `Recovery ${r.id}/${sourceId}`;
  async function findCopy(r: CutoverReceipt, sourceId: string) {
    const reply = await request<{ type: string; tasks?: Array<Record<string, unknown>> }>("cron_list", { agent_id: r.target.agentId });
    if (!Array.isArray(reply.tasks)) throw new Error("Schedule inventory unavailable");
    const matches = reply.tasks.filter(t => t.name === marker(r, sourceId));
    if (matches.length > 1 || matches.some(t => t.agent_id !== r.target.agentId || typeof t.id !== "string")) throw new Error("Ambiguous recovery schedule ownership");
    return matches[0];
  }
  async function scheduleConfig(r: CutoverReceipt, sourceId: string) {
    const c = (await hooks.plan(r)).scheduleCopies?.find(c => c.sourceId === sourceId);
    if (!c) throw new Error("Recovery schedule mapping missing");
    return { name: marker(r, sourceId), description: c.config.description, cron: c.config.cron, timezone: c.config.timezone, recurring: c.config.recurring, prompt: c.config.prompt, scheduled_for: c.config.scheduledFor, conversation_id: c.conversationId };
  }
  async function verify(m: Mutation, receipt: CutoverReceipt): Promise<"applied" | "not-applied" | "unknown"> {
    if (hooks.verify) return hooks.verify(m, receipt);
    try {
      let matched: boolean;
      if (m.kind === "fence") matched = isAgentRecoveryFenced(m.agentId) === m.fenced;
      else if (m.kind === "select") matched = getSettings().agentId === m.agentId;
      else if (m.kind === "stage-schedule" || m.kind === "configure-schedule" || m.kind === "copy-schedule-state") {
        const copy = await findCopy(receipt, m.sourceId);
        if (!copy) return "not-applied";
        if (m.kind === "stage-schedule") matched = true;
        else if (m.kind === "copy-schedule-state") matched = copy.status === (m.paused ? "paused" : "active");
        else { const config = await scheduleConfig(receipt, m.sourceId); matched = Object.entries(config).every(([k, v]) => (copy[k] ?? null) === (v ?? null)); }
      }
      else if (m.kind === "schedule") {
        const replies = await Promise.all([receipt.source.agentId, receipt.target.agentId].map(agent_id => request<{ type: string; tasks?: Array<Record<string, unknown>> }>("cron_list", { agent_id })));
        if (replies.some(r => !Array.isArray(r.tasks))) return "unknown";
        const found = replies.flatMap(r => r.tasks!).filter(t => t.id === m.id);
        if (found.length !== 1 || !["paused", "active"].includes(String(found[0]!.status))) return "unknown";
        matched = (found[0]!.status === "paused") === m.paused;
      } else if (m.kind === "binding") {
        const reply = await cutoverChannelRequest("channel_accounts_list", { channel_id: m.channelId });
        const found = Array.isArray(reply.accounts) ? reply.accounts.filter(a => a.account_id === m.accountId) : [];
        if (found.length !== 1) return "unknown";
        const binding = channelBinding(found[0]);
        if (!binding.agentId) return "unknown";
        matched = binding.agentId === m.agentId && binding.conversationId === m.conversationId;
      } else if (m.kind === "account") {
        const owner = channelBot(m.accountId);
        if (!owner || owner.owner !== "hearthside" || owner.connection !== connectionKey()) return "unknown";
        const reply = await cutoverChannelRequest<{ type: string; accounts?: Array<Record<string, unknown>> }>("channel_accounts_list", { channel_id: m.channelId });
        const account = reply.accounts?.find(a => a.account_id === m.accountId);
        if (!account || typeof account.running !== "boolean") return "unknown";
        matched = account.running === m.running && owner.wanted === m.running;
      } else {
        const reply = await cutoverChannelRequest<{ type: string; routes?: Array<Record<string, unknown>> }>("channel_routes_list", { channel_id: m.channelId, account_id: m.accountId });
        const routes = reply.routes?.filter(r => r.account_id === m.accountId && r.chat_id === m.chatId);
        if (!routes || routes.length !== 1) return "unknown";
        matched = routes[0]!.agent_id === m.agentId && routes[0]!.conversation_id === m.conversationId;
      }
      return matched ? "applied" : "not-applied";
    } catch { return "unknown"; }
  }
  async function apply(m: Mutation, receipt: CutoverReceipt) {
    switch (m.kind) {
      case "stage-schedule": {
        if (await findCopy(receipt, m.sourceId)) throw new Error("Recovery schedule already exists; no allocation retry");
        const config = await scheduleConfig(receipt, m.sourceId);
        await request("cron_add", { ...config, agent_id: receipt.target.agentId, cron: "0 0 1 1 *", recurring: false, scheduled_for: "9999-01-01T00:00:00.000Z", timezone: "UTC", prompt: "Inactive recovery schedule; do not run." });
        return;
      }
      case "copy-schedule-state": {
        const copy = await findCopy(receipt, m.sourceId); if (!copy) throw new Error("Recovery schedule missing");
        await setSchedulePaused(String(copy.id), m.paused); return;
      }
      case "configure-schedule": {
        const copy = await findCopy(receipt, m.sourceId); if (!copy || copy.status !== "paused") throw new Error("Recovery schedule must be paused before restoring its original time");
        await request("cron_update", { task_id: copy.id, ...await scheduleConfig(receipt, m.sourceId) }); return;
      }
      case "fence": if (hooks.setFence) return hooks.setFence(m.agentId, m.fenced); if (m.fenced) fenceAgentForRecovery(m.agentId); else unfenceAgentForRecovery(m.agentId); return;
      case "schedule": return setSchedulePaused(m.id, m.paused);
      // The handover is an authorised move between two agents, so it goes through
      // recovery's own path rather than the owner check that serves the window:
      // a bot from before bots belonged to companions has no owner to check, and
      // refusing it would strand a handover half done. Whose the bot is is left
      // untouched; `binding` below is what moves it.
      case "account": await setRecoveryBotRunning(m.channelId, m.accountId, m.running); return;
      // In the bot's own queue (channel-locks.ts), like every other change to a
      // bot. Recovery's admission gate holds the window's requests while a
      // handover runs, but start-up reconciliation and the Discord maintenance
      // pass are not window requests and do not pass through it.
      case "binding": return withBot(m.accountId, async () => {
        const reply = await cutoverChannelRequest("channel_accounts_list", { channel_id: m.channelId });
        const found = Array.isArray(reply.accounts) ? reply.accounts.filter(a => a.account_id === m.accountId) : [];
        if (found.length !== 1 || found[0].running !== false || channelBot(m.accountId)?.wanted !== false) throw new Error("Listener must be verified stopped before rebinding");
        if (channelBot(m.accountId)?.transfer) throw new Error("Listener has an unfinished move to another agent; resolve it before handover");
        // Clear before binding: even an ambiguous bind failure must not leave
        // old-owner conversation IDs available to later Discord maintenance.
        if (m.channelId === "discord") forgetDiscordChatTargets(m.accountId);
        // Pinned gateway bind preserves credentials, config and existing routes.
        // account_update rejects config.binding on builtins and resets some routes.
        await cutoverChannelRequest("channel_account_bind", { channel_id: m.channelId, account_id: m.accountId, runtime: { agent_id: m.agentId, conversation_id: m.conversationId } });
        // Hearthside's owner follows the binding, so the record can't be left naming
        // the companion the bot has just been moved away from. The connection is
        // written explicitly: both agents are on this one connection (assertOwned),
        // and a legacy record with none must not keep it through a handover.
        setBotOwner(m.accountId, m.agentId, { connection: connectionKey() });
      });
      case "select": setAgentId(m.agentId); return;
      case "route": return withBot(m.accountId, async () => {
        await cutoverChannelRequest("channel_route_update", { channel_id: m.channelId, account_id: m.accountId, chat_id: m.chatId, runtime: { agent_id: m.agentId, conversation_id: m.conversationId } });
      });
    }
  }
  return {
    receipt: id => hooks.receipt(id),
    inspect: async receipt => {
      const o = await hooks.inspect(receipt);
      if (receipt.source.connection !== receipt.target.connection || connectionKey() !== receipt.source.connection) o.blockers.push("Cross-machine/connection writer ownership is unavailable; no handover is permitted.");
      return o;
    },
    apply: async (action, j, id) => {
      if (read(id)) throw new Error("Operation already attempted; reconcile rather than retry");
      await assertOwned(j, action);
      const op: Operation = { action, entries: [], complete: false };
      write(id, op);
      // A rollback step being tried again after an attempt that was read back as not
      // applied. Part of that attempt may have taken effect (a listener already running
      // again, say), and making the same change twice is not always harmless: a listener
      // must be stopped to be re-bound. So on a repeat each effect is read first and
      // left alone if it already holds. A first attempt never skips anything.
      const repeat = j.direction === "rollback" && j.steps.some(s => s.action === action && s.operationId !== id && s.outcome === "not-applied");
      for (const mutation of await mutations(action, j)) {
        await assertOwned(j, action);
        const entry: Entry = { mutation, outcome: "intent" }; op.entries.push(entry); write(id, op);
        try {
          if (!repeat || await verify(mutation, j.receipt) !== "applied") await apply(mutation, j.receipt);
          entry.outcome = await verify(mutation, j.receipt);
        }
        catch { entry.outcome = "unknown"; }
        write(id, op);
        if (entry.outcome !== "applied") throw new Error("App-managed mutation could not be verified");
      }
      op.complete = true; write(id, op);
    },
    reconcile: async (action, j, id) => {
      const op = read(id);
      if (!op) return "not-applied";
      if (op.action !== action) return "unknown";
      await assertOwned(j);
      // Re-read every attempted effect; a partial, fully understood operation may be
      // rolled back, but must never be automatically retried as if it had no effects.
      for (const entry of op.entries) {
        entry.outcome = await verify(entry.mutation, j.receipt); write(id, op);
        if (entry.outcome === "unknown") return "unknown";
      }
      return op.complete && op.entries.every(e => e.outcome === "applied") ? "applied" : "not-applied";
    },
  };
}
