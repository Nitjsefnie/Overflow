import { describe, expect, it } from "vitest";
import { callGuarded, type GuardedCallback } from "@/lib/fold/guarded-callback";
import { captureUnhandledRejections } from "../support/unhandled-rejection-probe";

describe("guarded callback", () => {
  it("reports a retrieval that throws, and reads no member at all", () => {
    const unreachable = new Error("The lazily wired accessor failed");
    const receiver = noteReceiver();
    const reporter = recordingReporter();

    const returned = callGuarded(receiver, () => {
      throw unreachable;
    }, ["note"], reporter.report);

    // Retrieving the member is guarded on its own terms, so the throw lands on
    // the reporter instead of the caller — and no callback is delivered, because
    // the retrieval that would have produced one never returned.
    expect(returned).toBeUndefined();
    expect(reporter.reports).toEqual([[unreachable]]);
    expect(receiver.calls).toEqual([]);
  });

  it.each([
    { label: "an undefined member", member: undefined },
    { label: "a null member", member: null },
    { label: "a truthy non-callable member", member: { callable: false } },
  ] as Array<{ label: string; member: unknown }>)(
    "reports $label with no reason at all and calls nothing",
    ({ member }) => {
      const receiver = noteReceiver();
      const reporter = recordingReporter();
      // The null is what an untyped caller hands over where an optional member
      // can only express undefined, and the object is a member that simply held
      // a value which is not a callback.
      const returned = callGuarded(receiver, () => member as GuardedCallback<[string]>,
        ["note"], reporter.report);

      // Nothing failed on this path — the member was simply not a callback — so
      // the reporter is given no reason at all. `report(undefined)` would hand a
      // reason the guard never had, and `report(error)` a TypeError the guard
      // never suffered.
      expect(returned).toBeUndefined();
      expect(reporter.reports).toEqual([[]]);
      expect(receiver.calls).toEqual([]);
    },
  );

  it("reports a callback that throws synchronously and leaves no rejection behind", async () => {
    const unreachable = new Error("The callback failed before returning");
    const receiver = noteReceiver();
    const reporter = recordingReporter();
    const { seen: unhandled, restore } = captureUnhandledRejections();

    try {
      const returned = callGuarded(receiver, () => (() => {
        throw unreachable;
      }) as GuardedCallback<unknown[]>, ["note"], reporter.report);

      // A throw out of the call is contained on the same turn, so the reporter
      // has already run by the time callGuarded returns.
      expect(returned).toBeUndefined();
      expect(reporter.reports).toEqual([[unreachable]]);

      // The throw happened before any promise existed, so there is nothing to
      // reject: an unhandled rejection here would be the module's own defect.
      await drainMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      restore();
    }
  });

  it("reports a rejected promise asynchronously, with no unhandled rejection escaping", async () => {
    const unreachable = new Error("The callback rejected");
    const reporter = recordingReporter();
    const { seen: unhandled, restore } = captureUnhandledRejections();

    try {
      callGuarded(noteReceiver(), () => async () => {
        throw unreachable;
      }, [], reporter.report);

      // No `try` around the call can see a rejection, so the report is
      // necessarily a turn late rather than synchronous.
      expect(reporter.reports).toEqual([]);

      await drainMicrotasks();

      expect(reporter.reports).toEqual([[unreachable]]);
      expect(unhandled).toEqual([]);
    } finally {
      restore();
    }
  });

  it("never reports a callback that resolves, and settles its resolution", async () => {
    const reporter = recordingReporter();
    const { seen: unhandled, restore } = captureUnhandledRejections();
    let resolved: unknown;

    try {
      callGuarded(noteReceiver(), () => async () => {
        resolved = "the callback finished";
      }, [], reporter.report);

      await drainMicrotasks();

      expect(resolved).toBe("the callback finished");
      expect(reporter.reports).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      restore();
    }
  });

  it("binds the receiver the caller passed, so a method-form callback reaches its own object", () => {
    const receiver = noteReceiver();
    const reporter = recordingReporter();

    callGuarded(receiver, () => receiver.onNote, ["bound"], reporter.report);

    // A bare call would leave `this` undefined and turn the callback into the
    // very failure this guard exists to prevent: reported, but never delivered.
    expect(receiver.calls).toEqual([["bound"]]);
    expect(reporter.reports).toEqual([]);
  });

  it("hands the callback exactly the arguments it was given, in order", () => {
    const receiver = noteReceiver();
    const reporter = recordingReporter();
    const args: unknown[] = ["first", 2, null, { fourth: true }];

    callGuarded(receiver, () => receiver.onNote, args, reporter.report);

    expect(receiver.calls).toEqual([["first", 2, null, { fourth: true }]]);
    expect(reporter.reports).toEqual([]);
  });

  it("reads the member once per call, because an accessor can have a side effect", () => {
    const receiver = noteReceiver();
    const reporter = recordingReporter();

    callGuarded(receiver, () => receiver.onNote, ["once"], reporter.report);
    expect(receiver.reads.count).toBe(1);

    callGuarded(receiver, () => receiver.onNote, ["twice"], reporter.report);
    expect(receiver.reads.count).toBe(2);

    expect(receiver.calls).toEqual([["once"], ["twice"]]);
    expect(reporter.reports).toEqual([]);
  });

  it("settles rather than awaits, so a callback that never settles does not block the caller", async () => {
    const neverSettles = new Promise<never>(() => {});
    const reporter = recordingReporter();
    const { seen: unhandled, restore } = captureUnhandledRejections();

    try {
      // What this pins, exactly: the return value is undefined, so the guard
      // handed back no promise of its own, and nothing below blocks on the
      // callback. What it does not pin: that the guard never waits internally.
      // An async-IIFE rewrite also returns undefined and still reports a
      // synchronous throw on the same turn — `await expr` evaluates `expr` before
      // it suspends — so it passes here. Catching that needs a static check, and
      // it is parked as a coverage gap against the module's doc comment rather
      // than papered over with a claim these assertions do not support.
      const returned = callGuarded(noteReceiver(), () => () => neverSettles, [], reporter.report);

      expect(returned).toBeUndefined();

      await drainMicrotasks();

      expect(reporter.reports).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      restore();
    }
  });
});

