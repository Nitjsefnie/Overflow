import { describe, expect, it } from "vitest";
import {
  WEBHOOK_RATE_LIMIT_CAPACITY,
  WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
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
