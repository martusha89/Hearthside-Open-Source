import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import type { AppEvent, BackupCaptureDiagnostic, BackupSettingsInfo, BackupSnapshotInfo, BackupVerification } from "@hearthside/ipc-contract";
import { backupAgent, backupConversationPage, backupConversationRecord, backupConversations, backupMainConversation, backupMessages, listAgents, listConversations, sanitizeBackupState } from "../runtime";
import { runCaptureDiagnostic as runDiagnosticScan } from "./capture-diagnostic";
import { listScheduleRuns, listSchedules } from "../schedules";
import { listSkills } from "../skills";
import { listConnectors } from "../connectors";
import { localMemoryDir } from "../history-import";
import { getLooks } from "../looks";
import { backupSettings, channelChatModes, connectionKey, getConnectionConfig, getSettings, updateBackupSettings } from "../settings";
import { collectSnapshot } from "./collect";
import { BackupSourceError, backupSourceFailure, type BackupOperation } from "./diagnostics";
import { captureRecoveryArtifacts } from "./artifacts";
import { captureChannelInventory } from "./channel-inventory";
import { backupKeyFor, backupKeyringProblem, backupKeyUnreadable, isBackupFolder, rememberBackupKey, storeIdAt } from "./keys";
import { BackupError, BackupStore, type SnapshotHeader } from "./store";
import { canonicalSnapshotViewSteps } from "./object-ids";
import { drainAsync } from "./breathe";
import { gitBundle } from "./git-capture";
import { attachedRepositoryFiles } from "../history-cloud";

/**
 * Hearthside backups, wired to the app: the store in the chosen folder, the
 * companion's data from the runtime, "Back up now", the daily run, and the
 * folder's state for Settings → Backups. Restore lives in restore.ts.
 */

let broadcast: (event: AppEvent) => void = () => undefined;
export function initBackups(emit: (event: AppEvent) => void): void {
  broadcast = emit;
  startDailyRuns();
}

/**
 * Why this computer can't open the folder. A key that is kept here but can no
 * longer be decrypted (a keychain reset, a different Windows account) is a
 * different situation from never having had one, and saying "doesn't have the
 * key" for both hides the one case where nothing is actually lost.
 */
function missingKeyMessage(storeId: string | null): string {
  const ringProblem = backupKeyringProblem();
  if (ringProblem) {
    // Say what is actually wrong: this is repairable without the recovery code, and
    // blaming the keychain would send the person looking in the wrong place.
    return `Hearthside can't tell whether this computer has the key for that backup folder, because ${ringProblem}. Unlock the folder with the recovery code, or fix that file first.`;
  }
  if (storeId && backupKeyUnreadable(storeId)) {
    return "This computer keeps a key for that backup folder but can't open it any more (its keychain changed). Unlock the folder with the recovery code.";
  }
  return "This computer doesn't have the key for that backup folder. Unlock it with the recovery code.";
}

export function openStore(): BackupStore {
  const { folder } = backupSettings();
  if (!folder) throw new BackupError("Choose a backup folder first (Settings → Backups).");
  if (!isBackupFolder(folder)) throw new BackupError("The backup folder isn't there any more. Choose it again.");
  const storeId = storeIdAt(folder);
  const key = storeId ? backupKeyFor(storeId) : null;
  if (!key) throw new BackupError(missingKeyMessage(storeId));
  return BackupStore.open(folder, key);
}

export function getBackupSettingsInfo(): BackupSettingsInfo {
  const settings = backupSettings();
  let ready = false;
  let sizeOnDisk: number | null = null;
  if (settings.folder && isBackupFolder(settings.folder)) {
    const storeId = storeIdAt(settings.folder);
    const key = storeId ? backupKeyFor(storeId) : null;
    ready = key !== null;
    if (key) {
      try {
        sizeOnDisk = BackupStore.open(settings.folder, key).sizeOnDisk();
      } catch {
        ready = false;
      }
    }
  }
  return { folder: settings.folder, ready, includePictures: settings.includePictures, daily: settings.daily, dailyAt: settings.dailyAt, keepDays: settings.keepDays, lastRun: settings.lastRun, lastError: settings.lastError ?? {}, sizeOnDisk };
}

