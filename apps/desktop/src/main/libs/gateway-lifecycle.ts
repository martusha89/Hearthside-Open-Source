import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import treeKill from "tree-kill";

export type GatewayLease = (() => void) & { recordChild: (pid: number) => void };

/** Use the physical account directory, shared even by installs using aliases. */
export function gatewayLeasePath(home: string): string {
  const channels = join(home, ".letta", "channels");
  mkdirSync(channels, { recursive: true });
  return join(realpathSync(channels), ".hearthside-gateway.owner");
}

/** The lease directory exists: another Hearthside holds it, or left it behind. */
export class GatewayLeaseHeldError extends Error {
  constructor(path: string) {
    super(`Channel gateway ownership is already held or needs recovery (${path}). Close other Hearthside instances; an orphaned lease must be inspected before removal.`);
    this.name = "GatewayLeaseHeldError";
  }
}

/** Atomic, cross-process ownership. Never reclaim on PID alone: it may have been
 * reused, or the owning desktop may have died leaving its gateway alive.
 * Recovery (below) needs a complete record whose processes are positively gone;
 * anything less stays blocked until a person decides. */
export function acquireGatewayLease(path: string): GatewayLease {
  try { mkdirSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GatewayLeaseHeldError(path);
    throw error;
  }
  const metadata = join(path, "owner.json");
  // Diagnostic hints only, never authority to signal or reclaim a process.
  const owner = { ownerPid: process.pid, startNonce: randomUUID(), startedAt: new Date().toISOString(), childPid: null as number | null, childRecordedAt: null as string | null };
  try { writeFileSync(metadata, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); } catch (error) {
    // Keep a failed/partial record fail-closed too; no child has started yet.
    throw new Error(`Could not record gateway ownership (${path}): ${String(error)}`);
  }
  let released = false;
  const verifyOwner = () => {
    const current = JSON.parse(readFileSync(metadata, "utf8")) as { startNonce?: unknown };
    if (current?.startNonce !== owner.startNonce) throw new Error(`Gateway ownership changed (${path}); refusing to modify another owner's lease.`);
  };
  const release = () => {
    if (!released) { verifyOwner(); unlinkSync(metadata); rmdirSync(path); released = true; }
  };
  return Object.assign(release, { recordChild: (pid: number) => {
    if (released) throw new Error("Gateway ownership has already been released.");
    verifyOwner();
    owner.childPid = pid;
    // The child's own time of record: a probe compares its creation time with this,
    // never with the parent's lease time (a parent may spawn long after taking the lease).
    owner.childRecordedAt = new Date().toISOString();
    writeFileSync(metadata, JSON.stringify(owner), { mode: 0o600 });
  } });
}



/** What a process probe could establish. Unknown never counts as gone. */
export type ProcessProbe = {
  /** "gone": the OS says there is no such process. "alive": it exists. "unknown": could not tell. */
  presence: "gone" | "alive" | "unknown";
  /** The full command line when it was readable and not blank; otherwise null. */
  command: string | null;
  /** When the process was created (ms since epoch) when the OS reports it; otherwise null. */
  createdAt: number | null;
};
export type ProbeProcess = (pid: number) => Promise<ProcessProbe>;

