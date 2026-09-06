import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_build_failure_test";
/** Teardown only. A wedged connection would otherwise replace a named assertion failure with a bare suite timeout. */
const cleanupTimeoutSeconds = 5;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

/**
 * Not every rejected query means the connection is gone. A query whose parameters cannot be
 * serialised — an `undefined` value, too many parameters, an untagged call — fails before
 * anything is sent, and the driver recovers the connection by writing a `Sync` and waiting
 * for the server's answer. The connection is alive throughout, and the pool keeps handing it
 * work: `handler` in the client falls through to `busy.shift()` once no idle connection is
 * left, so a second query arrives on the very connection that is still recovering.
 *
 * The connection's in-flight slot is what keeps those two apart. If it were emptied when the
 * first query was rejected instead of when the server answered, the second query would take
 * the slot and be resolved by the first one's answer — with no rows, and no error anywhere.
 * A caller that did nothing wrong gets a silent wrong answer.
 *
 * A single connection is what makes that ordering deterministic. It is not a contrived
 * shape: the shared pool reaches it whenever all ten connections are busy, which is exactly
 * the load under which a wrong answer costs the most.
 */
describe("a query pipelined behind one that failed before it was sent", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("is answered with its own rows and not with the failed query's empty result", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      // Warm the connection, so the two queries below meet an established one rather than
      // racing the handshake for it.
      await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);

      // TypeScript refuses to interpolate `undefined`, which is the point: the driver's
      // `UNDEFINED_VALUE` guard exists for the values the compiler never saw — an absent
      // optional field, a JSON payload, anything crossing an untyped boundary. The fixture
      // reproduces that gap rather than routing around it.
      const partialRow: { value?: number } = {};
      const missingValue = partialRow.value as number;

      // Both are dispatched in the same tick, without awaiting in between: that is what puts
      // the second one on the wire before the first one's recovery has been answered.
      const failed = sql`select ${missingValue} as broken`.then(
        () => "resolved",
        (error: unknown) => error,
      );
      const following = sql`select 42 as value`.then(
        (rows) => [...rows],
        (error: unknown) => error,
      );

      // The first query has to fail in serialisation for any of this to be the case under
      // test — a version that accepted `undefined` would leave the connection untroubled and
      // make the assertion below prove nothing.
      expect(await failed).toMatchObject({ code: "UNDEFINED_VALUE" });

      expect(await following).toEqual([{ value: 42 }]);
    } finally {
      await sql.end({ timeout: cleanupTimeoutSeconds });
    }
  });
});
