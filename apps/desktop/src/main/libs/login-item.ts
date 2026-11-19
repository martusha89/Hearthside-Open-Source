import { app } from "electron";
import { getSettings } from "./settings";

/** Hearthside: start with the computer (quietly, in the tray), if the person chose to. */
export function applyLoginItem(): void {
  if (!app.isPackaged || process.platform === "darwin") return;
  app.setLoginItemSettings({ openAtLogin: getSettings().startAtLogin, args: ["--hidden"] });
}