const PROBE_TIMEOUT_MS = 8_000;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
        resolve(error ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

const blankToNull = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const timeOrNull = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

async function commandDetails(pid: number): Promise<{ command: string | null; createdAt: number | null }> {
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{ command = $p.CommandLine; created = $p.CreationDate.ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress }`;
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!out) return { command: null, createdAt: null };
    try {
      const parsed = JSON.parse(out) as { command?: unknown; created?: unknown };
      return { command: blankToNull(parsed.command), createdAt: timeOrNull(parsed.created) };
    } catch {
      return { command: null, createdAt: null };
    }
  }
  // lstart is a fixed 24-character column ("Sat Nov  1 12:00:00 2026"), then the command.
  const out = await run("ps", ["-o", "lstart=,command=", "-p", String(pid)]);
  if (!out) return { command: null, createdAt: null };
  const line = out.replace(/\r?\n$/, "");
  return { command: blankToNull(line.slice(24)), createdAt: timeOrNull(line.slice(0, 24).trim()) };
}

/** Asynchronous, bounded: never blocks the main process on a slow OS query. */
export async function probeProcess(pid: number): Promise<ProcessProbe> {
  let presence: ProcessProbe["presence"];
  try {
    process.kill(pid, 0);
    presence = "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    presence = code === "ESRCH" ? "gone" : code === "EPERM" ? "alive" : "unknown";
  }
  if (presence !== "alive") return { presence, command: null, createdAt: null };
  return { presence, ...(await commandDetails(pid)) };
}

/** Command lines that can legitimately hold or serve the lease: the packaged app
 * (Hearthside.exe, Hearthside.app/Contents/MacOS/Hearthside), a development
 * Electron, or the runtime's gateway (letta.js channel-gateway). */
const OURS = /hearthside|electron|channel-gateway|@letta-ai[\\/]letta-code|(?:^|[\\/\s"'=])letta(?:\.js|\.cmd|\.exe)?(?:[\s"']|$)/i;
/** A process born this long after its record was made cannot be the recorded one. */
const REUSE_SLACK_MS = 120_000;

/**
 * Whether a recorded process is positively gone, still here, or undecidable.
 * `recordedAt` is when THIS process was recorded (the owner's lease time, the
 * child's record time); null for a legacy record, which then gets no time rule.
 */
export function recordedProcessState(pid: unknown, recordedAt: number | null, probe: ProcessProbe, self = process.pid): "gone" | "present" | "unknown" {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unknown";
  if (pid === self) return "present";
  if (probe.presence === "gone") return "gone";
  if (probe.presence === "unknown") return "unknown";
  if (probe.createdAt !== null && recordedAt !== null && probe.createdAt > recordedAt + REUSE_SLACK_MS) return "gone";
  // A blank command line is unreadable, not foreign.
  if (probe.command === null || probe.command.trim() === "") return "unknown";
  return OURS.test(probe.command) ? "present" : "gone";
}

export type LeaseVerdict =
  /** Complete record, both processes positively gone: safe to reclaim. */
  | { kind: "stale"; nonce: string; reason: string }
  /** One of its processes is still here. */
  | { kind: "held"; reason: string }
  /** Missing, unreadable or incomplete record, or a probe that could not decide. */
  | { kind: "needs-recovery"; reason: string };

type OwnerRecord = { ownerPid: unknown; startNonce: unknown; startedAt: unknown; childPid: unknown; childRecordedAt?: unknown };

function readOwnerRecord(path: string): { record: OwnerRecord } | { missing: true } | { unreadable: true } {
  let raw: string;
  try { raw = readFileSync(join(path, "owner.json"), "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { unreadable: true };
    return { record: parsed as OwnerRecord };
  } catch {
    return { unreadable: true };
  }
}

/** Decide what an existing lease directory is. Reads and probes; changes nothing. */
export async function inspectGatewayLease(path: string, probe: ProbeProcess = probeProcess): Promise<LeaseVerdict> {
  const read = readOwnerRecord(path);
  if ("missing" in read) return { kind: "needs-recovery", reason: "the lease has no owner record; a Hearthside may still be writing it" };
  if ("unreadable" in read) return { kind: "needs-recovery", reason: "the lease's owner record can't be read" };
  const { record } = read;
  const nonce = typeof record.startNonce === "string" && record.startNonce ? record.startNonce : null;
  const validPid = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
  if (!nonce || !validPid(record.ownerPid)) return { kind: "needs-recovery", reason: "the lease's owner record is incomplete" };
  if (record.childPid === null || record.childPid === undefined) return { kind: "needs-recovery", reason: `Hearthside (process ${String(record.ownerPid)}) left no record of its gateway process` };
  if (!validPid(record.childPid)) return { kind: "needs-recovery", reason: "the lease's owner record is incomplete" };
  const startedAt = timeOrNull(record.startedAt);
  const owner = record.ownerPid as number;
  const child = record.childPid as number;
  const [ownerProbe, childProbe] = await Promise.all([probe(owner), probe(child)]);
  const states = [
    { what: "Hearthside", pid: owner, state: recordedProcessState(owner, startedAt, ownerProbe) },
    { what: "its gateway", pid: child, state: recordedProcessState(child, timeOrNull(record.childRecordedAt), childProbe) },
  ];
  const present = states.find((item) => item.state === "present");
  if (present) return { kind: "held", reason: `${present.what} (process ${present.pid}) is still running` };
  const unknown = states.find((item) => item.state === "unknown");
  if (unknown) return { kind: "needs-recovery", reason: `couldn't tell whether ${unknown.what} (process ${unknown.pid}) is still running` };
  return { kind: "stale", nonce, reason: `Hearthside (process ${owner}) and its gateway (process ${child}) have both exited` };
}

const QUARANTINE_KEEP = 3;
const quarantinePrefix = (path: string) => `${basename(path)}.stale-`;

/** Keep the newest few quarantined records as evidence; never follow links. */
function pruneQuarantine(path: string): void {
  const dir = dirname(path);
  const prefix = quarantinePrefix(path);
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().reverse(); } catch { return; }
  for (const name of names.slice(QUARANTINE_KEEP)) {
    const full = join(dir, name);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      rmSync(full, { recursive: true, force: true });
    } catch { /* Evidence that can't be removed is left; it never blocks recovery. */ }
  }
}

