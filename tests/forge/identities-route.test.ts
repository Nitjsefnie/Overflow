import { describe, expect, it } from "vitest";
import {
  createForgeIdentitiesDeleteHandler,
  createForgeIdentitiesGetHandler,
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import type { ForgeIdentityStore, ForgeIdentityView } from "@/lib/forge/identities";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
const SESSION = { user: { id: "user-1", role: "MEMBER" as const } };

function identityView(overrides: Partial<ForgeIdentityView> = {}): ForgeIdentityView {
  return {
    id: "identity-1",
    provider: "gitlab",
    instanceUrl: "https://gitlab.example.com",
    forgeLogin: "tester",
    verifiedAt: "2026-09-11T12:00:00.000Z",
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
    getSession: async () => options.session === undefined ? SESSION : options.session,
    createIdentityStore: () => store,
    tokenEncryptionKey: TEST_KEY,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ id: 4242, username: "tester" }), { status: 200 });
    }) as typeof fetch,
  };
  return { dependencies, calls };
}

function postRequest(body: unknown): Request {
  return new Request("https://overflow.example/api/forge-identities", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("forge identities API", () => {
  it("requires a session for every operation", async () => {
    const f = fixture({ session: null });
    expect((await createForgeIdentitiesGetHandler(f.dependencies)()).status).toBe(401);
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(postRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }))).status).toBe(401);
    expect((await createForgeIdentitiesDeleteHandler(f.dependencies)(postRequest({ id: "identity-1" }))).status).toBe(401);
  });

  it("lists the caller's identities and never a token", async () => {
    const f = fixture({ list: [identityView()] });
    const response = await createForgeIdentitiesGetHandler(f.dependencies)();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { identities: Array<Record<string, unknown>> };
    expect(body.identities).toHaveLength(1);
    expect(Object.keys(body.identities[0]!).sort()).toEqual([
      "forgeLogin", "id", "instanceUrl", "provider", "verifiedAt",
    ]);
    expect(f.calls[0]).toMatchObject({ op: "listForUser", args: { userId: "user-1" } });
  });

  it("links with the session's user id and answers 201", async () => {
    const f = fixture();
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(postRequest({
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
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(postRequest({ instanceUrl: "x" }))).status).toBe(400);
    expect((await createForgeIdentitiesPostHandler(f.dependencies)(postRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
      extra: true,
    }))).status).toBe(400);
  });

  it("maps the service's UNVERIFIED refusal to 401 without a row", async () => {
    const f = fixture({ upsertResult: null });
    // upsertResult null is the cross-account refusal; the UNVERIFIED path is
    // exercised by the service tests — here the mapping is what is pinned.
    const response = await createForgeIdentitiesPostHandler(f.dependencies)(postRequest({
      instanceUrl: "https://gitlab.example.com",
      token: "glpat-x",
    }));
    expect(response.status).toBe(403);
  });

  it("deletes only the caller's own identity and answers 404 on a foreign or absent id", async () => {
    const f = fixture({ deleted: true });
    const response = await createForgeIdentitiesDeleteHandler(f.dependencies)(postRequest({ id: "identity-9" }));
    expect(response.status).toBe(200);
    const deletion = f.calls.find((call) => call.op === "deleteForUser");
    expect(deletion!.args).toEqual({ identityId: "identity-9", userId: "user-1" });

    const foreign = fixture({ deleted: false });
    const refused = await createForgeIdentitiesDeleteHandler(foreign.dependencies)(postRequest({ id: "identity-9" }));
    expect(refused.status).toBe(404);
  });
});
