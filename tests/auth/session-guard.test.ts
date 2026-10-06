import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import {
  bumpSessionEpoch,
  isEpochRejected,
  readSessionGuardState,
  revokeAccountSessions,
  type SessionGuardSnapshot,
} from "@/lib/auth/session-guard";

/**
 * The per-account session guard (issue 1043): the pure epoch decisions and
 * the database reads the jwt refresh performs. `isEpochRejected` pins which
 * tokens survive an epoch mismatch — a token that cannot prove it was minted
 * under the account's current epoch dies, and a MISSING account row keeps
 * today's pass-through. The database legs prove `readSessionGuardState`
 * classifies LIVE/DELETED/MISSING from one query and that
 * `bumpSessionEpoch` increments and reports the row's epoch, refusing to
 * report success about an account that is not there.
 */

afterAll(() => { vi.resetModules(); });

const GITHUB_USER_ID_BASE = 76_402_500;
let nextGithubUserId = GITHUB_USER_ID_BASE;

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "session_guard",
    user: "session_guard",
    password: "session_guard",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl, { max: 1 });
});

afterAll(async () => {
  await sql?.end();
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

/** Seeds one live account and returns its row id and GitHub identity. */
async function seedLiveUser(): Promise<{ id: string; githubUserId: number; login: string }> {
  const githubUserId = nextGithubUserId;
  nextGithubUserId += 1;
  const login = `guard-user-${githubUserId}`;
  await sql!`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login})
  `;
  const [row] = await sql!<{ id: string }[]>`
    select id from users where github_user_id = ${githubUserId}
  `;
  return { id: row!.id, githubUserId, login };
}

describe("isEpochRejected", () => {
  it("accepts a token whose epoch equals the row's", () => {
    expect(isEpochRejected(0, 0)).toBe(false);
    expect(isEpochRejected(7, 7)).toBe(false);
  });

  it("rejects a token minted under an earlier epoch", () => {
    expect(isEpochRejected(0, 1)).toBe(true);
  });

  it("rejects a token carrying an epoch the row has left behind", () => {
    expect(isEpochRejected(2, 1)).toBe(true);
  });

  it("keeps the MISSING-row pass-through: no row epoch can be compared", () => {
    expect(isEpochRejected(0, null)).toBe(false);
    expect(isEpochRejected(undefined, null)).toBe(false);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "null", value: null },
    { label: "a string", value: "0" },
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
  ])("rejects a token whose epoch claim is $label — a pre-fix token cannot prove its epoch", ({ value }) => {
    expect(isEpochRejected(value, 0)).toBe(true);
  });
});

describe("readSessionGuardState", () => {
  it("classifies a live row with its login and its epoch", async () => {
    const user = await seedLiveUser();

    await expect(readSessionGuardState(user.id)).resolves.toEqual({
      state: "LIVE",
      githubLogin: user.login,
      sessionEpoch: 0,
    } satisfies SessionGuardSnapshot);
  });

  it("classifies a pseudonymised row as DELETED with nothing to carry", async () => {
    const user = await seedLiveUser();
    await sql!`
      update users set deleted_at = now(), avatar_url = null, encrypted_oauth_token = null
      where id = ${user.id}
    `;

    await expect(readSessionGuardState(user.id)).resolves.toEqual({
      state: "DELETED",
      githubLogin: null,
      sessionEpoch: null,
    } satisfies SessionGuardSnapshot);
  });

  it("classifies an absent row as MISSING with nothing to carry", async () => {
    await expect(readSessionGuardState(randomUUID())).resolves.toEqual({
      state: "MISSING",
      githubLogin: null,
      sessionEpoch: null,
    } satisfies SessionGuardSnapshot);
  });
});

describe("bumpSessionEpoch", () => {
  it("increments the row's epoch and reports the new value", async () => {
    const user = await seedLiveUser();

    await expect(bumpSessionEpoch(user.id)).resolves.toBe(1);
    const [row] = await sql!<{ session_epoch: number }[]>`
      select session_epoch from users where id = ${user.id}
    `;
    expect(row!.session_epoch).toBe(1);
  });

  it("keeps counting: a second bump reports 2", async () => {
    const user = await seedLiveUser();

    await bumpSessionEpoch(user.id);
    await expect(bumpSessionEpoch(user.id)).resolves.toBe(2);
  });

  it("throws when no row carries the id", async () => {
    await expect(bumpSessionEpoch(randomUUID())).rejects.toThrow(/no user/);
  });
});

describe("revokeAccountSessions", () => {
  it("bumps the account's epoch — the operator verb for ending one account's sessions", async () => {
    const user = await seedLiveUser();

    await expect(revokeAccountSessions(user.id)).resolves.toBe(1);
    const [row] = await sql!<{ session_epoch: number }[]>`
      select session_epoch from users where id = ${user.id}
    `;
    expect(row!.session_epoch).toBe(1);
  });
});