/** A folder was picked: start a store there (recovery code to show once) or open the one it holds. */
export function adoptBackupFolder(folder: string): { recoveryCode: string | null; needsRecoveryCode: boolean } {
  if (isBackupFolder(folder)) {
    const storeId = storeIdAt(folder);
    const known = storeId ? backupKeyFor(storeId) : null;
    updateBackupSettings({ folder });
    return { recoveryCode: null, needsRecoveryCode: known === null };
  }
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    throw new BackupError("Pick an empty folder (or one that already holds a Hearthside backup), so nothing else gets mixed in with it.");
  }
  // The key is kept before the folder becomes a backup folder: if keeping it fails,
  // `create` rolls back and this throws, leaving the folder as empty as it was found.
  const { recoveryCode } = BackupStore.create(folder, rememberBackupKey);
  updateBackupSettings({ folder });
  return { recoveryCode, needsRecoveryCode: false };
}

/** Hearthside: a replacement recovery code, possible only where the key is kept (this computer). */
export function newBackupRecoveryCode(): { recoveryCode: string } {
  const { folder } = backupSettings();
  if (!folder || !isBackupFolder(folder)) throw new BackupError("Choose the backup folder first.");
  const storeId = storeIdAt(folder);
  const key = storeId ? backupKeyFor(storeId) : null;
  if (!key) {
    const ringProblem = backupKeyringProblem();
    const detail = ringProblem
      ? ` (${ringProblem})`
      : storeId && backupKeyUnreadable(storeId)
        ? " (this computer keeps one, but its keychain can no longer open it)"
        : "";
    throw new BackupError(`This computer doesn't hold this backup's key${detail}, so it can't make a new code. Open the folder with the old code first, on a computer that has it.`);
  }
  return { recoveryCode: BackupStore.rewrapRecoveryCode(folder, key) };
}

export function unlockBackupFolder(recoveryCode: string): BackupSettingsInfo {
  const { folder } = backupSettings();
  if (!folder || !isBackupFolder(folder)) throw new BackupError("Choose the backup folder first.");
  const { store, key } = BackupStore.openWithRecoveryCode(folder, recoveryCode);
  rememberBackupKey(store.storeId, key);
  return getBackupSettingsInfo();
}

const toInfo = (header: SnapshotHeader): BackupSnapshotInfo => ({
  id: header.id,
  agentId: header.agentId,
  agentName: header.agentName,
  at: header.at,
  counts: header.counts,
  objects: header.objects,
  bytes: header.bytes,
  omissions: header.omissions,
});

const running = new Set<string>();


let queue: Promise<unknown> = Promise.resolve();

/** Cached verification is only a hint: recheck the objects before every use. */
export async function baselineFor(store: ReturnType<typeof openStore>, agentId: string): Promise<string | null> {
  const known = backupSettings().verified?.[agentId];
  const latest = store.listSnapshots(agentId).at(-1);
  const candidate = known ?? latest?.id;
  if (candidate) {
    try {
      if ((await store.verifyAsync(agentId, candidate)).ok) {
        updateBackupSettings({ verified: { ...backupSettings().verified, [agentId]: candidate } });
        return candidate;
      }
    } catch { /* Missing or damaged: invalidate the hint and capture fresh. */ }
  }
  const verified = { ...backupSettings().verified };
  delete verified[agentId];
  updateBackupSettings({ verified });
  return null;
}

/** Back one companion up now. */
/** Hearthside: how long an incremental chain may run before a full re-read. */
const FULL_BACKUP_EVERY_MS = 7 * 24 * 60 * 60_000;

/**
 * Full unless a verified full backup is recent enough to build on. A full read catches edits
 * and deletions but re-reads every message (half an hour for a long history), so the routine
 * run carries unchanged chats over and reads only what's new; `full` forces the slow kind.
 */
function backupMode(agentId: string, baselineId: string | null, full: boolean): "full" | "incremental" {
  if (full || !baselineId) return "full";
  const lastFull = backupSettings().lastFull?.[agentId];
  const age = lastFull ? Date.now() - new Date(lastFull).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(age) && age >= 0 && age < FULL_BACKUP_EVERY_MS ? "incremental" : "full";
}

export async function backUpNow(agentId: string, full = false): Promise<BackupSnapshotInfo> {
  if (running.has(agentId)) throw new BackupError("A backup of this companion is already running.");
  running.add(agentId);
  const turn = queue.then(() => runBackup(agentId, undefined, full));
  queue = turn.catch(() => undefined);
  try {
    return await turn;
  } catch (error) {
    recordFailure(agentId, safeBackupError(error));
    throw error;
  } finally {
    running.delete(agentId);
  }
}

