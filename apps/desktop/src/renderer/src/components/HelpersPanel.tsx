import { useEffect, useState } from "react";
import type { ChatHelper, ChatHelperStep } from "@hearthside/ipc-contract";
import { relativeTime } from "../lib/format";
import { describeTool } from "../lib/tools";
import { ChevronRightIcon, CloseIcon, Spinner } from "./icons";

/**
 * Hearthside: the helpers an agent sent off in this chat, beside the chat (as
 * the old Letta app's Subagents panel): running ones first, then previous
 * ones, each with its job, status, how long it took, and its steps.
 */

const RUNNING = new Set(["running", "pending", "queued", "started"]);

function duration(ms: number | null): string {
  if (!ms) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function typeLabel(type: string): string {
  return type.replace(/[-_]+/g, " ");
}

function Step({ step }: { step: ChatHelperStep }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "tool") {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(step.detail) as Record<string, unknown>;
    } catch {
      // Still streaming, or not JSON.
    }
    const { label, detail } = describeTool(step.name, input);
    return (
      <li className="grid gap-0.5">
        <button type="button" className="flex min-w-0 items-baseline gap-1.5 text-left" onClick={() => setOpen(!open)}>
          <span className={step.failed ? "text-error" : "text-ink-800"}>{label}</span>
          {detail && <span className="min-w-0 truncate font-mono text-[11px] text-muted">{detail}</span>}
        </button>
        {open && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-tertiary p-2 text-[11px] text-ink-700">{step.detail}</pre>}
      </li>
    );
  }
  return (
    <li className={`whitespace-pre-wrap break-words ${step.kind === "thought" ? "italic text-muted" : "text-ink-800"}`}>
      {step.detail.length > 400 && !open ? (
        <button type="button" className="text-left" onClick={() => setOpen(true)}>
          {step.detail.slice(0, 400)}…
        </button>
      ) : (
        step.detail
      )}
    </li>
  );
}

export function HelperRow({ helper }: { helper: ChatHelper }) {
  const [open, setOpen] = useState(false);
  const running = RUNNING.has(helper.status);
  const unobserved = helper.status === "unobserved";
  const failed = !unobserved && (helper.status === "failed" || helper.status === "error" || Boolean(helper.error));
  const completed = helper.status === "completed" || helper.status === "success";
  const cancelled = helper.status === "cancelled" || helper.status === "canceled";
  const tools = helper.steps.filter((step) => step.kind === "tool").length || helper.toolCalls;
  return (
    <li className="grid gap-1 border-b border-border px-3 py-2 last:border-b-0">
      <button type="button" className="flex items-start gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink-900">{helper.description || typeLabel(helper.type)}</span>
          <span className="block text-[11px] text-muted">
            {typeLabel(helper.type)}
            {" · "}
            {running ? (
              <span className="text-accent">working{tools ? ` · ${tools} step${tools === 1 ? "" : "s"}` : ""}</span>
            ) : failed ? (
              <span className="text-error">didn't finish</span>
            ) : helper.status === "ended" ? (
              <>ended{tools ? ` · ${tools} step${tools === 1 ? "" : "s"}` : ""}</>
            ) : completed ? (
              <>done{tools ? ` · ${tools} step${tools === 1 ? "" : "s"}` : ""}</>
            ) : cancelled ? (
              <>cancelled</>
            ) : (
              <>status unknown</>
            )}
            {helper.durationMs ? ` · ${duration(helper.durationMs)}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-muted">{running ? <Spinner className="h-3 w-3" /> : relativeTime(helper.updatedAt)}</span>
      </button>
      {open && (
        <div className="ml-5 grid gap-1.5 text-xs">
          {helper.error && <p className={unobserved ? "text-muted" : "text-error"}>{helper.error}</p>}
          {helper.steps.length > 0 ? (
            <ol className="grid gap-1.5">
              {helper.steps.map((step, index) => (
                <Step key={`${step.id}-${index}`} step={step} />
              ))}
            </ol>
          ) : (
            <p className="text-muted">No steps were recorded for this one.</p>
          )}
        </div>
      )}
    </li>
  );
}

export function HelpersPanel({ conversationId, onClose }: { conversationId: string | null; onClose: () => void }) {
  const [helpers, setHelpers] = useState<ChatHelper[]>([]);

  const [state, setState] = useState<{ status: "loading" | "ready" | "failed"; error?: string }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setHelpers([]);
    setState({ status: "loading" });
    if (!conversationId) return;
    let live = true;
    void window.bridge
      .listChatHelpers(conversationId)
      .then((list) => {
        if (!live) return;
        setHelpers(list);
        setState({ status: "ready" });
      })
      .catch((error: unknown) => live && setState({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    const unsubscribe = window.bridge.onEvent((event) => {
      if (event.type === "helpers.changed" && event.conversationId === conversationId) setHelpers(event.helpers);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [conversationId, attempt]);
  const running = helpers.filter((helper) => RUNNING.has(helper.status));
  const previous = helpers.filter((helper) => !RUNNING.has(helper.status));
  return (
    <aside aria-label="Helpers" className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-medium text-ink-800">Helpers</span>
        <button type="button" aria-label="Close helpers" className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-800" onClick={onClose}>
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {helpers.length === 0 && state.status === "loading" && (
          <div className="flex justify-center py-6">
            <Spinner className="h-4 w-4 text-muted" />
          </div>
        )}
        {helpers.length === 0 && state.status === "failed" && (
          <div className="grid justify-items-center gap-2 px-3 py-6 text-center text-xs">
            <p className="break-words text-error">Couldn't load the helpers: {state.error}</p>
            <button type="button" className="text-accent hover:underline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {helpers.length === 0 && state.status === "ready" && <p className="px-3 py-6 text-center text-xs text-muted">No helpers in this chat yet. When your agent sends one off, it shows here.</p>}
        {running.length > 0 && (
          <>
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">Working</p>
            <ul>{running.map((helper) => <HelperRow key={helper.id} helper={helper} />)}</ul>
          </>
        )}
        {previous.length > 0 && (
          <>
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">Previous</p>
            <ul>{previous.map((helper) => <HelperRow key={helper.id} helper={helper} />)}</ul>
          </>
        )}
      </div>
    </aside>
  );
}
