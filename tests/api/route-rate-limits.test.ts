import { afterAll, describe, expect, it, vi } from "vitest";
import {
  applyRouteRateGate,
  createRouteRateGate,
  EXPENSIVE_ROUTE_RATE_CLASSES,
  resolveRouteRateLimit,
  routeRateLimitKey,
  type RouteRateGate,
} from "@/lib/security/route-rate-limit";
import { createRateLimiter } from "@/lib/webhooks/rate-limit";
import { createAccountExportPostHandler } from "@/app/api/account/export/route";
import {
  createRepositoryDeleteHandler,
  createRepositoryPatchHandler,
  createRepositoryPostHandler,
} from "@/app/api/repositories/route";
import { createApiTokenPostHandler } from "@/app/api/tokens/route";
import {
  createForgeIdentitiesDeleteHandler,
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import { createSettlementOverridePostHandler } from "@/app/api/overrides/route";
import type { SqlClient } from "@/lib/db/types";
import type { AccountExport } from "@/lib/accounts/export";
import type { ApiTokenSummary } from "@/lib/tokens/postgres-store";
import type { SettlementOverrideRequest } from "@/lib/overrides/service";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { productionAuth, productionRole } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));
vi.mock("@/lib/db/client", () => ({
  getSql: vi.fn(() => ({}) as SqlClient),
  closeSql: vi.fn(async () => undefined),
}));

const { productionFindIdentity, productionExportAccount } = vi.hoisted(() => ({
  productionFindIdentity: vi.fn(),
  productionExportAccount: vi.fn(),
}));
vi.mock("@/lib/accounts/self-service", () => ({ findLiveAccountIdentity: productionFindIdentity }));
vi.mock("@/lib/accounts/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accounts/export")>()),
  exportAccount: productionExportAccount,
}));

const { productionApiTokenStore, findAccountByTokenHashMock } = vi.hoisted(() => {
  const findAccountByTokenHashMock = vi.fn();
  const issueTokenMock = vi.fn<(userId: string, tokenHash: Buffer) => Promise<ApiTokenSummary>>(async () => ({
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    expiresAt: new Date("2027-01-01T10:00:00.000Z"),
    confirmedAt: null,
  }));
  class ProductionApiTokenStore {
    async findAccountByTokenHash(hash: Buffer) {
      return findAccountByTokenHashMock(hash);
    }
    async issueToken(userId: string, tokenHash: Buffer) {
      return issueTokenMock(userId, tokenHash);
    }
  }
  return { productionApiTokenStore: ProductionApiTokenStore, findAccountByTokenHashMock, issueTokenMock };
});
vi.mock("@/lib/tokens/postgres-store", () => ({
  PostgresApiTokenStore: productionApiTokenStore,
}));

const { productionOverrideStore } = vi.hoisted(() => ({
  productionOverrideStore: class {
    createRequest = vi.fn(async () => ({ kind: "ok" as const, value: recordedOverride }));
  },
}));
vi.mock("@/lib/overrides/postgres-store", () => ({
  PostgresSettlementOverrideStore: productionOverrideStore,
}));

import { trustedOrigin, useTrustedOrigin, guardedRequests } from "../support/trusted-origin";

useTrustedOrigin();
const requests = guardedRequests("/api/account/export");

const RATE_LIMITED_BODY = {
  error: {
    code: "RATE_LIMITED",
    message: "Too many requests of this kind. Retry after the number of seconds the Retry-After header names.",
  },
};

/** Two member identities and one API token identity for the per-key proofs. */
const identityA = "11111111-1111-4111-8111-111111111111";
const identityB = "22222222-2222-4222-8222-222222222222";
const bearerToken = `ovf_${"r".repeat(43)}`;
const issuedTokenId = "00000000-0000-4000-8000-00000000aa01";

/**
 * The gate under test at a frozen instant: with the bound derived exactly as
 * the route wiring derives it (capacity n, refill n/60 per minute), a bucket
 * drained at the frozen instant is 1800 seconds from its next token.
 */
function gateOverTwoPerHour(clock: { value: number }): RouteRateGate {
  return createRouteRateGate({
    className: "test-class",
    limiter: createRateLimiter({ nowMs: () => clock.value }),
    limits: { capacity: 2, refillPerMinute: 2 / 60 },
  });
}

