import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { decode } from "next-auth/jwt";
// @ts-expect-error -- untyped .mjs script module
import { SESSION_COOKIE_NAME, authedLandingState, loadRepoEnvFile, mintSessionCookieValue, seedFixtureUsers, setSessionCookie, spawnedServerEnv } from "../../scripts/check-page-geometry.mjs";
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

/**
 * The CDP delivery half of the fixture (issue 453): the helper that sets the
 * session cookie must send exactly Network.setCookie with the session's
 * cookie name and the run's base URL, and must treat a DevTools-level
 * {success: false} as a hard error — a silently swallowed failure would leave
 * every authed contract reading as a bounce instead of surfacing the
 * delivery refusal. The fake client mirrors the DevTools.send surface the
 * script's own client exposes.
 */
describe("setSessionCookie — the CDP delivery contract (issue 453)", () => {
  /** A DevTools client double that records sends and scripts the response. */
  function fakeClient(response: unknown) {
    const calls: Array<{ method: string; params: unknown; sessionId: string | undefined }> = [];
    return {
      calls,
      send: async (method: string, params?: unknown, sessionId?: string) => {
        calls.push({ method, params, sessionId });
        return response;
      },
    };
  }

  it("sends the session cookie for the run's base URL and accepts an explicit success", async () => {
    const client = fakeClient({ success: true });

    await setSessionCookie(client, "session-1", "the-jwe-value", "http://127.0.0.1:3219");

    expect(client.calls).toEqual([
      {
        method: "Network.setCookie",
        params: { name: SESSION_COOKIE_NAME, value: "the-jwe-value", url: "http://127.0.0.1:3219" },
        sessionId: "session-1",
      },
    ]);
  });

  it("throws, naming the cookie and the URL, when DevTools reported the set as failed", async () => {
    const client = fakeClient({ success: false });

    await expect(setSessionCookie(client, "under-session", "the-jwe-value", "http://127.0.0.1:3219"))
      .rejects.toThrow(/authjs\.session-token.*127\.0\.0\.1:3219/s);
  });
});

/**
 * The server-side trust precondition the cookie delivery sits on top of
 * (issue 453): NextAuth v5 refuses to honor a session cookie for a host it
 * does not trust, and under `next start` (production) it grants that trust
 * only from the environment. The spawned measurement server must therefore
 * run with AUTH_TRUST_HOST=true, or every authed contract's request is
 * answered UntrustedHost and bounces to / — reading exactly like a rejected
 * session (measured live: the first gate run did exactly that). A caller
 * that already carries an explicit AUTH_TRUST_HOST keeps it: the helper must
 * never downgrade an explicit trust decision.
 */
describe("spawnedServerEnv — the spawned server's host trust (issue 453)", () => {
  it("grants the host trust a production server refuses to assume for itself", () => {
    const env = spawnedServerEnv({ DATABASE_URL: "postgresql://example/db" });

    expect(env.AUTH_TRUST_HOST).toBe("true");
    // The run's own environment rides along unchanged.
    expect(env.DATABASE_URL).toBe("postgresql://example/db");
  });

  it("preserves an explicit trust decision already in the environment", () => {
    const env = spawnedServerEnv({ AUTH_TRUST_HOST: "false" });

    expect(env.AUTH_TRUST_HOST).toBe("false");
  });

  it("treats an empty AUTH_TRUST_HOST as unset, not as an explicit negative", () => {
    // The server-side trust parser reads the variable truthily, so an empty
    // string grants nothing — forcing "true" is the only honest reading of
    // "the caller left it empty".
    const env = spawnedServerEnv({ AUTH_TRUST_HOST: "" });

    expect(env.AUTH_TRUST_HOST).toBe("true");
  });
});

/**
 * The gate process's own .env loading (issue 453, round 4). The spawned
 * `next start` loads the repo-root .env family for itself, but the run's
 * seeding and secret reads happen in THIS process — after the branch added
 * authed contracts, a preflight-passing .env-only run threw "DATABASE_URL is
 * not set" from the very variable the preflight had just declared satisfied.
 * The semantics are the db:migrate precedent (node's --env-file-if-exists):
 * .env at the repo root only, a missing file is a no-op, and an
 * already-exported variable wins.
 */
