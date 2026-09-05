import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { apiTokenPrefix, hashApiToken, mintApiToken } from "@/lib/security/api-token";
import {
  createApiTokenPostHandler,
  type ApiTokenIssuer,
  type ApiTokenRouteDependencies,
} from "@/app/api/tokens/route";

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
    const body = (await response.json()) as { token: string; createdAt: string };

    expect(response.status).toBe(201);
    expect(body).toEqual({
      token: expect.stringMatching(/^ovf_[A-Za-z0-9_-]{43}$/),
      createdAt: issuedAt.toISOString(),
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
      getSession: async () => ({ user: { id: "member-id", role: "MEMBER" } }),
      createTokenStore: async () => {
        throw new Error("token store unavailable");
      },
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
});

const issuedAt = new Date("2026-09-05T10:00:00.000Z");

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
      return { createdAt: issuedAt };
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
    createTokenStore: async () => store,
  };
}

function signedInAs(userId: string, store: ApiTokenIssuer): ApiTokenRouteDependencies {
  return {
    getSession: async () => ({ user: { id: userId, role: "MEMBER" } }),
    createTokenStore: async () => store,
  };
}

function mintRequest(headers: HeadersInit = {}): Request {
  return new Request("https://overflow.example/api/tokens", { method: "POST", headers });
}
