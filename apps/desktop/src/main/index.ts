import "./source-profile";
// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { shutdownForQuit } from "./libs/shutdown";
import { checkRemindersNow } from "./libs/calendar";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, dialog, Menu, nativeTheme, powerMonitor, shell, type MenuItemConstructorOptions } from "electron";
import type { AppEvent } from "@hearthside/ipc-contract";
import { broadcast, registerIpc } from "./ipc";
import { callbackFromArgv, cancelLettaSignIn, checkLettaSignInAfterWake, deliverLettaCallback, onLettaSignInExpired } from "./libs/letta-signin";
import { onControlPush } from "./libs/control";
import { installLogFile } from "./libs/log-file";
import { runtimeLog } from "./libs/owned-server";
import { getSettings, saveLettaCredential, settingsPath, takeTrayHint } from "./libs/settings";
import { createTray, showTrayHint } from "./libs/tray";
import { initNotifications, notifyFor } from "./libs/notifications";
import { applyLoginItem } from "./libs/login-item";
import { setOnChannelsUsed } from "./libs/channels";
import { setUseRealLettaHome } from "./runtime/paths";
import { initUpdater } from "./libs/updater";
import { setUpdateQuit } from "./libs/quit";
import { agentIdFor, agentNameFor, lastReplyFor } from "./libs/runtime";
import { avatarFileFor } from "./libs/looks";
import { setRuntimeDebugLog } from "./runtime/child-env";
import { applyModsSetting } from "./libs/mods/service";
import { join } from "node:path";
import { initBackups } from "./libs/backup/backup";
import { initRecovery } from "./libs/backup/recovery-wiring";
import { runChatReplayFromArgv } from "./libs/backup/replay-chat";
import { configureHistoryRegistry } from "./libs/backup/history-registry";
import { configureRecoveryEvents, historyEvidence } from "./libs/backup/recovery";
import { helperFeedPath, initHelperFeed } from "./libs/helper-feed";
import { cancelAllProviderSignIns, initProviderSignIn } from "./libs/provider-signin";
import { initImageSetup } from "./libs/image-setup";
import { disconnect, failConnection, initRuntime, startCalendarReminders, startIntentionsRuntime } from "./libs/runtime";
import { stopIntentions } from "./libs/intentions/service";
import { getThemePreference } from "./libs/settings";
import { devUrl, getPreloadPath, getUIPath, isAppUrl } from "./util";

import { onComputerStatus } from "./libs/computer-access";
import { onChannelServiceStatus } from "./libs/channel-gateway";

const isMac = process.platform === "darwin";
const QUIT_TIMEOUT_MS = 10_000;

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let updateQuit = false;
setUpdateQuit(() => {
  updateQuit = true;
  quitting = true;
}, () => {
  // The installer did not start: quit the ordinary way from now on.
  updateQuit = false;
  quitting = false;
});

/**
 * Apps launched from Finder or a desktop launcher get a minimal PATH, so tools
 * the agent runs (git, node, package managers) would not be found. Take PATH
 * from the user's login shell instead.
 */
function inheritShellPath(): void {
  if (process.platform === "win32" || !app.isPackaged) return;
  try {
    const output = execFileSync(process.env.SHELL || "/bin/sh", ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const path = output.match(/__PATH__(.+)__PATH__/s)?.[1];
    if (path) process.env.PATH = path;
  } catch {
    // Keep the inherited PATH.
  }
}

function showWindow(whenReady?: () => void): void {
  // A macOS protocol URL can arrive before Electron has finished launching.
  // BrowserWindow cannot be created until ready; preserve the requested action.
  if (!app.isReady()) {
    void app.whenReady().then(() => showWindow(whenReady));
    return;
  }
  const created = !mainWindow;
  if (!mainWindow) createWindow();
  const window = mainWindow;
  if (!window) return;
  const reveal = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    whenReady?.();
  };
  // On macOS the last window is destroyed while the app remains running.
  // Menu and notification events must wait until its replacement renderer has
  // mounted its event listener, or the requested destination is silently lost.
  if (created) window.once("ready-to-show", reveal);
  else reveal();
}

function sendMenuCommand(command: Extract<AppEvent, { type: "menu" }>["command"]): void {
  showWindow(() => broadcast({ type: "menu", command }));
}

