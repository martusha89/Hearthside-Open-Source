import { homedir } from "node:os";
import { historyVolumesFromMappings, recordHistoryVolumes } from "./history-registry";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { resolveRuntimeHome } from "../../runtime/paths";
import { backupSettings, connectionKey, getConnectionConfig, getSettings } from "../settings";
import { fenceAgentForRecovery, getLocalRecoveryClient } from "../runtime";
import { currentLettaAccessToken } from "../letta-signin";
import { openStore } from "./backup";
import { executeRestore, previewRestoreAsync, type RestorePlan, type RestoreProgress, type RestoreResult, type RestoreDestination } from "./restore";
import type { AppEvent } from "@hearthside/ipc-contract";
import { createLocalRestoreDestination } from "./restore-local";
import { createCloudRestoreDestination } from "./restore-cloud";
import type { BackupStore } from "./store";
import { canonicalSnapshotViewSteps } from "./object-ids";
import { drainAsync } from "./breathe";
import { assertRecoveryReadback, createRecoveryReceiptStore, snapshotDataFingerprint, type RecoveryReadback, type RecoveryReceipt } from "./receipts";
import { createCutoverService } from "./cutover";
import { createAppCutoverAdapter, type AppCutoverHooks } from "./cutover-runtime";

type VerifiedDestination = RestoreDestination & { readbackRecovery?: (id: string) => Promise<RecoveryReadback> };
const pending = new Map<string, { store: BackupStore; adapter: VerifiedDestination; target: string; connection: string; identity: string; plan: RestorePlan; expires: number }>();
let restoring = false;
let ordinaryMutations = 0;
export async function withRecoveryMutation<T>(run: () => Promise<T> | T): Promise<T> {
  assertRecoveryIdle(); ordinaryMutations++;
  try { return await run(); } finally { ordinaryMutations--; }
}
function assertRecoveryCanStart(): void {
  assertRecoveryIdle();
  if (ordinaryMutations) throw new Error("Wait for the current settings or data change before recovery.");
}
function home(): string { return resolveRuntimeHome().home ?? homedir(); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function baseUrl(): string {
  const config = getConnectionConfig();
  const url = new URL(config.apiBaseUrl || "https://api.letta.com");
  if (url.username || url.password || url.search || url.hash) throw new Error("Recovery requires a credential-free API base URL");
  return url.toString().replace(/\/+$/, "");
}
/** OAuth session revision changes on sign-in/out, but not access-token refresh. Never persist credentials. */
export function recoveryConnectionIdentity(): string {
  const config = getConnectionConfig();
  return hash(config.backend === "local" ? ["local", home()] : [config.backend, baseUrl(), config.apiKey ? hash(config.apiKey) : getSettings().connectionRevision]);
}
export function recoveryConnectionReference(): { connection: string; identity: string } {
  // Custom endpoint labels can contain secrets; validation happens before returning a reference.
  if (getConnectionConfig().backend === "cloud") baseUrl();
  return { connection: connectionKey(), identity: recoveryConnectionIdentity() };
}
function target(store: BackupStore): string {
  return hash([getConnectionConfig().backend, getSettings().connectionRevision, home(), backupSettings().folder, store.storeId, recoveryConnectionIdentity()]);
}
export function assertRecoveryIdle(): void {
  if (restoring) throw new Error("A recovery copy is being created. Wait for it to finish before changing the connection or backup folder.");
}
export function listBackupCompanions() { return openStore().listCompanions(); }


let emit: (event: AppEvent) => void = () => undefined;
export function configureRecoveryEvents(send: (event: AppEvent) => void): void { emit = send; }
function progressFor(phase: "preview" | "restore"): RestoreProgress {
  let last = 0, lastStep = "";
  return (step, done, total, what) => {
    const now = Date.now();
    if (step === lastStep && now - last < 150 && done !== total) return;
    last = now; lastStep = step;
    emit({ type: "recovery.progress", phase, step, ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}), ...(what ? { what } : {}) });
  };
}
function receipts() { return createRecoveryReceiptStore(join(app.getPath("userData"), "recovery-receipts")); }
/** Hearthside: validated receipts' history volumes, for rebuilding the history registry. Throws if any can't be read. */
export function historyEvidence(): Array<{ agentId: string; conversationIds: string[] }> {
  const directory = join(app.getPath("userData"), "recovery-receipts");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => {
    const receipt = receipts().get(name.slice(0, -5));
    return { agentId: receipt.target.agentId, conversationIds: historyVolumesFromMappings(receipt.mappings ?? []) };
  });
}
export function getRecoveryReceipt(id: string) { return receipts().get(id); }

