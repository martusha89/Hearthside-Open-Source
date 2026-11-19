import { useCallback, useEffect, useRef, useState } from "react";
import type { GptUsageReading, GptUsageReset, GptUsageView, GptUsageWindow, ProviderSummary } from "../types";
import { CheckIcon, ChevronRightIcon, ClockIcon, RefreshIcon, Spinner } from "./icons";

/**
 * Hearthside: what's left of a ChatGPT Plus/Pro plan, and the manual usage
 * resets it has been granted.
 *
 * Every number here is one ChatGPT reported through the runtime. A window the
 * plan doesn't give a percentage for says so; the graph is only the readings
 * Hearthside actually took on this computer — one each time this panel is
 * opened or refreshed, because ChatGPT reports the present state and keeps no
 * history, and nothing here polls it in the background. Spending a reset takes
 * a press and then a confirmation, and it names the exact reset being spent.
 */

/** The ChatGPT subscription entries in the provider lists (this computer, Letta Cloud). */
const CHATGPT_PROVIDER_IDS = ["openai-codex-oauth", "codex"];
const CHATGPT_PROVIDER_NAMES = ["chatgpt-plus-pro", "openai-codex"];

export function isChatGptProvider(provider: ProviderSummary): boolean {
  return (
    CHATGPT_PROVIDER_IDS.includes(provider.id) ||
    provider.connections.some((connection) => CHATGPT_PROVIDER_NAMES.includes(connection.name))
  );
}

const MINUTES_IN_DAY = 1440;

/** A window named by how long it is, falling back to the name the plan gave it. */
export function windowTitle(quota: GptUsageWindow): string {
  const minutes = quota.windowMinutes;
  if (minutes === null) {
    const label = quota.label.replace(/_/g, " ").trim();
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Limit";
  }
  if (minutes === 7 * MINUTES_IN_DAY) return "Weekly";
  if (minutes === MINUTES_IN_DAY) return "Daily";
  if (minutes === 60) return "Hourly";
  if (minutes % MINUTES_IN_DAY === 0) return `Every ${minutes / MINUTES_IN_DAY} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${Math.round(minutes)} minutes`;
}

/** Percentages as the runtime writes them: whole numbers unless the tenth matters. */
export function percentText(value: number): string {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? String(rounded) : value.toFixed(1);
}

export function percentLeft(quota: GptUsageWindow): number | null {
  return quota.usedPercent === null ? null : Math.max(0, 100 - quota.usedPercent);
}

/**
 * "in 5 days", "in 3 hours", "in 12 minutes" — the same rounding the runtime
 * uses. Null for a time that can't be read, so nothing is said about it.
 */
export function distanceWords(fromMs: number, toMs: number): string | null {
  const delta = toMs - fromMs;
  if (!Number.isFinite(delta)) return null;
  if (delta <= 0) return "now";
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

function dateWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function timeWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "expires in 3 days", or "expired", for a reset's own deadline. */
export function expiryWords(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt) return null;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return null;
  return expires <= nowMs ? "expired" : `expires ${distanceWords(nowMs, expires)}`;
}

/**
 * The meter's colour carries how close the window is to full, on the app's
 * status ramp. The percentage and the reset time are always written beside it,
 * so the colour is never the only thing saying it.
 */
export function severityColour(usedPercent: number | null): string {
  if (usedPercent === null) return "var(--color-muted)";
  if (usedPercent > 85) return "var(--color-error)";
  if (usedPercent > 65) return "var(--color-warning)";
  return "var(--color-accent)";
}

/**
 * The window closest to its limit — what a one-line summary has to be about,
 * because that is the one that will stop a reply. Windows without a percentage
 * can't be compared, so they are never chosen over one that has it.
 */
export function tightestWindow(windows: readonly GptUsageWindow[]): GptUsageWindow | null {
  const measured = windows.filter((quota) => quota.usedPercent !== null);
  if (measured.length === 0) return null;
  return measured.reduce((worst, quota) => ((quota.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? quota : worst));
}

/** The resets that can be spent now, soonest to expire first (the runtime's rule). */
export function spendable(resets: GptUsageReset[], nowMs: number): GptUsageReset[] {
  return resets
    .filter((reset) => reset.status === "available")
    .filter((reset) => !reset.expiresAt || Date.parse(reset.expiresAt) > nowMs)
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));
}