async function runBackup(agentId: string, transientStore?: BackupStore, full = false): Promise<BackupSnapshotInfo> {
  let phase = "Backup preflight";
  try {
    const store = transientStore ?? openStore();
    const settings = backupSettings();
    const { recoveryConnectionReference } = await import("./recovery");
    const sourceReference = recoveryConnectionReference();
    const checkSource = () => {
      if (JSON.stringify(recoveryConnectionReference()) !== JSON.stringify(sourceReference) || backupSettings().folder !== settings.folder) throw new BackupError("The source account, connection or backup folder changed during capture; no mixed-source snapshot was committed.");
    };
    const boundRead = async <T>(read: () => Promise<T>, operation: BackupOperation): Promise<T> => {
      checkSource(); const value = await sourceRead(read, operation); checkSource(); return value;
    };
    const startedAt = new Date().toISOString();
    const agent = await boundRead(() => backupAgent(agentId), "agent.retrieve");
    const conversations = await boundRead(() => backupConversations(agentId), "conversations.list");
    const memoryDir = localMemoryDir(agentId);
    phase = "Backup capture";
    const baselineId = transientStore ? null : await baselineFor(store, agentId);
    const mode = transientStore ? "full" : backupMode(agentId, baselineId, full);
    console.log(`[backup] ${agent.name}: ${mode} backup${baselineId ? ` (building on ${baselineId})` : ""}`);
    const header = await collectSnapshot(
      store,
      {
        agent: { ...agent, connection: safeConnectionLabel(connectionKey()) },
        listConversations: async () => conversations,
        listMessages: backupMessages,
        memoryDir,
        gitBundle: () => sourceRead(() => memoryDir ? gitBundle(memoryDir) : Promise.resolve(null), "git.capture"),
        schedules: () => sourceRead(() => listSchedules(agentId), "schedules.list"),
        hearthside: async () => {
          const looks = getLooks();
          const app = getSettings();
          return {
            look: looks.agents[agentId] ?? null,
            favourite: app.favouriteAgents.includes(agentId),
            channelChatModes: channelChatModes(),
          };
        },
        extras: async () => {
          const extras = await backupExtras(agentId);
          const afterAgent = await boundRead(() => backupAgent(agentId), "metadata.recheck");
          const afterConversations = await boundRead(() => backupConversations(agentId), "metadata.recheck");
          const stableChats = (items: typeof conversations) => [...items].sort((a, b) => a.id.localeCompare(b.id));
          const drifted = JSON.stringify(agent) !== JSON.stringify(afterAgent) || JSON.stringify(stableChats(conversations)) !== JSON.stringify(stableChats(afterConversations));
          // Hearthside: a handover's fresh source check must be exact. A daily backup of a companion who kept
          // chatting meanwhile (a new message changes message_ids and updated_at) is still a good backup: say so
          // in the snapshot rather than fail it, or an active companion would never get one.
          if (drifted && transientStore) throw new BackupError("Observed agent/conversation metadata changed during capture; retry the backup.");
          const scope = "agent configuration and conversation metadata/context only; not message bodies, local files or all connected services";
          return { ...extras, captureObservations: {
            items: [{ startedAt, finishedAt: new Date().toISOString(), status: drifted ? "metadata-changed-during-capture" : "best-effort-metadata-unchanged", atomic: false, scope }],
            ...(drifted ? { error: "the companion's details or chats changed while the backup ran (it was probably replying); the snapshot keeps them as they were at the start" } : {}),
          } };
        },
        repositories: () => sourceRead(() => attachedRepositoryFiles(agentId), "repositories.list"),
        artifacts: () => boundRead(async () => [
          { path: "recovery/connection.json", kind: "recovery-connection", bytes: Buffer.from(JSON.stringify(sourceReference)) },
          ...await captureRecoveryArtifacts(agentId, memoryDir, conversations),
        ], "artifacts.capture"),
        validateBeforeCommit: checkSource,
      },
      {
        includePictures: settings.includePictures,
        app: `Hearthside ${app.getVersion()}`,

        baselineId,
        // A handover's source check and a forced run read everything; the routine run builds on the last full.
        mode,
        onProgress: transientStore ? undefined : (done, total, what) => broadcast({ type: "backup.progress", agentId, done, total, what }),
      },
    );

    phase = "Backup verification";
    const check = await store.verifyAsync(agentId, header.id);
    if (!check.ok) {
      const message = `The new backup didn't check out (${check.missing.length} piece(s) missing, ${check.corrupt.length} damaged). Older backups were kept; try again.`;
      console.warn(`[backup] ${agent.name}: ${message}`);
      if (!transientStore) {
        recordFailure(agentId, message);
        // The snapshot stays in the folder (most of it is usually readable), marked so that
        // the list says it failed and cleanup doesn't keep it in place of the last good one.
        try { store.markFailedCheck(agentId, header.id); } catch (error) { console.warn(`[backup] ${agent.name}: the failed backup couldn't be marked: ${safeBackupError(error)}`); }
      }
      throw new BackupError(message);
    }
    if (transientStore) return toInfo(header);
    phase = "Backup retention cleanup";
    // Cleanup that had to hold back says why, in the log: it used to return quietly, and
    // old backups then piled up with nothing to show for it.
    for (const reason of store.prune(settings.keepDays).skipped) console.warn(`[backup] cleanup: ${safeBackupError(new BackupError(reason))}`);
    const done = backupSettings();
    const lastError = { ...done.lastError };
    delete lastError[agentId];
    updateBackupSettings({ lastRun: { ...done.lastRun, [agentId]: header.at }, verified: { ...done.verified, [agentId]: header.id }, lastError, ...(mode === "full" ? { lastFull: { ...done.lastFull, [agentId]: header.at } } : {}) });
    console.log(`[backup] ${agent.name}: ${header.counts.conversations} conversations, ${header.counts.newMessages} new messages, ${header.counts.memoryFiles} memory files`);
    return toInfo(header);
  } catch (error) {
    throw new BackupError(`${phase}: ${safeBackupError(error)}`);
  }
}

