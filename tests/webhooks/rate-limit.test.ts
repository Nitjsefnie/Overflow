import { describe, expect, it } from "vitest";
import {
  WEBHOOK_RATE_LIMIT_CAPACITY,
  WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
  createRateLimiter,
  createTokenBucket,
} from "@/lib/webhooks/rate-limit";

function clockFrozenAt(ms: number): () => number {
  return () => ms;
}

// A controllable clock for the injectable one the bucket is constructed
// with: admit() reads it, admit(nowMs) overrides it per call.
function controllableClock(startMs: number) {
  let now = startMs;
  return {
    advance(ms: number): void {
      now += ms;
    },
    read(): number {
      return now;
    },
  };
}

// Drains the bucket through admit() itself and reports how many tokens were
// actually grantable at that instant — no white-box peeking at internals.
function drainToExhaustion(
  bucket: { admit(nowMs?: number): boolean },
  nowMs: number,
): number {
  let granted = 0;
  while (bucket.admit(nowMs)) {
    granted += 1;
    if (granted > 10_000) throw new Error("bucket never exhausted; runaway admit loop");
  }
  return granted;
}

describe("createTokenBucket", () => {
  it("admits a burst up to capacity and declines the next admit in the same instant", () => {
    const bucket = createTokenBucket({
      capacity: 60,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(1_000_000),
    });

    const burst: boolean[] = [];
    for (let i = 0; i < 60; i += 1) burst.push(bucket.admit(1_000_000));
    expect(burst).toEqual(Array.from({ length: 60 }, () => true));
    expect(bucket.admit(1_000_000)).toBe(false);
  });

  it("grants exactly capacity tokens even after a long idle gap", () => {
    const bucket = createTokenBucket({
      capacity: 60,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(1_000_000),
    });

    // Nine hours pass before the first delivery: 540 tokens would accrue if
    // the bucket could hold more than capacity.
    expect(drainToExhaustion(bucket, 1_000_000 + 9 * 60 * 60 * 1000)).toBe(60);
  });

  it("refills tokens over elapsed time at refillPerMinute per minute", () => {
    const bucket = createTokenBucket({
      capacity: 3,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(0),
    });

    expect(drainToExhaustion(bucket, 0)).toBe(3);
    // One second later exactly one token has accrued: the next delivery is
    // admitted and the one after it — same instant — is not.
    expect(bucket.admit(1000)).toBe(true);
    expect(bucket.admit(1000)).toBe(false);
    // Half a second grants only half a token, which is not enough to admit.
    expect(bucket.admit(1500)).toBe(false);
    // Another half second completes the next token.
    expect(bucket.admit(2000)).toBe(true);
  });

  it("caps the refill at capacity — idle time never overfills", () => {
    const bucket = createTokenBucket({
      capacity: 3,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(0),
    });

    expect(drainToExhaustion(bucket, 0)).toBe(3);
    // Twenty minutes of idle would refill 20 tokens without the cap; the
    // bucket still holds exactly capacity.
    expect(drainToExhaustion(bucket, 20 * 60_000)).toBe(3);
  });

  it("reads the injected clock when admit is called without a timestamp", () => {
    const clock = controllableClock(0);
    const bucket = createTokenBucket({
      capacity: 2,
      refillPerMinute: 60,
      nowMs: clock.read,
    });

    expect(bucket.admit()).toBe(true);
    expect(bucket.admit()).toBe(true);
    expect(bucket.admit()).toBe(false); // empty at t=0
    clock.advance(1000);
    expect(bucket.admit()).toBe(true); // one token refilled by t=1000
    expect(bucket.admit()).toBe(false);
  });

  it("lets an explicit admit(nowMs) win over the injected clock", () => {
    const bucket = createTokenBucket({
      capacity: 2,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(0),
    });

    expect(bucket.admit(500)).toBe(true);
    expect(bucket.admit(500)).toBe(true);
    expect(bucket.admit(500)).toBe(false); // empty at t=500 per the explicit timestamp
    // The explicit t=1500 (one second later) refills one token even though the
    // injected clock still reads 0 — the explicit timestamp wins entirely.
    expect(bucket.admit(1500)).toBe(true);
    expect(bucket.admit(1500)).toBe(false);
  });

  it("grants nothing across a backwards step in time and stays consistent", () => {
    const bucket = createTokenBucket({
      capacity: 2,
      refillPerMinute: 60,
      nowMs: clockFrozenAt(0),
    });

    expect(bucket.admit(1000)).toBe(true);
    expect(bucket.admit(1000)).toBe(true);
    expect(bucket.admit(1000)).toBe(false);
    // t=500 is earlier than the bucket's newest t=1000: no negative elapsed
    // time, no throw, and the refill anchor stays pinned at the newest
    // t=1000. The next assertion is what discriminates that: measured from
    // the anchor, half a second after t=1000 refills only half a token — an
    // anchor wrongly left at t=500 would refill a full token here.
    expect(bucket.admit(500)).toBe(false);
    expect(bucket.admit(1500)).toBe(false);
    // One second after the newest t=1000 (not after t=500): exactly one token.
    expect(bucket.admit(2000)).toBe(true);
    expect(bucket.admit(2000)).toBe(false);
  });

  it("exports the webhook limits as 60 capacity / 60 per minute", () => {
    expect(WEBHOOK_RATE_LIMIT_CAPACITY).toBe(60);
    expect(WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE).toBe(60);
  });
});

