import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_sql_array_cold_client_test";
/** Teardown only. A wedged connection would otherwise replace a named assertion failure with a bare suite timeout. */
const cleanupTimeoutSeconds = 5;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

type Sql = ReturnType<typeof postgres>;

/**
 * Run `body` against a brand-new client, so that whatever it sends is that client's very first
 * query: the case under test only exists before the client has completed anything.
 */
async function withColdClient<T>(max: number, body: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max });

  try {
    return await body(sql);
  } finally {
    await sql.end({ timeout: cleanupTimeoutSeconds });
  }
}

/**
 * `sql.array(...)` builds a parameter that asks the client's array-type map for the array oid of
 * its element type. A new connection fills that map from `pg_type` before it runs the query it
 * was opened for, and the query has to be built after the map is filled, not before: built
 * early, the parameter falls back to its scalar element type and the server receives `"1,2"` as
 * text. That surfaces as `malformed array literal`, `op ANY/ALL (array) requires array on right
 * side`, `cannot cast type bigint to bigint[]`, or -- with no cast at all -- a scalar string
 * returned where an array was sent. Every case here is therefore the first query of a fresh
 * client, and every case asserts the value that came back rather than only that nothing threw.
 */
describe("an sql.array parameter in a new client's first query", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("binds numbers cast to bigint[] as an array", async () => {
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array([1, 2])}::bigint[] as v`);

    expect(rows.map((row) => row.v)).toEqual([["1", "2"]]);
  });

  it("matches rows through the application's any(...::bigint[]) shape", async () => {
    const rows = await withColdClient(
      1,
      (sql) => sql`
        select x
        from (values (1001::bigint), (1002::bigint)) as t(x)
        where x = any(${sql.array(["1001"])}::bigint[])
      `,
    );

    expect(rows.map((row) => row.x)).toEqual(["1001"]);
  });

  it("binds numbers cast to int[] as an array", async () => {
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array([1, 2])}::int[] as v`);

    expect(rows.map((row) => row.v)).toEqual([[1, 2]]);
  });

  it("binds uuid strings cast to uuid[] as an array", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array([id])}::uuid[] as v`);

    expect(rows.map((row) => row.v)).toEqual([[id]]);
  });

  it("binds strings cast to text[] as an array", async () => {
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array(["a", "b"])}::text[] as v`);

    expect(rows.map((row) => row.v)).toEqual([["a", "b"]]);
  });

  it("binds strings compared with an uncast text = any(...) as an array", async () => {
    const rows = await withColdClient(
      1,
      (sql) => sql`select 'b'::text = any(${sql.array(["a", "b"])}) as hit, 'c'::text = any(${sql.array(["a", "b"])}) as miss`,
    );

    expect(rows.map((row) => [row.hit, row.miss])).toEqual([[true, false]]);
  });

  it("returns an array, not the scalar string, when the parameter carries no cast", async () => {
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array(["a", "b"])} as v`);

    expect(rows.map((row) => row.v)).toEqual([["a", "b"]]);
  });

  it("binds an explicit element type as that type's array", async () => {
    const rows = await withColdClient(1, (sql) => sql`select ${sql.array([1, 2], 20)}::bigint[] as v`);

    expect(rows.map((row) => row.v)).toEqual([["1", "2"]]);
  });

  it("binds every one of three concurrent first queries on a max: 10 client as an array", async () => {
    const settled = await withColdClient(10, (sql) =>
      Promise.allSettled(
        ["1", "2", "3"].map(async (id) => {
          const rows = await sql`select ${sql.array([id])}::bigint[] as v`;
          return rows.map((row) => row.v);
        }),
      ),
    );

    expect(
      settled.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : `rejected: ${(outcome.reason as Error).message}`,
      ),
    ).toEqual([[["1"]], [["2"]], [["3"]]]);
  });

  // A reserve is not executed as the connection's opening query: the connection is handed to it
  // once the type fetch completes, so its first query is built later than the cases above. This
  // case already passed before the repair; it pins that moving where the types are applied did
  // not break the path a reserve takes through the same startup.
  it("binds as an array in the first query sent on a freshly reserved connection", async () => {
    const rows = await withColdClient(1, async (sql) => {
      const reserved = await sql.reserve();

      try {
        return await reserved`select ${sql.array([1, 2])}::bigint[] as v`;
      } finally {
        reserved.release();
      }
    });

    expect(rows.map((row) => row.v)).toEqual([["1", "2"]]);
  });
});
