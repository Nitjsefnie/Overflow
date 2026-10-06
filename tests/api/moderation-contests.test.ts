import { describe, expect, it, vi } from "vitest";
import {
  expectNoDependencyCall,
  guardedRequests,
  requestHost,
  useTrustedOrigin,
} from "../support/trusted-origin";

const { productionAuth, productionRole } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));

import {
  createSanctionContestDecisionPostHandler,
  createSanctionContestQueueGetHandler,
} from "@/app/api/moderation/contests/route";
import {
  SanctionContestError,
  type SanctionContestErrorCode,
  type SanctionContestRequest,
} from "@/lib/moderation/sanction-contest-service";

const moderatorId = "00000000-0000-4000-8000-0000000000d1";
const accountId = "00000000-0000-4000-8000-000000000002";
const eventId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";

const decided: SanctionContestRequest = {
  id: requestId,
  accountId,
  sanctionEventId: eventId,
  requestReason: "The cited review rounds were counted from the same reviewer twice.",
  state: "DECIDED",
  decision: "GRANTED",
  decidedBy: moderatorId,
  decidedBySoleModerator: false,
  decidedReason: "The audit overcounted the review rounds.",
  createdAt: "2026-10-01T10:00:00.000Z",
  decidedAt: "2026-10-02T10:00:00.000Z",
};

const openContest = {
  requestId,
  accountId,
  accountLogin: "mira",
  sanctionState: "BANNED",
  requestReason: "The cited review rounds were counted from the same reviewer twice.",
  filedAt: "2026-10-01T10:00:00.000Z",
};

const { json: jsonRequest, foreignJson: foreignJsonRequest } = guardedRequests("/api/moderation/contests");

useTrustedOrigin();

function dependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: moderatorId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue({ id: moderatorId, tokenId: "token-1" }),
    getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    createService: vi.fn().mockResolvedValue({
      decideContest: vi.fn().mockResolvedValue(decided),
      listOpenContests: vi.fn().mockResolvedValue([openContest]),
    }),
    ...overrides,
  };
}

function payload(): { requestId: string; decision: string; reason: string } {
  return { requestId, decision: "GRANTED", reason: "The audit overcounted the review rounds." };
}

describe("POST /api/moderation/contests", () => {
  it("refuses an anonymous request before deciding", async () => {
    const deps = dependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("refuses a foreign origin before any dependency is reached", async () => {
    const deps = dependencies();
    const response = await createSanctionContestDecisionPostHandler(deps)(foreignJsonRequest(payload()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("refuses a signed-in non-moderator before deciding", async () => {
    const deps = dependencies({ getCurrentRole: vi.fn().mockResolvedValue("MEMBER") });
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("answers 413 when the body crosses the 32 KiB read limit", async () => {
    const deps = dependencies();
    const oversized = { requestId, decision: "GRANTED", reason: "x".repeat(32 * 1024 + 1) };
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(oversized));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it.each([
    ["not JSON", "not json"],
    ["an extra field", { requestId, decision: "GRANTED", reason: "Why.", extra: 1 }],
    ["a missing request id", { decision: "GRANTED", reason: "Why." }],
    ["a missing decision", { requestId, reason: "Why." }],
    ["an unknown decision", { requestId, decision: "MAYBE", reason: "Why." }],
    ["a blank reason", { requestId, decision: "GRANTED", reason: "   " }],
    ["a non-uuid request id", { requestId: "nope", decision: "GRANTED", reason: "Why." }],
  ])("answers 422 for %s", async (_label, body) => {
    const deps = dependencies();
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid sanction contest decision." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("records the decision for the signed-in moderator and returns the decided request", async () => {
    const decideContest = vi.fn().mockResolvedValue(decided);
    const deps = dependencies({
      createService: vi.fn().mockResolvedValue({ decideContest }),
    });
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: decided });
    expect(decideContest).toHaveBeenCalledExactlyOnceWith(
      { id: moderatorId },
      { requestId, decision: "GRANTED", reason: payload().reason },
    );
  });

  it.each([
    ["the imposer deciding over another moderator", "FORBIDDEN", 403],
    ["an already decided request", "CONFLICT", 409],
    ["a missing request", "NOT_FOUND", 404],
    ["a service-normalized refusal", "INVALID_INPUT", 422],
  ] as const satisfies readonly (readonly [string, SanctionContestErrorCode, number])[])(
    "maps %s onto %s",
    async (_label, code, status) => {
      const deps = dependencies({
        createService: vi.fn().mockResolvedValue({
          decideContest: vi.fn().mockRejectedValue(new SanctionContestError(code, "The message names the rule.")),
        }),
      });
      const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(payload()));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        error: { code, message: "The message names the rule." },
      });
    },
  );

  it("answers 502 when the service itself fails", async () => {
    const deps = dependencies({
      createService: vi.fn().mockResolvedValue({
        decideContest: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createSanctionContestDecisionPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to complete the sanction contest request." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/moderation/contests/route");
    const response = await route.POST(jsonRequest(payload()));

    expect(response.status).toBe(401);
  });
});

describe("GET /api/moderation/contests", () => {
  function getDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return dependencies({
      createService: vi.fn().mockResolvedValue({
        listOpenContests: vi.fn().mockResolvedValue([openContest]),
      }),
      ...overrides,
    });
  }

  function getRequest(): Request {
    return new Request(new URL("/api/moderation/contests", requestHost));
  }

  it("refuses an anonymous request before listing", async () => {
    const deps = getDependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createSanctionContestQueueGetHandler(deps)(getRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("refuses a signed-in non-moderator", async () => {
    const deps = getDependencies({ getCurrentRole: vi.fn().mockResolvedValue("MEMBER") });
    const response = await createSanctionContestQueueGetHandler(deps)(getRequest());

    expect(response.status).toBe(403);
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("returns the open contest queue to a moderator", async () => {
    const listOpenContests = vi.fn().mockResolvedValue([openContest]);
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({ listOpenContests }),
    });
    const response = await createSanctionContestQueueGetHandler(deps)(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([openContest]);
    expect(listOpenContests).toHaveBeenCalledExactlyOnceWith();
  });

  it("answers 502 when the queue read fails", async () => {
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({
        listOpenContests: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createSanctionContestQueueGetHandler(deps)(getRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the sanction contest queue." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/moderation/contests/route");
    const response = await route.GET(getRequest());

    expect(response.status).toBe(401);
  });
});
