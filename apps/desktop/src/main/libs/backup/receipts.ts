import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncRecoveryDirectory } from "./durable-io";
import type { ContextCoverage, UnrestoredPart, RestoreMapping } from "./restore";
import type { SnapshotEntry } from "./store";
import type { CutoverReceipt } from "./cutover";

export type RecoveryArtifact = { path: string; hash: string; size: number };
export type RecoveryReadback = { fingerprint: string; dataMark: string; artifacts: RecoveryArtifact[] };
export type RecoveryReceipt = CutoverReceipt & {
  version: 1; createdAt: string; storeId: string; snapshotId: string;
  sourceConnectionIdentity: string | null; targetConnectionIdentity: string;
  contextCoverage: ContextCoverage; omissions: string[]; unrestoredParts: UnrestoredPart[];
  /** Destination references and hashes; never dependent on the source store remaining available. */
  artifacts: RecoveryArtifact[];
  mappings: RestoreMapping[];
};
const digest = /^[a-f0-9]{64}$/;
/** Only capture-time observations are excluded. All data/configuration artifacts remain covered. */
export function snapshotDataFingerprint(entries: SnapshotEntry[], readObject?: (hash: string) => Buffer): string {
  const stable = entries.filter(e => !["capture.json", "capture-observation.json"].includes(e.path))
    .map(e => {
      // Observation timestamps are embedded in extras; retain all actual extras inventory.
      if (e.path === "extras.json" && readObject) {
        const data = JSON.parse(readObject(e.hash).toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid source extras inventory");
        delete data.captureObservations;
        const bytes = Buffer.from(JSON.stringify(data));
        return { path: e.path, hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, kind: e.kind };
      }
      return { path: e.path, hash: e.hash, size: e.size, kind: e.kind };
    }).sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
export function assertRecoveryReadback(value: RecoveryReadback): void {
  if (!value || !digest.test(value.fingerprint) || !digest.test(value.dataMark) || !Array.isArray(value.artifacts) || !value.artifacts.length) throw new Error("Recovery readback evidence is incomplete");
  const paths = new Set<string>();
  for (const a of value.artifacts) {
    if (!a || typeof a.path !== "string" || !a.path || a.path.startsWith("/") || a.path.includes("\\") || a.path.split("/").some(x => x === ".." || x === ".") || paths.has(a.path) || !digest.test(a.hash) || !Number.isSafeInteger(a.size) || a.size < 0) throw new Error("Invalid recovery readback artifact");
    paths.add(a.path);
  }
}
export function createRecoveryReceiptStore(directory: string) {
  function path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid recovery receipt ID"); return join(directory, `${id}.json`); }
  function validate(r: RecoveryReceipt) {
    if (r.version !== 1 || r.verified !== true || !digest.test(r.snapshotIdentity) || !digest.test(r.sourceFingerprint) || !digest.test(r.targetConnectionIdentity) || (r.sourceConnectionIdentity !== null && !digest.test(r.sourceConnectionIdentity)) || !r.source?.agentId || !r.target?.agentId) throw new Error("Invalid recovery receipt");
    assertRecoveryReadback({ fingerprint: r.targetFingerprint, dataMark: r.targetDataMark, artifacts: r.artifacts });
  }
  return {
    save(input: Omit<RecoveryReceipt, "id" | "version" | "createdAt" | "verified">): RecoveryReceipt {
      const r: RecoveryReceipt = { ...input, id: randomUUID(), version: 1, createdAt: new Date().toISOString(), verified: true };
      validate(r);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(r.id), temp = `${destination}.${randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(r)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, destination);
      syncRecoveryDirectory(directory);
      return r;
    },
    get(id: string): RecoveryReceipt {
      const r = JSON.parse(readFileSync(path(id), "utf8")) as RecoveryReceipt;
      validate(r); if (r.id !== id) throw new Error("Recovery receipt identity mismatch"); return r;
    },
  };
}
