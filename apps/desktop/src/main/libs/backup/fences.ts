import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { syncRecoveryDirectory } from "./durable-io";

type Fences = Record<string, { since: string; mode?: "locked" | "manual-only" }>;
function path(): string { return join(app.getPath("userData"), "recovery-fences.json"); }
function load(): Fences {
  try {
    const value: unknown = JSON.parse(readFileSync(path(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery fences");
    for (const entry of Object.values(value)) if (!entry || typeof entry !== "object" || typeof entry.since !== "string" || (entry.mode !== undefined && !["locked", "manual-only"].includes(entry.mode))) throw new Error("Invalid recovery fence entry");
    return value as Fences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Recovery admission state cannot be read; refusing to start a turn.");
  }
}
function save(value: Fences): void {
  const destination = path();
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
  syncRecoveryDirectory(dirname(destination));
}
export function fenceAgentForRecovery(agentId: string): void {
  if (!agentId || ["__proto__", "constructor", "prototype"].includes(agentId)) throw new Error("Invalid recovery agent ID");
  const fences = load();
  if (!Object.hasOwn(fences, agentId) || fences[agentId]!.mode === "manual-only") { fences[agentId] = { since: new Date().toISOString(), mode: "locked" }; save(fences); }
}
export function unfenceAgentForRecovery(agentId: string): void {
  const fences = load();
  if (Object.hasOwn(fences, agentId)) { delete fences[agentId]; save(fences); }
}
export function allowManualRecovery(agentId: string): void {
  const fences = load();
  if (!Object.hasOwn(fences, agentId)) throw new Error("This is not a fenced recovery copy.");
  fences[agentId] = { since: fences[agentId]!.since, mode: "manual-only" }; save(fences);
}
export function isManualOnlyRecovery(agentId: string): boolean { return load()[agentId]?.mode === "manual-only"; }
export function isAgentRecoveryFenced(agentId: string): boolean { const f = load(); return Object.hasOwn(f, agentId) && f[agentId]!.mode !== "manual-only"; }
export function assertRecoveryAutomationAdmission(agentId: string): void {
  if (Object.hasOwn(load(), agentId)) throw new Error("Automatic turns are disabled for this recovery copy.");
}
export function assertRecoveryAdmission(agentId: string): void {
  if (isAgentRecoveryFenced(agentId)) throw new Error("This companion is fenced for recovery. Use the recovery handover or rollback controls before starting work.");
}
