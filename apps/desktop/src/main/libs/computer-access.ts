import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import Letta from "@letta-ai/letta-client";
import { type ComputerBackend, type ComputerIdentity, onComputerStatus, setComputerListener, shutdownComputerListener } from "./computer-listener";
import { getSettings } from "./settings";

/**
 * Hearthside: when to keep this computer reachable from Letta Cloud, and under
 * which name. Only on a Letta Cloud connection, only when the person switched it
 * on (Settings → Connection), and only while Hearthside runs.
 */

export type CloudLink = { backend: ComputerBackend; token: () => string; baseUrl: string };

let link: CloudLink | null = null;
let applying = 0;

/** The device id this computer already has with Letta (the person's own ~/.letta), if any. */
export function existingDeviceId(home = homedir()): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".letta", "settings.json"), "utf8")) as { deviceId?: unknown };
    return typeof settings.deviceId === "string" && /^[A-Za-z0-9:_-]{8,80}$/.test(settings.deviceId) ? settings.deviceId : null;
  } catch {
    return null;
  }
}

/** The name Letta already shows for this device (most recently seen), so it keeps it. */
export async function existingName(deviceId: string, token: string, baseUrl: string): Promise<string | null> {
  try {
    const client = new Letta({ apiKey: token, baseURL: baseUrl, maxRetries: 1, timeout: 15_000 });
    const listed = (await client.environments.list({ limit: "100" })) as { connections?: Array<{ deviceId?: string; connectionName?: string; lastSeenAt?: number }> };
    const mine = (listed.connections ?? []).filter((item) => item.deviceId === deviceId && item.connectionName).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    return mine[0]?.connectionName ?? null;
  } catch {
    return null;
  }
}

export async function resolveIdentity(current: CloudLink, settings = getSettings()): Promise<ComputerIdentity> {
  const deviceId = existingDeviceId();
  const chosen = settings.computerName.trim();
  const name = chosen || (deviceId ? await existingName(deviceId, current.token(), current.baseUrl) : null) || hostname();
  return { name, deviceId, account: settings.connectionRevision };
}

/** The connection changed: Cloud (with how to reach it) or anything else (null). */
export function setCloudLink(next: CloudLink | null): void {
  link = next;
  void applyComputerAccess();
}

/** Start, stop or rename the listener to match the connection and the setting. */
export async function applyComputerAccess(): Promise<void> {
  const attempt = ++applying;
  const settings = getSettings();
  if (!link || !settings.reachableComputer) {
    setComputerListener(null, false, null);
    return;
  }
  const current = link;
  const who = await resolveIdentity(current, settings);
  if (attempt !== applying || link !== current) return;
  setComputerListener(current.backend, true, who);
}

export { onComputerStatus, shutdownComputerListener };
export { computerListenerStopped } from "./computer-listener";
