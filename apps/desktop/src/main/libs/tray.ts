import { Menu, Tray, nativeImage } from "electron";
import { TRAY_ICON_16, TRAY_ICON_32, TRAY_ICON_48 } from "./tray-icon";

/**
 * Hearthside: the icon by the clock. Closing the window leaves the app running
 * here; clicking the icon brings the window back.
 */

let tray: Tray | null = null;

function icon(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(TRAY_ICON_16);
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 });
  image.addRepresentation({ scaleFactor: 3, dataURL: TRAY_ICON_48 });
  return image;
}

export function createTray(actions: { open: () => void; newChat: () => void; quit: () => void }): void {
  if (tray) return;
  tray = new Tray(icon());
  tray.setToolTip("Hearthside");
  // Electron calls these with its own arguments (the menu item, the click
  // event). The actions take none, and one of them has an optional callback as
  // its first parameter: handed the click event, it showed the window and then
  // tried to call the event ("whenReady is not a function") on every tray click.
  // So each is called with nothing, whatever Electron passes.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Hearthside", click: () => actions.open() },
      { label: "New chat", click: () => actions.newChat() },
      { type: "separator" },
      { label: "Quit Hearthside", click: () => actions.quit() },
    ]),
  );
  tray.on("click", () => actions.open());
}

/** Shown the first time the window is closed, so the app doesn't seem to vanish. */
export function showTrayHint(): void {
  tray?.displayBalloon({
    iconType: "info",
    title: "Hearthside is still running",
    content: "It's down here by the clock. Right-click the icon to quit.",
  });
}
