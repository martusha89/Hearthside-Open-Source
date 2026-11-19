

export const CLOUD_PAGE_DEADLINE_MS = 60_000;
export const CLOUD_EXPORT_DEADLINE_MS = 5 * 60_000;

export function cloudDeadline(ms: number): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(ms) };
}