describe("createRateLimiter", () => {
  it("keeps one bucket per key: draining key A never declines key B", () => {
    const limiter = createRateLimiter({ nowMs: clockFrozenAt(0) });
    const burst = { capacity: 2, refillPerMinute: 60 };

    // A's budget is spent to the last token at t=0 ...
    expect(limiter.admit("a", { ...burst, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("a", { ...burst, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("a", { ...burst, nowMs: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      firstDecline: true,
    });
    // ... and B, met for the first time at that same instant, still has a
    // full budget of its own — nothing about A's decline carries over.
    expect(limiter.admit("b", { ...burst, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("b", { ...burst, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("b", { ...burst, nowMs: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      firstDecline: true,
    });
  });

  it("reports retryAfterSeconds as the ceil of the time to the next token", () => {
    const limiter = createRateLimiter({ nowMs: clockFrozenAt(0) });

    // Drain a 2-token bucket at t=0. The third admit at t=0 is one full
    // second away from a token (60/min = 1/s).
    expect(limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(true);
    expect(
      limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 0 }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    // 400 ms later only 0.4 of the token is back: still 0.6 short, which
    // rounds up to 1 s.
    expect(
      limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 400 }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    // By t=900 the deficit is 0.1 tokens = 100 ms, which still rounds up to
    // a whole second.
    expect(
      limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 900 }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    // At t=1500 the accrued 1.5 tokens admit; a client acting on the earlier
    // retryAfterSeconds (1 s from t=900) lands inside that window.
    expect(
      limiter.admit("k", { capacity: 2, refillPerMinute: 60, nowMs: 1500 }),
    ).toMatchObject({ allowed: true, retryAfterSeconds: 0 });
    // A slower class shows the math is not hardwired to 1 s: 30/min = one
    // token per 2 s, so an empty bucket reports 2.
    expect(limiter.admit("slow", { capacity: 1, refillPerMinute: 30, nowMs: 0 }).allowed).toBe(
      true,
    );
    expect(limiter.admit("slow", { capacity: 1, refillPerMinute: 30, nowMs: 0 })).toMatchObject({
      allowed: false,
      retryAfterSeconds: 2,
    });
    // Halfway to that token the remaining second still rounds up to 1.
    expect(limiter.admit("slow", { capacity: 1, refillPerMinute: 30, nowMs: 1000 })).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("sets firstDecline once per decline burst: true, false, recovery, true again", () => {
    const limiter = createRateLimiter({ nowMs: clockFrozenAt(0) });
    const burst = { capacity: 2, refillPerMinute: 60 };

    expect(limiter.admit("k", { ...burst, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("k", { ...burst, nowMs: 0 }).allowed).toBe(true);
    // The transition into the declined state: the first decline of the burst.
    expect(limiter.admit("k", { ...burst, nowMs: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      firstDecline: true,
    });
    // Still declining at the same instant: not the transition again.
    expect(limiter.admit("k", { ...burst, nowMs: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      firstDecline: false,
    });
    // A refilled token admits, and with it the key is back in the admitting
    // state — the next decline is a fresh burst's beginning.
    expect(limiter.admit("k", { ...burst, nowMs: 1000 })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      firstDecline: false,
    });
    expect(limiter.admit("k", { ...burst, nowMs: 1000 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      firstDecline: true,
    });
  });

  it("creates a key's bucket fresh on first sight with the caller's class parameters", () => {
    const limiter = createRateLimiter({ nowMs: clockFrozenAt(0) });

    // No pre-registration: the first admit for a key is served from a full
    // bucket sized by the parameters carried on that very call.
    expect(limiter.admit("one", { capacity: 1, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(true);
    expect(limiter.admit("one", { capacity: 1, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(
      false,
    );
    // A different key can carry a different class at the same instant.
    expect(limiter.admit("three", { capacity: 3, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(
      true,
    );
    expect(limiter.admit("three", { capacity: 3, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(
      true,
    );
    expect(limiter.admit("three", { capacity: 3, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(
      true,
    );
    expect(limiter.admit("three", { capacity: 3, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(
      false,
    );
  });

  it("fixes a key's bucket parameters at first sight — later calls reuse the existing bucket", () => {
    const limiter = createRateLimiter({ nowMs: clockFrozenAt(0) });

    expect(limiter.admit("k", { capacity: 1, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(true);
    // The key keeps its capacity-1 bucket: a capacity-5 bucket recreated on
    // this call would grant, and recreating on a parameter change would hand
    // the key a fresh budget — the opposite of a rate limit.
    expect(limiter.admit("k", { capacity: 5, refillPerMinute: 60, nowMs: 0 }).allowed).toBe(false);
  });

  it("reads the limiter's injected clock when admit carries no explicit timestamp", () => {
    const clock = controllableClock(0);
    const limiter = createRateLimiter({ nowMs: clock.read });

    expect(limiter.admit("k", { capacity: 1, refillPerMinute: 60 }).allowed).toBe(true);
    expect(limiter.admit("k", { capacity: 1, refillPerMinute: 60 }).allowed).toBe(false);
    clock.advance(1000);
    expect(limiter.admit("k", { capacity: 1, refillPerMinute: 60 })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      firstDecline: false,
    });
  });
});
