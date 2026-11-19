/** What the memory web shows while files are fetched, prepared, or drawn.
 *
 * Initial loads, agent switches and errors cover the area, so another agent's
 * memory can never flash through. A same-agent refresh keeps the existing globe
 * visible and usable, marked busy, until the replacement is ready. */
export function memoryWebCoverage(input: { loading: boolean; preparing: boolean; message: string | null; prepared: boolean }): {
  covered: boolean; busy: boolean; status: "Loading memory files…" | "Preparing memory globe…" | null;
} {
  const busy = input.loading || input.preparing;
  const covered = Boolean(input.message) || (busy && !input.prepared);
  const status = input.message || !covered ? null : input.loading ? "Loading memory files…" : "Preparing memory globe…";
  return { covered, busy, status };
}

/** The globe's own drawing overlay shows only before its first successful draw. */
export function globeDrawingState(input: { hasNodes: boolean; settled: unknown; graph: unknown }): { pending: boolean; stale: boolean } {
  return { pending: input.hasNodes && input.settled === null, stale: input.hasNodes && input.settled !== input.graph };
}