/**
 * Hearthside: every restored copy this computer holds a receipt for, so the backups
 * screen can open one again later. The receipt's ID used to live only in the panel
 * shown right after a restore: close it, or restart, and the copy stayed locked with
 * no way back to the buttons that open it, short of restoring all over again. A
 * handover that stopped partway is named too, so its rollback can be reached.
 *
 * Read-only, and it never fails on one bad file: a receipt that can't be read is left
 * out of the list (it couldn't be acted on anyway) and the rest are still shown.
 */
export type RecoveryCopy = { receiptId: string; createdAt: string; sourceAgentId: string; targetAgentId: string; snapshotId: string; handoverId: string | null; handoverState: string | null };
export function listRecoveryCopies(): RecoveryCopy[] {
  const directory = join(app.getPath("userData"), "recovery-receipts");
  if (!existsSync(directory)) return [];
  // An unfinished handover, by the receipt it belongs to. Only one can be under way
  // at a time; previews and rolled-back ones need nothing from the person.
  const unfinished = new Map<string, { id: string; state: string }>();
  const journals = join(app.getPath("userData"), "recovery-handovers");
  for (const name of existsSync(journals) ? readdirSync(journals) : []) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const journal = JSON.parse(readFileSync(join(journals, name), "utf8")) as { version?: unknown; id?: unknown; state?: unknown; receipt?: { id?: unknown } };
      if (journal.version !== 1 || journal.id !== name.slice(0, -5) || typeof journal.receipt?.id !== "string") continue;
      if (typeof journal.state !== "string" || !["running", "blocked", "active", "rolling-back"].includes(journal.state)) continue;
      unfinished.set(journal.receipt.id, { id: journal.id, state: journal.state });
    } catch { /* an unreadable journal names no receipt */ }
  }
  const copies: RecoveryCopy[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const receipt = receipts().get(name.slice(0, -5));
      const handover = unfinished.get(receipt.id);
      copies.push({ receiptId: receipt.id, createdAt: receipt.createdAt, sourceAgentId: receipt.source.agentId, targetAgentId: receipt.target.agentId, snapshotId: receipt.snapshotId, handoverId: handover?.id ?? null, handoverState: handover?.state ?? null });
    } catch { /* left out; see above */ }
  }
  return copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Main-process wiring only, never renderer/backup-supplied callbacks.
let localOptions: () => Partial<Parameters<typeof createLocalRestoreDestination>[0]> = () => ({});
export function configureLocalRecovery(options: typeof localOptions): void { localOptions = options; }
let handoverHooks: Omit<AppCutoverHooks, "receipt"> | undefined;
export function configureRecoveryHandover(hooks: Omit<AppCutoverHooks, "receipt">): void { handoverHooks = hooks; }
function handovers() {
  if (!handoverHooks) throw new Error("Recovery handover writer ownership inspection is unavailable; copies remain inactive.");
  const hooks: AppCutoverHooks = { ...handoverHooks, receipt: async id => {
    const receipt = getRecoveryReceipt(id);
    if (!receipt.sourceConnectionIdentity || receipt.sourceConnectionIdentity !== receipt.targetConnectionIdentity || receipt.targetConnectionIdentity !== recoveryConnectionIdentity()) throw new Error("Exclusive handover requires proven control of the same source and target connection/account.");
    return receipt;
  } };
  return createCutoverService(join(app.getPath("userData"), "recovery-handovers"), createAppCutoverAdapter(join(app.getPath("userData"), "recovery-handover-operations"), hooks));
}
async function recoveryOperation<T>(run: () => Promise<T>): Promise<T> {
  assertRecoveryCanStart(); restoring = true;
  try { return await run(); } finally { restoring = false; }
}
export function previewRecoveryHandover(receiptId: string) { return recoveryOperation(() => handovers().preview(receiptId)); }
export function confirmRecoveryHandover(token: string, capabilities: string[]) { return recoveryOperation(() => handovers().confirm(token, capabilities)); }
export function rollbackRecoveryHandover(id: string) { return recoveryOperation(() => handovers().rollback(id)); }
export function getRecoveryHandover(id: string) { return handovers().get(id); }

