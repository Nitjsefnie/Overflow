// Inbound rate limiting for the webhook receivers (issue 852). Each receiver
// keeps a single token bucket SHARED by all of its senders: a delivery is
// admitted only when a token is available, and everything else is declined
// with 429 so the sender retries with backoff.
//
// The sharing is deliberate. Senders are unauthenticated at this boundary, so
// a per-sender key would have to be derived from the request IP — trivially
// spoofable, and every spoofed identity gets its own fresh budget. A shared
// total bound is the stricter guarantee against the defect the issue actually
// reports: unbounded aggregate spend against the database. The accepted
// tradeoff is that a sustained flood competes for every refilled token, so
// legitimate deliveries can be delayed; the senders' retry behavior and the
// reconciliation sweeps bound that delay.
//
// This module is the pure mechanism: a standard token bucket with a lazy
// refill and an injectable clock — no I/O, no database, no throw paths. The
// route wiring (one shared bucket per receiver, the 429 mapping) is the
// caller's.
//
// Issue 1054 generalises the same mechanism into a keyed limiter for the
// expensive routes: one bucket PER KEY, with the burst size and refill rate
// of each key's class supplied by the caller on every admit (the route layer
// derives them from configuration). The keys are caller-assigned identities,
// so the per-key isolation is only as strong as the key derivation — an
// unauthenticated, spoofable key buys nothing, which is why the webhook
// receivers above keep their deliberately shared single bucket.
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

// The lazy refill shared by the standalone bucket and the keyed limiter —
// ONE implementation of the mechanics, so the two shapes cannot drift. The
// anchor only ever moves forward (the clamp below), so a backwards step in
// time grants nothing and later refills are measured from the newest instant
// seen; full at birth (tokens = capacity).
interface BucketState {
  tokens: number;
  anchorMs: number;
}

function refillTo(
  state: BucketState,
  atMs: number,
  capacity: number,
  refillPerMinute: number,
): void {
  const elapsed = Math.max(0, atMs - state.anchorMs);
  state.tokens = Math.min(capacity, state.tokens + (elapsed / 60_000) * refillPerMinute);
  state.anchorMs += elapsed;
}

/**
 * Seconds until the bucket next admits, as a ceiling: the deficit to one
 * token converted at the refill rate. `Infinity` when `refillPerMinute` is
 * 0 — a bucket that never refills never admits again. Only meaningful after
 * a decline (a decline guarantees tokens < 1, so the deficit is positive).
 */
function secondsUntilNextAdmit(tokens: number, refillPerMinute: number): number {
  return Math.ceil((((1 - tokens) / refillPerMinute) * 60_000) / 1000);
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { capacity, refillPerMinute, nowMs: clockMs } = options;
  const state: BucketState = { tokens: capacity, anchorMs: clockMs() };

  return {
    admit(nowMs?: number): boolean {
      const atMs = nowMs ?? clockMs();
      refillTo(state, atMs, capacity, refillPerMinute);
      if (state.tokens >= 1) {
        state.tokens -= 1;
        return true;
      }
      return false;
    },
  };
}

export interface RateLimiterOptions {
  /**
   * The injectable clock, shared by every key. Read once when a key's bucket
   * is created (its birth instant) and again on every admit() that is not
   * given an explicit timestamp.
   */
  nowMs: () => number;
}

export interface AdmitOptions {
  /**
   * The burst size and refill rate of the class the CALLER has assigned this
   * key to. Taken from the call that first sees the key and fixed for the
   * key's lifetime — later calls passing different values reuse the existing
   * bucket rather than recreating it, since a recreation would hand the key
   * a fresh budget and defeat the limit.
   */
  capacity: number;
  /** Tokens restored per 60,000 ms of elapsed time, capped at capacity. */
  refillPerMinute: number;
  /**
   * Evaluated at this instant when given; otherwise the limiter's injected
   * clock is read.
   */
  nowMs?: number;
}

export interface AdmitResult {
  /** False when the key's bucket had no token to spare (the 429 mapping). */
  allowed: boolean;
  /**
   * Seconds until the key's bucket next admits — the ceil of the refill
   * math, so a client can act on it — and 0 when allowed.
   */
  retryAfterSeconds: number;
  /**
   * True only on the TRANSITION into the declined state for this key: the
   * once-per-burst signal a route uses to log a decline burst exactly once.
   * Any admit leaves the burst (a recovery resets it), so a renewed decline
   * after a refilled token starts a new burst.
   */
  firstDecline: boolean;
}

export interface RateLimiter {
  /**
   * Consumes one token from the key's own bucket, creating that bucket fresh
   * on first sight of the key. No pre-registration: the first sight is a
   * full bucket.
   */
  admit(key: string, options: AdmitOptions): AdmitResult;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { nowMs: clockMs } = options;
  const buckets = new Map<string, KeyedBucket>();

  return {
    admit(key: string, admitOptions: AdmitOptions): AdmitResult {
      let entry = buckets.get(key);
      if (!entry) {
        // First sight of the key: a full bucket born at the clock's current
        // instant, with the class parameters the caller carried on this call.
        entry = {
          capacity: admitOptions.capacity,
          refillPerMinute: admitOptions.refillPerMinute,
          state: { tokens: admitOptions.capacity, anchorMs: clockMs() },
          declining: false,
        };
        buckets.set(key, entry);
      }
      const atMs = admitOptions.nowMs ?? clockMs();
      refillTo(entry.state, atMs, entry.capacity, entry.refillPerMinute);
      const allowed = entry.state.tokens >= 1;
      if (allowed) {
        entry.state.tokens -= 1;
      }

      const firstDecline = !allowed && !entry.declining;
      entry.declining = !allowed;
      return {
        allowed,
        retryAfterSeconds: allowed
          ? 0
          : secondsUntilNextAdmit(entry.state.tokens, entry.refillPerMinute),
        firstDecline,
      };
    },
  };
}

interface KeyedBucket {
  capacity: number;
  refillPerMinute: number;
  state: BucketState;
  /** Whether the key's previous admit was a decline — the burst tracker. */
  declining: boolean;
}
