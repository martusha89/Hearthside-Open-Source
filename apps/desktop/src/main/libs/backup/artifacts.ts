import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Letta from "@letta-ai/letta-client";
import { resolveLettaCli } from "../../runtime/paths";
import { getConnectionConfig } from "../settings";
import { currentLettaAccessToken } from "../letta-signin";
import { agentBusy } from "../runtime";
import { captureNativeState } from "./native-state";
import { AgentFileCaptureError, agentFileCaptureFailure, captureAgentFile } from "./cloud-agent-file";
import { captureArchivalPassages } from "./archival";
import { backupSourceFailure } from "./diagnostics";
import type { SourceConversation } from "./collect";
import { CLOUD_PAGE_DEADLINE_MS, cloudDeadline } from "./cloud-deadline";

export type RecoveryArtifact = { path: string; kind: string; bytes?: Buffer; error?: string };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** Read-only capture. Never create a session or send a message to obtain state. */
/** Consecutive "not found" context exports, with none succeeding, before the rest are skipped. */
export const NOT_FOUND_BEFORE_STOP = 3;

export async function captureRecoveryArtifacts(agentId: string, memoryDir: string | null, conversations: SourceConversation[]): Promise<RecoveryArtifact[]> {
  const config = getConnectionConfig();
  if (config.backend === "local") {
    if (!memoryDir) return [{ path: "native-state/manifest.json", kind: "native-state", error: "The native source directory is unavailable." }];
    try {
      const runtimeVersion = JSON.parse(readFileSync(join(dirname(resolveLettaCli()), "package.json"), "utf8")).version as string;
      const archive = await captureNativeState({
        storageDir: dirname(dirname(dirname(memoryDir))), agentId, runtimeVersion,
        assertQuiescent: () => { if (agentBusy(agentId)) throw new Error("Wait for the companion's active turn before capturing native state."); },
      });
      const files = archive.files.map((file) => ({ path: file.path, artifactPath: `native-state/files/${Buffer.from(file.path).toString("base64url")}` }));
      return [
        { path: "native-state/manifest.json", kind: "native-state", bytes: json({ version: archive.version, runtimeVersion: archive.runtimeVersion, sourceAgentId: archive.sourceAgentId, files }) },
        ...archive.files.map((file, index) => ({ path: files[index]!.artifactPath, kind: "native-state-file", bytes: file.bytes })),
      ];
    } catch (error) {
      return [{ path: "native-state/manifest.json", kind: "native-state", error: error instanceof Error ? error.message : "Native state capture failed." }];
    }
  }
  if (config.backend !== "cloud") return [{ path: "native-state/manifest.json", kind: "native-state", error: "This remote runtime exposes no native-state export. Capture native state on its owning computer; projected history alone cannot reconstruct it losslessly." }];
  const token = await currentLettaAccessToken() || (config.lettaSignedIn ? "" : config.apiKey) /* signed in: never quietly swap to the saved key */;
  if (!token) return [{ path: "agent-files/main.af", kind: "agent-file", error: "Cloud credentials are unavailable for a raw context export." }];
  const client = new Letta({ apiKey: token, baseURL: config.apiBaseUrl || "https://api.letta.com", maxRetries: 0, timeout: 30_000 });
  const artifacts: RecoveryArtifact[] = [];
  try {
    // Each page is bounded through its body (cloud-deadline.ts).
    const bytes = await captureArchivalPassages(query => client.agents.passages.list(agentId, query, cloudDeadline(CLOUD_PAGE_DEADLINE_MS)));
    artifacts.push({ path: "archival/passages.json", kind: "archival-passages", bytes });
  } catch (error) {
    // Say which way it failed. The classified message carries only this build's own
    // words, the closed failure code and a clamped HTTP status; no request details.
    artifacts.push({ path: "archival/passages.json", kind: "archival-passages", error: `${backupSourceFailure(error, { operation: "passages.list" }).message} No partial archive is claimed.` });
  }
  const targets = [{ name: "main", id: undefined as string | undefined }, ...conversations.filter((c) => !c.main && !c.id.startsWith("main:")).map((c) => ({ name: Buffer.from(c.id).toString("base64url"), id: c.id }))];

  let exported = 0;
  const notFound: { path: string; error: unknown }[] = [];
  let skipped = 0;
  for (const [index, target] of targets.entries()) {
    if (exported === 0 && notFound.length >= NOT_FOUND_BEFORE_STOP) { skipped = targets.length - index; break; }
    const path = `agent-files/${target.name}.af`;
    try {
      const captured = await captureAgentFile(client, agentId, target.id);
      artifacts.push({ path, kind: "agent-file", bytes: captured.bytes });
      artifacts.push({ path: `agent-files/${target.name}.provenance.json`, kind: "agent-file-provenance", bytes: json(captured.manifest) });
      exported++;
    } catch (error) {
      // The service has no export at all: one line, and no point asking for the other chats.
      if (error instanceof AgentFileCaptureError && error.category === "unsupported") {
        artifacts.push({ path, kind: "agent-file", error: agentFileCaptureFailure(error) });
        break;
      }
      if (error instanceof AgentFileCaptureError && error.category === "not-found") notFound.push({ path, error });
      else artifacts.push({ path, kind: "agent-file", error: agentFileCaptureFailure(error) });
    }
  }
  if (notFound.length === 1 && skipped === 0) artifacts.push({ path: notFound[0]!.path, kind: "agent-file", error: agentFileCaptureFailure(notFound[0]!.error) });
  else if (notFound.length > 1) {
    const chats = (n: number) => `${n.toLocaleString("en-GB")} ${n === 1 ? "chat" : "chats"}`;
    artifacts.push({
      path: notFound[0]!.path,
      kind: "agent-file",
      error: `${agentFileCaptureFailure(notFound[0]!.error)} The same answer came for ${chats(notFound.length - 1)} more${skipped ? `, so the remaining ${chats(skipped)} weren't asked` : ""}. Their messages are in this backup.`,
    });
  }
  return artifacts;
}