export type ChartPoint = { at: number; left: number; x: number; y: number };
export type ChartGeometry = { points: ChartPoint[]; line: string; area: string };

const CHART = { width: 420, height: 96, padTop: 8, padBottom: 8 };

/**
 * The kept readings of one window as a line of "percent left" over time.
 * Null below two readings: one point is not a trend, and nothing is drawn
 * between readings that were never taken.
 */
export function chartGeometry(readings: readonly GptUsageReading[], label: string): ChartGeometry | null {
  const series = readings
    .filter((reading) => reading.label === label)
    .map((reading) => ({ at: Date.parse(reading.at), left: Math.max(0, 100 - reading.usedPercent) }))
    .filter((reading) => Number.isFinite(reading.at))
    .sort((a, b) => a.at - b.at);
  if (series.length < 2) return null;
  const first = series[0]!.at;
  const span = series[series.length - 1]!.at - first;
  const plot = CHART.height - CHART.padTop - CHART.padBottom;
  const points = series.map((reading) => ({
    ...reading,
    x: span === 0 ? CHART.width : (reading.at - first) / span * CHART.width,
    y: CHART.padTop + plot * (1 - reading.left / 100),
  }));
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points[points.length - 1]!.x.toFixed(1)} ${CHART.height - CHART.padBottom} L${points[0]!.x.toFixed(1)} ${CHART.height - CHART.padBottom} Z`;
  return { points, line, area };
}

/**
 * The bar is what's left, because that is what the figure beside it says: a
 * window reading "87% left" has to look nearly full, not nearly empty. The
 * colour is still keyed on how much has been used, so a window close to its
 * limit turns amber and then red as a short bar.
 */
function Meter({ quota }: { quota: GptUsageWindow }) {
  const used = quota.usedPercent;
  const left = percentLeft(quota);
  const colour = severityColour(used);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded"
      style={{ background: `color-mix(in srgb, ${colour} 16%, var(--color-surface))` }}
      role="img"
      aria-label={left === null ? `${windowTitle(quota)}: no percentage reported` : `${windowTitle(quota)}: ${percentText(left)}% left`}
    >
      {left !== null && (
        <div
          className="h-full rounded-r"
          style={{ width: `${Math.max(left > 0 ? 1 : 0, left)}%`, background: colour }}
        />
      )}
    </div>
  );
}

function WindowRow({ quota, now }: { quota: GptUsageWindow; now: number }) {
  const left = percentLeft(quota);
  const resetsIn = quota.resetsAt ? distanceWords(now, Date.parse(quota.resetsAt)) : null;
  return (
    <div className="grid grid-cols-1 gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-800">{windowTitle(quota)}</span>
        <span className="text-xs text-ink-700">
          {left === null ? (
            <span className="text-muted">No percentage reported</span>
          ) : (
            <>
              <span className="font-medium">{percentText(left)}% left</span>
              {resetsIn && <span className="text-muted"> · resets {resetsIn}</span>}
            </>
          )}
        </span>
      </div>
      <Meter quota={quota} />
      {quota.resetsAt && <p className="text-[11px] text-muted">Resets {dateWords(quota.resetsAt)}</p>}
    </div>
  );
}

/** The readings this computer kept for one window, as a line with its table twin. */
function ReadingsChart({ readings, quota }: { readings: readonly GptUsageReading[]; quota: GptUsageWindow }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const geometry = chartGeometry(readings, quota.label);
  const rows = readings.filter((reading) => reading.label === quota.label);

  if (!geometry) {
    return (
      <p className="text-[11px] text-muted">
        {rows.length === 1
          ? "One reading so far. The graph starts once a second one has been taken — Refresh takes one now."
          : "No readings kept yet. Hearthside draws this from the readings it takes when you open or refresh this panel — ChatGPT reports only the present state."}
      </p>
    );
  }

  const last = geometry.points[geometry.points.length - 1]!;
  const shown = hover === null ? null : geometry.points[hover];
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">
          Percent left, from {geometry.points.length} readings Hearthside took on this connection
        </span>
        <button type="button" className="text-[11px] text-accent underline" onClick={() => setTable(!table)}>
          {table ? "Hide readings" : "Show readings"}
        </button>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          className="h-24 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Percent left across ${geometry.points.length} readings: from ${percentText(geometry.points[0]!.left)}% to ${percentText(
            geometry.points[geometry.points.length - 1]!.left,
          )}%. The readings table has every value.`}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * CHART.width;
            let nearest = 0;
            for (let index = 1; index < geometry.points.length; index += 1) {
              if (Math.abs(geometry.points[index]!.x - x) < Math.abs(geometry.points[nearest]!.x - x)) nearest = index;
            }
            setHover(nearest);
          }}
        >
          {[0, 50, 100].map((percent) => {
            const y = CHART.padTop + (CHART.height - CHART.padTop - CHART.padBottom) * (1 - percent / 100);
            return <line key={percent} x1="0" x2={CHART.width} y1={y} y2={y} stroke="var(--color-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
          })}
          <path d={geometry.area} fill="var(--color-accent)" opacity="0.1" />
          <path d={geometry.line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {shown && <line x1={shown.x} x2={shown.x} y1="0" y2={CHART.height} stroke="var(--color-border-hover)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          <circle cx={last.x} cy={last.y} r="4" fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth="2" />
          {shown && shown !== last && (
            <circle cx={shown.x} cy={shown.y} r="4" fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth="2" />
          )}
        </svg>
        {/* The scale, so a flat line can't be mistaken for a full or empty one. */}
        <span className="pointer-events-none absolute left-0 top-0 bg-surface px-0.5 text-[10px] text-muted tabular-nums">100%</span>
        <span className="pointer-events-none absolute bottom-0 left-0 bg-surface px-0.5 text-[10px] text-muted tabular-nums">0%</span>
        <span className="pointer-events-none absolute right-0 top-0 rounded bg-surface px-1 text-[11px] font-medium text-ink-800 tabular-nums">
          {percentText(shown ? shown.left : last.left)}% left
          {shown && <span className="font-normal text-muted"> · {timeWords(new Date(shown.at).toISOString())}</span>}
        </span>
      </div>
      {table && (
        <table className="w-full text-[11px] text-ink-700">
          <thead>
            <tr className="text-left text-muted">
              <th className="font-normal">Reading</th>
              <th className="font-normal">Percent left</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {[...rows].reverse().map((reading) => (
              <tr key={reading.at}>
                <td>{timeWords(reading.at)}</td>
                <td>{percentText(Math.max(0, 100 - reading.usedPercent))}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Failure({ title, message, onRetry, busy }: { title: string; message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="grid gap-1.5 rounded-lg bg-surface-tertiary px-3 py-2">
      <p className="text-xs font-medium text-ink-800">{title}</p>
      <p className="break-words text-xs text-muted">{message}</p>
      <div>
        <button type="button" className="button-secondary" onClick={onRetry} disabled={busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Try again
        </button>
      </div>
    </div>
  );
}

/** One reset, with the two presses it takes to spend it. */
function ResetRow({
  reset,
  now,
  busy,
  onSpend,
}: {
  reset: GptUsageReset;
  now: number;
  busy: boolean;
  onSpend: (reset: GptUsageReset) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const expiry = expiryWords(reset.expiresAt, now);
  return (
    <div className="grid gap-2 rounded-lg bg-surface-tertiary px-3 py-2">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ink-900">{reset.title ?? "Usage reset"}</span>
          {reset.description && <span className="block text-[11px] text-muted">{reset.description}</span>}
          <span className="block text-[11px] text-muted">
            Granted {timeWords(reset.grantedAt)}
            {expiry ? ` · ${expiry}` : ""}
          </span>
        </span>
        {!confirming && (
          <button type="button" className="button-secondary shrink-0" disabled={busy} onClick={() => setConfirming(true)}>
            Use this reset
          </button>
        )}
      </div>
      {confirming && (
        <div className="grid gap-2 border-t border-border pt-2">
          <p className="text-xs text-ink-800">
            Use this reset now? It spends one of the resets on your ChatGPT plan, which can't be undone from here. It
            clears the limit you've hit — if you aren't limited right now, ChatGPT keeps the reset.
          </p>
          <div className="flex gap-2">
            <button type="button" className="button-primary" disabled={busy} onClick={() => onSpend(reset)}>
              {busy && <Spinner className="h-3.5 w-3.5" />}
              Yes, use this reset
            </button>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PlanCardProps = {
  view: GptUsageView;
  /** Taken with the reading, so "resets in 5 hours" is measured from one moment. */
  now: number;
  busy: boolean;
  spending: boolean;
  notice: { tone: "success" | "info" | "warning"; message: string } | null;
  error: string | null;
  open: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onSpend: (reset: GptUsageReset) => void;
};

/**
 * The plan as it reads to the person. Separate from the panel below so what is
 * shown for a given reading can be checked without a runtime behind it.
 */
export function PlanCard({ view, now, busy, spending, notice, error, open, onToggle, onRefresh, onSpend }: PlanCardProps) {
  if (!view.connected) {
    return (
      <div className="grid gap-2 rounded-lg bg-surface-tertiary px-3 py-2">
        <p className="text-xs text-muted">
          {view.usageError
            ? view.usageError.message
            : `Usage and resets show here once a ChatGPT Plus or Pro plan is ${view.source.where}.`}
        </p>
        {/* Nothing was read, and the reason may have passed — offer the read again. */}
        {view.usageError && (
          <button type="button" className="button-secondary justify-self-start" onClick={onRefresh} disabled={busy}>
            {busy && <Spinner className="h-3.5 w-3.5" />}
            Try again
          </button>
        )}
      </div>
    );
  }

  const usage = view.usage;
  const resets = view.resets;
  // Without the view's handle a reset cannot be spent at all, so none is offered.
  const available = resets && view.token ? spendable(resets.credits, now) : [];
  const windows = usage?.windows ?? [];

  return (
    // grid-cols-1 is minmax(0,1fr): without it a long provider line or a wide
    // chart makes the single column outgrow its container, which a narrow
    // parent (the composer's popover) then clips the figures off the side of.
    <section className="grid grid-cols-1 gap-2.5 rounded-xl border border-border px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ink-900">
            Plan usage
            {usage?.planType && <span className="ml-1.5 rounded bg-accent-light px-1.5 py-0.5 text-[11px] font-medium text-accent">{usage.planType}</span>}
          </span>
          <span className="block truncate font-mono text-[11px] text-muted">
            {view.source.providerName} · {view.source.where}
          </span>
        </span>
        <button
          type="button"
          className="button-secondary shrink-0"
          onClick={onRefresh}
          disabled={busy || spending}
          aria-label="Read usage again"
          title="Read usage again"
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {usage?.limitReached === true && (
        <p className="rounded-lg bg-error-light px-3 py-2 text-xs text-error">
          ChatGPT says this plan is rate limited right now
          {usage.limitReachedType ? ` (${usage.limitReachedType.replace(/_/g, " ")})` : ""}. A reset clears it, if one is available.
        </p>
      )}

      {view.usageError && <Failure title="Usage couldn't be read" message={view.usageError.message} onRetry={onRefresh} busy={busy} />}

      {usage && windows.length === 0 && !view.usageError && (
        <p className="text-xs text-muted">This plan reported no usage window. The runtime's own reading: {usage.summary || "nothing to show"}.</p>
      )}

      {windows.map((quota) => (
        <WindowRow key={quota.label} quota={quota} now={now} />
      ))}

      <div className="flex items-center gap-2 text-xs">
        <ClockIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
        {view.resetsError ? (
          <span className="text-muted">Resets couldn't be read: {view.resetsError.message}</span>
        ) : (
          <span className="text-ink-700">
            {available.length === 0 ? "No resets available" : `${available.length} reset${available.length === 1 ? "" : "s"} available`}
            {available[0]?.expiresAt && <span className="text-muted"> · next {expiryWords(available[0].expiresAt, now)}</span>}
          </span>
        )}
        <button type="button" className="ml-auto flex items-center gap-1 text-xs text-accent" onClick={onToggle} aria-expanded={open}>
          {open ? "Hide" : "View"}
          <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      </div>

      {notice && (
        <p
          className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ${
            notice.tone === "success"
              ? "bg-success-light text-success"
              : notice.tone === "warning"
                ? "bg-warning-light text-warning-strong"
                : "bg-surface-tertiary text-ink-700"
          }`}
        >
          {notice.tone === "success" && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {notice.message}
        </p>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}

      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-border pt-2.5">
          {windows.map((quota) => (
            <div key={quota.label} className="grid grid-cols-1 gap-1">
              <span className="text-xs font-medium text-ink-800">{windowTitle(quota)} over time</span>
              <ReadingsChart readings={view.readings} quota={quota} />
            </div>
          ))}

          {usage?.spendLimit && (
            <p className="text-xs text-ink-700">
              Spend limit: {usage.spendLimit.used} of {usage.spendLimit.limit} used ({percentText(usage.spendLimit.remainingPercent)}% left), resets{" "}
              {dateWords(usage.spendLimit.resetsAt)}.
            </p>
          )}

          <div className="grid grid-cols-1 gap-2">
            <span className="text-xs font-medium text-ink-800">Resets</span>
            {available.length === 0 ? (
              <p className="text-xs text-muted">
                {resets && resets.credits.length > 0
                  ? "None of this plan's resets can be used now. ChatGPT grants them; Hearthside only shows and spends them."
                  : "ChatGPT hasn't granted this plan any resets. Hearthside can't create one."}
              </p>
            ) : (
              available.map((reset) => <ResetRow key={reset.id} reset={reset} now={now} busy={spending} onSpend={onSpend} />)
            )}
          </div>

          {usage && (
            <p className="text-[11px] text-muted">
              Read {timeWords(usage.fetchedAt)}. These figures come from your ChatGPT plan, not from what your agents have spent here.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export type GptUsageState = {
  view: GptUsageView | null;
  error: string | null;
  busy: boolean;
  spending: boolean;
  notice: { tone: "success" | "info" | "warning"; message: string } | null;
  /** Taken with each reading, so every "resets in 5 hours" is from one moment. */
  now: number;
  refresh: () => void;
  spend: (reset: GptUsageReset) => void;
};

/**
 * Reading a plan, and spending one of its resets — the whole of what the panel
 * and the composer's usage button both do with the bridge, in one place, so
 * the two can never drift into saying different things about the same plan.
 *
 * `enabled` is what defers the first read. ChatGPT reports the present state
 * and keeps no history, so every read is a reading Hearthside keeps: the
 * button in the composer must not take one merely by existing on screen, only
 * when somebody opens it. Nothing here polls.
 */
export function useGptUsage(enabled: boolean): GptUsageState {
  const [view, setView] = useState<GptUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [spending, setSpending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "info" | "warning"; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.bridge.getGptUsage(refresh);
      if (!mounted.current) return;
      setView(next);
      setNow(Date.now());
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load(false);
  }, [enabled, load]);

  // "resets in 5 minutes" would quietly go stale on an open panel.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);

  const spend = useCallback(
    async (reset: GptUsageReset) => {
      // The press carries the handle of the view it was made in, so it can only
      // ever act on the plan these figures were actually read from.
      if (!view?.source.providerName || !view.token) return;
      setSpending(true);
      setNotice(null);
      setError(null);
      try {
        const outcome = await window.bridge.useGptReset({
          providerName: view.source.providerName,
          resetId: reset.id,
          token: view.token,
          confirm: "use-one-reset",
        });
        if (!mounted.current) return;
        setView(outcome.view);
        setNotice({ tone: outcome.tone, message: outcome.message });
        setNow(Date.now());
      } catch (failure) {
        if (mounted.current) setError(errorMessage(failure));
      } finally {
        if (mounted.current) setSpending(false);
      }
    },
    [view],
  );

  return {
    view,
    error,
    busy,
    spending,
    notice,
    now,
    refresh: () => void load(true),
    spend: (reset) => void spend(reset),
  };
}

/**
 * What to show while a plan hasn't been read yet, or couldn't be: a spinner
 * for the first read, the reason with a way to ask again for a failure, and
 * null when there is simply nothing to say. Shared so the composer's popover
 * and the settings panel are honest in the same words.
 */
export function GptUsagePending({ state }: { state: GptUsageState }) {
  if (state.busy && !state.view) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="h-4 w-4 text-muted" />
      </div>
    );
  }
  if (state.error && !state.view) {
    return <Failure title="Usage couldn't be read" message={state.error} onRetry={state.refresh} busy={state.busy} />;
  }
  return null;
}

/** ChatGPT plan usage for the connected subscription, with its resets. */
export function GptUsagePanel() {
  const state = useGptUsage(true);
  const [open, setOpen] = useState(false);

  if (!state.view) return <GptUsagePending state={state} />;

  return (
    <PlanCard
      view={state.view}
      now={state.now}
      busy={state.busy}
      spending={state.spending}
      notice={state.notice}
      error={state.error}
      open={open}
      onToggle={() => setOpen(!open)}
      onRefresh={state.refresh}
      onSpend={state.spend}
    />
  );
}