function buildMenu(): Menu {
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings...",
    accelerator: "CmdOrCtrl+,",
    click: () => sendMenuCommand("settings"),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => sendMenuCommand("new-chat") },
        ...(isMac ? [] : [settingsItem]),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: "Hearthside",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1917" : "#fdfaf6",
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 15, y: 18 } } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      // Hearthside hardening: no Node in the renderer, isolated preload.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Started with the computer: stay quietly in the tray until opened.
  const startHidden = process.argv.includes("--hidden") && !isMac && getSettings().closeToTray;
  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow?.show();
  });
  // Hearthside: the close button hides to the system tray, so the agent keeps
  // running (channels, schedules). Quit from the tray menu or with Ctrl+Q.
  mainWindow.on("close", (event) => {
    if (quitting || isMac || !getSettings().closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    if (takeTrayHint()) showTrayHint();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Links in agent output open in the browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  const dev = devUrl();
  if (dev) void mainWindow.loadURL(dev);
  else void mainWindow.loadFile(getUIPath());
}

installLogFile();

if (!app.requestSingleInstanceLock()) {
  // Another Hearthside is already running (perhaps in the tray): it gets the focus, this one leaves.
  // In development this means the running app is NOT the code just built; quit it from the tray first.
  console.warn("[hearthside] already running; handing over to the existing instance and quitting");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows/Linux deliver the "Sign in with Letta" return link as a second launch.
    const callback = callbackFromArgv(argv);
    if (callback) deliverLettaCallback(callback);
    // Hearthside: a second launch may carry a one-chat recovery replay (diagnostics only).
    void runChatReplayFromArgv(argv).catch((error) => console.error("[hearthside] replay", error));
    // Launching again brings the window back, even from the tray.
    showWindow();
  });

  // macOS delivers the return link as an open-url event.
  app.on("open-url", (event, url) => {
    if (deliverLettaCallback(url)) {
      event.preventDefault();
      // The browser may return after the person closed Hearthside's last Mac
      // window. Bring the app back just as the Windows second-instance path does.
      showWindow();
    }
  });

  void app.whenReady().then(() => {
    // Hearthside: a settings file that exists but can't be read is never replaced with
    // defaults (it may be the only copy). Say so, name the file, and stop, instead of
    // crashing on the first read below.
    try { getSettings(); } catch (error) {
      dialog.showErrorBox("Hearthside can't read its settings", `${error instanceof Error ? error.message : String(error)}

${settingsPath()}

Fix or move that file, then start Hearthside again. Nothing was changed.`);
      app.exit(1);
      return;
    }
    // Hearthside: a one-chat recovery replay into a kept scratch home (diagnostics only).
    void runChatReplayFromArgv().catch((error) => console.error("[hearthside] replay", error));
    // Hearthside: calendar reminders run while the app runs (tray included), and catch up after sleep.
    startCalendarReminders();
    powerMonitor.on("resume", () => checkRemindersNow());
    // Hearthside: the Letta sign-in's refresh timer doesn't count time asleep; look at the clock on waking.
    powerMonitor.on("resume", () => checkLettaSignInAfterWake());
    onLettaSignInExpired((reason) => {
      console.warn(`[hearthside] ${reason}`);
      saveLettaCredential(null);
      broadcast({ type: "settings.updated", settings: getSettings() });
      // Only a Cloud connection depends on the sign-in; leave Local alone.
      if (getSettings().backend === "cloud") void failConnection(reason);
    });
    inheritShellPath();
    setUseRealLettaHome(getSettings().useRealLettaHome);
    // Before the runtime is started: the mods gate lives in the child's
    // environment, and the runtime loads mods (including an agent's own)
    // without asking the desktop first.
    applyModsSetting();
    if (getSettings().runtimeDebugLog) setRuntimeDebugLog(join(app.getPath("logs"), "letta-runtime-debug.log"));
    nativeTheme.themeSource = getThemePreference();
    Menu.setApplicationMenu(buildMenu());
    registerIpc();
    runtimeLog(({ level, line }) => (level === "error" ? console.error : console.log)(`[letta] ${line}`));
    initRuntime((event) => {
      broadcast(event);
      notifyFor(event);
    });
    onComputerStatus((status) => broadcast({ type: "computer.status", status }));
    onChannelServiceStatus((status) => broadcast({ type: "channels.service", status }));
    initNotifications({
      enabled: () => getSettings().notifications,
      focused: () => Boolean(mainWindow && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized()),
      agentName: agentNameFor,
      lastReply: lastReplyFor,
      icon: (conversationId) => {
        const agentId = agentIdFor(conversationId);
        return agentId ? avatarFileFor(agentId) : null;
      },
      open: (conversationId) => {
        const agentId = agentIdFor(conversationId);
        showWindow(() => {
          if (agentId) broadcast({ type: "open.chat", conversationId, agentId });
        });
      },
    });
    applyLoginItem();
    setOnChannelsUsed(() => broadcast({ type: "settings.updated", settings: getSettings() }));
    initUpdater(broadcast);
    initRecovery();
    // Hearthside: which restored chats are read-only history parts (backup/history-registry.ts).
    configureHistoryRegistry(join(app.getPath("userData"), "recovery-history.json"), historyEvidence);
    initBackups(broadcast);
    configureRecoveryEvents(broadcast);
    startIntentionsRuntime();
    app.once("will-quit", stopIntentions);
    initHelperFeed(helperFeedPath(app.getPath("userData")), (conversationId, helpers) => broadcast({ type: "helpers.changed", conversationId, helpers }));
    onControlPush((frame) => {
      const paths = Array.isArray(frame.affected_paths) ? (frame.affected_paths as string[]) : [];
      broadcast({ type: "memory.updated", paths });
    });
    initProviderSignIn(broadcast);
    initImageSetup(broadcast);
    createWindow();
    if (!isMac) createTray({ open: showWindow, newChat: () => sendMenuCommand("new-chat"), quit: () => app.quit() });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  // Stop running turns and the Letta runtime, then exit. `app.exit` is used
  // for the second step because the quit sequence was already interrupted once.
  app.on("before-quit", (event) => {
    // Installing an update: the runtime is already stopped; let the updater quit normally.
    if (updateQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdownForQuit(QUIT_TIMEOUT_MS).then(() => app.exit(0)).catch((error: unknown) => {
      quitting = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[shutdown] ${message}`);
      dialog.showErrorBox("Hearthside could not shut down safely", `${message}\nHearthside has not exited because an owned process may still be running.`);
    });
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }
}
