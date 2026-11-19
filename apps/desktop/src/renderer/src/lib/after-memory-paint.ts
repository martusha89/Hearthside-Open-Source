/** Two frames leave a paint opportunity before synchronous graph/scene work.
 * A single rAF runs before paint, so it can still hide the loading feedback. */
export function afterMemoryPaint(work: () => void): () => void {
  let cancelled = false;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => { if (!cancelled) work(); });
  });
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}
