import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRightIcon } from "./icons";



export function FullPage({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const mac = window.bridge.platform === "darwin";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col bg-surface focus:outline-none"
        >
          <header className={`app-drag flex shrink-0 items-center gap-2 border-b border-border px-3 ${mac ? "pb-2.5 pl-20 pt-3" : "py-2.5"}`}>
            <Dialog.Close
              aria-label="Back to the chat"
              title="Back to the chat"
              className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-800"
            >
              <ChevronRightIcon className="h-4 w-4 rotate-180" />
            </Dialog.Close>
            <Dialog.Title className="text-base font-semibold text-ink-900">{title}</Dialog.Title>
            {subtitle && <span className="min-w-0 truncate text-sm text-muted">· {subtitle}</span>}
          </header>
          <div className="flex min-h-0 flex-1">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
