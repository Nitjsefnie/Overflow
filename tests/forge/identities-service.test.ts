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

function fetchJson(payload: unknown, status = 200) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe("Bearer glpat-live");
    expect(request.url).toBe("https://gitlab.example.com/api/v4/user");
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
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
  it("verifies the token against /api/v4/user, encrypts it, and upserts on the triple", async () => {
    const { store, upserts } = fakeStore();
    const identity = await linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchJson({ id: 4242, username: "tester" }) },
      { userId: "user-1", instanceUrl: "https://GitLab.Example.com/", token: "glpat-live" },
    );
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
    await expect(linkForgeIdentity(
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchJson({ message: "401 Unauthorized" }, 401) },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "UNVERIFIED" });
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
      fetch: fetchJson({ id: 4242, username: "tester" }),
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
      { store, tokenEncryptionKey: TEST_KEY, fetch: fetchJson({ id: 4242, username: "tester" }) },
      { userId: "user-1", instanceUrl: "https://gitlab.example.com", token: "glpat-live" },
    )).rejects.toMatchObject({ name: "ForgeIdentityError", code: "FORBIDDEN" });
  });
});
