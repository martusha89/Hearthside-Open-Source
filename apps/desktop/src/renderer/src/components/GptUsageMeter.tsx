import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { useAppStore } from "../store";
import {
  type GptUsageState,
  GptUsagePending,
  PlanCard,
  distanceWords,
  expiryWords,
  isChatGptProvider,
  percentLeft,
  percentText,
  spendable,
  tightestWindow,
  useGptUsage,
  windowTitle,
} from "./GptUsagePanel";
import { ChevronRightIcon, MeterRing, RefreshIcon, Spinner } from "./icons";




const menuContent = "z-50 rounded-xl border border-border bg-surface p-3 shadow-elevated";

/** The summary line: the window closest to its limit, which is the one that will bite. */
export function GptUsageSummary({ state }: { state: GptUsageState }) {
  const view = state.view;
  if (!view?.connected) {
    return (
      <p className="text-xs text-muted">
        {view?.usageError ? view.usageError.message : `Usage shows here once a ChatGPT Plus or Pro plan is ${view?.source.where ?? "connected"}.`}
      </p>
    );
  }
  const quota = tightestWindow(view.usage?.windows ?? []);
  const left = quota ? percentLeft(quota) : null;
  const resetsIn = quota?.resetsAt ? distanceWords(state.now, Date.parse(quota.resetsAt)) : null;
  const available = view.resets && view.token ? spendable(view.resets.credits, state.now) : [];

  return (
    <div className="grid gap-2">
      {view.usage?.limitReached === true && (
        <p className="rounded-lg bg-error-light px-2.5 py-1.5 text-xs text-error">ChatGPT says this plan is rate limited right now.</p>
      )}

      {view.usageError ? (
        <p className="break-words text-xs text-muted">Usage couldn't be read: {view.usageError.message}</p>
      ) : quota && left !== null ? (
        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium text-ink-800">{windowTitle(quota)}</span>
            <span className="text-xs text-ink-700">
              <span className="font-medium tabular-nums">{percentText(left)}% left</span>
              {resetsIn && <span className="text-muted"> · {resetsIn}</span>}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded"
            style={{ background: "var(--color-surface-tertiary)" }}
            role="img"
            aria-label={`${windowTitle(quota)}: ${percentText(left)}% left`}
          >
            <div className="h-full rounded-r bg-accent" style={{ width: `${Math.max(left > 0 ? 1 : 0, left)}%` }} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">This plan didn't report a percentage for any window.</p>
      )}

      <p className="text-xs text-ink-700">
        {view.resetsError ? (
          <span className="text-muted">Resets couldn't be read: {view.resetsError.message}</span>
        ) : (
          <>
            {available.length === 0 ? "No resets available" : `${available.length} reset${available.length === 1 ? "" : "s"} available`}
            {available[0]?.expiresAt && <span className="text-muted"> · next {expiryWords(available[0].expiresAt, state.now)}</span>}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The plan's usage in the composer footer. Renders nothing at all unless a
 * ChatGPT subscription is actually connected — there is no honest number to
 * offer otherwise, and a button that only ever says "not connected" is the
 * same dead end as the settings page was.
 */
export function GptUsageMeter() {
  const providers = useAppStore((state) => state.providers);
  const connectionRevision = useAppStore((state) => state.settings?.connectionRevision ?? "initial");
  const connected = providers?.some((provider) => isChatGptProvider(provider) && provider.connections.length > 0) ?? false;
  if (!connected) return null;
  // A different sign-in is a different plan: start again rather than show the
  // one before it while the new one is being read.
  return <Meter key={connectionRevision} />;
}

function Meter() {
  const [open, setOpen] = useState(false);
  // Latched: closing the popover must not throw away the reading that was
  // taken, nor make reopening it take another one.
  const [opened, setOpened] = useState(false);
  const [detail, setDetail] = useState(false);
  const state = useGptUsage(opened);
  const openSettings = useAppStore((store) => store.openSettings);

  const view = state.view;
  const quota = view?.connected ? tightestWindow(view.usage?.windows ?? []) : null;
  const left = quota ? percentLeft(quota) : null;
  const used = quota?.usedPercent ?? null;
  const label = quota && left !== null ? `ChatGPT plan usage: ${windowTitle(quota)} ${percentText(left)}% left` : "ChatGPT plan usage";

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setOpened(true);
        else setDetail(false);
      }}
    >
      <DropdownMenu.Trigger className="chip shrink-0" aria-label={label} title={label}>
        <MeterRing fraction={used === null ? null : used / 100} />
        {left !== null && <span className="tabular-nums">{percentText(left)}%</span>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${menuContent} ${detail ? "max-h-[70vh] w-[380px] overflow-y-auto" : "w-[300px]"}`}
          side="top"
          align="end"
          sideOffset={8}
        >
          {detail && view ? (
            // The same card the settings page shows, opened on its detail, so
            // the resets and the readings graph are here rather than elsewhere.
            <PlanCard
              view={view}
              now={state.now}
              busy={state.busy}
              spending={state.spending}
              notice={state.notice}
              error={state.error}
              open
              onToggle={() => setDetail(false)}
              onRefresh={state.refresh}
              onSpend={state.spend}
            />
          ) : (
            <>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-900">ChatGPT plan</span>
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {view?.source.providerName ?? "chatgpt-plus-pro"}
                    {view?.usage?.planType ? ` · ${view.usage.planType}` : ""}
                  </span>
                </span>
                {view && (
                  <button
                    type="button"
                    className="chip shrink-0"
                    onClick={state.refresh}
                    disabled={state.busy || state.spending}
                    aria-label="Read usage again"
                    title="Read usage again"
                  >
                    {state.busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>

              <div className="mt-2.5">{view ? <GptUsageSummary state={state} /> : <GptUsagePending state={state} />}</div>

              {view?.connected && (
                <button type="button" className="mt-2.5 flex w-full items-center gap-1 text-xs text-accent" onClick={() => setDetail(true)}>
                  View resets and readings
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </button>
              )}

              <DropdownMenu.Separator className="my-2.5 h-px bg-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center rounded-lg px-2 py-1.5 text-xs text-ink-700 outline-none data-[highlighted]:bg-surface-tertiary"
                onSelect={() => openSettings("providers")}
              >
                Manage this plan in Settings…
              </DropdownMenu.Item>
              <p className="px-2 pt-1.5 text-[11px] text-muted">
                From your ChatGPT plan, not from what your agents have spent here.
              </p>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
