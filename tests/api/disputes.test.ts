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
  createClosedPrDisputeListGetHandler,
  createClosedPrDisputePostHandler,
} from "@/app/api/disputes/route";
import {
  ClosedPrDisputeError,
  type ClosedPrDisputeErrorCode,
  type ClosedPrDisputeRequest,
} from "@/lib/moderation/closed-pr-dispute-service";

const memberId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";

const recorded: ClosedPrDisputeRequest = {
  id: requestId,
  contributorId: memberId,
  pullRequestId: eventId,
  requestReason: "The cited review rounds were counted from the same reviewer twice.",
  state: "OPEN",
  decision: null,
  decidedBy: null,
  decidedBySoleModerator: false,
  decidedReason: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  decidedAt: null,
  issueId: eventId,
  landedPullRequestId: eventId,
  landedCommitUrl: null,
  moderatorFigure: null,
  awardedPoints: null,
};

const { json: jsonRequest, foreignJson: foreignJsonRequest } = guardedRequests("/api/disputes");

useTrustedOrigin();

function postDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    createService: vi.fn().mockResolvedValue({
      fileDispute: vi.fn().mockResolvedValue(recorded),
    }),
    ...overrides,
  };
}

function payload(): { pullRequestId: string; reason: string } {
  return {
    pullRequestId: eventId,
    reason: "The cited review rounds were counted from the same reviewer twice.",
  };
}

describe("POST /api/disputes", () => {
  it("refuses an anonymous request before filing", async () => {
    const deps = postDependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("refuses a foreign origin before any dependency is reached", async () => {
    const deps = postDependencies();
    const response = await createClosedPrDisputePostHandler(deps)(foreignJsonRequest(payload()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("answers 413 when the body crosses the 32 KiB read limit", async () => {
    const deps = postDependencies();
    const oversized = {
      pullRequestId: eventId,
      reason: "x".repeat(32 * 1024 + 1),
    };
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(oversized));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it.each([
    ["not JSON", "not json"],
    ["an extra field", { pullRequestId: eventId, reason: "Why.", extra: 1 }],
    ["missing the pull request", { reason: "Why." }],
    ["missing the reason", { pullRequestId: eventId }],
    ["blank reason", { pullRequestId: eventId, reason: "   " }],
    ["a non-uuid pull request id", { pullRequestId: "nope", reason: "Why." }],
  ])("answers 422 for %s", async (_label, body) => {
    const deps = postDependencies();
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid closed PR dispute request." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("files a dispute for the signed-in account and returns the recorded request", async () => {
    const fileDispute = vi.fn().mockResolvedValue(recorded);
    const deps = postDependencies({
      createService: vi.fn().mockResolvedValue({ fileDispute }),
    });
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: recorded });
    expect(fileDispute).toHaveBeenCalledExactlyOnceWith(
      { id: memberId },
      { pullRequestId: eventId, reason: payload().reason },
    );
  });

  it.each([
    ["a duplicate open request", "CONFLICT", 409],
    ["another contributor", "FORBIDDEN", 403],
    ["missing review evidence", "INSUFFICIENT_EVIDENCE", 422],
    ["a missing account", "NOT_FOUND", 404],
    ["a service-normalized refusal", "INVALID_INPUT", 422],
  ] as const satisfies readonly (readonly [string, ClosedPrDisputeErrorCode, number])[])(
    "maps %s onto %s",
    async (_label, code, status) => {
      const deps = postDependencies({
        createService: vi.fn().mockResolvedValue({
          fileDispute: vi.fn().mockRejectedValue(
            new ClosedPrDisputeError(code, "The message names the rule."),
          ),
        }),
      });
      const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(payload()));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        error: { code, message: "The message names the rule." },
      });
    },
  );

  it("answers 502 when the service itself fails", async () => {
    const deps = postDependencies({
      createService: vi.fn().mockResolvedValue({
        fileDispute: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(payload()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to complete the closed PR dispute request." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const response = await import("@/app/api/disputes/route").then((route) => route.POST(jsonRequest(payload())));

    expect(response.status).toBe(401);
  });
});

describe("GET /api/disputes", () => {
  function getDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return postDependencies({
      createService: vi.fn().mockResolvedValue({
        listDisputes: vi.fn().mockResolvedValue([recorded]),
      }),
      ...overrides,
    });
  }

  function getRequest(): Request {
    return new Request(new URL("/api/disputes", requestHost));
  }

  it("refuses an anonymous request before listing", async () => {
    const deps = getDependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createClosedPrDisputeListGetHandler(deps)(getRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createService: deps.createService });
  });

  it("returns only the signed-in account's own disputes", async () => {
    const listDisputes = vi.fn().mockResolvedValue([recorded]);
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({ listDisputes }),
    });
    const response = await createClosedPrDisputeListGetHandler(deps)(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([recorded]);
    expect(listDisputes).toHaveBeenCalledExactlyOnceWith({ id: memberId });
  });

  it("answers 502 when the list read fails", async () => {
    const deps = getDependencies({
      createService: vi.fn().mockResolvedValue({
        listDisputes: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });
    const response = await createClosedPrDisputeListGetHandler(deps)(getRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load your closed PR dispute requests." },
    });
  });

  it("refuses an unauthenticated request through the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/disputes/route");
    const response = await route.GET(getRequest());

    expect(response.status).toBe(401);
  });
});

describe("dispute filing evidence and token identity", () => {
  it.each(["landedPullRequestUrl", "landedCommitUrl"] as const)("passes %s through to the service", async (field) => {
    const fileDispute = vi.fn().mockResolvedValue(recorded);
    const deps = postDependencies({ createService: vi.fn().mockResolvedValue({ fileDispute }) });
    const url = field === "landedPullRequestUrl" ? "https://github.com/owner/repo/pull/42" : "https://github.com/owner/repo/commit/example";
    const body = { ...payload(), [field]: url };
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(body));
    expect(response.status).toBe(200);
    expect(fileDispute).toHaveBeenCalledExactlyOnceWith({ id: memberId }, body);
  });
  it("uses the bearer account instead of the browser account", async () => {
    const tokenAccount = "00000000-0000-4000-8000-000000000099";
    const fileDispute = vi.fn().mockResolvedValue(recorded);
    const deps = postDependencies({
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: tokenAccount, tokenId: "token-1" }),
      createService: vi.fn().mockResolvedValue({ fileDispute }),
    });
    const response = await createClosedPrDisputePostHandler(deps)(jsonRequest(payload(), "POST", {
      authorization: `Bearer ovf_${"r".repeat(43)}`,
    }));
    expect(response.status).toBe(200);
    expect(fileDispute).toHaveBeenCalledExactlyOnceWith({ id: tokenAccount }, payload());
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