describe("resolveRouteRateLimit", () => {
  const spec = { envName: "RATE_LIMIT_EXAMPLE_PER_HOUR", defaultPerHour: 7 };

  it("derives the bound from a valid env value: capacity is the value, refill is value/60 per minute", () => {
    expect(resolveRouteRateLimit({ RATE_LIMIT_EXAMPLE_PER_HOUR: "12" }, spec)).toEqual({
      capacity: 12,
      refillPerMinute: 0.2,
    });
  });

  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["non-numeric", "most-of-the-time"],
    ["zero", "0"],
    ["negative", "-2"],
    ["infinite", "1e999"],
  ])("falls back to the documented default for a %s env value", (_label, value) => {
    expect(resolveRouteRateLimit({ RATE_LIMIT_EXAMPLE_PER_HOUR: value }, spec)).toEqual({
      capacity: 7,
      refillPerMinute: 7 / 60,
    });
  });

  it("carries the five documented classes with their env names and defaults", () => {
    expect(EXPENSIVE_ROUTE_RATE_CLASSES).toEqual({
      export: { envName: "RATE_LIMIT_EXPORT_PER_HOUR", defaultPerHour: 3 },
      repositories: { envName: "RATE_LIMIT_REPOSITORIES_PER_HOUR", defaultPerHour: 10 },
      tokens: { envName: "RATE_LIMIT_TOKENS_PER_HOUR", defaultPerHour: 5 },
      forgeIdentities: { envName: "RATE_LIMIT_FORGE_IDENTITIES_PER_HOUR", defaultPerHour: 5 },
      overrides: { envName: "RATE_LIMIT_OVERRIDES_PER_HOUR", defaultPerHour: 5 },
    });
  });
});

describe("routeRateLimitKey", () => {
  it("keys a session credential by the account id and a bearer credential by the token issuance id", () => {
    expect(routeRateLimitKey({ kind: "session" }, identityA)).toBe(`user:${identityA}`);
    expect(routeRateLimitKey({ kind: "token", tokenId: issuedTokenId }, identityA)).toBe(
      `token:${issuedTokenId}`,
    );
  });
});

describe("applyRouteRateGate", () => {
  it("admits through the injected gate under the credential identity the caller names", () => {
    const admitted: string[] = [];
    const gate = createRouteRateGate({
      className: "test-class",
      limiter: createRateLimiter({ nowMs: () => 0 }),
      limits: { capacity: 1, refillPerMinute: 1 / 60 },
    });
    // Wrap the gate so the admitted keys are observable without white-box peeking.
    const observing = (key: string): Response | null => {
      const refusal = gate(key);
      if (refusal === null) admitted.push(key);
      return refusal;
    };

    expect(applyRouteRateGate(observing, { kind: "session" }, identityA)).toBeNull();
    expect(applyRouteRateGate(observing, { kind: "session" }, identityA)).toMatchObject({ status: 429 });
    expect(applyRouteRateGate(observing, { kind: "token", tokenId: issuedTokenId }, identityA)).toBeNull();

    expect(admitted).toEqual([`user:${identityA}`, `token:${issuedTokenId}`]);
  });

  it("admits everything when no gate is wired: a handler built without one stays unbounded", () => {
    expect(applyRouteRateGate(undefined, { kind: "session" }, identityA)).toBeNull();
  });
});

