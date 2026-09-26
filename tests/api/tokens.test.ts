import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import {
  foreignOrigin,
  requestHost,
  trustedOrigin,
  useTrustedOrigin,
} from "../support/trusted-origin";
import { apiTokenPrefix, hashApiToken, mintApiToken } from "@/lib/security/api-token";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import { deleteAccount } from "@/lib/accounts/deletion";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  createApiTokenPostHandler,
  POST as productionPost,
  type ApiTokenIssuer,
  type ApiTokenRouteDependencies,
} from "@/app/api/tokens/route";

// Rebind cached consumers to this file's mocks when workers are shared
// (isolate:false), both ways: a previous file's real or mocked db-client
// record would otherwise win over this file's mock (its production-wiring
// tests would answer 502 through the real getSql), and this file's records
// would leak its stub into the next file's production wiring. Same pattern as
// tests/api/reconciliation-wiring.test.ts.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

// The production wiring reads the live role through `getSql()` (issue 733),
// and the unit tests here run without a database: the stub answers one live
// MEMBER role row. The container suite below passes its own sql to
// getCurrentUserRole explicitly, so the stub never stands in for a real
// lookup there, and runMigrations keeps the real module's transaction client.
const { sqlStub } = vi.hoisted(() => ({
  sqlStub: vi.fn(async () => [{ role: "MEMBER" }]),
}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getSql: () => sqlStub };
});

const { productionAuth } = vi.hoisted(() => ({ productionAuth: vi.fn() }));

vi.mock("@/auth", () => ({ auth: productionAuth }));

useTrustedOrigin();