interface NoteReceiver {
  readonly reads: { count: number };
  readonly calls: unknown[][];
  note(this: NoteReceiver, ...args: unknown[]): void;
  onNote: GuardedCallback<unknown[]>;
}

/**
 * A receiver whose callback is declared as a method that reaches its own object
 * through `this`, which is the form the callback type's method syntax invites.
 * The member it is retrieved through is an accessor, so every read is counted
 * and a second read of it is visible. The accessor cannot be written as a
 * literal property — a getter that counts is exactly what a literal cannot
 * express — so it is installed afterwards and the receiver is widened to the
 * interface the consumers see.
 */
function noteReceiver(): NoteReceiver {
  const receiver = {
    reads: { count: 0 },
    calls: [] as unknown[][],
    note(...args: unknown[]) {
      this.calls.push(args);
    },
  };
  Object.defineProperty(receiver, "onNote", {
    get() {
      receiver.reads.count += 1;
      return receiver.note;
    },
    configurable: true,
  });
  return receiver as NoteReceiver;
}

/**
 * A reporter that keeps the exact argument list of every call, so a reporter
 * given nothing at all is distinguishable from one given `undefined`.
 */
function recordingReporter() {
  const reports: unknown[][] = [];
  const report = (...reason: unknown[]) => {
    reports.push(reason);
  };

  return { reports, report };
}

/**
 * Drains the microtask queue and the turn after it. One drain is enough for a
 * rejection handler to run; Node reports a rejection it is going to report only
 * once the microtask queue has drained, so the second turn widens the window
 * the listener had to fire in.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