/** Another instance is inside the short section that moves a lease, or left its lock behind. */
export class GatewayLeaseRecoveryBusyError extends Error {
  constructor(lock: string, holder: string) {
    super(`Another Hearthside is recovering the channel service lease, or left its recovery lock behind (${lock}${holder ? `, ${holder}` : ""}). If no other Hearthside is running, remove that folder.`);
    this.name = "GatewayLeaseRecoveryBusyError";
  }
}

export const reclaimLockPath = (path: string) => `${path}.reclaim`;

/**
 * The only way a lease at `path` may be moved: holding `<path>.reclaim`, an
 * exclusive directory. A lease can disappear from `path` only by its owner's
 * release (the owner is gone, by premise) or by a reclaimer, and every
 * reclaimer takes this lock, so the record re-read inside the section is the
 * record the rename moves: no competitor can replace it meanwhile.
 *
 * The lock is never taken from another holder, however old: a holder may be
 * suspended, and elapsed time is not proof it is gone (a holder that resumed
 * after being "expired" would move a lease it no longer inspected). A lock a
 * crashed reclaimer left behind is reported, with its holder, for a person to
 * remove. Only the holder removes its lock, and only while it is still its own.
 */
export function withReclaimLock<T>(path: string, work: () => T): T {
  const lock = reclaimLockPath(path);
  const nonce = randomUUID();
  const record = join(lock, "owner.json");
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder = "";
    try {
      const existing = JSON.parse(readFileSync(record, "utf8")) as { pid?: unknown; at?: unknown };
      holder = `held by process ${String(existing.pid)} since ${String(existing.at)}`;
    } catch { /* an unreadable holder is still a holder */ }
    throw new GatewayLeaseRecoveryBusyError(lock, holder);
  }
  try { writeFileSync(record, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce }), { flag: "wx", mode: 0o600 }); } catch { /* the directory is the lock */ }
  try {
    return work();
  } finally {
    // Removed only when positively still ours: a lock replaced underneath us,
    // even by a holder that has not written its record yet, is left alone, and
    // so is our own lock when its record could not be written or read (it is
    // then reported, with no holder, for a person to remove).
    let mine = false;
    try { mine = (JSON.parse(readFileSync(record, "utf8")) as { nonce?: unknown }).nonce === nonce; } catch { mine = false; }
    if (mine) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Move a lease aside, inside the reclaim lock and only if the record at the
 * path is still the one that was inspected (its nonce; or, for `expectNonce`
 * null, still no readable record). A lease another instance took meanwhile is
 * never renamed. The post-move check is a last line of detection, not the
 * protocol.
 */
export function quarantineGatewayLease(path: string, expectNonce: string | null, now = new Date()): string {
  return withReclaimLock(path, () => {
    const sameRecord = (read: ReturnType<typeof readOwnerRecord>) =>
      expectNonce === null ? "missing" in read || "unreadable" in read : "record" in read && read.record.startNonce === expectNonce;
    if (!sameRecord(readOwnerRecord(path))) throw new Error(`Gateway ownership changed during recovery (${path}); refusing to move another owner's lease.`);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const target = join(dirname(path), `${quarantinePrefix(path)}${stamp}-${randomUUID().slice(0, 8)}`);
    renameSync(path, target);
    if (!sameRecord(readOwnerRecord(target))) {
      try { renameSync(target, path); } catch (error) {
        throw new Error(`Gateway ownership changed during recovery and could not be restored (${target}): ${String(error)}`);
      }
      throw new Error(`Gateway ownership changed during recovery (${path}); refusing to move another owner's lease.`);
    }
    pruneQuarantine(path);
    return target;
  });
}

/** A lease that exists and must not be reclaimed by itself. */
export class GatewayLeaseBlockedError extends Error {
  readonly verdict: Exclude<LeaseVerdict, { kind: "stale" }>;
  constructor(path: string, verdict: Exclude<LeaseVerdict, { kind: "stale" }>) {
    super(verdict.kind === "held"
      ? `Another Hearthside is running the channel service: ${verdict.reason}.`
      : `The channel service's last run left a lease that needs recovery: ${verdict.reason} (${path}).`);
    this.name = "GatewayLeaseBlockedError";
    this.verdict = verdict;
  }
}

export type LeaseAcquisition = { lease: GatewayLease; recovered: string | null };

/**
 * Move a demonstrably stale lease aside so a fresh one can be taken. Returns a
 * line for the log and the UI; throws GatewayLeaseBlockedError for anything
 * that must stay blocked. The caller takes the lease afterwards (and may still
 * lose that race to another instance, which then simply holds it).
 */
export async function reclaimStaleGatewayLease(path: string, probe: ProbeProcess = probeProcess, hooks: { beforeReclaim?: () => void } = {}): Promise<string> {
  const verdict = await inspectGatewayLease(path, probe);
  if (verdict.kind !== "stale") throw new GatewayLeaseBlockedError(path, verdict);
  hooks.beforeReclaim?.();
  const moved = quarantineGatewayLease(path, verdict.nonce);
  return `${verdict.reason}; the old record was moved to ${basename(moved)}`;
}

/** Take the lease, reclaiming it first when a complete record is demonstrably stale. */
export async function acquireOrRecoverGatewayLease(path: string, probe: ProbeProcess = probeProcess, hooks: { beforeReclaim?: () => void } = {}): Promise<LeaseAcquisition> {
  try {
    return { lease: acquireGatewayLease(path), recovered: null };
  } catch (error) {
    if (!(error instanceof GatewayLeaseHeldError)) throw error;
  }
  const recovered = await reclaimStaleGatewayLease(path, probe, hooks);
  return { lease: acquireGatewayLease(path), recovered };
}

/**
 * One process as the OS lists it. `name` is the executable's file name (always
 * reported); `command` is the full command line, null when it could not be read
 * (on Windows, other users' and protected processes).
 */
export type ProcessEntry = { pid: number; ppid: number | null; name: string | null; command: string | null };
/** Every process on this computer, or null when that could not be established. */
export type EnumerateProcesses = () => Promise<ProcessEntry[] | null>;

export async function enumerateProcesses(): Promise<ProcessEntry[] | null> {
  if (process.platform === "win32") {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"]);
    if (!out) return null;
    try {
      const parsed = JSON.parse(out) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row) => {
        const item = row as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
        return typeof item.ProcessId === "number"
          ? [{ pid: item.ProcessId, ppid: typeof item.ParentProcessId === "number" ? item.ParentProcessId : null, name: blankToNull(item.Name), command: blankToNull(item.CommandLine) }]
          : [];
      });
    } catch {
      return null;
    }
  }
  const out = await run("ps", ["-eo", "pid=,ppid=,command="]);
  if (!out) return null;
  const rows: ProcessEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = blankToNull(match[3]);
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: command ? executableName(command) : null, command });
  }
  return rows;
}

