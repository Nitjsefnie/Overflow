import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { decode } from "next-auth/jwt";
// @ts-expect-error -- untyped .mjs script module
import { SESSION_COOKIE_NAME, mintSessionCookieValue, seedFixtureUsers } from "../../scripts/check-page-geometry.mjs";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * The gate's fixture users (issue 453), pinned here by their literals: the
 * seeder must create exactly these rows, so the test knows the ids apart from
 * the seeder's own return value.
 */
const MEMBER_FIXTURE_USER_ID = "00000000-0000-4000-8000-00000000453a";
const MODERATOR_FIXTURE_USER_ID = "00000000-0000-4000-8000-00000000453b";

/** A throwaway secret: the minting path reads it as opaque key material only. */
const AUTH_SECRET_TEST = "geometry-fixture-test-secret-not-for-production";

/**
 * decode comes from `next-auth/jwt`, which is a verbatim
 * `export * from "@auth/core/jwt"` — the installed @auth/core 0.41.3 module
 * the app's own sessions run through. pnpm's strict layout does not expose
 * the transitive @auth/core to workspace imports, so the re-export is the
 * way to pin the minted cookie against the real session decoder.
 */
describe("mintSessionCookieValue — the @auth/core interop pin (issue 453)", () => {
  it("mints a JWE the installed session decoder reads back as the fixture payload", async () => {
    // A fixed instant the real clock cannot have passed: the installed
    // decoder enforces exp, so a past date (even "today, earlier") turns the
    // first assertion into a legitimate expiry rejection.
    const now = new Date("2030-01-01T00:00:00.000Z");

    const token = mintSessionCookieValue({
      secret: AUTH_SECRET_TEST,
      userId: MEMBER_FIXTURE_USER_ID,
      role: "MEMBER",
      now,
    });

    const payload = await decode({ token, secret: AUTH_SECRET_TEST, salt: SESSION_COOKIE_NAME });

    expect(payload?.sub).toBe(MEMBER_FIXTURE_USER_ID);
    expect(payload?.userId).toBe(MEMBER_FIXTURE_USER_ID);
    expect(payload?.role).toBe("MEMBER");
    expect(payload?.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(payload?.exp).toBe(Math.floor(now.getTime() / 1000) + 3600);
  });

  it("produces a token the decoder refuses once its hour has passed", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const token = mintSessionCookieValue({
      secret: AUTH_SECRET_TEST,
      userId: MEMBER_FIXTURE_USER_ID,
      role: "MEMBER",
      now: twoHoursAgo,
    });

    await expect(decode({ token, secret: AUTH_SECRET_TEST, salt: SESSION_COOKIE_NAME })).rejects.toThrow();
  });
});

describe("seedFixtureUsers (issue 453)", () => {
  let container: StartedTestContainer | undefined;
  let sql: Sql;
  let databaseUrl: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "geometry_session_fixture_test",
      user: "geometry_session_fixture_test",
      password: "geometry_session_fixture_test",
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    // The second run replays every migration against the installed schema, the
    // same re-runnability guard the other container suites apply.
    await runMigrations();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("seeds both fixture users, then repeats with the same ids and no new rows", async () => {
    const first = await seedFixtureUsers({ databaseUrl });
    expect(first).toEqual({
      memberUserId: MEMBER_FIXTURE_USER_ID,
      moderatorUserId: MODERATOR_FIXTURE_USER_ID,
    });

    const second = await seedFixtureUsers({ databaseUrl });
    expect(second).toEqual(first);

    // A fresh container holds nothing but the fixture rows, so the count pins
    // both the insert and the no-op second call.
    const [counts] = await sql<{ count: string }[]>`
      select count(*)::text as count from users
    `;
    expect(counts.count).toBe("2");

    const roles = await sql<{ id: string; role: string }[]>`
      select id, role::text as role from users order by id
    `;
    expect(roles).toEqual([
      { id: MEMBER_FIXTURE_USER_ID, role: "MEMBER" },
      { id: MODERATOR_FIXTURE_USER_ID, role: "MODERATOR" },
    ]);
  });

  it("repairs a role that drifted from the fixture contract on the next seed", async () => {
    await sql`update users set role = 'MEMBER' where id = ${MODERATOR_FIXTURE_USER_ID}`;

    await seedFixtureUsers({ databaseUrl });

    const [moderator] = await sql<{ role: string }[]>`
      select role::text as role from users where id = ${MODERATOR_FIXTURE_USER_ID}
    `;
    expect(moderator.role).toBe("MODERATOR");
  });
});