describe("loadRepoEnvFile — the gate process's own .env (issue 453 round 4)", () => {
  it("fills variables the environment does not carry", async () => {
    const env: Record<string, string> = {};

    const applied = await loadRepoEnvFile({
      repoRoot: "/fake-root",
      env,
      readFileFn: async () => "DATABASE_URL=postgresql://example/db\nAUTH_SECRET=the-secret\n",
    });

    expect(applied).toEqual(["DATABASE_URL", "AUTH_SECRET"]);
    expect(env.DATABASE_URL).toBe("postgresql://example/db");
    expect(env.AUTH_SECRET).toBe("the-secret");
  });

  it("prefers an already-exported variable over the .env value", async () => {
    const env: Record<string, string> = { DATABASE_URL: "from-exported-environment" };

    const applied = await loadRepoEnvFile({
      repoRoot: "/fake-root",
      env,
      readFileFn: async () => "DATABASE_URL=from-dotenv-file\n",
    });

    expect(applied).toEqual([]);
    expect(env.DATABASE_URL).toBe("from-exported-environment");
  });

  it("treats a missing .env as a no-op, the way CI without one still runs", async () => {
    const env: Record<string, string> = {};

    const applied = await loadRepoEnvFile({
      repoRoot: "/fake-root",
      env,
      readFileFn: async () => {
        throw new Error("ENOENT: no .env here");
      },
    });

    expect(applied).toEqual([]);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("parses the shapes .env files actually carry", async () => {
    const env: Record<string, string> = {};

    await loadRepoEnvFile({
      repoRoot: "/fake-root",
      env,
      readFileFn: async () =>
        [
          "# a comment line",
          "export TOKEN_ENCRYPTION_KEY=\"abc def\"",
          "EMPTY=",
          "BROKEN LINE WITHOUT AN EQUALS SIGN",
          "=VALUE_WITH_NO_KEY",
        ].join("\n") + "\n",
    });

    expect(env.TOKEN_ENCRYPTION_KEY).toBe("abc def");
    expect(env.EMPTY).toBe("");
    expect(env.BROKEN).toBeUndefined();
    expect(env[""]).toBeUndefined();
  });
});

/**
 * The authed navigation's terminal landing states (issue 453 fix round 2).
 * A rejected session bounces to / or /session?reason=..., and a session the
 * ledger admits at the WRONG ROLE bounces to /dashboard (the role is
 * re-read from the database; /moderation redirects non-moderators there).
 * Every bounce must settle the poll and fail the ROW as a render failure
 * naming the landed URL — the original predicate knew only / and /session*,
 * so a /dashboard bounce burned the full 30s timeout and aborted the run
 * with no row and no diagnosis (reviewer-proven against this exact gate).
 */
describe("authedLandingState — the authed navigation's terminal landing states (issue 453)", () => {
  const target = "http://127.0.0.1:3219/moderation";

  it("settles at the target regardless of the stale-document marker", () => {
    expect(authedLandingState(target, target, false)).toBe("target");
    expect(authedLandingState(target, target, true)).toBe("target");
  });

  it("reads every bounce pathname — including /dashboard — as a row-level bounce", () => {
    expect(authedLandingState(target, "http://127.0.0.1:3219/", false)).toBe("bounce");
    expect(authedLandingState(target, "http://127.0.0.1:3219/session?reason=stale", false)).toBe("bounce");
    expect(authedLandingState(target, "http://127.0.0.1:3219/dashboard", false)).toBe("bounce");
  });

  it("holds the departing document pending so a previous page cannot satisfy the bounce arm", () => {
    // The stale-document marker is set on the document the navigation
    // departs from; while it lives, its location — bounce-shaped or not —
    // must read as pending, never as a landed bounce.
    expect(authedLandingState(target, "http://127.0.0.1:3219/", true)).toBe("pending");
    expect(authedLandingState(target, "http://127.0.0.1:3219/dashboard", true)).toBe("pending");
  });

  it("keeps an unrelated in-flight location pending", () => {
    expect(authedLandingState(target, "about:blank", false)).toBe("pending");
    expect(authedLandingState(target, "http://127.0.0.1:3219/issues", false)).toBe("pending");
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

    const createdAtAfterFirst = await sql<{ id: string; createdAt: Date }[]>`
      select id, created_at as "createdAt" from users order by id
    `;

    const second = await seedFixtureUsers({ databaseUrl });
    expect(second).toEqual(first);

    // The never-deletes half of the seeding constraint: an upsert keeps each
    // row's created_at, where a delete-and-recreate would reset it to now().
    const createdAtAfterSecond = await sql<{ id: string; createdAt: Date }[]>`
      select id, created_at as "createdAt" from users order by id
    `;
    expect(createdAtAfterSecond).toEqual(createdAtAfterFirst);

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
