// Next.js calls this once when the server starts, on every runtime it builds
// for — the Node.js server and the Edge Instrumentation bundle it also
// compiles, which nothing in this deployment ever runs.
//
// The literal comparison is load-bearing. Turbopack folds
// `process.env.NEXT_RUNTIME` per runtime when it compiles this module, so the
// Node-only wiring lives behind a dynamic import the Edge build prunes
// entirely; a runtime predicate would not do, because a function call is
// invisible to the bundler and its Node-only imports would still be bundled
// into Edge as dead code, warned about as a Node.js module loaded into the
// Edge Runtime (issue 88).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { registerNodejs } = await import("./instrumentation-node");
      await registerNodejs();
    } catch (error) {
      // Next.js retries register() on every request once it has rejected, so a
      // throw here would leave the unit `active` serving 500s and printing the
      // same rejection per request, forever, seen by nobody (issue 846).
      // Exiting hands the failure to systemd instead: Restart=on-failure
      // restarts the process, the start limit then fails the unit visibly,
      // and OnFailure= alerts on it.
      console.error("Overflow server startup failed; exiting so the unit restarts, trips its start limit, and fails visibly", error);
      process.exit(1);
    }
  }
}