describe("createRouteRateGate", () => {
  it("answers 429 with the limiter's Retry-After at the injected instant", () => {
    const clock = { value: 1_000_000 };
    const gate = gateOverTwoPerHour(clock);

    expect(gate("k")).toBeNull();
    expect(gate("k")).toBeNull();
    const declined = gate("k");
    expect(declined).toBeInstanceOf(Response);
    expect(declined?.status).toBe(429);
    expect(declined?.headers.get("retry-after")).toBe("1800");
    clock.value = 1_000_000 + 1_800_000;
    // At the named instant the bucket refills exactly one token: the same gate
    // admits again, which is the math the header promised.
    expect(gate("k")).toBeNull();
  });

  it("declines a second identity only by its own bucket: the first key's spent bound carries nothing over", () => {
    const gate = gateOverTwoPerHour({ value: 5_000 });
    gate("first");
    gate("first");
    expect(gate("first")?.status).toBe(429);
    expect(gate("second")).toBeNull();
  });

  it("warns once per decline burst, naming the class and the identity", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const gate = gateOverTwoPerHour({ value: 0 });
      gate("user:7");
      gate("user:7");
      expect(gate("user:7")?.status).toBe(429);
      expect(gate("user:7")?.status).toBe(429);

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `Rate limit: the test-class bound is spent for "user:7"; declining until the next token refills.`,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("each wired route declines past its bound", () => {
  interface RouteCase {
    name: string;
    /** Builds the handler with the injected gate; identities arrive in the order A, A, B. */
    build: (rateGate: RouteRateGate) => (request: Request) => Promise<Response>;
    request: () => Request;
    /** The answer an admitted request receives. */
    admittedStatus: number;
  }

  const sessionSequence = (ids: string[]) => {
    const getSession = vi.fn();
    for (const id of ids) getSession.mockResolvedValueOnce({ user: { id, role: "MEMBER" } });
    return getSession;
  };

  // The same sequence carrying a sign-in instant the route's pinned clock
  // (now: () => 1_000_000) reads as recent.
  const recentSignInSequence = (ids: string[]) => {
    const getSession = vi.fn();
    for (const id of ids) {
      getSession.mockResolvedValueOnce({
        user: { id, role: "MEMBER", authenticatedAt: 1_000 },
      });
    }
    return getSession;
  };

  const cases: RouteCase[] = [
    {
      name: "POST /api/account/export",
      build: (rateGate) => {
        const handler = createAccountExportPostHandler({
          getSession: sessionSequence([identityA, identityA, identityA, identityB]),
          getSql: () => ({}) as SqlClient,
          findIdentity: async () => ({ githubUserId: 42, githubLogin: "alice" }),
          exportAccount: async () => ({ formatVersion: 1 } as AccountExport),
          rateGate,
        });
        return handler;
      },
      request: () => requests.json({}),
      admittedStatus: 200,
    },
    {
      name: "POST /api/repositories",
      build: (rateGate) =>
        createRepositoryPostHandler({
          getSession: vi.fn(),
          findAccountByTokenHash: bearerSequence(),
          getCurrentRole: async () => "MEMBER",
          createRegistrationDependencies: vi.fn(async () => {
            throw new Error("the flow is beyond this test");
          }),
          rateGate,
        }),
      request: () => requests.json({}, "POST", { authorization: `Bearer ${bearerToken}` }),
      admittedStatus: 400,
    },
    {
      name: "PATCH /api/repositories",
      build: (rateGate) =>
        createRepositoryPatchHandler({
          getSession: vi.fn(),
          findAccountByTokenHash: bearerSequence(),
          getCurrentRole: async () => "MEMBER",
          createRegistrationDependencies: vi.fn(async () => {
            throw new Error("the flow is beyond this test");
          }),
          rateGate,
        }),
      request: () => requests.json({}, "PATCH", { authorization: `Bearer ${bearerToken}` }),
      admittedStatus: 400,
    },
    {
      name: "DELETE /api/repositories",
      build: (rateGate) =>
        createRepositoryDeleteHandler({
          getSession: vi.fn(),
          findAccountByTokenHash: bearerSequence(),
          getCurrentRole: async () => "MEMBER",
          createRegistrationDependencies: vi.fn(async () => {
            throw new Error("the flow is beyond this test");
          }),
          rateGate,
        }),
      request: () => requests.json({}, "DELETE", { authorization: `Bearer ${bearerToken}` }),
      // The unregistration schema accepts an empty object (every field is
      // optional), so the flow is reached and the stubbed wiring throws — the
      // answer an admitted request receives before the bound matters.
      admittedStatus: 502,
    },
    {
      name: "POST /api/tokens",
      build: (rateGate) => {
        const store = { issueToken: async () => tokenSummary() };
        return createApiTokenPostHandler({
          getSession: recentSignInSequence([identityA, identityA, identityA, identityB]),
          getCurrentRole: async () => "MEMBER",
          createTokenStore: async () => store,
          now: () => 1_000_000,
          rateGate,
        });
      },
      request: () => mintRequest(),
      admittedStatus: 201,
    },
    {
      name: "POST /api/forge-identities",
      build: (rateGate) =>
        createForgeIdentitiesPostHandler(
          forgeDependencies(rateGate, sessionSequence([identityA, identityA, identityA, identityB])),
        ),
      // The link schema requires both fields, so the empty body is refused
      // after the gate — the answer an admitted request receives.
      request: () => requests.json({}, "POST", { cookie: "authjs.session-token=irrelevant" }),
      admittedStatus: 400,
    },
    {
      name: "DELETE /api/forge-identities",
      build: (rateGate) =>
        createForgeIdentitiesDeleteHandler(
          forgeDependencies(rateGate, sessionSequence([identityA, identityA, identityA, identityB])),
        ),
      request: () => requests.json({}, "DELETE", { cookie: "authjs.session-token=irrelevant" }),
      admittedStatus: 400,
    },
    {
      name: "POST /api/overrides",
      build: (rateGate) =>
        createSettlementOverridePostHandler({
          getSession: sessionSequence([identityA, identityA, identityA, identityB]),
          findAccountByTokenHash: async () => null,
          getCurrentRole: async () => "MEMBER",
          createService: async () => ({ requestOverride: async () => recordedOverride }),
          rateGate,
        }),
      request: () => requests.json({ settlementId: settlementId, reason: "The rationale comment was late." }),
      admittedStatus: 200,
    },
  ];

  it.each(cases)("$name answers 429 with the limiter's Retry-After past the bound, and the next identity is unaffected", async (testCase) => {
    const clock = { value: 1_000_000 };
    const handler = testCase.build(gateOverTwoPerHour(clock));
    // Capacity 2: the first two requests of identity A drain the bucket, the
    // third is over the bound, and B's first request draws its own full one.
    const requestsSent: Request[] = [];
    requestsSent.push(testCase.request(), testCase.request(), testCase.request(), testCase.request());

    const first = await handler(requestsSent[0]!);
    expect(first.status).toBe(testCase.admittedStatus);
    const second = await handler(requestsSent[1]!);
    expect(second.status).toBe(testCase.admittedStatus);

    const declined = await handler(requestsSent[2]!);
    expect(declined.status).toBe(429);
    expect(declined.headers.get("retry-after")).toBe("1800");
    await expect(declined.json()).resolves.toEqual(RATE_LIMITED_BODY);

    // The second identity's first request on the same handler: its own full bucket.
    const other = await handler(requestsSent[3]!);
    expect(other.status).toBe(testCase.admittedStatus);
  });
});

describe("the production wiring derives the bound from the environment", () => {
  it("POST /api/account/export wires the module gate: capacity 1 admits once, then 429 with Retry-After 3600", async () => {
    vi.stubEnv("RATE_LIMIT_EXPORT_PER_HOUR", "1");
    vi.resetModules();
    try {
      const route = await import("@/app/api/account/export/route");
      productionAuth.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
      productionFindIdentity.mockResolvedValue({ githubUserId: 42, githubLogin: "alice" });
      productionExportAccount.mockResolvedValue({ formatVersion: 1 });

      const first = await route.POST(requests.json({}));
      expect(first.status).toBe(200);
      const second = await route.POST(requests.json({}));
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("3600");
      await expect(second.json()).resolves.toEqual(RATE_LIMITED_BODY);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("POST /api/tokens wires the module gate: capacity 1 admits once, then 429", async () => {
    vi.stubEnv("RATE_LIMIT_TOKENS_PER_HOUR", "1");
    vi.resetModules();
    try {
      const route = await import("@/app/api/tokens/route");
      productionAuth.mockResolvedValue({
        user: {
          id: "member-id",
          role: "MEMBER",
          authenticatedAt: Math.floor(Date.now() / 1000) - 60,
        },
      });
      productionRole.mockResolvedValue("MEMBER");

      const first = await route.POST(mintRequest());
      expect(first.status).toBe(201);
      const second = await route.POST(mintRequest());
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("3600");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("POST /api/repositories wires the module gate: capacity 1 admits once, then 429", async () => {
    vi.stubEnv("RATE_LIMIT_REPOSITORIES_PER_HOUR", "1");
    vi.resetModules();
    try {
      const route = await import("@/app/api/repositories/route");
      productionAuth.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
      productionRole.mockResolvedValue("MEMBER");

      // An invalid body is refused after the gate, so the first request is
      // admitted (400) and the second is over the bound.
      const first = await route.POST(requests.json({}));
      expect(first.status).toBe(400);
      const second = await route.POST(requests.json({}));
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("3600");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("POST /api/forge-identities wires the module gate: capacity 1 admits once, then 429", async () => {
    vi.stubEnv("RATE_LIMIT_FORGE_IDENTITIES_PER_HOUR", "1");
    vi.resetModules();
    try {
      const route = await import("@/app/api/forge-identities/route");
      productionAuth.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
      productionRole.mockResolvedValue("MEMBER");

      const first = await route.POST(requests.json({}));
      expect(first.status).toBe(400);
      const second = await route.POST(requests.json({}));
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("3600");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("POST /api/overrides wires the module gate: capacity 1 admits once, then 429", async () => {
    vi.stubEnv("RATE_LIMIT_OVERRIDES_PER_HOUR", "1");
    vi.resetModules();
    try {
      const route = await import("@/app/api/overrides/route");
      productionAuth.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
      productionRole.mockResolvedValue("MEMBER");

      const first = await route.POST(overrideRequest());
      expect(first.status).toBe(200);
      const second = await route.POST(overrideRequest());
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("3600");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("the MCP composition shares the bound with the REST route", () => {
  it("a correction_open dispatch for an identity the REST route exhausted answers 429 in-band", async () => {
    vi.stubEnv("RATE_LIMIT_OVERRIDES_PER_HOUR", "1");
    vi.resetModules();
    try {
      const overridesRoute = await import("@/app/api/overrides/route");
      const mcpRoute = await import("@/app/api/mcp/route");
      productionAuth.mockResolvedValue(null);
      productionRole.mockResolvedValue("MEMBER");
      findAccountByTokenHashMock.mockResolvedValue({
        id: identityA,
        tokenId: issuedTokenId,
      });

      // The REST leg spends the token identity's only slot...
      const rest = await overridesRoute.POST(
        requests.json({ settlementId, reason: "The rationale comment was late." }, "POST", {
          authorization: `Bearer ${bearerToken}`,
        }),
      );
      expect(rest.status).toBe(200);

      // ...and the MCP dispatch of the same operation for the same credential
      // meets the shared bucket, so the bound declines it through the tool
      // result (HTTP stays 200; the 429 travels in-band, and the seconds the
      // REST answer carries as a header reach the client as a field it can
      // act on).
      const mcp = await mcpRoute.POST(correctionOpenCall());
      expect(mcp.status).toBe(200);
      const body = (await mcp.json()) as {
        result: {
          isError?: boolean;
          content: { text: string }[];
          structuredContent?: { retryAfterSeconds: number };
        };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("RATE_LIMITED");
      expect(body.result.structuredContent).toEqual({ retryAfterSeconds: 3600 });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

function mintRequest(): Request {
  return new Request(`${trustedOrigin}/api/tokens`, {
    method: "POST",
    headers: { origin: trustedOrigin },
  });
}

function overrideRequest(): Request {
  return requests.json({ settlementId, reason: "The rationale comment was late." });
}

function correctionOpenCall(): Request {
  return new Request(`${trustedOrigin}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "correction_open",
        arguments: { settlementId, reason: "The rationale comment was late." },
      },
    }),
  });
}

/**
 * The bearer credential sequence for the repositories cases: the first two
 * requests authenticate one token issuance, the third a second one.
 */
function bearerSequence() {
  const findAccountByTokenHash = vi.fn();
  findAccountByTokenHash
    .mockResolvedValueOnce({ id: identityA, tokenId: issuedTokenId })
    .mockResolvedValueOnce({ id: identityA, tokenId: issuedTokenId })
    .mockResolvedValueOnce({ id: identityA, tokenId: issuedTokenId })
    .mockResolvedValue({ id: identityB, tokenId: "00000000-0000-4000-8000-00000000aa02" });
  return findAccountByTokenHash;
}

function forgeDependencies(
  rateGate: RouteRateGate,
  getSession: ReturnType<typeof vi.fn>,
): ForgeIdentitiesRouteDependencies {
  return {
    getSession,
    getCurrentRole: async () => "MEMBER",
    createIdentityStore: vi.fn(() => {
      throw new Error("the store is beyond this test");
    }),
    tokenEncryptionKey: "irrelevant-for-this-test",
    fetch: vi.fn(),
    claimPastWork: vi.fn(async () => {}),
    rateGate,
  } as ForgeIdentitiesRouteDependencies;
}

function tokenSummary(): ApiTokenSummary {
  return {
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    expiresAt: new Date("2027-01-01T10:00:00.000Z"),
    confirmedAt: null,
  };
}

const settlementId = "00000000-0000-4000-8000-000000000011";

const recordedOverride: SettlementOverrideRequest = {
  id: "00000000-0000-4000-8000-000000000012",
  issueId: "00000000-0000-4000-8000-000000000013",
  requesterId: identityA,
  reason: "The rationale comment was late.",
  state: "OPEN",
  settledPoints: null,
  decidedById: null,
  decisionReason: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  decidedAt: null,
};
