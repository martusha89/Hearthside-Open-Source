/**
 * Decides whether and when to bring the runtime back after it exits
 * unexpectedly. Kept free of process handling so it can be unit-tested.
 *
 * Design: a short, fixed schedule of retries. If the runtime keeps failing
 * inside the budget window we stop and let the person decide, rather than
 * looping forever. A run that stays up for the stability period earns a
 * fresh budget.
 */
export interface RestartPolicyOptions {
  /** Wait before each successive retry. Its length is the retry budget. */
  schedule: readonly number[];
  /** Retries are counted inside this rolling window. */
  budgetWindowMs: number;
  /** Uptime after which earlier failures are forgiven. */
  stableAfterMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicyOptions = {
  schedule: [1_000, 3_000, 10_000, 30_000],
  budgetWindowMs: 10 * 60_000,
  stableAfterMs: 5 * 60_000,
};

export type RestartDecision = { action: "retry"; delayMs: number; attempt: number } | { action: "give-up"; failures: number };

export class RestartPolicy {
  private failures: number[] = [];

  constructor(private readonly options: RestartPolicyOptions = DEFAULT_RESTART_POLICY) {}

  /** Call when the runtime exited unexpectedly after running for `uptimeMs`. */
  decide(now: number, uptimeMs: number): RestartDecision {
    if (uptimeMs >= this.options.stableAfterMs) this.failures = [];
    this.failures = this.failures.filter((at) => now - at < this.options.budgetWindowMs);
    this.failures.push(now);
    const attempt = this.failures.length;
    const delayMs = this.options.schedule[attempt - 1];
    if (delayMs === undefined) return { action: "give-up", failures: attempt };
    return { action: "retry", delayMs, attempt };
  }

  /** A deliberate (re)start wipes the failure history. */
  clear(): void {
    this.failures = [];
  }
}
