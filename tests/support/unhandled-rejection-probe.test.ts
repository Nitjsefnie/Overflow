import { describe, expect, it } from "vitest";

import { captureUnhandledRejections } from "./unhandled-rejection-probe";

const UNHANDLED = "unhandledRejection";

describe("unhandled rejection probe", () => {
  it("installs one listener and detaches that one on restore", () => {
    const before = process.listenerCount(UNHANDLED);
    const { restore } = captureUnhandledRejections();

    // The count is what pins the detach. A leak here is invisible from inside
    // any single test — the probe still records, and the suite that installed it
    // still passes — because the listener lives on the process, not on the test.
    // The three consumers install this probe 29 times across tests/fold/, and
    // vitest.config.ts runs the directory with `isolate: false`, so a listener
    // that outlives its test outlives the file that installed it.
    try {
      expect(process.listenerCount(UNHANDLED)).toBe(before + 1);
    } finally {
      restore();
    }
    expect(process.listenerCount(UNHANDLED)).toBe(before);
  });

  it("detaches only its own listener, leaving another probe installed", () => {
    const before = process.listenerCount(UNHANDLED);
    const first = captureUnhandledRejections();
    const second = captureUnhandledRejections();

    // Two probes, because a detach that took every listener with it would leave
    // the count looking right while silently disarming a sibling — and in
    // `isolate: false` that sibling may belong to a file this one never saw.
    try {
      expect(process.listenerCount(UNHANDLED)).toBe(before + 2);
      first.restore();
      expect(process.listenerCount(UNHANDLED)).toBe(before + 1);
    } finally {
      second.restore();
    }
    expect(process.listenerCount(UNHANDLED)).toBe(before);
  });

  it("records every rejection nothing handled, in order, for as long as it is installed", async () => {
    const first = new Error("Nothing handled this one");
    const second = new Error("Nor this one");
    const { seen, restore } = captureUnhandledRejections();

    try {
      // Two, and by identity rather than by shape: one rejection cannot tell a
      // listener registered once from one registered for good, and only the
      // second tells them apart. Both are floated with no handler anywhere, so
      // Node reports them — which is the only thing the listener exists to
      // observe, and the reason it must be installed before they are created.
      void Promise.reject(first);
      void Promise.reject(second);

      await drainMicrotasks();

      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(first);
      expect(seen[1]).toBe(second);
    } finally {
      restore();
    }
  });
});

/**
 * Drains the microtask queue and the turn after it. One turn is enough for
 * Node to report a rejection it is going to report, since it does so once the
 * microtask queue has drained; the second widens the window. Neither is a
 * margin something is expected to finish inside.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
