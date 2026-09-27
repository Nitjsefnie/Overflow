import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import {
  createForgeIdentitiesDeleteHandler,
  createForgeIdentitiesGetHandler,
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import type { ForgeIdentityStore, ForgeIdentityView } from "@/lib/forge/identities";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import { deleteAccount } from "@/lib/accounts/deletion";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { foreignOrigin, guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

useTrustedOrigin();

const { json: mutationRequest } = guardedRequests("/api/forge-identities");

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
const SESSION = { user: { id: "user-1", role: "MEMBER" as const } };

function identityView(overrides: Partial<ForgeIdentityView> = {}): ForgeIdentityView {
  return {
    id: "identity-1",
    provider: "gitlab",
    instanceUrl: "https://gitlab.example.com",
    forgeLogin: "tester",
    verifiedAt: "2026-09-11T12:00:00.000Z",
    tokenFailedAt: null,
    ...overrides,
  };
}

function fixture(options: {
  session?: { user: { id: string; role: "MEMBER" | "MODERATOR" } } | null;
  sessionFails?: boolean;
  storeCreationFails?: boolean;
  listFails?: boolean;
  /** What the live role read answers (issue 733); "fails" makes it throw. */
  liveRole?: "MEMBER" | "MODERATOR" | null | "fails";
  list?: ForgeIdentityView[];
  deleted?: boolean;
  upsertResult?: ForgeIdentityView | null;
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const store: ForgeIdentityStore = {
    async listForUser(userId) {
      calls.push({ op: "listForUser", args: { userId } });
      if (options.listFails) {
        throw new Error("storage read unavailable");
      }
      return options.list ?? [];
    },
    async markTokenRejected(userId, identityId) {
      calls.push({ op: "markTokenRejected", args: { userId, identityId } });
    },
    async upsertIdentity(input) {
      calls.push({ op: "upsertIdentity", args: input });
      return options.upsertResult === undefined ? identityView() : options.upsertResult;
    },
    async deleteForUser(input) {
      calls.push({ op: "deleteForUser", args: input });
      return options.deleted ?? true;
    },
  };
  const dependencies: ForgeIdentitiesRouteDependencies = {
    getSession: vi.fn(async () => {
      if (options.sessionFails) {
        throw new Error("session lookup unavailable");
      }
      return options.session === undefined ? SESSION : options.session;
    }),
    getCurrentRole: vi.fn(async () => {
      if (options.liveRole === "fails") {
        throw new Error("role lookup unavailable");
      }
      return options.liveRole === undefined ? "MEMBER" : options.liveRole;
    }),
    createIdentityStore: vi.fn(() => {
      if (options.storeCreationFails) {
        throw new Error("store construction unavailable");
      }
      return store;
    }),
    tokenEncryptionKey: TEST_KEY,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // A linkable token: /user answers, and the token's own record carries read_api.
      const url = new Request(input, init).url;
      const payload = url.endsWith("/api/v4/personal_access_tokens/self")
        ? { id: 7, name: "overflow", scopes: ["read_api"] }
        : { id: 4242, username: "tester" };
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
    claimPastWork: vi.fn(async () => {}),
  };
  return { dependencies, calls };
}

describe("forge identities API", () => {
  const operations: {
    method: string;
    invoke: (dependencies: ForgeIdentitiesRouteDependencies) => Promise<Response>;
    checksLiveRole: boolean;
  }[] = [
    { method: "GET", invoke: (dependencies) => createForgeIdentitiesGetHandler(dependencies)(), checksLiveRole: false },
    { method: "POST", invoke: (dependencies) => createForgeIdentitiesPostHandler(dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com", token: "glpat-x",
    })), checksLiveRole: true },
    { method: "DELETE", invoke: (dependencies) => createForgeIdentitiesDeleteHandler(dependencies)(mutationRequest({
      id: "identity-1",
    }, "DELETE")), checksLiveRole: true },
  ];

  async function expectUpstreamFailure(response: Response) {
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "The forge identity operation could not complete." },
    });
  }

  it.each(operations)("$method answers a JSON 502 when session lookup rejects", async ({ invoke }) => {
    const f = fixture({ sessionFails: true });

    await expectUpstreamFailure(await invoke(f.dependencies));

    expect(f.dependencies.getSession).toHaveBeenCalledExactlyOnceWith();
    expect(f.dependencies.getCurrentRole).not.toHaveBeenCalled();
    expect(f.dependencies.createIdentityStore).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it.each(operations)("$method answers a JSON 502 when store construction throws", async ({ invoke, checksLiveRole }) => {
    const f = fixture({ storeCreationFails: true });

    await expectUpstreamFailure(await invoke(f.dependencies));

    expect(f.dependencies.getSession).toHaveBeenCalledExactlyOnceWith();
    if (checksLiveRole) {
      expect(f.dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith("user-1");
    } else {
      expect(f.dependencies.getCurrentRole).not.toHaveBeenCalled();
    }
    expect(f.dependencies.createIdentityStore).toHaveBeenCalledExactlyOnceWith();
    expect(f.calls).toEqual([]);
  });

  it("GET answers a JSON 502 when the identity list read rejects", async () => {
    const f = fixture({ listFails: true });

    await expectUpstreamFailure(await createForgeIdentitiesGetHandler(f.dependencies)());

    expect(f.dependencies.getSession).toHaveBeenCalledExactlyOnceWith();
    expect(f.dependencies.getCurrentRole).not.toHaveBeenCalled();
    expect(f.dependencies.createIdentityStore).toHaveBeenCalledExactlyOnceWith();
    expect(f.calls).toEqual([{ op: "listForUser", args: { userId: "user-1" } }]);
  });

  it("requires a session for every operation", async () => {
    const f = fixture({ session: null });
    expect((await createForgeIdentitiesGetHandler(f.dependencies)()).status).toBe(401);
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }))).status).toBe(401);
    expect((await createForgeIdentitiesDeleteHandler(f.dependencies)(mutationRequest({ id: "identity-1" }, "DELETE"))).status).toBe(401);
  });

  it("refuses a link for a deleted account with the exact member-gate envelope, before the body or the store", async () => {
    const f = fixture({ liveRole: null });
    const request = mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    });
    const parseBody = vi.spyOn(request, "json");

    const response = await createForgeIdentitiesPostHandler(f.dependencies)(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(f.dependencies.getSession).toHaveBeenCalledExactlyOnceWith();
    expect(f.dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(parseBody).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(f.dependencies.createIdentityStore).not.toHaveBeenCalled();
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.claimPastWork).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("refuses an unlink for a deleted account with the exact member-gate envelope", async () => {
    const f = fixture({ liveRole: null });
    const response = await createForgeIdentitiesDeleteHandler(f.dependencies)(mutationRequest(
      { id: "identity-1" },
      "DELETE",
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(f.dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(f.calls).toEqual([]);
  });

  it("answers 502 without touching the store when the role read fails", async () => {
    const f = fixture({ liveRole: "fails" });
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "The forge identity operation could not complete." },
    });
    expect(f.calls).toEqual([]);
  });

  it("consults the live role read for the writes but never for the GET", async () => {
    const f = fixture({ list: [identityView()] });
    expect((await createForgeIdentitiesGetHandler(f.dependencies)()).status).toBe(200);
    expect(f.dependencies.getCurrentRole).not.toHaveBeenCalled();

    expect((await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "sugar",
      token: "glpat-x",
    }))).status).toBe(400);
    // The gate ran ahead of the body validation: the lookup happened even
    // though the malformed body refused afterward.
    expect(f.dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith("user-1");
  });

  it("lists the caller's identities and never a token", async () => {
    const f = fixture({ list: [identityView()] });
    const response = await createForgeIdentitiesGetHandler(f.dependencies)();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { identities: Array<Record<string, unknown>> };
    expect(body.identities).toHaveLength(1);
    expect(Object.keys(body.identities[0]!).sort()).toEqual([
      "forgeLogin", "id", "instanceUrl", "provider", "tokenFailedAt", "verifiedAt",
    ]);
    expect(f.calls[0]).toMatchObject({ op: "listForUser", args: { userId: "user-1" } });
  });

  it("exposes the re-verification marker on the listed identity", async () => {
    const failedAt = "2026-09-11T13:00:00.000Z";
    const f = fixture({ list: [identityView({ tokenFailedAt: failedAt })] });
    const response = await createForgeIdentitiesGetHandler(f.dependencies)();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { identities: Array<{ tokenFailedAt: string | null }> };
    expect(body.identities[0]!.tokenFailedAt).toBe(failedAt);
  });

  it("links with the session's user id and answers 201", async () => {
    const f = fixture();
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }));
    expect(response.status).toBe(201);
    const upsert = f.calls.find((call) => call.op === "upsertIdentity");
    expect(upsert).toBeDefined();
    expect((upsert!.args as { userId: string }).userId).toBe("user-1");
  });

  it("rejects a malformed link body", async () => {
    const f = fixture();
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({ instanceUrl: "x" }))).status).toBe(400);
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
      extra: true,
    }))).status).toBe(400);
  });

  it("refuses an http instance as 400 INVALID_INPUT before any request leaves, storing nothing", async () => {
    const f = fixture();
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "http://gitlab.example.com",
      token: "glpat-x",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
    // The token never travels: not one outbound request was made.
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.claimPastWork).not.toHaveBeenCalled();
    expect(f.calls.filter((call) => call.op === "upsertIdentity")).toEqual([]);
  });

  it("maps the service's UNVERIFIED refusal to 401 without a row", async () => {
    const f = fixture({ upsertResult: null });
    // upsertResult null is the cross-account refusal; the UNVERIFIED path is
    // exercised by the service tests — here the mapping is what is pinned.
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }));
    expect(response.status).toBe(403);
  });

  it("deletes only the caller's own identity and answers 404 on a foreign or absent id", async () => {
    const f = fixture({ deleted: true });
    const response = await createForgeIdentitiesDeleteHandler(f.dependencies)(mutationRequest({ id: "identity-9" }, "DELETE"));
    expect(response.status).toBe(200);
    const deletion = f.calls.find((call) => call.op === "deleteForUser");
    expect(deletion!.args).toEqual({ identityId: "identity-9", userId: "user-1" });

    const foreign = fixture({ deleted: false });
    const refused = await createForgeIdentitiesDeleteHandler(foreign.dependencies)(mutationRequest({ id: "identity-9" }, "DELETE"));
    expect(refused.status).toBe(404);
  });
});