/** Full fresh source observation for handover; never prunes or updates the user's backup store. */
export async function captureSourceSnapshot(agentId: string) {
  const directory = mkdtempSync(join(tmpdir(), "hearthside-source-check-"));
  try {
    const { store } = BackupStore.create(directory);
    const info = await runBackup(agentId, store);
    const snapshot = store.readSnapshot(agentId, info.id);
    const canonical = await drainAsync(canonicalSnapshotViewSteps(store, snapshot));
    return { entries: canonical.snapshot.entries, omissions: snapshot.omissions, readObject: canonical.readObject, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

function recordFailure(agentId: string, message: string): void {
  updateBackupSettings({ lastError: { ...backupSettings().lastError, [agentId]: { at: new Date().toISOString(), message: message.slice(0, 500) } } });
}

/** An address without its query, fragment or login: keys sometimes travel in those. */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "";
  }
}

async function sourceRead<T>(read: () => Promise<T>, operation: BackupOperation): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof BackupError) throw new BackupError(safeBackupError(error));
    throw backupSourceFailure(error, { operation });
  }
}

export function safeConnectionLabel(label: string): string {
  return label.replace(/^(cloud|remote):(.*)$/s, (_match, kind: string, url: string) => `${kind}:${safeUrl(url)}`);
}

