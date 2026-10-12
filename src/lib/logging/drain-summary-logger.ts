export const DRAIN_SUMMARY_INTERVAL_MS = 15 * 60_000;

export type DrainSummaryLoggerOptions = {
  now?: () => number;
  info?: (...args: unknown[]) => void;
};

export class DrainSummaryLogger {
  #now: () => number;
  #info: (...args: unknown[]) => void;
  #lastEmitAt: number;
  #counts: Record<string, number> = {};

  constructor(options: DrainSummaryLoggerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#info = options.info ?? ((...args: unknown[]) => console.info(...args));
    this.#lastEmitAt = this.#now();
  }

  /** Carry routine bookkeeping until a state change or the next quiet interval. */
  record(outcomes: readonly string[]): void {
    for (const outcome of outcomes) {
      this.#counts[outcome] = (this.#counts[outcome] ?? 0) + 1;
    }
    const now = this.#now();
    // Only these two kinds are routine: future outcomes must remain visible.
    const stateChanged = outcomes.some((outcome) => outcome !== "DEFERRED" && outcome !== "IDLE");
    if (Object.keys(this.#counts).length > 0 &&
        (stateChanged || now - this.#lastEmitAt >= DRAIN_SUMMARY_INTERVAL_MS)) {
      this.#info("Reconciliation drain", this.#counts);
      this.#counts = {};
      this.#lastEmitAt = now;
    }
  }
}