describe("POST /api/tokens", () => {
  beforeEach(() => {
    spyOnConsoleOutput();
  });

  afterEach(() => {
    try {
      expectNoConsoleOutput();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(["another-member-id", "second-member-id"])("mints a token for signed-in member %s, returning the plaintext while storing only its hash", async (userId) => {
    const store = recordingStore();
    const handler = createApiTokenPostHandler(signedInAs(userId, store));

    const response = await handler(mintRequest());
    const body = (await response.json()) as { token: string; createdAt: string; expiresAt: string };

    expect(response.status).toBe(201);
    expect(body).toEqual({
      token: expect.stringMatching(/^ovf_[A-Za-z0-9_-]{43}$/),
      createdAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    expect(store.calls).toEqual([{ userId, tokenHash: expect.any(Buffer) }]);

    // The whole "shown once" design fails silently if these two are swapped, so
    // assert the relationship rather than either value on its own.
    const storedHash = store.calls[0].tokenHash;
    expect(storedHash.equals(hashApiToken(body.token) as Buffer)).toBe(true);
    expect(storedHash.equals(Buffer.from(body.token, "utf8"))).toBe(false);
  });

  it("returns a structured 401 without a session and never reaches the store", async () => {
    const store = recordingStore();
    const handler = createApiTokenPostHandler(signedOut(store));

    const response = await handler(mintRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(store.calls).toEqual([]);
  });

  it("returns a structured 502 carrying no token material when the store fails", async () => {
    const store = recordingStore({ failure: true });
    const handler = createApiTokenPostHandler(signedInAs("member-id", store));

    const response = await handler(mintRequest());
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to issue an API token." },
    });

    // A token was minted before the failure; neither it nor its hash may appear.
    expect(text).not.toContain(apiTokenPrefix);
    const storedHash = store.calls[0].tokenHash;
    expect(text).not.toContain(storedHash.toString("hex"));
    expect(text).not.toContain(storedHash.toString("base64url"));
  });

  it("returns a structured 502 without logging when token store creation fails after minting", async () => {
    const handler = createApiTokenPostHandler({
      getSession: async () => ({ user: { id: "member-id", role: "MEMBER", authenticatedAt: freshSignIn } }),
      getCurrentRole: async () => "MEMBER",
      createTokenStore: async () => {
        throw new Error("token store unavailable");
      },
      now: () => clockAt,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to issue an API token." },
    });
  });

  it("returns a structured 502 when the session lookup fails", async () => {
    const store = recordingStore();
    const handler = createApiTokenPostHandler({
      getSession: async () => {
        throw new Error("session backend unavailable");
      },
      getCurrentRole: async () => "MEMBER",
      createTokenStore: async () => store,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to issue an API token." },
    });
    expect(store.calls).toEqual([]);
  });

  it("mints a distinct token on every call, so regenerating replaces the stored hash", async () => {
    const store = recordingStore();
    const handler = createApiTokenPostHandler(signedInAs("member-id", store));

    const first = (await (await handler(mintRequest())).json()) as { token: string };
    const second = (await (await handler(mintRequest())).json()) as { token: string };

    expect(second.token).not.toEqual(first.token);
    expect(store.calls).toHaveLength(2);
    expect(store.calls[1].tokenHash.equals(store.calls[0].tokenHash)).toBe(false);
  });

  it("refuses to mint for a request carrying only an API token credential", async () => {
    // A token cannot mint its successor: revocation stays a human act in a
    // browser, and a leaked token cannot roll itself forward.
    const store = recordingStore();
    const handler = createApiTokenPostHandler(signedOut(store));
    const { token } = mintApiToken();

    const response = await handler(mintRequest({ authorization: `Bearer ${token}` }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(store.calls).toEqual([]);
    expect(store.accountLookups).toEqual([]);
  });

  // A forged request must cost the server nothing: no session read, no store.
  it("refuses a foreign-origin request before reading the session or the store", async () => {
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createTokenStore = vi.fn();
    const handler = createApiTokenPostHandler({ getSession, getCurrentRole, createTokenStore });

    const response = await handler(
      mintRequest({ origin: foreignOrigin, "content-type": "text/plain" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(createTokenStore).not.toHaveBeenCalled();
  });

  it("refuses a trusted-origin request that is not JSON", async () => {
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createTokenStore = vi.fn();
    const handler = createApiTokenPostHandler({ getSession, getCurrentRole, createTokenStore });

    const response = await handler(mintRequest({ "content-type": "text/plain" }));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(createTokenStore).not.toHaveBeenCalled();
  });

  describe("GitHub sign-in freshness", () => {
    const tenMinutes = 10 * 60 * 1000;
    const refusal = {
      error: {
        code: "REAUTHENTICATION_REQUIRED",
        message: "Confirm your GitHub sign-in to issue an API token.",
      },
    };

    it.each([
      { label: "exactly ten minutes old", now: clockAt + tenMinutes },
      { label: "signed in this instant", now: clockAt },
      { label: "a minute ahead of the clock (allowed skew)", now: clockAt - 60_000 },
    ])("mints for a sign-in $label", async ({ now }) => {
      const store = recordingStore();
      const handler = createApiTokenPostHandler(signedInAs("member-id", store, clockAt / 1000, now));

      const response = await handler(mintRequest());

      expect(response.status).toBe(201);
      expect(store.calls).toHaveLength(1);
    });

    it.each([
      { label: "one millisecond past ten minutes old", authenticatedAt: clockAt / 1000, now: clockAt + tenMinutes + 1 },
      { label: "hours old", authenticatedAt: clockAt / 1000 - 4 * 3600, now: clockAt },
      { label: "absent (a JWT issued before the claim existed)", authenticatedAt: null, now: clockAt },
      { label: "further ahead of the clock than the allowed skew", authenticatedAt: clockAt / 1000, now: clockAt - 60_001 },
    ])("refuses a sign-in $label with 403 before minting or storing", async ({ authenticatedAt, now }) => {
      const store = recordingStore();
      const createTokenStore = vi.fn(async () => store);
      const handler = createApiTokenPostHandler({
        ...signedInAs("member-id", store, authenticatedAt, now),
        createTokenStore,
      });

      const response = await handler(mintRequest());

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual(refusal);
      expect(createTokenStore).not.toHaveBeenCalled();
      expect(store.calls).toEqual([]);
    });

    it("still answers 401, not 403, when there is no session at all", async () => {
      const store = recordingStore();
      const handler = createApiTokenPostHandler({ ...signedOut(store), now: () => clockAt });

      const response = await handler(mintRequest());

      expect(response.status).toBe(401);
    });

    it.each([
      { label: "a stale", authenticatedAt: 1 },
      { label: "no", authenticatedAt: undefined },
      { label: "a non-numeric", authenticatedAt: "1790424000" },
    ])("refuses $label sign-in instant read from the production session", async ({ authenticatedAt }) => {
      productionAuth.mockResolvedValueOnce({
        user: { id: "member-id", role: "MEMBER", ...(authenticatedAt === undefined ? {} : { authenticatedAt }) },
      });

      const response = await productionPost(mintRequest({ "content-type": "application/json" }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual(refusal);
    });
  });

  // The invariant at the production wiring, not only through injected
  // dependencies: a syntactically valid ovf_ credential in the Authorization
  // header and no session is 401, because the production route module never
  // wires a token lookup at all. A token cannot mint its successor.
  it("refuses a syntactically valid bearer token with no session through the production route", async () => {
    productionAuth.mockResolvedValueOnce(null);
    const { token } = mintApiToken();

    const response = await productionPost(mintRequest({ authorization: `Bearer ${token}` }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });
});

const issuedAt = new Date("2026-09-05T10:00:00.000Z");
const expiresAt = new Date("2026-12-04T10:00:00.000Z");

type RecordingStore = ApiTokenIssuer & {
  calls: { userId: string; tokenHash: Buffer }[];
  accountLookups: Buffer[];
  findAccountByTokenHash(tokenHash: Buffer): Promise<{ id: string }>;
};

/**
 * Records every way the route could touch the token store. The account lookup
 * is here so that a route resolving an account from a bearer credential leaves
 * a trace the tests can fail on.
 */
function recordingStore(options: { failure?: boolean } = {}): RecordingStore {
  const calls: { userId: string; tokenHash: Buffer }[] = [];
  const accountLookups: Buffer[] = [];
  return {
    calls,
    accountLookups,
    async issueToken(userId, tokenHash) {
      calls.push({ userId, tokenHash });
      if (options.failure) {
        throw new Error("api_tokens upsert failed");
      }
      return { createdAt: issuedAt, expiresAt };
    },
    async findAccountByTokenHash(tokenHash) {
      accountLookups.push(tokenHash);
      return { id: "member-id" };
    },
  };
}

function signedOut(store: ApiTokenIssuer): ApiTokenRouteDependencies {
  return {
    getSession: async () => null,
    getCurrentRole: async () => "MEMBER",
    createTokenStore: async () => store,
  };
}

/**
 * The injected clock every handler test reads, and a GitHub sign-in one minute
 * before it: fresh enough to mint, and independent of the day the suite runs.
 */
const clockAt = Date.parse("2026-09-26T12:00:00.000Z");
const freshSignIn = clockAt / 1000 - 60;

function signedInAs(
  userId: string,
  store: ApiTokenIssuer,
  authenticatedAt: number | null = freshSignIn,
  now: number = clockAt,
): ApiTokenRouteDependencies {
  return {
    getSession: async () => ({ user: { id: userId, role: "MEMBER", authenticatedAt } }),
    getCurrentRole: async () => "MEMBER",
    createTokenStore: async () => store,
    now: () => now,
  };
}

function mintRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${requestHost}/api/tokens`, {
    method: "POST",
    headers: { origin: trustedOrigin, ...headers },
  });
}

/**
 * Issue 733: the session JWT outlives the account it was issued for, so the
 * route re-reads the account's role live before minting. The deleted row here
 * is real: the suite runs the migrations and the account deletion against a
 * disposable database, and the refusal is asserted through the real
 * getCurrentUserRole, so a stub could never wave the gate through.
 */
describe("POST /api/tokens for a deleted account (issue 733)", () => {
  let sql: Sql;
  let container: StartedTestContainer | undefined;
  let deletedAccountId = "";
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "tokens_deleted_account_test",
      user: "tokens_deleted_account_test",
      password: "tokens_deleted_account_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = postgres(started.databaseUrl, { max: 1 });
    await runMigrations();
    const githubUserId = 7_330_001;
    const [row] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${githubUserId}, 'deleted-gate-member')
      returning id
    `;
    deletedAccountId = row!.id;
    await deleteAccount(sql, githubUserId, { confirm: true });
  });

  afterAll(async () => {
    // Two pools: runMigrations ran on the module client, the fixtures on this one.
    await closeSql();
    await sql.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("refuses to mint with the member-gate envelope when the account row is deleted", async () => {
    // The lookup is the real one against the container: the row is provably
    // deleted, not merely unknown to a stub.
    expect(await getCurrentUserRole(deletedAccountId, sql)).toBeNull();

    const store = recordingStore();
    const createTokenStore = vi.fn(async () => store);
    const handler = createApiTokenPostHandler({
      getSession: async () => ({ user: { id: deletedAccountId, role: "MEMBER", authenticatedAt: freshSignIn } }),
      getCurrentRole: (userId) => getCurrentUserRole(userId, sql),
      createTokenStore,
      now: () => clockAt,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(createTokenStore).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it("answers the member-gate envelope for the deleted account even with a stale sign-in", async () => {
    // The ordering pin, against the real deleted row: the live-account gate
    // precedes the recent-sign-in check, so a deleted account never reads the
    // reauthentication refusal.
    const store = recordingStore();
    const handler = createApiTokenPostHandler({
      getSession: async () => ({ user: { id: deletedAccountId, role: "MEMBER", authenticatedAt: 1 } }),
      getCurrentRole: (userId) => getCurrentUserRole(userId, sql),
      createTokenStore: async () => store,
      now: () => clockAt,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(store.calls).toEqual([]);
  });
});

describe("POST /api/tokens live-account gate (issue 733)", () => {
  beforeEach(() => {
    spyOnConsoleOutput();
  });

  afterEach(() => {
    try {
      expectNoConsoleOutput();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses with the exact member-gate envelope when the role read returns null", async () => {
    const store = recordingStore();
    const getCurrentRole = vi.fn(async () => null);
    const handler = createApiTokenPostHandler({
      ...signedInAs("member-id", store),
      getCurrentRole,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(getCurrentRole).toHaveBeenCalledExactlyOnceWith("member-id");
    expect(store.calls).toEqual([]);
  });

  it("mints when the role read confirms a live account", async () => {
    const store = recordingStore();
    const getCurrentRole = vi.fn(async () => "MODERATOR" as const);
    const handler = createApiTokenPostHandler({
      ...signedInAs("moderator-id", store),
      getCurrentRole,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(201);
    expect(getCurrentRole).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([{ userId: "moderator-id", tokenHash: expect.any(Buffer) }]);
  });

  it("answers 502 without minting when the role read fails", async () => {
    const store = recordingStore();
    const handler = createApiTokenPostHandler({
      ...signedInAs("member-id", store),
      getCurrentRole: async () => {
        throw new Error("role lookup unavailable");
      },
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to issue an API token." },
    });
    expect(store.calls).toEqual([]);
  });

  it("still answers the recent-sign-in 403 for a live account with a stale sign-in", async () => {
    // The ordering pin's other half: a live account's stale sign-in is the
    // reauthentication refusal, so the two 403s stay distinguishable.
    const store = recordingStore();
    const getCurrentRole = vi.fn(async () => "MEMBER" as const);
    const handler = createApiTokenPostHandler({
      ...signedInAs("member-id", store, 1),
      getCurrentRole,
    });

    const response = await handler(mintRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REAUTHENTICATION_REQUIRED",
        message: "Confirm your GitHub sign-in to issue an API token.",
      },
    });
    expect(getCurrentRole).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([]);
  });
});
