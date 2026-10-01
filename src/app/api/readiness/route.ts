import { getSql } from "@/lib/db/client";
import { bundledMigrationNames } from "@/lib/db/migration-manifest";
import { describeErrorCause } from "@/lib/repositories/register";

/**
 * Deployment readiness probe — issue 439.
 *
 * The deploy script used to probe the landing page, which answers 200 even
 * with PostgreSQL unreachable. This endpoint answers from the database
 * instead, and every failure mode means NOT ready:
 *
 * - A rejection or a thrown error from the probe answers 503. A timeout is
 *   not ready too: the probe query is raced onto a
 *   READINESS_QUERY_TIMEOUT_MS budget, so a database that accepts the
 *   connection and never answers still fails the probe in time.
 * - The probe reads the applied migration names out of `schema_migrations`
 *   and answers 200 only when every migration this build bundles is recorded
 *   applied (issue 692). A schema behind the build — an empty ledger, or one
 *   missing a migration this build carries — is not ready. A schema AHEAD of
 *   the build is ready: it holds every name this build needs plus rows from
 *   a newer migration set, which is exactly the state a rollback to an older
 *   release runs against, so the check is one-sided on purpose.
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
 * failure is served with its reason, exactly like a cached success. In the
 * worst case an attacker costs one query every TTL window.
 *
 * Issue 910 adds the why to a not-ready answer: every failure mode maps to a
 * reason string — a rejection renders its redacted cause through
 * `describeErrorCause` (imported from the repositories module, PR 887
 * precedent), a schema behind the build names the migrations it is missing,
 * and a probe that outlives the hard cap names the cap — and the reason
 * reaches both the 503 body and the journal, one `console.error` per failed
 * probe at settlement. A TTL-cached failure served inside its window does
 * not log again: only a probe settlement logs. Status codes, cache-control,
 * single-flight and TTL semantics are unchanged.
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

/**
 * What one probe run concluded. `reason` is present exactly when `status` is
 * `"unavailable"` (issue 910): it names the failing dependency and why —
 * every reason this module produces starts "database: …" — and is rendered
 * into the 503 body and the journal line.
 */
export type ReadinessProbeOutcome = {
  status: Readiness;
  reason?: string;
};

export type ReadinessRouteDependencies = {
  probe: () => Promise<ReadinessProbeOutcome>;
  now: () => number;
};

/**
 * The real probe: read the applied migration names and refuse a schema this
 * build is ahead of.
 *
 * Readiness is one-sided (issue 692): ready iff every migration the bundled
 * manifest names is recorded applied. A missing table or a failed query
 * rejects, landing in the existing error mapping as 503; an empty
 * `schema_migrations` is behind, and answers 503 through the same predicate.
 * An ahead schema carries the bundled names plus rows this build does not
 * know, and stays ready — the state a rollback to an older release runs
 * against.
 *
 * The 2000 ms budget is raced onto the query by hand: the pinned postgres
 * client (3.4.9, the `_patch_hash` build) exposes no per-query `.timeout()`,
 * so the probe rejects the query itself when it outlives the budget. A query
 * that loses this race settles late through the client (or not at all, into
 * a socket that never answers); its settlement reaches only the handlers
 * attached here, never the process's unhandled-rejection path.
 */
async function probeDatabase(): Promise<ReadinessProbeOutcome> {
  const sql = getSql();
  const appliedRows = await raceTimeout(
    sql<{ name: string }[]>`select name from schema_migrations`,
    READINESS_QUERY_TIMEOUT_MS,
  );
  const missing = missingMigrations(appliedRows.map((row) => row.name));
  return missing.length === 0
    ? { status: "ready" }
    : {
        status: "unavailable",
        reason: `database: schema is behind the build; missing migrations: ${missing.join(", ")}`,
      };
}

/**
 * The bundled migrations the applied ledger does not name, in bundled order —
 * the exact list a behind-schema reason renders (issue 910).
 */
export function missingMigrations(applied: readonly string[]): readonly string[] {
  const appliedNames = new Set(applied);
  return bundledMigrationNames.filter((name) => !appliedNames.has(name));
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

  let inFlight: Promise<ReadinessProbeOutcome> | undefined;
  let cached: { outcome: ReadinessProbeOutcome; at: number } | undefined;

  /**
   * Runs the probe exactly once per call and settles it through the hard cap.
   * The probe is invoked through Promise.resolve().then so a synchronous throw
   * counts as a failure like any other, and the mapped promise never rejects —
   * every failure mode arrives as an unavailable outcome carrying its reason
   * (issue 910): a rejection renders `describeErrorCause`, and the hard cap
   * renders its own. The race's loser is deliberately not awaited — a query
   * that loses the race settles late through the client, or not at all — and
   * `finish` consumes whichever settlement arrives second without resolving
   * or logging again, so each probe journals exactly once.
   */
  function runProbe(): Promise<ReadinessProbeOutcome> {
    const settled = Promise.resolve()
      .then(probe)
      .then(
        (outcome) => outcome,
        (error: unknown) => ({
          status: "unavailable" as const,
          reason: `database: ${describeErrorCause(error)}`,
        }),
      );

    return new Promise<ReadinessProbeOutcome>((resolve) => {
      let decided = false;
      const finish = (outcome: ReadinessProbeOutcome): void => {
        if (decided) {
          return;
        }
        decided = true;
        // One consolidated outcome: the reason fallback lives here, so the
        // body and the journal line derive from the same string.
        const consolidated: ReadinessProbeOutcome =
          outcome.status === "unavailable" && outcome.reason === undefined
            ? { ...outcome, reason: "database: an unavailable probe outcome arrived without a reason" }
            : outcome;
        if (consolidated.status === "unavailable") {
          console.error(`Readiness probe failed: ${consolidated.reason}`);
        }
        resolve(consolidated);
      };
      const cap = setTimeout(
        () =>
          finish({
            status: "unavailable",
            reason: `database: probe did not settle within the ${READINESS_HARD_CAP_MS} ms hard cap`,
          }),
        READINESS_HARD_CAP_MS,
      );
      settled.then((outcome) => {
        clearTimeout(cap);
        finish(outcome);
      });
    });
  }

  async function readiness(): Promise<ReadinessProbeOutcome> {
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
      outcome.status === "ready"
        ? { status: "ready" }
        : { status: "unavailable", reason: outcome.reason },
      {
        status: outcome.status === "ready" ? 200 : 503,
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
