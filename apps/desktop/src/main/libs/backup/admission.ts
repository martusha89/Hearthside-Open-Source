const recoveryOperations = new Set([
  "restoreBackupCopy", "previewRecoveryHandover", "confirmRecoveryHandover",
  "rollbackRecoveryHandover", "confirmManualRecoveryCopy",
]);
// Explicitly reviewed observers: a read-like name is not proof of a read-only API.
// In particular listChatHelpers settles state, checkForUpdates starts an updater,
// and getSandboxLink may provision a sandbox.
const observers = new Set([
  "getSettings", "getConnection", "listAgents", "getAgent", "getLooks",
  "getBackupSettings", "listBackups", "verifyBackup", "listBackupCompanions",
  "previewBackupRestore", "getRecoveryReceipt", "getRecoveryHandover", "previewManualRecoveryCopy",
  // Reads the receipts and handover journals kept on this computer; changes nothing.
  "listRecoveryCopies",
  "listModels", "listProviders", "listMemory", "readMemoryFile", "listMemoryHistory",
  // Reads ChatGPT's usage and lists resets; spending one (useGptReset) is a
  // change to the person's plan and stays behind the lock.
  "getGptUsage",
  "readMemoryFileAt", "listMemoryActivity", "readMemoryCommitDiff", "listConversations",
  "loadHistory", "latestMessageMark", "listArchivedConversations", "getDreamSettings",
  "searchMessages", "listDirectory", "readWorkingFile", "listSecretNames", "listConnectors",
  "listConnectorVoices", "listConnectorImports", "readAudioFile", "listGifs", "imageEngineStatus",
  // Asks the Codex CLI whether it is signed in; installing it or signing in
  // (startImageSetup) writes, so that one stays behind the lock.
  "imageConnectStatus",
  "listCalendar", "listCalendarSubscriptions", "calendarAccess", "readImageFile", "getDiagnostics",
  "getComputerStatus", "getChannelServiceStatus", "getToolset", "listChannels", "listChannelAccounts", "listPairings",
  "listMutedChannels", "listChannelRoutes", "listSchedules", "listScheduleRuns", "checkPrograms",
  "listSkills", "listSkillCatalog", "getUpdateReady", "getAppVersion",
  // The connection check reads and counts; it writes, sends and schedules
  // nothing (capture-diagnostic.ts). Holding the mutation lock for the length
  // of a scan would tell someone to "wait for the current change" when no
  // change is happening. Its cancel is a cancel, like stopTurn above.
  "runCaptureDiagnostic", "cancelCaptureDiagnostic",
]);
/** Recovery operations take their own lock; observers and cancellation remain usable. */
export function bypassRecoveryMutationLock(name: string, args: readonly unknown[] = []): boolean {
  if (recoveryOperations.has(name) || name === "stopTurn" || name === "cancelProviderSignIn" || name === "cancelLettaSignIn" || name === "cancelImageSetup") return true;
  if (name === "respondApproval") {
    const decision = args[2];
    return !!decision && typeof decision === "object" && "behavior" in decision && decision.behavior === "deny";
  }
  return observers.has(name);
}