export type ManualRecoveryObservation = { readback: RecoveryReadback; targetIdle: boolean; automationOff: boolean; manualOnly: boolean; blockers: string[] };
export type ManualRecoveryHooks = {
  /** Read the destination, not the original backup/source. Census must fail closed. */
  inspect(receipt: RecoveryReceipt): Promise<ManualRecoveryObservation>;
  /** Persist manual-only admission BEFORE selecting the target. Never enable automation. */
  open(receipt: RecoveryReceipt): Promise<void>;
};
let manualHooks: ManualRecoveryHooks | undefined;
const manualPending = new Map<string, { receiptId: string; receiptDigest: string; identity: string; expires: number }>();
export function configureManualRecovery(hooks: ManualRecoveryHooks): void { manualHooks = hooks; }
async function inspectManual(receipt: RecoveryReceipt) {
  if (!manualHooks) throw new Error("Manual-only recovery admission is unavailable; the copy remains fenced.");
  if (receipt.targetConnectionIdentity !== recoveryConnectionIdentity() || receipt.target.connection !== connectionKey()) throw new Error("Select the recovery copy's original account and connection first.");
  const observation = await manualHooks.inspect(receipt);
  assertRecoveryReadback(observation.readback);
  if (observation.blockers.length || !observation.targetIdle || !observation.automationOff || observation.readback.fingerprint !== receipt.targetFingerprint || observation.readback.dataMark !== receipt.targetDataMark) throw new Error("Recovery copy changed, is busy, or its automation cannot be proven off.");
  return observation;
}
export async function previewManualRecoveryCopy(receiptId: string) {
  assertRecoveryIdle();
  const receipt = getRecoveryReceipt(receiptId);
  await inspectManual(receipt);
  for (const [token, preview] of manualPending) if (preview.expires < Date.now()) manualPending.delete(token);
  if (manualPending.size >= 50) throw new Error("Too many manual recovery previews are open.");
  const token = randomUUID();
  manualPending.set(token, { receiptId, receiptDigest: hash(receipt), identity: recoveryConnectionIdentity(), expires: Date.now() + 15 * 60_000 });
  return { token, receiptId, destinationAgentId: receipt.target.agentId, contextCoverage: receipt.contextCoverage, omissions: receipt.omissions, unrestoredParts: receipt.unrestoredParts,
    warning: "Open a standalone MANUAL-ONLY copy. This is not an exclusive migration; the source may still run elsewhere. Bots and schedules remain off." };
}
export async function confirmManualRecoveryCopy(token: string) {
  assertRecoveryCanStart();
  const preview = manualPending.get(token); manualPending.delete(token);
  if (!preview || preview.expires < Date.now()) throw new Error("Manual recovery preview expired or was already used.");
  const receipt = getRecoveryReceipt(preview.receiptId);
  if (preview.identity !== recoveryConnectionIdentity() || hash(receipt) !== preview.receiptDigest) throw new Error("Recovery receipt or account changed; preview again.");
  restoring = true;
  try {
    await inspectManual(receipt);
    await manualHooks!.open(receipt);
    const after = await inspectManual(receipt);
    if (!after.manualOnly) throw new Error("Manual-only admission could not be verified.");
    return { receiptId: receipt.id, destinationAgentId: receipt.target.agentId, manualOnly: true as const, exclusiveMigration: false as const };
  } catch (error) {
    fenceAgentForRecovery(receipt.target.agentId);
    throw error;
  } finally { restoring = false; }
}

