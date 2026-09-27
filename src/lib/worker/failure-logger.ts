/**
 * Bounds a site's failure logging to one full report per outage (issue 661).
 *
 * The reconciliation worker's drain hook used to pass every failure straight
 * to console.error, so an unreachable database printed one full stack trace
 * every five-second poll, and recovery was visible only by the errors
 * stopping. This helper keeps the first failure of an outage loud, keeps the
 * outage's continuation visible as one counted line per quiet window, and
 * makes the end of the outage a line of its own instead of an inference from
 * silence.
 */

/**
 * How long a key may go without printing before its next failure carries a
 * one-line summary instead of silence. Failures inside the window after an
 * emission are counted and suppressed; the first failure at or beyond the
 * window prints the summary and restarts the cycle from itself.
 */
export const FAILURE_LOG_QUIET_WINDOW_MS = 60_000;

export type FailureLoggerOptions = {
  /**
   * The clock, in epoch milliseconds. Injected so the state machine's windows
   * are testable without waiting on them; Date.now in production.
   */
  now?: () => number;
  /**
   * Where lines are emitted, shaped like console.error. Injected so tests can
   * capture the lines; console.error in production.
   */
  error?: (...args: unknown[]) => void;
};

/**
 * One key's outstanding outage: when its last line went out, when the outage
 * began, how many failures it has seen in total, and how many since the last
 * of its own emissions. `lastEmitAt` is the anchor the quiet window is
 * measured against, whether the emission was a detail or a summary.
 */
type FailureLogState = {
  lastEmitAt: number;
  outageStartedAt: number;
  totalFailures: number;
  failuresSinceEmission: number;
};

export class FailureLogger {
  #now: () => number;
  #error: (...args: unknown[]) => void;
  readonly #states: Map<string, FailureLogState> = new Map();

  constructor(options: FailureLoggerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#error = options.error ?? ((...args: unknown[]) => console.error(...args));
  }

  /**
   * Records one failure of `key`, printing the first failure of an outage in
   * full — the arguments pass through to the sink unchanged, so a site's line
   * is exactly the line it printed before the bound. Later failures inside the
   * quiet window are counted silently; the first one at or beyond the window
   * prints the key and the count on a single line, no stack, and the cycle
   * restarts from that emission.
   *
   * A failure that arrives between the detail and the summary of the same
   * outage is the same outage continuing, whatever the failure objects say:
   * identity is the key's, not the error's.
   */
  failure(key: string, ...detail: unknown[]): void {
    const now = this.#now();
    const state = this.#states.get(key);
    if (state === undefined) {
      this.#error(...detail);
      this.#states.set(key, {
        lastEmitAt: now,
        outageStartedAt: now,
        totalFailures: 1,
        failuresSinceEmission: 0,
      });
      return;
    }

    if (now - state.lastEmitAt >= FAILURE_LOG_QUIET_WINDOW_MS) {
      // The current failure is included in the count: it is one of the
      // failures that arrived since the last detail.
      const failuresSinceLastDetail = state.failuresSinceEmission + 1;
      this.#error(`still failing: ${key}: ${failuresSinceLastDetail} failures since last detail`);
      state.lastEmitAt = now;
      state.failuresSinceEmission = 0;
    } else {
      state.failuresSinceEmission += 1;
    }
    state.totalFailures += 1;
  }

  /**
   * Records one success of `key`. After a failure, that ends the outage with
   * one line carrying the key, the total failures it saw, and its duration in
   * whole seconds — the operator's positive signal, in place of inferring
   * recovery from the errors stopping. With no failure outstanding, success is
   * the ordinary case and prints nothing at all.
   */
  success(key: string): void {
    const state = this.#states.get(key);
    if (state === undefined) {
      return;
    }
    const recoveredAt = this.#now();
    const durationSeconds = Math.round((recoveredAt - state.outageStartedAt) / 1_000);
    this.#error(`recovered: ${key} after ${state.totalFailures} failures over ${durationSeconds} s`);
    this.#states.delete(key);
  }
}
