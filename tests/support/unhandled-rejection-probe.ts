import { EventEmitter } from "node:events";

/**
 * Records what Node reports as an unhandled rejection during one test, for the
 * suites whose subject is a promise the code under test is expected to contain.
 *
 * Installing a listener is also what keeps Node's default from ending the run,
 * so a case that drives a rejection on purpose needs this whether or not it
 * asserts on what was captured. Node's default is to throw on an unhandled
 * rejection, which would take the worker process down mid-suite, so a suite
 * that cannot attach a handler to a rejection of its own making is the one
 * thing this records: a rejection that got away.
 *
 * A returned `seen` that is empty after the code under test has run is the
 * evidence that nothing escaped, and it is a stronger claim than the run simply
 * finishing — a contained rejection and a silenced one are indistinguishable
 * from the outside, and only the recorded one tells them apart.
 * An optional observer runs after each reason is recorded to signal a wait.
 */
export function captureUnhandledRejections(
  onRejection?: (reason: unknown) => void,
): {
  /** The reasons Node reported, in the order it reported them. */
  seen: unknown[];
  restore(): void;
} {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
    onRejection?.(reason);
  };
  // Next redirects process.on/off to a private queue. Vitest's cached native
  // listener counter cannot see that queue, so the probe must own a native
  // listener for the entire capture window, including an observer's wait.
  EventEmitter.prototype.on.call(process, "unhandledRejection", listener);

  return {
    seen,
    restore: () => {
      EventEmitter.prototype.off.call(process, "unhandledRejection", listener);
    },
  };
}
