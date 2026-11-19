// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { type AppEvent, type AppRequests, isRequestName, parseRequestArgs } from "@hearthside/ipc-contract";
import {
  adoptConnectedModels,
  assertNoReplyRunning,
  agentBusy,
  assertExecutionTargetIdle,
  assertConversationDesktopAccess,
  assertWritableConversation,
  getConversationExecution,
  conversationAgent,
  setConversationExecution,
  listExecutionPlaces,
  moveConversation,
  applyPermissionMode,
  archiveConversation,
  listArchivedConversations,
  restoreConversation,
  createAgent,
  deleteAgent,
  disconnect,
  getAgent,
  restoreCompanionPrompt,
  getConnection,
  listAgents,
  listConversations,
  listConversationPreviews,
  loadHistory,
  latestMessageMark,
  sandboxLinkAccess,
  settleHelpers,
  reconnect,
  renameConversation,
  respondApproval,
  sendMessageForIpc,
  stopTurn,
  updateAgent,
  setConversationContextWindow,
  runCommand,
  listChatCommands,
  listHistory,
  runChatCommand,
  reloadMods,
  forkConversation,
  conversationMarkdown,
} from "./libs/runtime.js";
import { getModsOverview, importContext, modsOffState, readModSource, setModsOffSetting } from "./libs/mods/service";
import { confirmModImport, previewModFile } from "./libs/mods/import";
import { searchMessages } from "./libs/chat-tools";
import { listSecretNames, removeSecret, setSecret } from "./libs/secrets";
import {
  importConnectors,
  listConnectors,
  listImports as listConnectorImports,
  readAudioFile,
  removeConnector,
  saveConnector,
  setConnectorAgents,
  setLettaToolAttached,
  setConnectorTools,
  setConnectorVoice,
  setConnectorVoiceModel,
  listConnectorVoices,
  signInConnector,
  signOutConnector,
  testConnector,
  testConnectorInput,
  addConnectorsFromJson,
} from "./libs/connectors";
import { getDiagnostics } from "./libs/diagnostics";
import { listDirectory, readWorkingFile } from "./libs/files";
import { logFilePath } from "./libs/log-file";
import { backupLettaHome } from "./libs/letta-home";
import { setUseRealLettaHome } from "./runtime/paths";
import { setRuntimeDebugLog } from "./runtime/child-env";
import { join } from "node:path";
import { dirname as pathDirname } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import {
  deleteMemoryFile,
  listMemory,
  listMemoryHistory,
  readMemoryFile,
  readMemoryFileAt,
  writeMemoryFile,
  listMemoryActivity,
  readMemoryCommitDiff,
} from "./libs/memory.js";
import { connectProvider, disconnectProvider, listModels, listProviders } from "./libs/providers.js";
import { getGptUsage, useGptReset } from "./libs/gpt-usage.js";
import { getSettings, getThemePreference, gifCustomerId, updateSettings } from "./libs/settings.js";
import { getChatPreferences, setChatPreference } from "./libs/chat-preferences.js";
import { fetchGif, listGifs } from "./libs/gifs";
import { engineStatus, readImageFile } from "./libs/image-gen";
import { cancelImageSetup, imageConnectStatus, startImageSetup } from "./libs/image-setup";
import { checkLocalPath } from "./libs/local-media";
import {
  addSubscription,
  calendarAccess,
  deleteEvent,
  listOccurrences,
  listSubscriptions,
  refreshSubscription,
  removeSubscription,
  saveEvent,
  setCalendarAccess,
} from "./libs/calendar";
import { listMutedChannels, setDiscordChannelListening } from "./libs/channel-chat-mode";
import { applyLoginItem } from "./libs/login-item";
import { checkForUpdatesNow, installUpdate, ReplyRunningError, updateReady } from "./libs/updater";
import { cancelUpdateQuit, prepareUpdateQuit } from "./libs/quit";
import { shutdownForQuit } from "./libs/shutdown";
import { previewHistoryImport, runHistoryImport } from "./libs/history-import";
import { historyCloudAccess } from "./libs/history-cloud";
import { nativeTheme } from "electron";
import { getDreamSettings, setDreamSettings } from "./libs/dreams";
import { clearLookImage, forgetLook, getLooks, setLookImage, setLookStyle } from "./libs/looks";
import { adoptBackupFolder, backUpNow, cancelCaptureDiagnostic, getBackupSettingsInfo, listBackups, newBackupRecoveryCode, runCaptureDiagnostic, unlockBackupFolder, verifyBackup } from "./libs/backup/backup";
import { assertRecoveryIdle, withRecoveryMutation, listBackupCompanions, previewBackupRestore, restoreBackupCopy, getRecoveryReceipt, listRecoveryCopies, previewRecoveryHandover, confirmRecoveryHandover, rollbackRecoveryHandover, getRecoveryHandover, previewManualRecoveryCopy, confirmManualRecoveryCopy } from "./libs/backup/recovery";
import { bypassRecoveryMutationLock } from "./libs/backup/admission";
import { updateBackupSettings } from "./libs/settings";
import { helpersFor } from "./libs/helper-feed";
import { openFileLink } from "./libs/open-file-link";
import { executionTarget, listExecutionComputers } from "./libs/remote-execution";
import { cancelLettaSignIn, signInWithLetta, signOutOfLetta } from "./libs/letta-signin";
import { getToolset, setToolset } from "./libs/toolset";
import { checkPrograms, installSkill, listCatalog, listSkills, removeSkill } from "./libs/skills";
import {
  approvePairing,
  claimChannelBot,
  declinePairing,
  previewChannelBotReassign,
  reassignChannelBot,
  resumeChannelBotMove,
  setChannelAccess,
  setDiscordCompanionParticipation,
  setChannelChatMode,
  listChannelAccounts,
  listChannelRoutes,
  listChannels,
  listPairings,
  removeChannelAccount,
  removeChannelRoute,
  setChannelAccountRunning,
  setupChannel,
} from "./libs/channels";
import { channelServiceStatus, recoverChannelService } from "./libs/channel-gateway";
import { addSchedule, deleteSchedule, listScheduleRuns, listSchedules, runScheduleNow, setSchedulePaused, updateSchedule } from "./libs/schedules";
import { answerProviderSignIn, cancelAllProviderSignIns, cancelProviderSignIn, startProviderSignIn } from "./libs/provider-signin";
import { describeError } from "./libs/transcript.js";
import { validateEventFrame } from "./util.js";
import { applyComputerAccess } from "./libs/computer-access";
import { computerStatus } from "./libs/computer-listener";
import { downloadFromSandbox, sandboxDesktopUrl } from "./libs/cloud-sandbox";

