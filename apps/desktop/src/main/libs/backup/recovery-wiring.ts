import { homedir } from "node:os";
import { resolveLettaCli, resolveRuntimeHome } from "../../runtime/paths";
import { agentBusy, allowManualRecovery, isManualOnlyRecovery, listConversations, listArchivedConversations, recoveryHasActiveTurns, withLocalRecoveryRuntimeStopped } from "../runtime";
import { request, runtimeIdle } from "../control";
import { currentLettaAccessToken } from "../letta-signin";
import { connectionKey, getConnectionConfig, setAgentId } from "../settings";
import { captureSourceSnapshot } from "./backup";
import { captureChannelInventory } from "./channel-inventory";
import { createAppCutoverHooks } from "./cutover-app-hooks";
import { configureLocalRecovery, configureManualRecovery, configureRecoveryHandover, recoveryConnectionIdentity } from "./recovery";
import { readLocalRecoveryCopy } from "./restore-local";
import { readCloudRecoveryCopy } from "./restore-cloud";
import type { RecoveryReceipt } from "./receipts";

/** Fresh destination reads also work after restart and without the original backup. */
export async function readRecoveryTarget(receipt: RecoveryReceipt) {
  if (receipt.targetConnectionIdentity !== recoveryConnectionIdentity() || receipt.target.connection !== connectionKey()) throw new Error("The recovery copy belongs to a different connection or account.");
  const config = getConnectionConfig();
  if (config.backend === "local") {
    return readLocalRecoveryCopy({ agentId: receipt.target.agentId, runtimeHome: resolveRuntimeHome().home ?? homedir(), assertQuiescent: () => {
      if (agentBusy(receipt.target.agentId)) throw new Error("The recovery copy is working; wait before verifying it.");
    } });
  }
  if (config.backend !== "cloud") throw new Error("This destination has no verified recovery readback adapter.");
  const token = await currentLettaAccessToken() || (config.lettaSignedIn ? "" : config.apiKey) /* signed in: never quietly swap to the saved key */;
  if (!token) throw new Error("Sign in to the recovery copy's Cloud account first.");
  const shared = receipt.mappings.filter((m) => m.kind === "repository").map((m) => {
    if (!m.destinationName) throw new Error("Recovery repository mapping is incomplete.");
    return { id: m.destinationId, name: m.destinationName };
  });
  return readCloudRecoveryCopy({ agentId: receipt.target.agentId, baseUrl: config.apiBaseUrl || "https://api.letta.com", token, connectionIdentity: receipt.targetConnectionIdentity, shared });
}

async function targetIdle(agentId: string): Promise<boolean> {
  if (agentBusy(agentId)) return false;
  const chats = [...await listConversations(agentId), ...await listArchivedConversations(agentId)];
  const ids = new Set(chats.map((c) => c.main || c.id.startsWith("main:") ? "default" : c.id));
  for (const conversation_id of ids) if (!await runtimeIdle({ agent_id: agentId, conversation_id })) return false;
  return !agentBusy(agentId);
}
async function automationOff(agentId: string): Promise<boolean> {
  const cron = await request<{ type: string; tasks?: Array<Record<string, unknown>> }>("cron_list", { agent_id: agentId });
  if (!Array.isArray(cron.tasks)) throw new Error("Schedule inventory is unavailable.");
  if (cron.tasks.some((task) => !["paused", "completed", "cancelled"].includes(String(task.status)))) return false;
  const channels = await captureChannelInventory(agentId);
  // Standalone opening never transfers a bot account or enables an old route.
  return channels.bots.every((bot) => bot.running === false) && channels.routes.every((route) => route.enabled === false);
}

/** Main-process-only configuration; renderer data cannot supply any of these hooks. */
export function initRecovery(): void {
  configureLocalRecovery(() => ({ nativeRuntime: {
    cliPath: resolveLettaCli(), withStoppedRuntime: withLocalRecoveryRuntimeStopped,
    assertQuiescent: () => { if (recoveryHasActiveTurns()) throw new Error("Wait for all active turns before native recovery."); },
  } }));
  configureRecoveryHandover(createAppCutoverHooks({
    sourceSnapshot: (receipt) => captureSourceSnapshot(receipt.source.agentId),
    targetReadback: readRecoveryTarget,
  }));
  configureManualRecovery({
    async inspect(receipt) {
      const idle = await targetIdle(receipt.target.agentId);
      const off = await automationOff(receipt.target.agentId);
      return { readback: await readRecoveryTarget(receipt), targetIdle: idle, automationOff: off, manualOnly: isManualOnlyRecovery(receipt.target.agentId), blockers: [] };
    },
    async open(receipt) {
      allowManualRecovery(receipt.target.agentId);
      setAgentId(receipt.target.agentId);
    },
  });
}
