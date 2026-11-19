import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ChatPreference, ChatPreferencePatch, ChatPreferencesView } from "@hearthside/ipc-contract";
import { validChatIcon } from "@hearthside/ipc-contract";
import { getSettings } from "./settings";

const preference = z.object({ pinned: z.boolean(), starred: z.boolean(), icon: z.string().refine(validChatIcon).nullable(), pinnedAt: z.number().finite().nonnegative().nullable() }).strict();
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), scopes: z.record(z.string(), z.record(z.string(), z.record(z.string(), preference))) }).strict();
type PreferencesFile = z.infer<typeof fileSchema>;
const empty = (): PreferencesFile => ({ version: 1, revision: 0, scopes: {} });
const path = () => join(app.getPath("userData"), "chat-preferences.json");
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;

function scope(): string {
  const settings = getSettings();
  // The opaque connection revision changes on account replacement, not refresh.
  // Hash endpoints so no server URL (which could contain credentials) is stored.
  return createHash("sha256").update(JSON.stringify([settings.connectionRevision ?? "initial", settings.backend,
    settings.backend === "cloud" ? settings.apiBaseUrl : settings.backend === "remote" ? settings.serverUrl : "local"])).digest("hex");
}

function read(): PreferencesFile {
  let text: string;
  try { text = readFileSync(path(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw new Error("Chat organisation could not be read. Nothing was changed."); }
  try { return fileSchema.parse(JSON.parse(text, (key, value: unknown) => {
    if (key === "__proto__") throw new Error("Unsupported chat identifier.");
    return value;
  })); }
  catch { throw new Error("Chat organisation data is unreadable or from an unsupported version. Nothing was changed."); }
}

function write(file: PreferencesFile): void {
  const target = path(), temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600); created = true;
    try { writeFileSync(fd, JSON.stringify(file)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
  } finally { if (created) { try { unlinkSync(temporary); } catch { /* Never mask a failed save. */ } } }
}

/**
 * An agent's organisation under `key`. For an agent on This computer that has
 * none there, what earlier identities of the same local store held is used
 * instead: the local connection used to be given a new identity whenever a
 * Cloud detail changed, which left its pins, stars and icons behind under the
 * old one. A local agent id is unique to its store, so those can only be this
 * agent's. Later entries win, and the next save writes them under `key`.
 */
function itemsFor(file: PreferencesFile, key: string, agentId: string): Record<string, ChatPreference> {
  const current = own(own(file.scopes, key) ?? {}, agentId);
  if (current || !agentId.startsWith("agent-local-")) return current ?? {};
  const recovered: Record<string, ChatPreference> = {};
  for (const [other, agents] of Object.entries(file.scopes)) {
    if (other !== key) Object.assign(recovered, own(agents, agentId) ?? {});
  }
  return recovered;
}

function view(file: PreferencesFile, key: string, agentId: string): ChatPreferencesView {
  return { scope: key, revision: file.revision, items: structuredClone(itemsFor(file, key, agentId)) };
}

function identifier(id: string): void {
  if (!id || id.length > 200 || id === "__proto__") throw new Error("Unsupported chat identifier. Nothing was changed.");
}

export function getChatPreferences(agentId: string, expectedRevision?: string): ChatPreferencesView {
  identifier(agentId);
  if (expectedRevision !== undefined && expectedRevision !== (getSettings().connectionRevision ?? "initial")) {
    throw new Error("The connection changed. Reopen this chat before changing its organisation.");
  }
  return view(read(), scope(), agentId);
}

export function setChatPreference(agentId: string, conversationId: string, expectedScope: string, patch: ChatPreferencePatch): ChatPreferencesView {
  identifier(agentId); identifier(conversationId);
  const key = scope();
  if (key !== expectedScope) throw new Error("The connection changed. Reopen this chat before changing its organisation.");
  if (patch.icon !== undefined && patch.icon !== null) {
    const icon = patch.icon;
    if (!validChatIcon(icon)) {
      throw new Error("Choose one emoji or symbol for this chat.");
    }
  }
  const file = read();
  const account = own(file.scopes, key) ?? {}, items = itemsFor(file, key, agentId);
  const before: ChatPreference = own(items, conversationId) ?? { pinned: false, starred: false, icon: null, pinnedAt: null };
  const next: ChatPreference = { pinned: patch.pinned ?? before.pinned, starred: patch.starred ?? before.starred,
    icon: patch.icon === undefined ? before.icon : patch.icon, pinnedAt: before.pinnedAt };
  next.pinnedAt = next.pinned ? before.pinned ? before.pinnedAt ?? Date.now() : Date.now() : null;
  const nextItems = { ...items, [conversationId]: next };
  if (!next.pinned && !next.starred && !next.icon) delete nextItems[conversationId];
  if (!Number.isSafeInteger(file.revision + 1)) throw new Error("Chat organisation revision is out of range. Nothing was changed.");
  const saved: PreferencesFile = { version: 1, revision: file.revision + 1,
    scopes: { ...file.scopes, [key]: { ...account, [agentId]: nextItems } } };
  write(saved);
  return view(saved, key, agentId);
}
