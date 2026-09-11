import { describe, expect, it } from "vitest";
import { decryptToken } from "@/lib/security/token-cipher";
import {
  ForgeIdentityError,
  linkForgeIdentity,
  normalizeInstanceUrl,
  type ForgeIdentityStore,
} from "@/lib/forge/identities";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

function fakeStore() {
  const upserts: Array<Record<string, unknown>> = [];
  return {
    upserts,
    store: {
      async upsertIdentity(input: { userId: string; provider: string; instanceUrl: string; forgeUserId: number; forgeLogin: string; encryptedToken: string }) {
        upserts.push({ ...input });
        return {
          id: "identity-1",
          provider: input.provider,
          instanceUrl: input.instanceUrl,
          forgeLogin: input.forgeLogin,
          verifiedAt: "2026-09-11T12:00:00.000Z",
        };
      },
    } as unknown as ForgeIdentityStore,
  };
}

const USER_URL = "https://gitlab.example.com/api/v4/user";
const SELF_URL = "https://gitlab.example.com/api/v4/personal_access_tokens/self";
const PROBE_URL = "https://gitlab.example.com/api/v4/projects?membership=true&per_page=1";

type Answer = { status: number; body?: unknown } | "transport-failure";

/**
 * A fetch stub keyed on the exact URL. Every request is recorded, so a test
 * asserts on the sequence the service made rather than inside the stub — an
 * `expect` thrown inside fetch would be swallowed by the service's transport
 * catch and read as a refusal. A URL no test listed answers 599 so it lands
 * as an upstream failure rather than a silent pass.
 */
function fetchStub(answers: Record<string, Answer>) {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchImplementation = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    const answer = answers[request.url];
    if (answer === undefined) {
      return new Response("unexpected request", { status: 599 });
    }
    if (answer === "transport-failure") {
      throw new Error("the operation was aborted");
    }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImplementation, requests };
}

const FORGE_USER = { status: 200, body: { id: 4242, username: "tester" } };
const SELF_READ_API = { status: 200, body: { id: 7, name: "overflow", scopes: ["read_api"] } };

/** The stub for a link that succeeds: /user answers, the token carries read_api. */
function fetchLinkable() {
  return fetchStub({ [USER_URL]: FORGE_USER, [SELF_URL]: SELF_READ_API });
}

describe("normalizeInstanceUrl", () => {
  it("lowercases the scheme and host and strips path and trailing slash", () => {
    expect(normalizeInstanceUrl("HTTPS://GitLab.Example.com/")).toBe("https://gitlab.example.com");
    expect(normalizeInstanceUrl("https://gitlab.example.com/group/project")).toBe("https://gitlab.example.com");
  });

  it("keeps the port, lowercased", () => {
    expect(normalizeInstanceUrl("https://GitLab.Example.com:8443/")).toBe("https://gitlab.example.com:8443");
  });

  it("rejects a value with no scheme or no host", () => {
    expect(() => normalizeInstanceUrl("gitlab.example.com")).toThrow(ForgeIdentityError);
    expect(() => normalizeInstanceUrl("https://")).toThrow(ForgeIdentityError);
  });
});

