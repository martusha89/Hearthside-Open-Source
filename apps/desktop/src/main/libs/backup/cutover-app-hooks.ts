import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { homedir } from "node:os";
import { readRecoveryCapsule, RECOVERY_CAPSULE_LIMITS } from "./restore";
import { app } from "electron";
import { syncRecoveryDirectory } from "./durable-io";
import { request, runtimeIdle } from "../control";
import { agentBusy, isAgentRecoveryFenced, listConversations } from "../runtime";
import { channelBot, channelChatMode, connectionKey, getSettings, getConnectionConfig } from "../settings";
import { resolveRuntimeHome } from "../../runtime/paths";
import { openStore } from "./backup";
import { assertRecoveryReadback, snapshotDataFingerprint, type RecoveryReadback, type RecoveryReceipt } from "./receipts";
import type { SnapshotEntry } from "./store";
import { canonicalSnapshotViewSteps } from "./object-ids";
import { drainAsync } from "./breathe";
import { cutoverChannelRequest, type AppCutoverHooks, type AppCutoverPlan } from "./cutover-runtime";
import type { CutoverReceipt } from "./cutover";
import { channelBinding, channelConfigFingerprint } from "./channel-inventory";

type Wire = Record<string, unknown>;
export type CutoverSourceSnapshot = { entries: SnapshotEntry[]; readObject(hash: string): Buffer; omissions?: string[]; dispose?(): void };
export type AppCutoverInspectionSources = {
  planDirectory?: string;
  /** A new full capture on EVERY call, never metadata or a cached snapshot. */
  sourceSnapshot(receipt: RecoveryReceipt): Promise<CutoverSourceSnapshot>;
  targetReadback(receipt: RecoveryReceipt): Promise<RecoveryReadback>;
  /** Ownership of the runtime and all other writer sessions, not merely this window.
   * Return explicit blockers when the backend cannot establish this boundary. */
  writerOwnership?(receipt: RecoveryReceipt): Promise<string[]>;
  /** Test seam; production verifies the original store or receipt-bound local capsule. */
  baseline?(receipt: RecoveryReceipt): CutoverSourceSnapshot | Promise<CutoverSourceSnapshot>;
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Handover compares against the backup a copy came from; without it, it waits for the person. */
export const BACKUP_FOLDER_NEEDED = "Handover needs the backup this copy was restored from. Choose that backup folder in Settings, Backups, then try again. Nothing was changed.";
export const BACKUP_DAMAGED = "The backup this copy was restored from didn't pass its check, so handover can't compare against it. Nothing was changed.";
const text = (v: unknown) => typeof v === "string" ? v : "";
function json(snapshot: CutoverSourceSnapshot, path: string): unknown {
  const entry = snapshot.entries.find(e => e.path === path);
  if (!entry) throw new Error(`Recovery inventory missing: ${path}`);
  return JSON.parse(snapshot.readObject(entry.hash).toString("utf8"));
}
function rows(value: unknown, label: string): Wire[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new Error(`${label} inventory unavailable`);
  return value as Wire[];
}
function object(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recovery inventory malformed");
  return value as Wire;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Real app census and deterministic receipt-bound mapping. No mutations occur here. */
export function createAppCutoverHooks(sources: AppCutoverInspectionSources): Omit<AppCutoverHooks, "receipt"> {
  async function baseline(r: RecoveryReceipt): Promise<CutoverSourceSnapshot> {
    if (sources.baseline) return sources.baseline(r);

    let unavailable = BACKUP_FOLDER_NEEDED;
    try {
      const store = openStore();
      if (store.storeId === r.storeId) {
        const snapshot = store.readSnapshot(r.source.agentId, r.snapshotId);
        const canonical = await drainAsync(canonicalSnapshotViewSteps(store, snapshot));
        if (!store.verify(r.source.agentId, r.snapshotId).ok || hash(Buffer.from(JSON.stringify(canonical.snapshot))) !== r.snapshotIdentity) unavailable = BACKUP_DAMAGED;
        else return { entries: canonical.snapshot.entries, readObject: canonical.readObject };
      }
    } catch {
      // No backup folder chosen, or it can't be opened: ask for it (below).
    }
    {
      if (getConnectionConfig().backend !== "local" || r.target.connection !== connectionKey()) throw new Error(unavailable);
      const home = resolveRuntimeHome().home ?? homedir();
      if (!/^agent-local-[a-zA-Z0-9-]+$/.test(r.target.agentId) || !isAbsolute(home) || home.split(/[\\/]/).includes("..")) throw new Error("Invalid local recovery location");
      const root = join(home, ".letta", "lc-local-backend", "memfs", r.target.agentId, "memory");
      if (!existsSync(join(root, "recovery-capsule", "snapshot.json"))) throw new Error(unavailable);
      const { snapshot, objects } = await readRecoveryCapsule(relative => {
        if (!/^recovery-capsule\/(snapshot\.json|objects\/[a-f0-9]{64}\.bin)$/.test(relative)) throw new Error("Unsafe recovery capsule path");
        const path = join(root, relative);
        // Same all-ancestor/no-link boundary as restore-local readback, including home.
        let ancestor = parse(path).root;
        for (const segment of dirname(path).slice(ancestor.length).split(/[\\/]/).filter(Boolean)) {
          ancestor = join(ancestor, segment);
          const stat = lstatSync(ancestor);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe recovery capsule directory");
        }
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd), limit = relative.endsWith("snapshot.json") ? RECOVERY_CAPSULE_LIMITS.manifestBytes : RECOVERY_CAPSULE_LIMITS.objectBytes;
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe recovery capsule file or size limit exceeded");
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error("Recovery capsule file changed during read");
            offset += count;
          }
          if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || fstatSync(fd).size !== stat.size) throw new Error("Recovery capsule file changed during read");
          return bytes;
        } finally { closeSync(fd); }
      }, { snapshotIdentity: r.snapshotIdentity, sourceAgentId: r.source.agentId });
      if (snapshot.id !== r.snapshotId) throw new Error("Recovery capsule snapshot identity mismatch");
      return { entries: snapshot.entries, omissions: snapshot.omissions, readObject: h => {
        const bytes = objects.get(h); if (!bytes) throw new Error("Recovery capsule object missing"); return bytes;
      } };
    }
  }
  function mapping(r: RecoveryReceipt, conversation: unknown): string {
    const original = text(conversation);
    if (!original || original === "default" || original === `main:${r.source.agentId}`) return "default";
    const mappings = (r as RecoveryReceipt & { mappings?: Array<{ kind: string; originalId: string; destinationId: string }> }).mappings;
    const match = mappings?.filter(m => m.kind === "conversation" && m.originalId === original);
    if (match?.length !== 1 || !match[0]?.destinationId) throw new Error("Recovered conversation mapping is missing or ambiguous");
    return match[0].destinationId;
  }
  async function plan(input: CutoverReceipt): Promise<AppCutoverPlan> {
    const r = input as RecoveryReceipt, b = await baseline(r);
    const schedules = rows(json(b, "schedules.json"), "Source schedules");
    const extras = object(json(b, "extras.json"));
    const routes = rows(extras.channelRoutes, "Source routes").map(route => {
      if (route.error) throw new Error("Source route capture was incomplete");
      if (!text(route.channelId) || !text(route.accountId) || !text(route.chatId) || route.threadId) throw new Error("Source route identity is incomplete or threaded route updates are unsupported");
      return { channelId: text(route.channelId), accountId: text(route.accountId), chatId: text(route.chatId), sourceConversationId: text(route.conversationId) || "default", targetConversationId: mapping(r, route.conversationId) };
    });
    const accounts = rows(extras.channelBots, "Source listeners").map(bot => {
      const binding = object(bot.binding);
      if (!text(bot.channelId) || !text(bot.accountId) || binding.agentId !== r.source.agentId || !text(binding.conversationId)) throw new Error("Source listener has an unknown or shared default binding");
      return { channelId: text(bot.channelId), accountId: text(bot.accountId), sourceBinding: { agentId: r.source.agentId, conversationId: text(binding.conversationId) }, targetBinding: { agentId: r.target.agentId, conversationId: mapping(r, binding.conversationId) } };
    });
    if (new Set(accounts.map(a => `${a.channelId}/${a.accountId}`)).size !== accounts.length || routes.some(route => !accounts.some(a => a.channelId === route.channelId && a.accountId === route.accountId))) throw new Error("Source listener inventory is incomplete or ambiguous");
    if (!/^[a-f0-9-]{36}$/.test(r.id)) throw new Error("Invalid receipt ID");
    const directory = sources.planDirectory ?? join(app.getPath("userData"), "recovery-handover-plans"), file = join(directory, `${r.id}.accounts.json`);
    let activity: Record<string, boolean>;
    if (existsSync(file)) activity = JSON.parse(readFileSync(file, "utf8"));
    else {
      if (isAgentRecoveryFenced(r.source.agentId) || getSettings().agentId !== r.source.agentId || !isAgentRecoveryFenced(r.target.agentId)) throw new Error("Original listener state was not captured before handover");
      activity = {};
      for (const a of accounts) {
        const owner = channelBot(a.accountId);
        if (!owner || owner.owner !== "hearthside" || owner.connection !== r.source.connection) throw new Error("Source listener ownership unknown");
        const reply = await cutoverChannelRequest<{ type: string; accounts?: Wire[] }>("channel_accounts_list", { channel_id: a.channelId });
        const found = rows(reply.accounts, "Source accounts").filter(v => v.account_id === a.accountId);
        if (found.length !== 1 || typeof found[0]!.running !== "boolean" || owner.wanted !== found[0]!.running) throw new Error("Source listener state is unresolved");
        activity[`${a.channelId}/${a.accountId}`] = found[0]!.running as boolean;
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fd = openSync(file, "wx", 0o600); try { writeFileSync(fd, JSON.stringify(activity)); fsyncSync(fd); } finally { closeSync(fd); }
      syncRecoveryDirectory(directory);
    }
    if (accounts.some(a => typeof activity[`${a.channelId}/${a.accountId}`] !== "boolean") || Object.keys(activity).length !== accounts.length) throw new Error("Original listener inventory changed");
    return {
      sourceSchedules: schedules.filter(s => s.status === "active").map(s => text(s.id)), targetSchedules: [], accounts: accounts.map(a => ({ ...a, originallyRunning: activity[`${a.channelId}/${a.accountId}`] })), routes,
      scheduleCopies: schedules.filter(s => s.status === "active" || s.status === "paused").map(s => {
        if (!text(s.id) || s.agentId !== r.source.agentId || !text(s.cron) || typeof s.recurring !== "boolean" || typeof s.prompt !== "string") throw new Error("Source schedule configuration is incomplete");
        return { sourceId: text(s.id), conversationId: mapping(r, s.conversationId), active: s.status === "active", config: { name: text(s.name), description: text(s.description), cron: text(s.cron), timezone: text(s.timezone), recurring: s.recurring, prompt: s.prompt, scheduledFor: typeof s.scheduledFor === "string" ? s.scheduledFor : null } };
      }),
    };
  }
  async function census(r: RecoveryReceipt, p: AppCutoverPlan) {
    const blockers: string[] = [];
    const cron = await request<{ type: string; tasks?: Wire[] }>("cron_list", {});
    const tasks = rows(cron.tasks, "Runtime schedules");
    const channels = await cutoverChannelRequest<{ type: string; channels?: Wire[] }>("channels_list", {});
    const channelIds = rows(channels.channels, "Runtime channels").map(c => text(c.channel_id));
    if (channelIds.some(id => !id) || p.accounts.some(a => !channelIds.includes(a.channelId))) throw new Error("Runtime channel census is incomplete");
    const allRoutes: Wire[] = [], allAccounts: Wire[] = [];
    for (const channelId of channelIds) {
      const routeReply = await cutoverChannelRequest<{ type: string; routes?: Wire[] }>("channel_routes_list", { channel_id: channelId });
      const accountReply = await cutoverChannelRequest<{ type: string; accounts?: Wire[] }>("channel_accounts_list", { channel_id: channelId });
      allRoutes.push(...rows(routeReply.routes, "Runtime routes").map(route => ({ ...route, channel_id: channelId })));
      allAccounts.push(...rows(accountReply.accounts, "Runtime accounts").map(account => ({ ...account, channel_id: channelId })));
    }
    for (const account of allAccounts) {
      const binding = channelBinding(account);
      const expected = p.accounts.find(a => a.channelId === account.channel_id && a.accountId === account.account_id);
      if (expected ? !equal(binding, expected.sourceBinding) && !equal(binding, expected.targetBinding) : [r.source.agentId, r.target.agentId].includes(binding.agentId)) blockers.push("Default listener binding diverged from the recovery receipt");
    }
    const originalBots = rows(object(json(await baseline(r), "extras.json")).channelBots, "Original listener configuration");
    for (const account of p.accounts) {
      const owner = channelBot(account.accountId);
      if (!owner || owner.owner !== "hearthside" || owner.connection !== r.source.connection) blockers.push("Source channel account is not owned by this connection");
      const live = allAccounts.filter(a => a.channel_id === account.channelId && a.account_id === account.accountId);
      if (live.length !== 1 || typeof live[0]!.running !== "boolean") blockers.push("Source listener activity is unknown");
      const original = originalBots.filter(b => b.channelId === account.channelId && b.accountId === account.accountId);
      if (original.length !== 1 || !live[0] || original[0]!.configFingerprint !== channelConfigFingerprint(live[0]) || original[0]!.enabled !== live[0].enabled || original[0]!.name !== live[0].display_name || original[0]!.dmPolicy !== live[0].dm_policy || !equal(original[0]!.allowedUsers, live[0].allowed_users) || original[0]!.chatMode !== channelChatMode(account.accountId)) blockers.push("Listener configuration diverged from the snapshot");
      const related = allRoutes.filter(route => route.channel_id === account.channelId && route.account_id === account.accountId);
      if (related.some(route => !p.routes.some(expected => expected.channelId === route.channel_id && expected.accountId === route.account_id && expected.chatId === route.chat_id))) blockers.push("Source account also serves an unowned route");
    }
    for (const route of allRoutes.filter(route => route.agent_id === r.source.agentId || route.agent_id === r.target.agentId)) {
      const expected = p.routes.find(e => e.channelId === route.channel_id && e.accountId === route.account_id && e.chatId === route.chat_id);
      if (!expected || route.thread_id || (route.agent_id === r.source.agentId ? route.conversation_id !== expected.sourceConversationId : route.conversation_id !== expected.targetConversationId)) blockers.push("Route mapping diverged from the recovery receipt");
    }
    for (const expected of p.routes) {
      const matches = allRoutes.filter(route => route.channel_id === expected.channelId && route.account_id === expected.accountId && route.chat_id === expected.chatId && [r.source.agentId, r.target.agentId].includes(text(route.agent_id)));
      if (matches.length !== 1) blockers.push("Source route disappeared or is ambiguous");
    }
    const originalSchedules = rows(json(await baseline(r), "schedules.json"), "Original schedules");
    const sourceTasks = tasks.filter(t => t.agent_id === r.source.agentId), targetTasks = tasks.filter(t => t.agent_id === r.target.agentId);
    if (sourceTasks.length !== originalSchedules.length || sourceTasks.some(t => !originalSchedules.some(s => s.id === t.id))) blockers.push("Source schedules diverged");
    for (const t of targetTasks) {
      const copy = p.scheduleCopies?.find(c => t.name === `Recovery ${r.id}/${c.sourceId}`);
      if (!copy || t.conversation_id !== copy.conversationId || !["active", "paused"].includes(text(t.status)) || targetTasks.filter(other => other.name === t.name).length !== 1) blockers.push("Target has an unowned or changed schedule");
      else {
        const staged = t.scheduled_for === "9999-01-01T00:00:00.000Z" && t.cron === "0 0 1 1 *" && t.timezone === "UTC" && t.recurring === false && t.prompt === "Inactive recovery schedule; do not run.";
        const configured = t.cron === copy.config.cron && t.timezone === copy.config.timezone && t.recurring === copy.config.recurring && t.prompt === copy.config.prompt && (t.scheduled_for ?? null) === copy.config.scheduledFor;
        if ((!staged && !configured) || (t.description ?? "") !== copy.config.description) blockers.push("Target schedule configuration diverged");
      }
    }
    const listenerActive = (agentId: string) => allAccounts.some(a => channelBinding(a).agentId === agentId && a.running !== false) || allRoutes.some(route => route.agent_id === agentId && allAccounts.some(a => a.channel_id === route.channel_id && a.account_id === route.account_id && a.running !== false));
    return { blockers, sourceAutomationOff: sourceTasks.every(t => t.status !== "active") && !listenerActive(r.source.agentId), targetAutomationOff: targetTasks.every(t => t.status !== "active" || t.scheduled_for === "9999-01-01T00:00:00.000Z") && !listenerActive(r.target.agentId) };
  }
  async function idle(agentId: string) {
    if (agentBusy(agentId)) return false;
    const conversations = await listConversations(agentId);
    const ids = new Set(["default", ...conversations.map(c => c.id.startsWith("main:") ? "default" : c.id)]);
    for (const conversation_id of ids) if (!await runtimeIdle({ agent_id: agentId, conversation_id })) return false;
    return !agentBusy(agentId);
  }
  async function sourceFingerprint(r: RecoveryReceipt, current: CutoverSourceSnapshot): Promise<string> {
    if (!isAgentRecoveryFenced(r.source.agentId)) return snapshotDataFingerprint(current.entries, current.readObject);
    const original = await baseline(r), replacements = new Map<string, Buffer>();
    // Only known handover effects are normalized. Every unrelated byte/config field remains covered.
    const before = rows(json(original, "schedules.json"), "Original schedules"), after = rows(json(current, "schedules.json"), "Current schedules");
    if (before.length !== after.length) return snapshotDataFingerprint(current.entries, current.readObject);
    const normalized = after.map(s => {
      const old = before.find(o => o.id === s.id);
      return old?.status === "active" && s.status === "paused" ? { ...s, status: "active" } : s;
    });
    if (equal(normalized, before)) replacements.set("schedules.json", original.readObject(original.entries.find(e => e.path === "schedules.json")!.hash));
    const oldExtras = object(json(original, "extras.json")), newExtras = object(json(current, "extras.json"));
    for (const key of ["channelRoutes", "channelBots"]) {
      const oldItems = rows(oldExtras[key], key), newItems = rows(newExtras[key], key);
      const normalizedItems = newItems.map(item => {
        if (key !== "channelBots") return item;
        const old = oldItems.find(o => o.channelId === item.channelId && o.accountId === item.accountId);
        if (!old) return item;
        const normalized = { ...item };
        if (old.running === true && item.running === false) normalized.running = true;
        const binding = object(old.binding);
        if (equal(item.binding, { agentId: r.target.agentId, conversationId: mapping(r, binding.conversationId) })) normalized.binding = old.binding;
        return normalized;
      });
      if (!oldItems.some(i => i.error) && !newItems.some(i => i.error) && normalizedItems.every(item => oldItems.some(old => equal(item, old)))) newExtras[key] = oldItems;
    }
    replacements.set("extras.json", Buffer.from(JSON.stringify(newExtras)));
    const objects = new Map<string, Buffer>();
    const entries = current.entries.map(e => {
      const bytes = replacements.get(e.path); if (!bytes) return e;
      const digest = hash(bytes); objects.set(digest, bytes); return { ...e, hash: digest, size: bytes.length };
    });
    return snapshotDataFingerprint(entries, h => objects.get(h) ?? current.readObject(h));
  }
  return {
    plan,
    inspect: async input => {
      const r = input as RecoveryReceipt, p = await plan(r);
      // Exclusive within the private app-managed runtime, not a claim against a future
      // administrator deliberately bypassing its ownership boundary.
      const blockers = sources.writerOwnership ? await sources.writerOwnership(r) :
        getConnectionConfig().backend === "local" && resolveRuntimeHome().sandbox === true && !process.env.LETTA_LOCAL_BACKEND_DIR ? [] :
          ["Exclusive writer ownership is unavailable for Cloud, shared homes, or externally overridden runtimes; only a private app-managed local runtime can hand over."];
      if (r.source.connection !== connectionKey() || r.target.connection !== connectionKey()) blockers.push("Source and target must belong to this exact connection");
      const inventory = await census(r, p); blockers.push(...inventory.blockers);
      const [target, sourceIdle, targetIdle] = await Promise.all([sources.targetReadback(r), idle(r.source.agentId), idle(r.target.agentId)]);
      assertRecoveryReadback(target);
      const selected = getSettings().agentId;
      if (selected !== r.source.agentId && selected !== r.target.agentId) blockers.push("Selected companion changed outside handover");
      const fresh = await sources.sourceSnapshot(r);
      let fingerprint: string;
      try {
        if (fresh.omissions?.some(o => !r.omissions?.includes(o))) blockers.push("Fresh source capture has new omissions");
        fingerprint = await sourceFingerprint(r, fresh);
      } finally { fresh.dispose?.(); }
      return { source: r.source, target: r.target, sourceFingerprint: fingerprint, targetFingerprint: target.fingerprint, targetDataMark: target.dataMark, sourceFenced: isAgentRecoveryFenced(r.source.agentId) && inventory.sourceAutomationOff, targetFenced: isAgentRecoveryFenced(r.target.agentId) && inventory.targetAutomationOff, sourceIdle, targetIdle, selected: selected === r.target.agentId ? "target" : "source", blockers };
    },
  };
}
