/**
 * One guard, shared by the reconciliation sweep and the reconciliation worker:
 * both hand a caller-supplied reporter a failure they exist to survive, and both
 * are reached from a detached async call where anything the reporter does wrong
 * becomes the crash the surrounding handler was written to prevent.
 */

export type GuardedCallback<Arguments extends unknown[]> = (
  ...args: Arguments
) => void | PromiseLike<unknown>;

/**
 * Calls a callback the caller supplied, containing every way one can fail, and
 * reports instead of failing.
 *
 * The three ways are guarded separately because each fails on its own terms:
 * retrieving the member can throw before any callback exists, since it may be an
 * accessor wired lazily; the call itself can throw; and an async callback can
 * reject, which no `try` around the call can see. Each of the three ends at
 * `report`, which is given the reason where there is one and nothing where the
 * member simply held a value that is not callable, since nothing failed there.
 * Anything uncallable — a member that could not be retrieved, or the null an
 * untyped caller can pass where an optional member expresses only undefined —
 * counts as no callback at all, though what arrives here is the thunk's to
 * decide: armSweepInterval maps a nullish member to defaultSchedule before it
 * gets this far, so a null scheduler arms the default rather than nothing. The
 * member is read once, through the thunk, because an accessor can have a side
 * effect as well as a failure.
 *
 * The receiver is passed rather than left to the call, because the local no
 * longer supplies the one the property access did: these members are declared as
 * methods, so a bare call would leave `this` undefined and turn the callback
 * itself into the failure this guard exists to prevent. A callback that cannot
 * be invoked that way falls into the guard below like any other failing one.
 *
 * One caller hands over a callback that is not a member of its receiver at all:
 * armSweepInterval falls back to this module's own defaultSchedule, which now
 * runs with `this` bound to the caller's schedule where the bare call left it
 * undefined. That is the one observable change this guard makes on a path that
 * already worked, and it is safe because defaultSchedule never reads `this`.
 *
 * Every member this guards declares its return as `void | PromiseLike<unknown>`
 * rather than `void`, because an async callback is supported rather than merely
 * tolerated by TypeScript's void-return assignability: what one returns is
 * settled here and its rejection is handled.
 *
 * The result is settled, not awaited: containing a rejection does not require
 * awaiting one, and awaiting would put whatever follows behind a callback that
 * may never settle at all. For the same reason this is not written as an async
 * function awaiting the callback — that puts a second floating promise into a
 * module whose whole defect was a floating promise, and it hides the synchronous
 * case, which survives only because an async body runs eagerly up to its first
 * await. Settling the result and catching separately shows both failure modes
 * where they happen.
 *
 * What stays fatal, deliberately: a console broken at every arity, since
 * catching that would leave the module unable to report anything at all with no
 * sign of it, and any rejection this module cannot attach a handler to — one is
 * only containable while it can be reached, and a rejection out of reach is
 * Node's to report. Where a `report` that throws lands depends on the path that
 * reached it: from the retrieval, the uncallable check or a synchronous throw it
 * propagates to this function's caller, while from the rejection handler it
 * becomes an unhandled rejection. Each caller documents what that costs it.
 */
export function callGuarded<Arguments extends unknown[]>(
  receiver: object,
  retrieve: () => GuardedCallback<Arguments> | undefined,
  args: Arguments,
  report: (reason?: unknown) => void,
): void {
  let callback: GuardedCallback<Arguments> | undefined;
  try {
    callback = retrieve();
  } catch (error) {
    report(error);
    return;
  }

  if (typeof callback !== "function") {
    report();
    return;
  }

  try {
    void Promise.resolve(callback.apply(receiver, args)).catch((reason: unknown) => {
      report(reason);
    });
  } catch (error) {
    report(error);
  }
}
