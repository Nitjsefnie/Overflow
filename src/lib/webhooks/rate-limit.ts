// Inbound rate limiting for the webhook receivers (issue 852). Each receiver
// keeps one token bucket per sender identity; a delivery is admitted only
// when a token is available, and everything else is declined with 429 so the
// sender retries with backoff. This module is the pure mechanism: a standard
// token bucket with a lazy refill and an injectable clock — no I/O, no
// database, no throw paths. The route wiring (bucket-per-key, 429 mapping)
// is the caller's.
//
// Standard token bucket: refilling is a function of elapsed time alone and
// happens on every admit, whether or not it succeeds — a declined caller's
// elapsed time still accrues, the same as a wall clock filling the bucket
// between deliveries.

/**
 * The webhook receiver's burst size: 60 concurrent deliveries before a
 * sender is declined. Derived from the observed peak minute of 25 deliveries
 * over the 14 days ending 2026-10-01, with a 2.4x margin (25 x 2.4 = 60).
 */
export const WEBHOOK_RATE_LIMIT_CAPACITY = 60;

/**
 * The refill rate: the whole burst is restored after one minute of quiet
 * (60 tokens per minute = one token per second). The observed peak minute of
 * 25 deliveries/minute stays well under it, so a sender at the historical
 * peak is admitted indefinitely without ever draining the bucket.
 */
export const WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE = 60;

export interface TokenBucketOptions {
  /** Maximum tokens held at once; the bucket starts full. */
  capacity: number;
  /** Tokens restored per 60,000 ms of elapsed time, capped at capacity. */
  refillPerMinute: number;
  /**
   * The injectable clock. Read once at construction (the bucket's birth
   * instant) and again on every admit() that is not given an explicit
   * timestamp.
   */
  nowMs: () => number;
}

export interface TokenBucket {
  /**
   * Attempts to consume one token. True when admitted, false when the bucket
   * is empty (the caller maps that to 429). With an explicit nowMs the call
   * is evaluated at that instant; without one, the injected clock is read.
   */
  admit(nowMs?: number): boolean;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { capacity, refillPerMinute, nowMs: clockMs } = options;
  // Full at birth; the anchor for the lazy refill. The anchor only ever
  // moves forward (see the clamp below), so a backwards step in time grants
  // nothing and later refills are measured from the newest instant seen.
  let tokens = capacity;
  let anchorMs = clockMs();

  return {
    admit(nowMs?: number): boolean {
      const atMs = nowMs ?? clockMs();
      const elapsed = Math.max(0, atMs - anchorMs);
      tokens = Math.min(capacity, tokens + (elapsed / 60_000) * refillPerMinute);
      anchorMs += elapsed;

      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
