import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { syncRecoveryDirectory } from "./durable-io";

export type CutoverIdentity = { connection: string; agentId: string };
/** References and digests only: never credentials or executable configuration. */
export type CutoverReceipt = {
  id: string; verified: true; source: CutoverIdentity; target: CutoverIdentity;
  snapshotIdentity: string; sourceFingerprint: string; targetFingerprint: string;
  targetDataMark: string; capabilities: string[];
};
export type CutoverObservation = {
  source: CutoverIdentity; target: CutoverIdentity;
  sourceFingerprint: string; targetFingerprint: string; targetDataMark: string;
  sourceFenced: boolean; targetFenced: boolean; sourceIdle: boolean; targetIdle: boolean;
  selected: "source" | "target"; blockers: string[];
};
export type CutoverAction = "fence-source" | "configure-target" | "select-target" | "enable-target" | "fence-target" | "restore-source";
export type CutoverStep = { action: CutoverAction; operationId: string; outcome: "intent" | "applied" | "unknown" | "not-applied" };
export type CutoverJournal = {
  version: 1; id: string; token: string; expiresAt: number; receipt: CutoverReceipt;
  approvedCapabilities: string[]; state: "preview" | "running" | "blocked" | "active" | "rolling-back" | "rolled-back";
  direction: "forward" | "rollback"; steps: CutoverStep[]; blockers: string[];
};
export interface CutoverAdapter {
  receipt(id: string): Promise<CutoverReceipt>;
  /** Must enumerate ALL writers/listeners, failing closed for unavailable ownership. */
  inspect(receipt: CutoverReceipt): Promise<CutoverObservation>;
  /** Each operation must enforce identity and ownership again at mutation time. */
  apply(action: CutoverAction, journal: CutoverJournal, operationId: string): Promise<void>;
  /** Read-only reconciliation. Never retry a mutation to discover its outcome. */
  reconcile(action: CutoverAction, journal: CutoverJournal, operationId: string): Promise<"applied" | "not-applied" | "unknown">;
}
const locks = new Set<string>();
const same = (a: CutoverIdentity, b: CutoverIdentity) => a.connection === b.connection && a.agentId === b.agentId;
const forward: CutoverAction[] = ["fence-source", "configure-target", "select-target", "enable-target"];
const backward: CutoverAction[] = ["fence-target", "restore-source"];