/** The executable a command line starts with, without quotes or directory. */
function executableName(command: string): string {
  const trimmed = command.trim();
  const quoted = /^"([^"]*)"/.exec(trimmed) ?? /^'([^']*)'/.exec(trimmed);
  const first = quoted ? quoted[1] ?? "" : trimmed.split(/\s+/)[0] ?? "";
  return basename(first).toLowerCase();
}

/** Executables that can be the app or its gateway: the packaged app, a development Electron, or Node running letta.js. */
const OWNER_EXECUTABLE = /^(hearthside|electron|node)(\.exe)?$|^hearthside helper/;

/**
 * Sort the computer's processes into those that could own or be the channel
 * service and those that could not be told apart.
 *
 * - A channel gateway (its command line names channel-gateway) is an owner even
 *   when it is this app's child: a child that survived a failed termination is
 *   exactly what recovery must not race.
 * - This app itself, its helpers (--type=…) and its other children are not
 *   another owner.
 * - A Hearthside / Electron main process is an owner, told by executable, never
 *   by words in a path.
 * - A process whose command line could not be read is unknown when its
 *   executable is one that could be ours (or is itself unknown); known
 *   unrelated executables (svchost.exe, System, …) are not.
 */
export function classifyProcesses(processes: ProcessEntry[], self = process.pid): { owners: ProcessEntry[]; unknown: ProcessEntry[] } {
  const owners: ProcessEntry[] = [];
  const unknown: ProcessEntry[] = [];
  for (const entry of processes) {
    if (entry.pid === self) continue;
    const name = (entry.name ?? (entry.command ? executableName(entry.command) : null))?.toLowerCase() ?? null;
    if (entry.command === null) {
      if (name === null || OWNER_EXECUTABLE.test(name)) unknown.push(entry);
      continue;
    }
    if (/channel-gateway/.test(entry.command)) { owners.push(entry); continue; }
    if (entry.ppid === self || /--type=/.test(entry.command)) continue;
    // The enumerator's own executable name, when it gives one: a Windows path in a
    // command line is not split by basename on another platform.
    if (name !== null && /^(hearthside|electron)(\.exe)?$/.test(name)) owners.push(entry);
  }
  return { owners, unknown };
}