describe("linkForgeIdentity", () => {
  it("verifies the token against /api/v4/user and its scopes, encrypts it, and upserts on the triple", async () => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation, requests } = fetchLinkable();
    const identity = await linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://GitLab.Example.com/", token: "glpat-live" },
    );
    expect(requests).toEqual([
      { url: USER_URL, authorization: "Bearer glpat-live" },
      { url: SELF_URL, authorization: "Bearer glpat-live" },
    ]);
    expect(upserts).toHaveLength(1);
    const upsert = upserts[0]! as { userId: string; provider: string; instanceUrl: string; forgeUserId: number; forgeLogin: string; encryptedToken: string };
    expect(upsert.userId).toBe("user-1");
    expect(upsert.provider).toBe("gitlab");
    expect(upsert.instanceUrl).toBe("https://gitlab.example.com");
    expect(upsert.forgeUserId).toBe(4242);
    expect(upsert.forgeLogin).toBe("tester");
    // The token round-trips through the cipher: decrypt(encrypt(x)) === x.
    expect(decryptToken(upsert.encryptedToken, TEST_KEY)).toBe("glpat-live");
    expect(identity.forgeLogin).toBe("tester");
  });

  it("refuses a token the instance rejects, storing no row", async () => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation, requests } = fetchStub({
      [USER_URL]: { status: 401, body: { message: "401 Unauthorized" } },
    });
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({
      name: "ForgeIdentityError",
      code: "UNVERIFIED",
      // The refusal names the scope the member has to mint the token with —
      // the literal token they tick in GitLab's scope checklist.
      message: expect.stringContaining("read_api"),
    });
    // A rejected token is never asked about its scopes.
    expect(requests.map((request) => request.url)).toEqual([USER_URL]);
    expect(upserts).toEqual([]);
  });

  it("refuses a token whose scopes lack read_api, naming the scope and what the token carries", async () => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation } = fetchStub({
      [USER_URL]: FORGE_USER,
      // read_user alone answers /user, which is the shape issue 529 is about.
      [SELF_URL]: { status: 200, body: { id: 7, name: "overflow", scopes: ["read_user"] } },
    });
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({
      name: "ForgeIdentityError",
      code: "UNVERIFIED",
      message: expect.stringContaining("read_api"),
    });
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ message: expect.stringContaining("read_user") });
    expect(upserts).toEqual([]);
  });

  it.each([["api"], ["read_api"]])("links a token whose scopes include %s", async (scope) => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation } = fetchStub({
      [USER_URL]: FORGE_USER,
      [SELF_URL]: { status: 200, body: { id: 7, name: "overflow", scopes: ["read_user", scope] } },
    });
    const identity = await linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    );
    expect(identity.forgeLogin).toBe("tester");
    expect(upserts).toHaveLength(1);
  });

  it("fails upstream when the self endpoint answers 200 without a scopes list, storing no row", async () => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation } = fetchStub({
      [USER_URL]: FORGE_USER,
      [SELF_URL]: { status: 200, body: { id: 7, name: "overflow" } },
    });
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "UPSTREAM_FAILURE" });
    expect(upserts).toEqual([]);
  });

  describe("when the instance cannot describe the token's scopes", () => {
    it.each([
      ["404, an instance older than 16.0", 404],
      ["400, a token type the endpoint does not describe", 400],
    ])("falls back to a scope-gated probe on %s and links when it answers 200", async (_label, status) => {
      const { store, upserts } = fakeStore();
      const { fetchImplementation, requests } = fetchStub({
        [USER_URL]: FORGE_USER,
        [SELF_URL]: { status, body: { message: "not here" } },
        [PROBE_URL]: { status: 200, body: [] },
      });
      const identity = await linkForgeIdentity(
        { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
        { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
      );
      expect(requests.map((request) => request.url)).toEqual([USER_URL, SELF_URL, PROBE_URL]);
      expect(identity.forgeLogin).toBe("tester");
      expect(upserts).toHaveLength(1);
    });

    it.each([[401], [403]])("refuses when the probe answers %s, naming read_api and storing no row", async (status) => {
      const { store, upserts } = fakeStore();
      const { fetchImplementation } = fetchStub({
        [USER_URL]: FORGE_USER,
        [SELF_URL]: { status: 404, body: { message: "404 Not Found" } },
        [PROBE_URL]: { status, body: { error: "insufficient_scope" } },
      });
      await expect(linkForgeIdentity(
        { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
        { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
      )).rejects.toMatchObject({
        name: "ForgeIdentityError",
        code: "UNVERIFIED",
        message: expect.stringContaining("read_api"),
      });
      expect(upserts).toEqual([]);
    });

    it("fails upstream when the probe answers something other than accept or refuse, storing no row", async () => {
      const { store, upserts } = fakeStore();
      const { fetchImplementation } = fetchStub({
        [USER_URL]: FORGE_USER,
        [SELF_URL]: { status: 404, body: { message: "404 Not Found" } },
        [PROBE_URL]: { status: 500, body: { message: "500 Internal Server Error" } },
      });
      await expect(linkForgeIdentity(
        { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
        { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
      )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "UPSTREAM_FAILURE" });
      expect(upserts).toEqual([]);
    });
  });

  it("refuses on a transport failure reading the token's scopes, storing no row", async () => {
    const { store, upserts } = fakeStore();
    const { fetchImplementation, requests } = fetchStub({
      [USER_URL]: FORGE_USER,
      [SELF_URL]: "transport-failure",
    });
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({
      name: "ForgeIdentityError",
      code: "UNVERIFIED",
      message: expect.stringContaining("reached"),
    });
    expect(requests.map((request) => request.url)).toEqual([USER_URL, SELF_URL]);
    expect(upserts).toEqual([]);
  });

  it("refuses on a transport timeout, storing no row", async () => {
    const { store, upserts } = fakeStore();
    await expect(linkForgeIdentity(
      {
        store,
        tokenEncryptionKey: TEST_KEY,
        fetch: async () => {
          throw new Error("the operation was aborted");
        },
      },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "UNVERIFIED" });
    expect(upserts).toEqual([]);
  });

  it("claims past GitLab work with the verified triple after storing the identity", async () => {
    const claims: Array<Record<string, unknown>> = [];
    const { store, upserts } = fakeStore();
    const dependencies = {
      store,
      tokenEncryptionKey: TEST_KEY,
      fetch: fetchLinkable().fetchImplementation,
      claimPastWork: async (input: { userId: string; instanceUrl: string; forgeUserId: number }) => {
        claims.push({ ...input });
      },
    };
    await linkForgeIdentity(
      dependencies,
      { userId: "user-1", instanceUrl: "https://GitLab.Example.com/", token: "glpat-live" },
    );
    expect(claims).toEqual([
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", forgeUserId: 4242 },
    ]);
    expect(upserts).toHaveLength(1);
  });

  it("refuses when another account already holds the triple", async () => {
    const store = {
      async upsertIdentity() {
        // The store-level gate: the conditional upsert skipped, so nothing came back.
        return null;
      },
    } as unknown as ForgeIdentityStore;
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchLinkable().fetchImplementation },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "FORBIDDEN" });
  });
});
