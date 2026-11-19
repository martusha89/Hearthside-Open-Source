// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { app, type WebFrameMain } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Hearthside builds with electron-vite: the dev server URL comes from
// ELECTRON_RENDERER_URL and the bundles live under out/{main,preload,renderer}.

export function devUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
}

export function isDev(): boolean {
  return devUrl() !== null;
}

export function getPreloadPath(): string {
  return join(__dirname, "../preload/index.js");
}

export function getUIPath(): string {
  return join(__dirname, "../renderer/index.html");
}

/** True when a URL is the app's own UI rather than somewhere it navigated to. */
export function isAppUrl(url: string): boolean {
  const dev = devUrl();
  if (dev) return new URL(url).origin === new URL(dev).origin;
  return url.split(/[?#]/)[0] === pathToFileURL(getUIPath()).toString();
}

/** Reject IPC from anything other than the app's own UI. */
export function validateEventFrame(frame: WebFrameMain | null): void {
  if (!frame || !isAppUrl(frame.url)) throw new Error("Blocked IPC from an untrusted frame.");
}
