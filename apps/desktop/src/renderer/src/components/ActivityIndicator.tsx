import { useEffect, useMemo, useRef, useState } from "react";
import type { TurnActivityPhase } from "@hearthside/ipc-contract";
import type { ChatRow } from "../types";
import { activityKey, describeActivity, elapsedLabel, isWorkingPhase } from "../lib/activity";

/**
 * Hearthside: the line that says what the agent is doing. Says which tool it's
 * on, counts the seconds, and changes its wording now and then with a soft fade
 * so a long wait doesn't look frozen.
 *
 * When the runtime sends a phase of its own, that decides what the line claims —
 * including the phases that mean the work is happening on another computer,
 * where the playful wording would be a lie about who is doing it. Anything the
 * runtime says at length goes in "Details", folded away: the line stays a line.
 */
export function ActivityIndicator({ activity, rows, phase, detail }: {
  activity: string;
  rows: readonly ChatRow[];
  phase?: TurnActivityPhase | null;
  detail?: string | null;
}) {
  const reported = useMemo(() => ({ phase: phase ?? null, detail: detail ?? null }), [phase, detail]);
  const key = activityKey(activity, rows, reported);
  const [seconds, setSeconds] = useState(0);
  // A different starting phrase each time something new starts.
  const offset = useMemo(() => Math.floor(Math.random() * 8), [key]);
  const started = useRef(Date.now());
  useEffect(() => {
    started.current = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [key]);

  const { phase: shown, text, detail: more } = describeActivity(activity, rows, seconds, offset, reported);
  const elapsed = elapsedLabel(seconds);
  const working = isWorkingPhase(shown);
  return (

    <div className="grid gap-1 text-sm text-ink-700">
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        {/* A pulse means something is happening here. A wait on another computer
            gets a still dot: the beat would imply this window was at work. */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${working ? "animate-pulse bg-accent" : "bg-muted-light"}`} />
        <span key={text} className="animate-fade-in min-w-0">
          {text}
        </span>
        {elapsed && <span className="tabular-nums text-xs text-ink-700">{elapsed}</span>}
      </div>
      {more && (
        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60">Details</summary>
          <p className="mt-1 whitespace-pre-wrap break-words pl-4">{more}</p>
        </details>
      )}
    </div>
  );
}
