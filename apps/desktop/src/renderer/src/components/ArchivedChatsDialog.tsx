// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { relativeTime } from "../lib/format";
import { useAppStore } from "../store";
import type { ConversationSummary } from "../types";
import { CloseIcon, Spinner } from "./icons";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hearthside: browse an agent's archived chats and restore them. */
export function ArchivedChatsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const openChat = useAppStore((state) => state.openChat);
  const [chats, setChats] = useState<ConversationSummary[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    let cancelled = false;
    window.bridge
      .listArchivedConversations(agentId)
      .then((list) => !cancelled && setChats(list))
      .catch((failure: unknown) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const restore = async (chat: ConversationSummary, open: boolean) => {
    setRestoring(chat.id);
    setError(null);
    try {
      await window.bridge.restoreConversation(chat.id);
      setChats((list) => list?.filter((item) => item.id !== chat.id) ?? null);
      if (open) {
        openChat(chat.id);
        onClose();
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-900">Archived chats</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-800">
              <CloseIcon className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <p className="mt-1 text-xs text-muted">Archived chats keep their messages. Restore one to bring it back to the list.</p>
          {error && <p className="mt-3 break-words text-xs text-error">{error}</p>}
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {chats === null && !error && (
              <div className="flex justify-center py-8">
                <Spinner className="h-5 w-5 text-muted" />
              </div>
            )}
            {chats?.length === 0 && <p className="py-8 text-center text-sm text-muted">Nothing archived yet.</p>}
            <div className="flex flex-col gap-1">
              {chats?.map((chat) => (
                <div key={chat.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-tertiary">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-900">{chat.title || "Untitled chat"}</span>
                    <span className="block text-xs text-muted">{relativeTime(chat.updatedAt, now) || "—"}</span>
                  </span>
                  <button
                    type="button"
                    className="button-secondary shrink-0"
                    disabled={restoring !== null}
                    onClick={() => void restore(chat, false)}
                  >
                    {restoring === chat.id && <Spinner className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                  <button
                    type="button"
                    className="button-primary shrink-0"
                    disabled={restoring !== null}
                    onClick={() => void restore(chat, true)}
                  >
                    Restore &amp; open
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
