import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createModerationUnwritableClosuresGetHandler,
  GET as productionGet,
  type ModerationUnwritableClosuresRouteDependencies,
} from "@/app/api/moderation/unwritable-closures/route";
import type { UnwritableClosureQueues } from "@/lib/dashboard/queries";

vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

const moderatorId = "00000000-0000-4000-8000-000000000004";
const queues: UnwritableClosureQueues = {
  queue: [{
    id: "00000000-0000-4000-8000-00000000000a",
    kind: "SETTLEMENT_EVIDENCE_REJECTED",
    reason: "The closing evidence could not be written.",
    recordedAt: "2026-09-01T00:00:00.000Z",
    repositoryName: "octo/overflow",
    issueNumber: 780,
    issueTitle: "Correction queue",
    issueUrl: "https://github.com/octo/overflow/issues/780",
    pullRequest: null,
    settlementId: "00000000-0000-4000-8000-00000000000b",
    settlementParties: { creditorLogin: "creditor", debtorLogin: "debtor" },
    calibrationId: null,
    calibrationOwnerLogin: null,
    viewerCanRequestCorrection: true,
    latestCorrection: { state: "OPEN", requestedAt: "2026-09-02T00:00:00.000Z" },
  }],
  history: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

type DependencyMocks = {
  [K in keyof ModerationUnwritableClosuresRouteDependencies]: Mock;
};

function dependencies(overrides: Partial<DependencyMocks> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: moderatorId, role: "MODERATOR" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    listUnwritableClosures: vi.fn().mockResolvedValue(queues),
    ...overrides,
  };
}

function request(): Request {
  return new Request("https://overflow.example/api/moderation/unwritable-closures");
}

describe("GET /api/moderation/unwritable-closures", () => {
  it("refuses an anonymous request before listing closures", async () => {
    const deps = dependencies({ getSession: vi.fn().mockResolvedValue(null) });
    const response = await createModerationUnwritableClosuresGetHandler(deps)(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(deps.listUnwritableClosures).not.toHaveBeenCalled();
  });

  it("refuses an authenticated member before listing closures", async () => {
    const deps = dependencies({ getCurrentRole: vi.fn().mockResolvedValue("MEMBER") });
    const response = await createModerationUnwritableClosuresGetHandler(deps)(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
    expect(deps.listUnwritableClosures).not.toHaveBeenCalled();
  });

  it("returns the queue and history for the authenticated moderator", async () => {
    const deps = dependencies();
    const response = await createModerationUnwritableClosuresGetHandler(deps)(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(queues);
    expect(deps.listUnwritableClosures).toHaveBeenCalledExactlyOnceWith(moderatorId);
  });

  it("reports a queue read failure as a 502", async () => {
    const deps = dependencies({ listUnwritableClosures: vi.fn().mockRejectedValue(new Error("db down")) });
    const response = await createModerationUnwritableClosuresGetHandler(deps)(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the unwritable-closure queue." },
    });
  });
});

describe("the exported production GET", () => {
  it("refuses an unauthenticated request through the route export", async () => {
    const response = await productionGet(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });
});