export async function previewBackupRestore(agentId: string, snapshotId: string, options: { pictures?: "block" | "placeholder"; unansweredCalls?: "block" | "annotate"; windowCalls?: "block" | "close"; excludeChats?: string[]; fallbacks?: boolean } = {}): Promise<RestorePlan> {
  assertRecoveryIdle();
  for (const [token, saved] of pending) if (saved.expires < Date.now()) pending.delete(token);
  if (pending.size >= 50) throw new Error("Too many recovery previews are open. Wait for older previews to expire.");
  const store = openStore(), config = getConnectionConfig();
  if (config.backend !== "local" && config.backend !== "cloud") throw new Error("Recovery supports This computer or Letta Cloud only. No fallback destination was selected.");
  const bound = target(store), reference = recoveryConnectionReference();
  const assertConnection = async () => {
    if (bound !== target(openStore())) throw new Error("The recovery destination, account or backup folder changed. Preview again; no further writes were made.");
  };
  let adapter: VerifiedDestination;
  if (config.backend === "cloud") {
    // The sign-in first, as chats do; while signed in, never the saved key instead (it may be another account).
    const token = await currentLettaAccessToken() || (config.lettaSignedIn ? "" : config.apiKey);
    if (!token) throw new Error("Sign in to Letta Cloud or supply an API key before previewing recovery.");
    await assertConnection();
    adapter = createCloudRestoreDestination({ baseUrl: baseUrl(), token, connectionIdentity: reference.identity, assertConnection, onAllocated: fenceAgentForRecovery } as Parameters<typeof createCloudRestoreDestination>[0]);
  } else {
    adapter = createLocalRestoreDestination({ ...localOptions(), getLocalClient: getLocalRecoveryClient, runtimeHome: home(), onAllocated: fenceAgentForRecovery } as Parameters<typeof createLocalRestoreDestination>[0]);
  }
  // Defence in depth for adapters predating the immediate allocation callback.
  const allocate = adapter.createInactiveAgent.bind(adapter);
  adapter.createInactiveAgent = async input => {
    // Refused before asking the destination: positively nothing was created.
    try { await assertConnection(); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { allocation: "none" }); }
    const created = await allocate(input);
    fenceAgentForRecovery(created.id);
    return created;
  };
  // Only the two named degraded choices pass through, exactly as the person chose them.
  const chosen = {
    ...(options.fallbacks === true ? { fallbacks: true } : {}),
    ...(options.pictures === "placeholder" ? { pictures: "placeholder" as const } : {}),
    ...(options.unansweredCalls === "annotate" ? { unansweredCalls: "annotate" as const } : {}),
    ...(options.windowCalls === "close" ? { windowCalls: "close" as const } : {}),
    ...(Array.isArray(options.excludeChats) && options.excludeChats.length ? { excludeChats: options.excludeChats.filter((id) => typeof id === "string" && id.length <= 300).slice(0, 1000) } : {}),
  };
  const plan = await previewRestoreAsync(store, agentId, snapshotId, adapter, progressFor("preview"), chosen);
  // Hearthside: what the conversion couldn't place, as shapes (types and IDs, no text), in
  // a file beside the receipts so a problem can be looked at without reading the chats.
  if (plan.conversion?.diagnostics?.length) {
    try {
      const directory = join(app.getPath("userData"), "recovery-diagnostics");
      mkdirSync(directory, { recursive: true, mode: 0o700 });

      writeFileSync(join(directory, `${snapshotId}.json`), JSON.stringify({ snapshotId, agentId, unconvertedByReason: plan.conversion.unconvertedByReason, diagnostics: plan.conversion.diagnostics }, null, 2), { mode: 0o600 });
    } catch { /* a diagnostic only */ }
    delete plan.conversion.diagnostics;
  }
  if (!plan.blockers.length) pending.set(plan.token, { store, adapter, target: bound, connection: reference.connection, identity: reference.identity, plan, expires: Date.now() + 15 * 60_000 });
  return plan;
}

