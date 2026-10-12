import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { captureUnhandledRejections } from "./unhandled-rejection-probe";

const UNHANDLED = "unhandledRejection";

describe("unhandled rejection probe", () => {
  it("owns Node rejections when process listener methods redirect to a private queue", async () => {
    // Next's rejection filter redirects process.on/off. Vitest retains the
    // native listener counter, so a listener in that private queue cannot tell
    // it that a test owns the rejection. Exercise a real Node rejection here.
    const redirected = new EventEmitter();
    const originalOn = process.on;
    const originalOff = process.off;
    const on = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === UNHANDLED) redirected.on(event, listener);
      else originalOn.call(process, event, listener);
      return process;
    });
    const off = vi.spyOn(process, "off").mockImplementation((event, listener) => {
      if (event === UNHANDLED) redirected.off(event, listener);
      else originalOff.call(process, event, listener);
      return process;
    });
    const before = process.listenerCount(UNHANDLED);
    const failure = new Error("Rejection forwarded by Node");
    const notified: unknown[] = [];
    const { seen, restore } = captureUnhandledRejections((reason) => { notified.push(reason); });

    try {
      void Promise.reject(failure);
      await drainMicrotasks();
      expect(seen).toEqual([failure]);
      expect(notified).toEqual([failure]);
      expect(process.listenerCount(UNHANDLED)).toBe(before + 1);
      restore();
      expect(process.listenerCount(UNHANDLED)).toBe(before);
      expect(redirected.listenerCount(UNHANDLED)).toBe(0);
    } finally {
      restore();
      off.mockRestore();
      on.mockRestore();
    }
  });

  it("installs one listener and detaches that one on restore", () => {
    const before = process.listenerCount(UNHANDLED);
    const { restore } = captureUnhandledRejections();

    // The count is what pins the detach. A leak here is invisible from inside
    // any single test — the probe still records, and the suite that installed it
    // still passes — because the listener lives on the process, not on the test.
    // The fold suites install this probe throughout tests/fold/, and
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
      // observe.
      //
      // Vitest's listener is already installed, so a broken probe registration
      // makes these real rejections fail its unhandled-error gate as well as
      // our assertions, without killing the worker or hanging the test.
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
