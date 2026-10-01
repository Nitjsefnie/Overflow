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
 */
export function captureUnhandledRejections(): {
  /** The reasons Node reported, in the order it reported them. */
  seen: unknown[];
  restore(): void;
} {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);

  return {
    seen,
    restore: () => {
      process.off("unhandledRejection", listener);
    },
  };
}