export async function restoreBackupCopy(token: string): Promise<RestoreResult & { receiptId?: string }> {
  assertRecoveryCanStart();
  const saved = pending.get(token);
  pending.delete(token);
  if (!saved || saved.expires < Date.now()) throw new Error("Recovery preview expired or was already used. Preview this snapshot again.");
  if (saved.target !== target(openStore())) throw new Error("The recovery destination or backup folder changed. Preview this snapshot again; nothing was restored.");
  restoring = true;
  try {
    const snapshot = saved.store.readSnapshot(saved.plan.sourceAgentId, saved.plan.snapshotId);
    const canonical = await drainAsync(canonicalSnapshotViewSteps(saved.store, snapshot));
    if (hash(canonical.snapshot) !== saved.plan.snapshotIdentity) throw new Error("Snapshot changed before recovery.");
    const sourceFingerprint = snapshotDataFingerprint(canonical.snapshot.entries, canonical.readObject);
    const entry = snapshot.entries.find(e => e.path === "recovery/connection.json");
    let sourceConnection = "unknown", sourceConnectionIdentity: string | null = null;
    if (entry) {
      const reference = JSON.parse(saved.store.getObject(entry.hash).toString("utf8"));
      if (typeof reference.connection === "string" && /^(local|cloud(?::https?:\/\/[^@?#]+)?)$/.test(reference.connection) && /^[a-f0-9]{64}$/.test(reference.identity)) {
        sourceConnection = reference.connection; sourceConnectionIdentity = reference.identity;
      }
    }
    const progress = progressFor("restore");
    const result = await executeRestore(saved.store, token, saved.adapter, progress);
    if (result.destinationAgentId) fenceAgentForRecovery(result.destinationAgentId);
    if (!result.ok || !result.destinationAgentId) return result;
    // Which of the last steps a failure happened in. The error itself is never shown or
    // kept (it can carry request details), but "something failed" with nothing else left
    // nobody able to tell a copy that can't be read back from a full disk.
    let stage = "The copy couldn't be read back from where it was restored to.";
    try {
      progress("verify");
      if (!saved.adapter.readbackRecovery) throw new Error("Destination readback evidence is unavailable");
      const readback = await saved.adapter.readbackRecovery(result.destinationAgentId);
      stage = "What was read back from the copy was incomplete.";
      assertRecoveryReadback(readback);
      stage = "The connection or backup folder changed while the copy was being checked.";
      if (saved.target !== target(saved.store)) throw new Error("Recovery connection changed during verification");

      stage = "The copy's read-only history couldn't be recorded on this computer.";
      recordHistoryVolumes(result.destinationAgentId, historyVolumesFromMappings(result.mappings ?? []));
      stage = "The copy's receipt couldn't be saved on this computer.";
      const receipt = receipts().save({
        source: { connection: sourceConnection, agentId: saved.plan.sourceAgentId }, target: { connection: saved.connection, agentId: result.destinationAgentId },
        storeId: saved.store.storeId, snapshotId: saved.plan.snapshotId, snapshotIdentity: saved.plan.snapshotIdentity,
        sourceConnectionIdentity, targetConnectionIdentity: saved.identity,
        sourceFingerprint, targetFingerprint: readback.fingerprint, targetDataMark: readback.dataMark,

        capabilities: result.contextCoverage === "native-all-conversations" ? ["manual", "schedules", "channels"] : result.contextCoverage === "translated-native" ? ["manual"] : [],
        mappings: result.mappings, contextCoverage: result.contextCoverage, omissions: [...saved.plan.omissions], unrestoredParts: result.unrestoredParts, artifacts: readback.artifacts,
      });
      return { ...result, receiptId: receipt.id };
    } catch (error) {
      console.warn(`[recovery] the restored copy stays locked: ${stage} (${error instanceof Error ? error.name : "error"})`);
      return { ...result, ok: false, error: `The recovery copy remains fenced: durable readback verification or receipt persistence failed. ${stage} No handover is permitted.` };
    }
  } finally { restoring = false; }
}
