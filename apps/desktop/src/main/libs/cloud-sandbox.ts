import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, posix } from "node:path";
import { readCapped, DownloadTooBig } from "./safe-fetch";




export type CloudAccess = { token: string; baseUrl: string };
export type ChatScope = { agentId: string; conversationId: string };

const CHAT_BASE = "https://chat.letta.com";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

async function api(access: CloudAccess, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, access.baseUrl.replace(/\/+$/, "") + "/"), {
    ...init,
    headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json", Accept: "application/json, */*", ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Letta said ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return response;
}

/** The chat's sandbox (Letta starts or resumes it if needed). */
async function chatSandbox(access: CloudAccess, scope: ChatScope): Promise<string> {
  const response = await api(access, `v1/agents/${encodeURIComponent(scope.agentId)}/sandboxes`, {
    method: "POST",
    body: JSON.stringify(scope.conversationId === "default" ? {} : { conversationId: scope.conversationId }),
  });
  const sandbox = (await response.json()) as { sandboxId?: unknown; conversationId?: unknown };
  if (typeof sandbox.sandboxId !== "string") throw new Error("Letta didn't say which sandbox belongs to this chat.");
  if ((typeof sandbox.conversationId === "string" ? sandbox.conversationId : "default") !== scope.conversationId) {
    throw new Error("Letta returned the sandbox of a different chat, so nothing was opened.");
  }
  return sandbox.sandboxId;
}

/** The chat.letta.com page for a desktop session (as the runtime builds it). */
export function desktopViewerUrl(relayUrl: string, expiresAt: string): string {
  const relay = new URL(relayUrl);
  const viewer = new URL("/desktop", CHAT_BASE);
  viewer.hash = new URLSearchParams({ path: `${relay.pathname}${relay.search}`, expiresAt }).toString();
  return viewer.toString();
}

export async function sandboxDesktopUrl(access: CloudAccess, scope: ChatScope): Promise<string> {
  const sandboxId = await chatSandbox(access, scope);
  const response = await api(access, `v1/sandboxes/${encodeURIComponent(sandboxId)}/desktop-session`, { method: "POST", body: "{}" });
  const session = (await response.json()) as { url?: unknown; expiresAt?: unknown };
  if (typeof session.url !== "string") throw new Error("Letta didn't send a link to the computer.");
  return desktopViewerUrl(session.url, String(session.expiresAt ?? ""));
}

/** A sandbox path Letta will hand over: only under /root/downloads, no ".." tricks. */
export function sandboxDownloadPath(path: string): string | null {
  const cleaned = posix.normalize(`/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`);
  if (!cleaned.startsWith("/root/downloads/") || cleaned.endsWith("/")) return null;
  return cleaned;
}

/** A name in the Downloads folder that doesn't replace anything already there. */
export function freeName(folder: string, wanted: string): string {
  const safe = (wanted.split(/[\\/]/).pop() ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "download";
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length) || "download";
  let name = safe;
  for (let n = 2; existsSync(join(folder, name)); n += 1) name = `${stem} (${n})${extension}`;
  return join(folder, name);
}

export async function downloadFromSandbox(access: CloudAccess, scope: ChatScope, sandboxPath: string, folder: string): Promise<string> {
  const path = sandboxDownloadPath(sandboxPath);
  if (!path) throw new Error("Only files in the sandbox's downloads folder (/root/downloads) can be downloaded.");
  const sandboxId = await chatSandbox(access, scope);
  const response = await api(access, `v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${new URLSearchParams({ path })}`, { method: "GET" });
  let bytes: Buffer;
  try {
    bytes = await readCapped(response, MAX_DOWNLOAD_BYTES);
  } catch (error) {
    if (error instanceof DownloadTooBig) throw new Error("That file is too big to download here (over 200 MB).");
    throw error;
  }
  mkdirSync(folder, { recursive: true });
  const target = freeName(folder, basename(path));
  writeFileSync(target, bytes);
  return target;
}