import { getFollowups, saveFollowupPolicy, createFollowup, updateFollowup, changeFollowup, scanFollowups } from "./libs/intentions/service";
import { isIntentionsStorageError, reportIntentionsStorageError } from "./libs/intentions/storage-errors";

const intentionsStorageOperations: Record<string, string> = {
  getFollowups: "load intentions",
  saveFollowupPolicy: "save intentions settings",
  createFollowup: "create intention",
  updateFollowup: "update intention",
  changeFollowup: "change intention state",
  scanFollowups: "scan intentions",
};

type Handlers = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => ReturnType<AppRequests[K]> | Promise<ReturnType<AppRequests[K]>>;
};

export function broadcast(event: AppEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("app:event", event);
  }
}

/** Hearthside: a picture or chat background changed; every window follows. */
function looksChanged<T extends ReturnType<typeof getLooks>>(looks: T): T {
  broadcast({ type: "looks.changed", looks });
  return looks;
}

function requireDesktopFileAccess(): void {
  const target = executionTarget();
  if (target) throw new Error(`This file belongs to the execution computer (${target.name}). Remote file previews aren't available here yet.`);
}

const handlers: Handlers = {
  getFollowups, saveFollowupPolicy, createFollowup, updateFollowup, changeFollowup, scanFollowups,
  getSettings,
  getChatPreferences,
  setChatPreference,
  listExecutionComputers,
  getConversationExecution,
  getConversationAgent: (conversationId: string) => conversationAgent(conversationId),
  setConversationExecution,
  listExecutionPlaces,
  moveConversation,
  updateSettings: (update) => {
    assertRecoveryIdle();
    const before = getSettings();
    const afterTarget = (update.backend ?? before.backend) === "cloud"
      ? update.executionComputer !== undefined ? update.executionComputer : before.executionComputer ?? null
      : null;
    if (JSON.stringify(executionTarget()) !== JSON.stringify(afterTarget)) assertExecutionTargetIdle();
    if (update.runtimeDebugLog !== undefined && update.runtimeDebugLog !== getSettings().runtimeDebugLog) assertNoReplyRunning("switching the detailed runtime log");
    const { connectionChanged } = updateSettings(update);
    if (update.startAtLogin !== undefined) applyLoginItem();
    if (update.permissionMode) applyPermissionMode();
    // Electron's themeSource drives prefers-color-scheme in the window.
    if (update.theme) nativeTheme.themeSource = getThemePreference();
    // Hearthside: the detailed runtime log takes effect when the runtime restarts.
    if (update.runtimeDebugLog !== undefined) {
      setRuntimeDebugLog(update.runtimeDebugLog ? join(app.getPath("logs"), "letta-runtime-debug.log") : null);
      void reconnect();
    }
    // Hearthside: keeping this computer reachable from Letta Cloud, or its name, changed.
    if (update.reachableComputer !== undefined || update.computerName !== undefined) void applyComputerAccess();
    // The renderer follows the reconnect through `connection` events.
    if (connectionChanged) void reconnect();
    return getSettings();
  },
  getConnection,
  reconnect: () => { assertRecoveryIdle(); return reconnect(); },
  listAgents,
  createAgent,
  getAgent,
  restoreCompanionPrompt,
  updateAgent,
  deleteAgent: async (agentId) => {
    await deleteAgent(agentId);
    forgetLook(agentId);
    looksChanged(getLooks());
  },
  getLooks: () => getLooks(),
  setLookImage: (target, kind, dataUrl) => looksChanged(setLookImage(target, kind, dataUrl)),
  clearLookImage: (target, kind) => looksChanged(clearLookImage(target, kind)),
  setLookStyle: (agentId, style) => looksChanged(setLookStyle(agentId, style)),
  // Hearthside: helpers shown as working are checked with the runtime first (they may have finished meanwhile).
  listChatHelpers: async (conversationId) => {
    await settleHelpers(conversationId).catch(() => undefined);
    return helpersFor(conversationId);
  },
  // Hearthside: backups.
  getBackupSettings: () => getBackupSettingsInfo(),
  chooseBackupFolder: async () => {
    assertRecoveryIdle();
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = { title: "Where should backups go?", properties: ["openDirectory", "createDirectory"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!folder) return null;
    assertRecoveryIdle();
    return { folder, ...adoptBackupFolder(folder) };
  },
  unlockBackupFolder: (recoveryCode) => unlockBackupFolder(recoveryCode),
  newBackupRecoveryCode: () => { assertRecoveryIdle(); return newBackupRecoveryCode(); },
  updateBackupSettings: (update) => {
    assertRecoveryIdle();
    updateBackupSettings(update);
    return getBackupSettingsInfo();
  },
  backUpNow: (agentId, full) => backUpNow(agentId, full === true),
  listBackups: (agentId) => listBackups(agentId),
  verifyBackup: (agentId, snapshotId) => verifyBackup(agentId, snapshotId),
  // Read-only and metadata-only; an explicit press, never part of a capture.
  runCaptureDiagnostic: (agentId) => runCaptureDiagnostic(agentId),
  cancelCaptureDiagnostic,
  listBackupCompanions,
  previewBackupRestore: (agentId, snapshotId, options) => previewBackupRestore(agentId, snapshotId, options),
  restoreBackupCopy,
  getRecoveryReceipt,
  listRecoveryCopies,
  previewRecoveryHandover,
  confirmRecoveryHandover,
  rollbackRecoveryHandover,
  getRecoveryHandover,
  previewManualRecoveryCopy,
  confirmManualRecoveryCopy,
  // Hearthside: reading the models is also when a companion made before any
  // model was connected is given the first one that now is (Local only).
  listModels: async (refresh) => {
    const models = await listModels(refresh === true);
    await adoptConnectedModels(models).catch((error: unknown) => console.warn(`[agents] ${error instanceof Error ? error.message : String(error)}`));
    return models;
  },
  listProviders,
  connectProvider,
  disconnectProvider,
  getGptUsage: (refresh) => getGptUsage(refresh === true),
  useGptReset,
  listMemory,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  listMemoryHistory,
  readMemoryFileAt,
  listMemoryActivity,
  readMemoryCommitDiff,
  listConversations,
  listConversationPreviews,
  loadHistory,
  latestMessageMark,
  renameConversation,
  archiveConversation,
  listArchivedConversations,
  restoreConversation,
  sendMessage: sendMessageForIpc,
  stopTurn,
  respondApproval,
  startProviderSignIn,
  answerProviderSignIn,
  cancelProviderSignIn,
  // Hearthside: sign in to Letta Cloud in the browser, then switch to Cloud.
  signInWithLetta: async () => {
    await signInWithLetta();
    updateSettings({ backend: "cloud" });
    // Rebuild the connection so the runtime starts with the new sign-in.
    void reconnect();
    return getSettings();
  },
  cancelLettaSignIn,
  signOutOfLetta: async () => {
    await signOutOfLetta();
    if (getSettings().backend === "cloud") void reconnect();
    return getSettings();
  },
  getDreamSettings,
  setDreamSettings,
  setConversationContextWindow,
  runCommand,
  listChatCommands,
  listHistory,
  runChatCommand,
  reloadMods,
  // Hearthside: mods. Files are read, never imported — only the runtime runs
  // mod code, on its own startup or on an explicit /reload (docs/MODS.md).
  getModsOverview,
  readModSource,
  chooseModFile: async () => {
    // Resolved before the dialog and again at confirmation, so a preview can
    // never be confirmed against a different runtime's folder.
    const context = importContext();
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: "Choose a mod file",
      properties: ["openFile"],
      filters: [{ name: "Mod", extensions: ["js", "mjs", "ts", "tsx"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const file = result.canceled ? null : result.filePaths[0];
    return file ? previewModFile(file, context) : null;
  },
  confirmModImport: (token: string) => confirmModImport(token, importContext()),
  setModsOff: (off: boolean) => {
    // Only a change that will restart the runtime: the same value again, or a
    // switch an environment variable overrides, restarts nothing.
    const now = modsOffState();
    if (now.reason !== "environment" && now.active !== off) assertNoReplyRunning("switching mods on or off");
    const state = setModsOffSetting(off);
    // The gate is in the child's environment, so it only applies to a runtime
    // that hasn't started yet. Restart so the switch means something now.
    if (state.needsRestart) void reconnect();
    return state;
  },
  forkConversation,
  searchMessages,
  listDirectory,
  readWorkingFile,
  listSecretNames,
  setSecret,
  removeSecret,
  listConnectors,
  saveConnector,
  removeConnector,
  setConnectorAgents,
  setLettaToolAttached,
  setConnectorTools,
  setConnectorVoice,
  setConnectorVoiceModel,
  listConnectorVoices,
  testConnector,
  testConnectorInput,
  addConnectorsFromJson,
  signInConnector,
  signOutConnector,
  listConnectorImports,
  importConnectors,
  readAudioFile: (path) => {
    requireDesktopFileAccess();
    return readAudioFile(path);
  },
  listGifs: (query) => listGifs(query, getSettings().gifFilter, gifCustomerId()),
  fetchGif: (url) => fetchGif(url),
  imageEngineStatus: () => engineStatus(),
  imageConnectStatus: () => imageConnectStatus(),
  startImageSetup: (step, mode) => startImageSetup(step, mode),
  cancelImageSetup: (sessionId) => cancelImageSetup(sessionId),
  listCalendar: (fromMs, toMs) => listOccurrences(fromMs, toMs),
  getPresenceCalendar: (agentId, fromMs, toMs) => {
    const shared = calendarAccess().includes(agentId);
    return { shared, occurrence: shared ? (listOccurrences(fromMs, toMs)[0] ?? null) : null };
  },
  saveCalendarEvent: (input) => saveEvent(input, "person"),
  deleteCalendarEvent: (id) => deleteEvent(id),
  listCalendarSubscriptions: () => listSubscriptions(),
  addCalendarSubscription: (name, url) => addSubscription(name, url),
  removeCalendarSubscription: (id) => removeSubscription(id),
  refreshCalendarSubscription: (id) => refreshSubscription(id),
  calendarAccess: () => calendarAccess(),
  setCalendarAccess: (agentId, on) => setCalendarAccess(agentId, on),
  readImageFile: (path) => {
    requireDesktopFileAccess();
    return readImageFile(path);
  },
  revealAudioFile: async (path) => {
    requireDesktopFileAccess();
    const full = await checkLocalPath(path);
    if (existsSync(full)) shell.showItemInFolder(full);
  },
  getDiagnostics,
  getComputerStatus: () => computerStatus(),
  getChannelServiceStatus: () => channelServiceStatus(),
  recoverChannelService: () => recoverChannelService(),
  openFileLink: (href, cwd, conversationId) => {
    assertConversationDesktopAccess(conversationId ?? null);
    return openFileLink(href, cwd, getSettings().backend === "cloud" && conversationId
      ? async (path) => {
          const { access, scope } = sandboxLinkAccess(conversationId);
          return downloadFromSandbox(access, scope, path, app.getPath("downloads"));
        }
      : null);
  },
  openLettaComputer: async (conversationId) => {
    const { access, scope } = sandboxLinkAccess(conversationId);
    await shell.openExternal(await sandboxDesktopUrl(access, scope));
  },
  openLogFolder: () => {
    void shell.openPath(pathDirname(logFilePath()));
  },
  setUseRealLettaHome: async (value) => {
    assertRecoveryIdle();
    assertNoReplyRunning("moving the runtime's home");
    const backup = value ? await backupLettaHome() : null;
    // The copy takes a while now that it no longer blocks; a reply may have started meanwhile.
    if (value) assertNoReplyRunning("moving the runtime's home");
    updateSettings({ useRealLettaHome: value });
    setUseRealLettaHome(value);
    void reconnect();
    return { backup };
  },
  exportConversation: async (conversationId) => {
    const { markdown, title } = await conversationMarkdown(conversationId);
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.SaveDialogOptions = {
      title: "Save chat",
      defaultPath: `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "chat"}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, markdown, "utf8");
    return result.filePath;
  },
  getToolset,
  setToolset,
  listChannels,
  listChannelAccounts,
  setupChannel,
  setChannelAccountRunning,
  removeChannelAccount,
  listPairings,
  approvePairing,
  declinePairing,
  setChannelAccess,
  setDiscordCompanionParticipation,
  setChannelChatMode,
  claimChannelBot,
  previewChannelBotReassign,
  reassignChannelBot,
  resumeChannelBotMove,
  setDiscordChannelListening,
  listMutedChannels,
  listChannelRoutes,
  removeChannelRoute,
  listSchedules,
  // Hearthside: a schedule sends into its chat; never into a read-only history part.
  addSchedule: async (input) => { if (input.conversationId) await assertWritableConversation(input.conversationId); return addSchedule(input); },
  updateSchedule: async (id, input) => { if (input.conversationId) await assertWritableConversation(input.conversationId); return updateSchedule(id, input); },
  setSchedulePaused,
  runScheduleNow,
  deleteSchedule,
  listScheduleRuns,
  checkPrograms,
  listSkills,
  listSkillCatalog: () => listCatalog(),
  installSkill,
  removeSkill,
  getUpdateReady: () => updateReady(),
  checkForUpdates: () => checkForUpdatesNow(),
  getAppVersion: () => app.getVersion(),
  // Only verified shutdown may enable the installer's before-quit bypass.
  installUpdate: () => installUpdate(async () => {
    // Installing stops the runtime, which would cut off a reply (or a
    // scheduled run, or a channel answer) part-way with no warning.
    try { assertNoReplyRunning("installing the update"); } catch {
      throw new ReplyRunningError("A reply is still being written. Wait for it to finish, or stop it, then choose Restart to update again.");
    }
    await prepareUpdateQuit(() => shutdownForQuit(10_000));
  }, cancelUpdateQuit),
  chooseHistoryImport: async (agentId: string) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: "Choose your ChatGPT or Claude export",
      properties: ["openFile"],
      filters: [{ name: "ChatGPT or Claude export", extensions: ["zip", "json"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const file = result.canceled ? null : result.filePaths[0];
    return file ? previewHistoryImport(agentId, file, historyCloudAccess) : null;
  },
  runHistoryImport: async (token: string, options: { personName?: string; includeArchived?: boolean }) => {
    const result = await runHistoryImport(token, {
      ...options,
      agentBusy,
      cloudAccess: historyCloudAccess,
      onProgress: (done, total) => broadcast({ type: "history.progress", done, total }),
    });
    broadcast({ type: "memory.updated", paths: ["history"] });
    return result;
  },
  selectDirectory: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

export function registerIpc(): void {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`app:${name}`, async (event, ...args: unknown[]) => {
      // Errors cross the bridge as data so the renderer sees the real message
      // instead of Electron's "Error invoking remote method" wrapper.
      try {
        validateEventFrame(event.senderFrame);
        // Hearthside: every argument is schema-checked before it reaches a handler.
        if (!isRequestName(name)) throw new Error("Unknown request.");
        const parsed = parseRequestArgs(name, args) as unknown[];
        const invoke = () => (handler as (...input: unknown[]) => unknown)(...parsed);
        const value = bypassRecoveryMutationLock(name, parsed) ? await invoke() : await withRecoveryMutation(invoke);
        return { ok: true, value };
      } catch (error) {
        const operation = intentionsStorageOperations[name];
        const reported = operation && isIntentionsStorageError(error)
          ? reportIntentionsStorageError(error, operation) : error;
        return { ok: false, error: describeError(reported) };
      }
    });
  }
}
