import { getSql } from "@/lib/db/client";

/**
 * Deployment readiness probe — issue 439.
 *
 * The deploy script used to probe the landing page, which answers 200 even
 * with PostgreSQL unreachable. This endpoint answers from the database
 * instead, and every failure mode means NOT ready:
 *
 * - A rejection, a thrown error, or an empty result from the probe answers
 *   503. A timeout is not ready too: the probe query is raced onto a
 *   READINESS_QUERY_TIMEOUT_MS budget, so a database that accepts the
 *   connection and never answers still fails the probe in time.
 * - Beneath the per-query timeout sits a structural hard cap
 *   (READINESS_HARD_CAP_MS) raced against the probe, so even a probe that
 *   never settles cannot hold a response open past the cap. The race's loser
 *   is deliberately not awaited — a query that loses the race settles late
 *   through the client, or not at all; the cap is what bounds the handler —
 *   and its eventual settlement, if any, is consumed by the mapping below,
 *   so no unhandled rejection can take the process down.
 *
 * The endpoint is reachable unauthenticated by anything that can reach the
 * deployment, so it is bounded against request floods: the single-flight and
 * TTL cache below live in the handler factory's closure, so at most ONE probe
 * runs per handler instance no matter how many requests arrive. Requests
 * landing while a probe is in flight share that probe's result, a completed
 * result is reused with zero probe work until the TTL expires, and a cached
 * failure is served exactly like a cached success. In the worst case an
 * attacker costs one query every TTL window.
 */

/** How long a single probe query may run before it counts as not ready. */
const READINESS_QUERY_TIMEOUT_MS = 2000;

/**
 * Structural ceiling on any probe outcome, raced against the probe as a
 * backstop for failure modes the query timeout cannot reach (a probe
 * dependency that never settles).
 */
const READINESS_HARD_CAP_MS = 3000;

/** How long a completed probe result is reused before the next request re-probes. */
const READINESS_TTL_MS = 3000;

export type Readiness = "ready" | "unavailable";

export type ReadinessRouteDependencies = {
  probe: () => Promise<Readiness>;
  now: () => number;
};

/**
 * The real probe: one trivial query, not ready if it fails or returns nothing.
 *
 * The 2000 ms budget is raced onto the query by hand: the pinned postgres
 * client (3.4.9, the `_patch_hash` build) exposes no per-query `.timeout()`,
 * so the probe rejects the query itself when it outlives the budget. A query
 * that loses this race settles late through the client (or not at all, into
 * a socket that never answers); its settlement reaches only the handlers
 * attached here, never the process's unhandled-rejection path.
 */
async function probeDatabase(): Promise<Readiness> {
  const rows = await raceTimeout(
    getSql()`select 1`,
    READINESS_QUERY_TIMEOUT_MS,
  );
  return rows.length > 0 ? "ready" : "unavailable";
}

/** Rejects if the query has not settled within `budgetMs`. */
function raceTimeout<T>(query: PromiseLike<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe query exceeded its ${budgetMs} ms budget`)),
      budgetMs,
    );
    query.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Builds the GET handler with its own single-flight + TTL state, so tests get
 * a fresh handler (and fresh state) per construction instead of a reset hook.
 */
export function createReadinessGetHandler(
  dependencies: Partial<ReadinessRouteDependencies> = {},
) {
  const probe = dependencies.probe ?? probeDatabase;
  const now = dependencies.now ?? Date.now;

  let inFlight: Promise<Readiness> | undefined;
  let cached: { outcome: Readiness; at: number } | undefined;

  /**
   * Runs the probe exactly once per call and settles it through the hard cap.
   * The probe is invoked through Promise.resolve().then so a synchronous throw
   * counts as a failure like any other, and the mapped promise never rejects —
   * every failure mode arrives as "unavailable".
   */
  function runProbe(): Promise<Readiness> {
    const settled = Promise.resolve()
      .then(probe)
      .then(
        (outcome) => outcome,
        () => "unavailable" as const,
      );

    return new Promise<Readiness>((resolve) => {
      const cap = setTimeout(() => resolve("unavailable"), READINESS_HARD_CAP_MS);
      settled.then((outcome) => {
        clearTimeout(cap);
        resolve(outcome);
      });
    });
  }

  async function readiness(): Promise<Readiness> {
    if (inFlight !== undefined) {
      return inFlight;
    }

    const timestamp = now();
    if (cached !== undefined && timestamp - cached.at < READINESS_TTL_MS) {
      return cached.outcome;
    }

    const probed = runProbe();
    inFlight = probed;
    probed.then((outcome) => {
      if (inFlight === probed) {
        inFlight = undefined;
      }
      cached = { outcome, at: now() };
    });
    return probed;
  }

  return async function getReadiness(): Promise<Response> {
    const outcome = await readiness();
    return Response.json(
      { status: outcome },
      {
        status: outcome === "ready" ? 200 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  };
}

const productionDependencies: ReadinessRouteDependencies = {
  probe: probeDatabase,
  now: Date.now,
};

export const GET = createReadinessGetHandler(productionDependencies);
