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
  createSanctionContestListGetHandler,
  createSanctionContestPostHandler,
} from "@/app/api/contests/route";
import {
  SanctionContestError,
  type SanctionContestErrorCode,
  type SanctionContestRequest,
} from "@/lib/moderation/sanction-contest-service";

const memberId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";

const recorded: SanctionContestRequest = {
  id: requestId,
  accountId: memberId,
  sanctionEventId: eventId,
  requestReason: "The cited review rounds were counted from the same reviewer twice.",
  state: "OPEN",
  decision: null,
  decidedBy: null,
  decidedBySoleModerator: false,
  decidedReason: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  decidedAt: null,
};

const { json: jsonRequest, foreignJson: foreignJsonRequest } = guardedRequests("/api/contests");

useTrustedOrigin();

function postDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    createService: vi.fn().mockResolvedValue({
      fileSanctionContest: vi.fn().mockResolvedValue(recorded),
    }),
    ...overrides,
  };
}

function payload(): { sanctionEventId: string; reason: string } {
  return {
    sanctionEventId: eventId,
    reason: "The cited review rounds were counted from the same reviewer twice.",
  };
}

describe("POST /api/contests", () => {
  it("refuses an anonymous request before filing", async () => {
    const deps = postDependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createSanctionContestPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("refuses a foreign origin before any dependency is reached", async () => {
    const deps = postDependencies();
    const response = await createSanctionContestPostHandler(deps)(foreignJsonRequest(payload()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("answers 413 when the body crosses the 32 KiB read limit", async () => {
    const deps = postDependencies();
    const oversized = {
      sanctionEventId: eventId,
      reason: "x".repeat(32 * 1024 + 1),
    };
    const response = await createSanctionContestPostHandler(deps)(jsonRequest(oversized));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it.each([
    ["not JSON", "not json"],
    ["an extra field", { sanctionEventId: eventId, reason: "Why.", extra: 1 }],
    ["missing the event", { reason: "Why." }],
    ["missing the reason", { sanctionEventId: eventId }],
    ["blank reason", { sanctionEventId: eventId, reason: "   " }],
    ["a non-uuid event id", { sanctionEventId: "nope", reason: "Why." }],
  ])("answers 422 for %s", async (_label, body) => {
    const deps = postDependencies();
    const response = await createSanctionContestPostHandler(deps)(jsonRequest(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid sanction contest request." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("files a contest for the signed-in account and returns the recorded request", async () => {
    const fileSanctionContest = vi.fn().mockResolvedValue(recorded);
    const deps = postDependencies({
      createService: vi.fn().mockResolvedValue({ fileSanctionContest }),
    });
    const response = await createSanctionContestPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: recorded });
    expect(fileSanctionContest).toHaveBeenCalledExactlyOnceWith(
      { id: memberId },
      { sanctionEventId: eventId, reason: payload().reason },
    );
  });

  it.each([
    ["a duplicate open request", "CONFLICT", 409],
    ["a missing sanction", "NOT_FOUND", 404],
    ["a service-normalized refusal", "INVALID_INPUT", 422],
  ] as const satisfies readonly (readonly [string, SanctionContestErrorCode, number])[])(
    "maps %s onto %s",
    async (_label, code, status) => {
      const deps = postDependencies({
        createService: vi.fn().mockResolvedValue({
          fileSanctionContest: vi.fn().mockRejectedValue(
            new SanctionContestError(code, "The message names the rule."),
          ),
        }),
      });
      const response = await createSanctionContestPostHandler(deps)(jsonRequest(payload()));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        error: { code, message: "The message names the rule." },
      });
    },
  );

  it("answers 502 when the service itself fails", async () => {
    const deps = postDependencies({
      createService: vi.fn().mockResolvedValue({
        fileSanctionContest: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createSanctionContestPostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to complete the sanction contest request." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const response = await import("@/app/api/contests/route").then((route) => route.POST(jsonRequest(payload())));

    expect(response.status).toBe(401);
  });
});

describe("GET /api/contests", () => {
  function getDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return postDependencies({
      createService: vi.fn().mockResolvedValue({
        listContests: vi.fn().mockResolvedValue([recorded]),
      }),
      ...overrides,
    });
  }

  function getRequest(): Request {
    return new Request(new URL("/api/contests", requestHost));
  }

  it("refuses an anonymous request before listing", async () => {
    const deps = getDependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createSanctionContestListGetHandler(deps)(getRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("returns only the signed-in account's own contests", async () => {
    const listContests = vi.fn().mockResolvedValue([recorded]);
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({ listContests }),
    });
    const response = await createSanctionContestListGetHandler(deps)(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([recorded]);
    expect(listContests).toHaveBeenCalledExactlyOnceWith({ id: memberId });
  });

  it("answers 502 when the list read fails", async () => {
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({
        listContests: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createSanctionContestListGetHandler(deps)(getRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load your sanction contest requests." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/contests/route");
    const response = await route.GET(getRequest());

    expect(response.status).toBe(401);
  });
});