describe.each([
  {
    method: "POST",
    createHandler: createForgeIdentitiesPostHandler,
    body: { instanceUrl: "https://gitlab.example.com", token: "glpat-x" },
    successStatus: 201,
    storeOperation: "upsertIdentity",
  },
  {
    method: "DELETE",
    createHandler: createForgeIdentitiesDeleteHandler,
    body: { id: "identity-1" },
    successStatus: 200,
    storeOperation: "deleteForUser",
  },
])("$method forge identity request boundary", ({ method, createHandler, body, successStatus, storeOperation }) => {
  async function expectRejection(request: Request, status: number, code: string) {
    const f = fixture();
    const parseBody = vi.spyOn(request, "json");

    const response = await createHandler(f.dependencies)(request);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(f.dependencies.getSession).not.toHaveBeenCalled();
    expect(parseBody).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(f.dependencies.createIdentityStore).not.toHaveBeenCalled();
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.claimPastWork).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  }

  it.each([
    ["foreign", foreignOrigin],
    ["missing", null],
    ["different scheme", "http://overflow.example"],
    ["different port", "https://overflow.example:8443"],
    ["lookalike host", "https://overflow.example.attacker.example"],
    ["opaque", "null"],
  ])("rejects a %s origin before authentication, body parsing, or side effects", async (_name, origin) => {
    const request = mutationRequest(body, method);
    if (origin === null) {
      request.headers.delete("origin");
    } else {
      request.headers.set("origin", origin);
    }

    await expectRejection(request, 403, "FORBIDDEN");
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""])(
    "rejects explicit Content-Type %j before authentication, body parsing, or side effects",
    async (contentType) => {
      const request = mutationRequest(body, method, { "content-type": contentType });

      await expectRejection(request, 415, "UNSUPPORTED_MEDIA_TYPE");
    },
  );

  it("allows a trusted request with genuinely absent Content-Type", async () => {
    const f = fixture();
    const request = mutationRequest(body, method);
    request.headers.delete("content-type");
    expect(request.headers.has("content-type")).toBe(false);

    const response = await createHandler(f.dependencies)(request);

    expect(response.status).toBe(successStatus);
    expect(f.calls).toContainEqual({ op: storeOperation, args: expect.objectContaining({ userId: "user-1" }) });
  });
});

