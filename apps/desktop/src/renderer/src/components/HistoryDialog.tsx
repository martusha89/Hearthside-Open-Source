import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../store";
import type { ConversationSummary } from "../types";
import { CloseIcon } from "./icons";

/** "1 Aug 2026" or "1–3 Aug 2026", from a history part's span. */
export function historySpan(volume: ConversationSummary): string {
  const first = volume.history?.firstAt ? new Date(volume.history.firstAt) : null;
  const last = volume.history?.lastAt ? new Date(volume.history.lastAt) : null;
  if (!first || Number.isNaN(first.getTime())) return "Undated";
  const day = (date: Date) => date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (!last || Number.isNaN(last.getTime()) || first.toDateString() === last.toDateString()) return day(first);
  return `${day(first)} – ${day(last)}`;
}

/** The chat a history part belongs to, as its label names it ("History · Main chat · …"). */
export function historyChatTitle(volume: ConversationSummary): string {
  if (volume.history?.of === "main") return "Main chat";
  const parts = volume.title.split(" · ");
  return parts.length >= 3 ? parts.slice(1, -1).join(" · ") : volume.title || "Chat";
}

/**
 * Hearthside: a restored companion's older messages, kept read-only in parts
 * (backup/cloud-native.ts). Grouped by the chat they came from, oldest first.
 * Search (in the sidebar) finds a message in any of them and opens it.
 */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const volumes = useAppStore((state) => state.historyVolumes);
  const error = useAppStore((state) => state.historyVolumesError);
  const openChat = useAppStore((state) => state.openChat);
  const groups = new Map<string, ConversationSummary[]>();
  for (const volume of volumes) {
    const key = volume.history?.of ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), volume]);
  }
  // The main chat first, then the others by name.
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) => (a === "main" ? -1 : b === "main" ? 1 : historyChatTitle(x[0]!).localeCompare(historyChatTitle(y[0]!))));

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-900">History</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-800">
              <CloseIcon className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <p className="mt-1 text-xs text-muted">
            Older messages brought back from a backup, kept as they were. They're read-only; open one and use
            “Continue from here” to carry on in a new chat. Search in the sidebar looks through them too.
          </p>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {error && <p role="alert" className="py-3 text-sm text-error">History couldn't be listed just now: {error}</p>}
            {!error && volumes.length === 0 && <p className="py-8 text-center text-sm text-muted">No history yet.</p>}
            {ordered.map(([key, parts]) => (
              <details key={key} open={ordered.length === 1} className="mb-2">
                <summary className="cursor-pointer rounded-lg px-2.5 py-2 text-sm font-medium text-ink-900 hover:bg-surface-tertiary">
                  {historyChatTitle(parts[0]!)} <span className="font-normal text-muted">· {parts.length} part{parts.length === 1 ? "" : "s"}</span>
                </summary>
                <div className="mt-1 flex flex-col gap-0.5 pl-2">
                  {parts.map((volume) => (
                    <button
                      key={volume.id}
                      type="button"
                      onClick={() => { openChat(volume.id); onClose(); }}
                      className="rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-800 hover:bg-surface-tertiary"
                    >
                      {historySpan(volume)}
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