/** Exclude request details from persisted errors; known local backup errors remain actionable. */
export function safeBackupError(error: unknown): string {
  if (error instanceof BackupSourceError) return new BackupSourceError(error.context, error.code, error.status).message;
  if (!(error instanceof BackupError)) return "Backup source or verification operation failed; request details were omitted to avoid saving credentials.";
  return error.message.replace(/https?:\/\/[^\s]+/g, (url) => safeUrl(url)).replace(/((?:api[_-]?key|token|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

/** Known credential fields are excluded. User-authored content may still contain secrets. */
export async function backupExtras(agentId: string): Promise<Record<string, { items: unknown[]; error?: string; limitation?: string }>> {
  const read = async (work: () => Promise<unknown[]>) => {
    try {
      const items = sanitizeBackupState(await work()) as unknown[];
      const partial = items.some((item) => item && typeof item === "object" && "error" in item);
      return { items, ...(partial ? { error: "One or more components failed; see per-component errors in extras.json." } : {}) };
    } catch (error) {
      return { items: [{ code: "component_unavailable", error: safeBackupError(error) }], error: safeBackupError(error) };
    }
  };
  const inventory = captureChannelInventory(agentId);
  const [scheduleRuns, channelRoutes, channelBots, conversationSettings, skills, connectors] = await Promise.all([
    read(async () => {
      const schedules = await listSchedules(agentId);
      return Promise.all(schedules.map(async (schedule) => {
        try { return { scheduleId: schedule.id, name: schedule.name, runs: await listScheduleRuns(schedule.id) }; }
        catch (error) { return { scheduleId: schedule.id, name: schedule.name, runs: [], error: safeBackupError(error), code: "schedule_runs_unavailable" }; }
      }));
    }),
    read(async () => (await inventory).routes),
    read(async () => (await inventory).bots),
    read(async () => (await listConversations(agentId)).map(({ id, title, model, cwd, contextWindowLimit, channel, main }) => ({ id, title, model, cwd, contextWindowLimit: contextWindowLimit ?? null, channel: channel ?? null, main: main === true }))),
    read(() => listSkills(agentId)),
    read(async () => (await listConnectors(agentId)).connectors.map(({ id, name, where, kind, command, args, url, envKeys, headerKeys, preset, tools }) => ({
      id,
      name,
      where,
      kind,
      command,

      argCount: args.length,
      url: url ? safeUrl(url) : "",
      envKeys,
      headerKeys,
      preset,
      tools: tools.map((tool) => tool.name),
    }))),
  ]);
  return {
    scheduleRuns,
    channelRoutes,
    channelBots,
    conversationSettings,
    skills,
    connectors,
    configurationCoverage: { items: [{ mode: "public-sdk-allowlist", excluded: ["credential fields", "execution environment variables", "unrecognized state fields"], secretsMayExistInUserContent: true }], limitation: "Configuration is an allowlisted recovery seed, not a complete export of every runtime setting or credential." },
    continuationCoverage: { items: [{ mode: "artifact-dependent", note: "Native context and compaction coverage requires native-state/manifest.json; Cloud context coverage requires the corresponding Agent File. Transcript summaries alone are not continuation state." }] },
    archivalPassages: { items: [{ mode: "artifact-dependent", note: "Cloud passage content and provenance are exported to archival/passages.json when available. The recovery capsule preserves that archive; embeddings and live searchable archival stores are not recreated. The local backend has no equivalent archival store." }] },
  };
}

/** The note a listed backup carries when it didn't pass its check at the time it was made. */
export const FAILED_CHECK_NOTE = "This backup didn't pass its own check when it was made: some of its pieces may be missing or damaged. Press \"Check\" to see which.";

export function listBackups(agentId: string): BackupSnapshotInfo[] {
  const store = openStore();
  const failed = store.failedChecks(agentId);
  return store.listSnapshots(agentId).map(toInfo).map((info) => (failed.has(info.id) ? { ...info, omissions: [FAILED_CHECK_NOTE, ...info.omissions] } : info)).reverse();
}

export async function verifyBackup(agentId: string, snapshotId: string): Promise<BackupVerification> {
  const store = openStore();
  const result = await store.verifyAsync(agentId, snapshotId);
  // A backup that failed when it was made but checks out now (a synced folder that has
  // since caught up) is a good one again. Clearing the mark is a convenience, never a
  // reason to fail the check the person asked for.
  if (result.ok) try { store.clearFailedCheck(agentId, snapshotId); } catch { /* the mark stays */ }
  return result;
}

// --- "What does this connection report?" -----------------------------------------
// A read-only, metadata-only count, through the same readers a capture uses, so
// what it reports is what a capture would see. It writes nothing, sends nothing,
// schedules nothing, and asks no model anything. See capture-diagnostic.ts.

let diagnostic: { cancel: boolean } | null = null;

export async function runCaptureDiagnostic(agentId: string): Promise<BackupCaptureDiagnostic> {
  if (diagnostic) throw new BackupError("A connection check is already running.");
  const token = { cancel: false };
  diagnostic = token;
  try {
    const { recoveryConnectionReference } = await import("./recovery");
    const reference = JSON.stringify(recoveryConnectionReference());
    const backend = getConnectionConfig().backend;
    return await runDiagnosticScan({
      backend: backend === "cloud" || backend === "local" || backend === "remote" ? backend : "unknown",
      checkScope: () => {
        if (JSON.stringify(recoveryConnectionReference()) !== reference) throw new BackupError("The source account or connection changed during the check.");
      },
      // The companion has to be one on the connection this app is signed in to.
      // This is the authoritative check — one read of this agent, by id — rather
      // than a search of the first page of a listing, which would turn a
      // hundred-and-first companion into "not on this connection".
      readMainChat: () => sourceRead(() => backupMainConversation(agentId), "agent.retrieve"),
      // Only this companion's own chats, through the same readers a capture uses,
      // one bounded page at a time rather than the whole history.
      listChatPage: (options) => sourceRead(() => backupConversationPage(agentId, { archived: options.archived, limit: options.limit, ...(options.after ? { after: options.after } : {}) }), "conversations.list"),
      readChat: (conversationId) => sourceRead(() => backupConversationRecord(conversationId), "conversations.list"),
      listMessages: (conversationId, options, read) => sourceRead(() => backupMessages(conversationId, options, { signal: read.signal, timeoutMs: read.timeoutMs }), "messages.list"),
      cancelled: () => token.cancel,
    });
  } finally {
    // The scan returns inside its own deadline whatever the connection does, so
    // the next press is never refused by a check that is no longer running.
    diagnostic = null;
  }
}

export function cancelCaptureDiagnostic(): { cancelled: boolean } {
  if (!diagnostic) return { cancelled: false };
  diagnostic.cancel = true;
  return { cancelled: true };
}

// --- The daily run --------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

/** Once a minute: if daily backups are on and today's hasn't happened since the chosen time, run them (a catch-up after reopening counts). */
function startDailyRuns(): void {
  if (timer) return;
  timer = setInterval(() => void dailyTick().catch((error: unknown) => console.warn(`[backup] daily run: ${error instanceof Error ? error.message : String(error)}`)), 60_000);
  timer.unref?.();
}

/** Exported for its unit test; the app reaches this only through `startDailyRuns`. */
export async function dailyTick(now = new Date()): Promise<void> {
  const settings = backupSettings();
  if (!settings.daily || !settings.folder) return;
  const [hour, minute] = settings.dailyAt.split(":").map(Number);
  const due = new Date(now);
  due.setHours(hour ?? 3, minute ?? 0, 0, 0);
  if (now < due) return;
  const agents = await listAgents().catch(() => []);
  for (const agent of agents) {
    // Read again on every turn: the previous agent's backup, or a "Back up now" the person
    // started meanwhile, has already written lastRun/lastError, and they may have switched
    // daily backups off or moved the folder while this loop was awaiting.
    const current = backupSettings();
    if (!current.daily || current.folder !== settings.folder) return;
    if (attemptedInWindow(current, agent.id, due)) continue;
    if (running.has(agent.id)) continue;
    // Write the mark here, with no await between it and the capture: nothing can slip in to
    // make the attempt twice, and a close or a crash mid-capture still spends the window.
    if (!markAutoAttempt(agent.id, now)) return;
    await backUpNow(agent.id).catch((error: unknown) => console.warn(`[backup] ${agent.name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * One *automatic* attempt per daily window — the gate is the attempt, not the success.
 * `lastRun` only advances when a backup verifies, so gating on it alone retried a failing
 * companion every minute from `dailyAt` until midnight, and again a minute after the app was
 * reopened, each retry re-stamping the error — which can make a failure look permanent for the
 * rest of the day, and spends a whole capture attempt a minute.
 *
 * The mark is `lastAutoAttempt`, which this run owns outright, and deliberately not the error
 * the person sees: `lastError` is shared with "Back up now", so one manual attempt that failed
 * at 09:00 would have eaten the automatic window at 09:30, and a manual failure after an
 * automatic one would overwrite any record of whether the day's automatic attempt had happened.
 *
 * The trade-off is narrow and chosen: a passing failure — a connection down at 03:00 — now waits
 * for tomorrow's window rather than being retried automatically. "Back up now" is never gated by
 * any of this and stays available at any moment, and the failure keeps its place in Settings
 * until a backup actually checks out. None of it says the capture failure itself is mended.
 */
function attemptedInWindow(settings: ReturnType<typeof backupSettings>, agentId: string, due: Date): boolean {
  const ran = settings.lastRun[agentId];
  if (ran && new Date(ran) >= due) return true;
  const attempted = settings.lastAutoAttempt?.[agentId];
  // An unparseable stored time is treated as no attempt: a damaged value must not silence
  // backups for the rest of the day. The attempt that follows writes a sound one.
  return attempted !== undefined && new Date(attempted) >= due;
}

/**
 * Records the automatic attempt about to be made. Returns false if it could not be stored —
 * then the capture is skipped rather than made untracked, because an untracked one is exactly
 * what brings the minute-by-minute retrying back. Settings are a single file, so a failure here
 * is not this one companion's problem and the caller stops for this turn.
 */
function markAutoAttempt(agentId: string, at: Date): boolean {
  try {
    updateBackupSettings({ lastAutoAttempt: { ...backupSettings().lastAutoAttempt, [agentId]: at.toISOString() } });
    return true;
  } catch (error: unknown) {
    console.warn(`[backup] daily run: the attempt could not be noted down, so none was made: ${safeBackupError(error)}`);
    return false;
  }
}