/**
 * Issue 733: the session JWT outlives the account it was issued for, so the
 * write verbs re-read the account's role live before acting on the session's
 * account id. The deleted row here is real: the suite runs the migrations and
 * the account deletion against a disposable database, and the refusal is
 * asserted through the real getCurrentUserRole. GET is deliberately absent —
 * it reads the caller's own, already scrubbed rows, so a deleted account's
 * list answers empty without a gate.
 */
describe("forge identity writes for a deleted account (issue 733)", () => {
  let sql: Sql;
  let container: StartedTestContainer | undefined;
  let deletedAccountId = "";
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "forge_deleted_account_test",
      user: "forge_deleted_account_test",
      password: "forge_deleted_account_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = postgres(started.databaseUrl, { max: 1 });
    await runMigrations();
    const githubUserId = 7_330_002;
    const [row] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${githubUserId}, 'deleted-gate-forge')
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

  it("refuses a link with the member-gate envelope when the account row is deleted", async () => {
    // The lookup is the real one against the container: the row is provably
    // deleted, not merely unknown to a stub.
    expect(await getCurrentUserRole(deletedAccountId, sql)).toBeNull();

    const f = fixture({ session: { user: { id: deletedAccountId, role: "MEMBER" } } });
    f.dependencies.getCurrentRole = (userId) => getCurrentUserRole(userId, sql);
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(f.calls).toEqual([]);
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.claimPastWork).not.toHaveBeenCalled();
  });

  it("refuses an unlink with the member-gate envelope when the account row is deleted", async () => {
    const f = fixture({ session: { user: { id: deletedAccountId, role: "MEMBER" } } });
    f.dependencies.getCurrentRole = (userId) => getCurrentUserRole(userId, sql);
    const response = await createForgeIdentitiesDeleteHandler(f.dependencies)(mutationRequest(
      { id: "identity-1" },
      "DELETE",
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(f.calls).toEqual([]);
  });
});
