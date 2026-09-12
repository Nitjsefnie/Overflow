import { describe, expect, it, vi } from "vitest";
import {
  createForgeIdentitiesDeleteHandler,
  createForgeIdentitiesGetHandler,
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import type { ForgeIdentityStore, ForgeIdentityView } from "@/lib/forge/identities";
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
  list?: ForgeIdentityView[];
  deleted?: boolean;
  upsertResult?: ForgeIdentityView | null;
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const store: ForgeIdentityStore = {
    async listForUser(userId) {
      calls.push({ op: "listForUser", args: { userId } });
      return options.list ?? [];
    },
    async markTokenRejected(userId, instanceUrl) {
      calls.push({ op: "markTokenRejected", args: { userId, instanceUrl } });
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
    getSession: vi.fn(async () => options.session === undefined ? SESSION : options.session),
    createIdentityStore: vi.fn(() => store),
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
  it("requires a session for every operation", async () => {
    const f = fixture({ session: null });
    expect((await createForgeIdentitiesGetHandler(f.dependencies)()).status).toBe(401);
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(mutationRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }))).status).toBe(401);
    expect((await createForgeIdentitiesDeleteHandler(f.dependencies)(mutationRequest({ id: "identity-1" }, "DELETE"))).status).toBe(401);
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