/** Main-process singleton service. The application must hold its Electron single-instance lock. */
export function createCutoverService(directory: string, adapter: CutoverAdapter) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  function path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid handover ID"); return join(root, `${id}.json`); }
  function save(j: CutoverJournal) {
    const destination = path(j.id), temp = `${destination}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(j)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, destination);
    syncRecoveryDirectory(root);
  }
  function get(id: string): CutoverJournal { const j = JSON.parse(readFileSync(path(id), "utf8")) as CutoverJournal; if (j.version !== 1 || j.id !== id) throw new Error("Invalid handover journal"); return j; }
  function list() { return readdirSync(root).filter(x => /^[a-f0-9-]{36}\.json$/.test(x)).map(x => get(x.slice(0, -5))); }
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (locks.has(root)) throw new Error("Another handover operation is running");
    locks.add(root); try { return await fn(); } finally { locks.delete(root); }
  }
  async function check(j: CutoverJournal, action?: CutoverAction) {
    const receipt = await adapter.receipt(j.receipt.id);
    if (JSON.stringify(receipt) !== JSON.stringify(j.receipt) || receipt.verified !== true) throw new Error("Recovery receipt changed or is unverified");
    const o = await adapter.inspect(j.receipt);
    if (!same(o.source, j.receipt.source) || !same(o.target, j.receipt.target) || same(o.source, o.target)) throw new Error("Source/target identity mismatch");
    if (o.blockers.length) throw new Error(o.blockers.join("; "));
    if (o.sourceFingerprint !== j.receipt.sourceFingerprint) throw new Error("Source changed since the recovered snapshot");
    if (o.targetDataMark !== j.receipt.targetDataMark) throw new Error("Target contains new user data; retained without rollback");
    if (!action || action === "fence-source") {
      if (o.targetFingerprint !== j.receipt.targetFingerprint || !o.targetFenced || !o.targetIdle || o.selected !== "source") throw new Error("Recovery destination diverged or is not inactive");
    } else if (action === "restore-source") {
      if (!o.targetFenced || !o.targetIdle) throw new Error("Target must be fenced and idle before restoring source");
    } else if (action !== "fence-target") {
      if (!o.sourceFenced || !o.sourceIdle) throw new Error("Source must be fenced and idle before target activation");
      if (action !== "enable-target" && (!o.targetFenced || !o.targetIdle)) throw new Error("Target writers started before activation");
    }
  }
  async function run(j: CutoverJournal) {
    try {
      const pending = j.steps.find(s => s.outcome === "intent" || s.outcome === "unknown");
      if (pending) {
        pending.outcome = await adapter.reconcile(pending.action, j, pending.operationId);
        save(j);
        if (pending.outcome !== "applied") throw new Error("Mutation outcome unresolved; no automatic retry");
      }
      const actions = j.direction === "forward" ? forward : backward;
      for (const action of actions) {
        // The latest attempt at this action is the one that counts.
        const prior = j.steps.findLast(s => s.action === action);
        if (prior?.outcome === "applied") continue;
        // Going forward, a step that didn't apply is never tried again: the way out is
        // rollback. Rollback has no such way out. Refusing to try its steps again left
        // both companions fenced for good after one passing failure, with nothing the
        // person could press. So a rollback step that was read back as NOT applied (never
        // one whose outcome is unknown) is attempted once more each time the person asks,
        // as a new recorded operation, after the same checks as the first time. The
        // adapter re-reads each effect and only makes the ones that are missing.
        if (prior && !(j.direction === "rollback" && prior.outcome === "not-applied")) throw new Error("Mutation was not applied; start no blind retry");
        await check(j, action);
        const step: CutoverStep = { action, operationId: randomUUID(), outcome: "intent" };
        j.steps.push(step); save(j);
        try {
          await adapter.apply(action, structuredClone(j), step.operationId);
          step.outcome = await adapter.reconcile(action, j, step.operationId);
          if (step.outcome !== "applied") throw new Error("Mutation could not be verified");
        }
        catch { step.outcome = "unknown"; save(j); throw new Error("Mutation response unknown; reconcile before continuing"); }
        save(j);
      }
      const final = await adapter.inspect(j.receipt);
      if (final.blockers.length || !same(final.source, j.receipt.source) || !same(final.target, j.receipt.target)) throw new Error("Final ownership verification failed");
      if (j.direction === "forward" ? (!final.sourceFenced || !final.sourceIdle || final.selected !== "target") : (!final.targetFenced || !final.targetIdle || final.selected !== "source")) throw new Error("Final single-writer verification failed");
      j.state = j.direction === "forward" ? "active" : "rolled-back"; j.blockers = []; save(j);
    } catch (error) {
      j.state = "blocked";
      // Adapter errors may contain credentials. Persist a fixed diagnostic only.
      j.blockers = ["Handover blocked. Inspect writer ownership, freshness and recorded operation outcomes before resuming."];
      save(j);
      throw error;
    }
    return j;
  }
  return {
    get, list,
    preview: (receiptId: string) => exclusive(async () => {
      const receipt = await adapter.receipt(receiptId);
      if (receipt.verified !== true || same(receipt.source, receipt.target)) throw new Error("A verified recovery into a distinct target is required");
      const j: CutoverJournal = { version: 1, id: randomUUID(), token: randomUUID(), expiresAt: Date.now() + 15 * 60_000, receipt, approvedCapabilities: [], state: "preview", direction: "forward", steps: [], blockers: [] };
      await check(j); save(j); return j;
    }),
    confirm: (token: string, approvedCapabilities: string[]) => exclusive(async () => {
      const j = list().find(j => j.token === token);
      if (!j || j.state !== "preview" || j.expiresAt < Date.now()) throw new Error("Handover preview expired or already consumed");
      if (list().some(other => other.id !== j.id && !["preview", "rolled-back"].includes(other.state))) throw new Error("Resolve the existing handover before starting another");
      if (approvedCapabilities.some(c => !j.receipt.capabilities.includes(c))) throw new Error("Capability was not in the recovery preview");
      j.approvedCapabilities = [...new Set(approvedCapabilities)]; j.state = "running"; save(j);
      return run(j);
    }),
    resume: (id: string) => exclusive(async () => {
      const j = get(id);
      if (!["running", "rolling-back", "blocked"].includes(j.state)) throw new Error("No interrupted handover to resume");
      return run(j);
    }),
    rollback: (id: string) => exclusive(async () => {
      const j = get(id);
      if (!["active", "blocked", "running", "rolling-back"].includes(j.state)) throw new Error("No confirmed handover to roll back");
      // Resolve in-flight forward effects first. Never restore a source beside an unknown writer.
      for (const s of j.steps.filter(s => s.outcome === "intent" || s.outcome === "unknown")) {
        s.outcome = await adapter.reconcile(s.action, j, s.operationId); save(j);
        if (s.outcome === "unknown") throw new Error("Resolve unknown operations before rollback");
      }
      j.direction = "rollback"; j.state = "rolling-back"; save(j); return run(j);
    }),
  };
}
