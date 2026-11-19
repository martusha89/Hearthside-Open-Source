import type { ChatPreference } from "@hearthside/ipc-contract";

export const DEFAULT_CHAT_PREFERENCE: ChatPreference = { pinned: false, starred: false, icon: null, pinnedAt: null };

/** Titles alone are searched: icons are explicit decoration, never inferred content. */
export function organiseChats<T extends { id: string; title?: string | null }>(chats: T[], preferences: Record<string, ChatPreference>, query: string, starredOnly: boolean) {
  const visible = chats.filter((chat) => (!starredOnly || preferences[chat.id]?.starred) &&
    (chat.title || "New chat").toLowerCase().includes(query.trim().toLowerCase()));
  const pinned = visible.filter((chat) => preferences[chat.id]?.pinned).sort((a, b) =>
    (preferences[a.id]?.pinnedAt ?? Number.MAX_SAFE_INTEGER) - (preferences[b.id]?.pinnedAt ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  return { pinned, rest: visible.filter((chat) => !preferences[chat.id]?.pinned) };
}

/** One visible Unicode grapheme; no markup, URLs, controls or arbitrary text. */
export { validChatIcon } from "@hearthside/ipc-contract";
