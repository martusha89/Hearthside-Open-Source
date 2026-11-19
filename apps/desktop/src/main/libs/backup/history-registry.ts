import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { syncRecoveryDirectory } from "./durable-io";



type Registry = { version: 1; agents: Record<string, string[]> };
export type HistoryEvidence = () => Array<{ agentId: string; conversationIds: string[] }>;
const HISTORY_ARCHIVE_ID = /^history-[a-f0-9]{24}$/;

export class HistoryRegistryUnavailable extends Error {
  constructor(reason: string) {
    super(`The record of read-only history chats can't be read (${reason}), so nothing is sent until it can. Restart Hearthside; if this keeps happening, restore from a backup again.`);
    this.name = "HistoryRegistryUnavailable";
  }
}

let path: string | null = null;
let evidence: HistoryEvidence | null = null;
let cache: Registry | null = null;
let unavailable: string | null = null;

export function configureHistoryRegistry(file: string, receipts?: HistoryEvidence): void {
  path = file; evidence = receipts ?? null; cache = null; unavailable = null;
}

function valid(value: unknown): value is Registry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const registry = value as Registry;
  if (registry.version !== 1 || !registry.agents || typeof registry.agents !== "object" || Array.isArray(registry.agents)) return false;
  return Object.entries(registry.agents).every(([agent, ids]) => typeof agent === "string" && agent.length > 0 && Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0));
}

/** The receipts' own mappings, merged into one registry. Throws when they can't be read. */
function fromEvidence(): Registry {
  const agents: Record<string, string[]> = {};
  for (const item of evidence ? evidence() : []) {
    if (!item.conversationIds.length) continue;
    agents[item.agentId] = [...new Set([...(agents[item.agentId] ?? []), ...item.conversationIds])];
  }
  return { version: 1, agents };
}

function load(): Registry {

  if (unavailable) throw new HistoryRegistryUnavailable(unavailable);
  if (cache) return cache;
  if (!path) return (cache = { version: 1, agents: {} });
  let problem: string | null = null;
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (valid(parsed)) {
        // Anything the receipts know and the file lost is put back, never the other way round.
        let merged = parsed;
        try {
          const rebuilt = fromEvidence();
          merged = { version: 1, agents: { ...parsed.agents } };
          for (const [agent, ids] of Object.entries(rebuilt.agents)) merged.agents[agent] = [...new Set([...(merged.agents[agent] ?? []), ...ids])];
        } catch { /* the file alone is valid authority */ }
        return (cache = merged);
      }
      problem = "it doesn't have the expected shape";
    } catch (error) {
      problem = error instanceof SyntaxError ? "it isn't valid JSON" : "it couldn't be read";
    }
  }
  // Missing, or present but unusable: rebuild from the receipts, or refuse.
  // Published only once it is durable (save sets the cache last).
  try {
    const rebuilt = fromEvidence();
    if (problem || Object.keys(rebuilt.agents).length) save(rebuilt);
    else cache = rebuilt;
    return rebuilt;
  } catch {
    cache = null;
    unavailable = problem ?? "the recovery receipts couldn't be read or the repaired record couldn't be saved";
    throw new HistoryRegistryUnavailable(unavailable);
  }
}

function save(registry: Registry): void {
  if (!path) throw new Error("History registry is not configured.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(registry)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncRecoveryDirectory(dirname(path));
  cache = registry;
}

/** From a completed restore's mappings: conversations whose archive ID is a generated history volume. */
export function historyVolumesFromMappings(mappings: ReadonlyArray<{ kind: string; originalId: string; destinationId: string }>): string[] {
  return mappings.filter((mapping) => mapping.kind === "conversation" && HISTORY_ARCHIVE_ID.test(mapping.originalId)).map((mapping) => mapping.destinationId);
}

/** Durable before it returns; throws (so the caller publishes no receipt) if it can't be. */
export function recordHistoryVolumes(agentId: string, conversationIds: string[]): void {
  if (!conversationIds.length) return;
  const registry = load();
  const known = new Set(registry.agents[agentId] ?? []);
  for (const id of conversationIds) known.add(id);
  save({ version: 1, agents: { ...registry.agents, [agentId]: [...known] } });
}

/** Throws HistoryRegistryUnavailable rather than answer "no" when the record can't be trusted. */
export function isRecordedHistoryVolume(conversationId: string): boolean {
  return Object.values(load().agents).some((ids) => ids.includes(conversationId));
}