/** Processes that could own or be the channel service, other than this app and what it spawned. */
export function otherServiceOwners(processes: ProcessEntry[], self = process.pid): ProcessEntry[] {
  return classifyProcesses(processes, self).owners;
}

/**
 * A person's decision for a lease that recovery refused by itself: move it aside
 * when nothing that could own it is running. A held lease is still refused. An
 * incomplete, missing or undecided record is moved only when the processes of
 * this computer could be listed and none of them, other than this app and its
 * children, is a gateway or a Hearthside; a recorded owner must also be
 * positively gone.
 */
export async function recoverGatewayLease(path: string, probe: ProbeProcess = probeProcess, enumerate: EnumerateProcesses = enumerateProcesses, hooks: { beforeMove?: () => void } = {}): Promise<string> {
  const verdict = await inspectGatewayLease(path, probe);
  if (verdict.kind === "held") throw new GatewayLeaseBlockedError(path, verdict);
  if (verdict.kind === "stale") {
    hooks.beforeMove?.();
    return quarantineGatewayLease(path, verdict.nonce);
  }
  const processes = await enumerate();
  if (processes === null) throw new Error("Couldn't list the processes on this computer, so it can't be shown that nothing owns the channel service. Recovery refused.");
  const { owners, unknown } = classifyProcesses(processes);
  if (owners.length) throw new Error(`Something that could own the channel service is still running (process ${owners.map((entry) => entry.pid).join(", ")}). Close it first.`);
  if (unknown.length) throw new Error(`Couldn't identify ${unknown.length === 1 ? "a process" : `${unknown.length} processes`} that could be the channel service (process ${unknown.map((entry) => `${entry.pid}${entry.name ? ` ${entry.name}` : ""}`).join(", ")}). Recovery refused.`);
  const read = readOwnerRecord(path);
  const owner = "record" in read ? read.record.ownerPid : null;
  if (typeof owner === "number" && Number.isInteger(owner) && owner > 0) {
    const state = recordedProcessState(owner, "record" in read ? timeOrNull(read.record.startedAt) : null, await probe(owner));
    if (state !== "gone") throw new Error(`Hearthside (process ${owner}) may still be running. Close it first.`);
  }
  hooks.beforeMove?.();
  const nonce = "record" in read && typeof read.record.startNonce === "string" ? read.record.startNonce : null;
  return quarantineGatewayLease(path, "record" in read ? nonce : null);
}

/** Signal delivery (including tree-kill's callback) is not evidence of exit. */
export function terminateGateway(proc: ChildProcess, termMs = 3_000, killMs = 3_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const exited = () => { clearTimeout(timer); proc.removeListener("exit", exited); resolve(); };
    proc.once("exit", exited);
    const signal = (name: string) => {
      try { treeKill(proc.pid!, name, () => { /* Wait for the owned ChildProcess exit, not a PID probe. */ }); } catch { /* Escalate, then report failure if exit is never observed. */ }
    };
    timer = setTimeout(() => {
      timer = setTimeout(() => {
        proc.removeListener("exit", exited);
        reject(new Error("Channel gateway did not exit after TERM/KILL; shutdown and replacement are blocked."));
      }, killMs);
      signal("SIGKILL");
    }, termMs);
    signal("SIGTERM");
  });
}
