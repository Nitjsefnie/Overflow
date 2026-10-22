import { describe, expect, it, vi } from "vitest";
import { guardedRequests, requestHost, useTrustedOrigin } from "../support/trusted-origin";
import {
  createClosedPrDisputeDecisionPostHandler,
  createClosedPrDisputeQueueGetHandler,
} from "@/app/api/moderation/disputes/route";
import { ClosedPrDisputeError, type ClosedPrDisputeRequest } from "@/lib/moderation/closed-pr-dispute-service";

const { productionAuth } = vi.hoisted(() => ({ productionAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: vi.fn() }));

const moderatorId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const decided: ClosedPrDisputeRequest = {
  id: requestId, contributorId: requestId, pullRequestId: requestId, issueId: requestId,
  landedPullRequestId: null, landedCommitUrl: "https://example.test/commit/landed",
  requestReason: "My closed change landed elsewhere.", state: "DECIDED", decision: "GRANTED",
  decidedBy: moderatorId, decidedBySoleModerator: true, decidedReason: "The evidence supports the claim.",
  moderatorFigure: 5, awardedPoints: 3,
  createdAt: "2026-10-01T10:00:00.000Z", decidedAt: "2026-10-02T10:00:00.000Z",
};
const open = { ...decided, state: "OPEN" as const, decision: null, decidedBy: null,
  decidedAt: null, decidedReason: null, decidedBySoleModerator: false, moderatorFigure: null, awardedPoints: null };
const { json, foreignJson } = guardedRequests("/api/moderation/disputes");
useTrustedOrigin();
function payload() { return { requestId, decision: "GRANTED", figure: 5, reason: decided.decidedReason }; }
function dependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: moderatorId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    createService: vi.fn().mockResolvedValue({ decideDispute: vi.fn().mockResolvedValue(decided),
      listDisputes: vi.fn().mockResolvedValue([open, decided]) }),
    ...overrides,
  };
}

describe("POST /api/moderation/disputes", () => {
  it.each([[null, "MODERATOR", 401], [{ user: { id: moderatorId } }, "MEMBER", 403]] as const)(
    "guards session %j and role %s", async (session, role, status) => {
      const deps = dependencies({ getSession: vi.fn().mockResolvedValue(session), getCurrentRole: vi.fn().mockResolvedValue(role) });
      expect((await createClosedPrDisputeDecisionPostHandler(deps)(json(payload()))).status).toBe(status);
      expect(deps.createService).not.toHaveBeenCalled();
    });
  it("guards foreign origins before authentication", async () => {
    const deps = dependencies();
    expect((await createClosedPrDisputeDecisionPostHandler(deps)(foreignJson(payload()))).status).toBe(403);
    expect(deps.getSession).not.toHaveBeenCalled();
  });
  it("bounds the body at 32 KiB", async () => {
    const deps = dependencies();
    expect((await createClosedPrDisputeDecisionPostHandler(deps)(json({ ...payload(), reason: "x".repeat(32 * 1024) })) ).status).toBe(413);
    expect(deps.createService).not.toHaveBeenCalled();
  });
  it.each([
    "not JSON", {}, { ...payload(), extra: true }, { ...payload(), requestId: "invalid" },
    { ...payload(), reason: " " }, { ...payload(), reason: "x".repeat(2001) },
    { ...payload(), decision: "MAYBE" }, { ...payload(), figure: undefined },
    { ...payload(), figure: 0 }, { ...payload(), figure: 11 }, { ...payload(), figure: 1.5 },
    { ...payload(), figure: "5" }, { ...payload(), moderatorAccountId: moderatorId },
  ])("refuses invalid or forged input %j", async (body) => {
    const deps = dependencies();
    const response = await createClosedPrDisputeDecisionPostHandler(deps)(json(body));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST", message: "Invalid closed PR dispute decision." } });
    expect(deps.createService).not.toHaveBeenCalled();
  });
  it.each([
    { decision: "GRANTED", figure: 1 },
    { decision: "GRANTED", figure: 5 },
    { decision: "GRANTED", figure: 10 },
    { decision: "DENIED", figure: 5 },
  ] as const)("records $decision with figure $figure under the session moderator identity", async ({ decision, figure }) => {
    const journal = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const decideDispute = vi.fn().mockResolvedValue({ ...decided, decision });
      const deps = dependencies({ createService: vi.fn().mockResolvedValue({ decideDispute }) });
      const response = await createClosedPrDisputeDecisionPostHandler(deps)(json({ ...payload(), decision, figure }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ request: { ...decided, decision } });
      expect(decideDispute).toHaveBeenCalledExactlyOnceWith(requestId, { id: moderatorId }, {
        decision, figure, decidedReason: decided.decidedReason,
      });
      expect(journal).toHaveBeenCalledWith("Privileged action", expect.objectContaining({
        action: "closed_pr.dispute.decide", actorId: moderatorId,
      }));
    } finally { journal.mockRestore(); }
  });
  it("accepts a denial without a figure", async () => {
    const deps = dependencies();
    expect((await createClosedPrDisputeDecisionPostHandler(deps)(json({ requestId, decision: "DENIED", reason: "Insufficient grounds." }))).status).toBe(200);
  });
  it("uses the authenticated token moderator identity", async () => {
    const decideDispute = vi.fn().mockResolvedValue(decided);
    const tokenAccount = "00000000-0000-4000-8000-000000000099";
    const deps = dependencies({
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: tokenAccount, tokenId: "token-1" }),
      createService: vi.fn().mockResolvedValue({ decideDispute }),
    });
    expect((await createClosedPrDisputeDecisionPostHandler(deps)(json(payload(), "POST", {
      authorization: `Bearer ovf_${"r".repeat(43)}`,
    }))).status).toBe(200);
    expect(decideDispute).toHaveBeenCalledWith(requestId, { id: tokenAccount }, expect.anything());
    expect(deps.getSession).not.toHaveBeenCalled();
  });
  it.each([
    ["FORBIDDEN", 403], ["CONFLICT", 409], ["NOT_FOUND", 404], ["INVALID_INPUT", 422], ["INSUFFICIENT_EVIDENCE", 422],
  ] as const)("maps %s to %s", async (code, status) => {
    const deps = dependencies({ createService: vi.fn().mockResolvedValue({
      decideDispute: vi.fn().mockRejectedValue(new ClosedPrDisputeError(code, "The rule explains the refusal.")),
    }) });
    const response = await createClosedPrDisputeDecisionPostHandler(deps)(json(payload()));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "The rule explains the refusal." } });
  });
  it("masks internal failures", async () => {
    const deps = dependencies({ createService: vi.fn().mockRejectedValue(new Error("secret DB details")) });
    const response = await createClosedPrDisputeDecisionPostHandler(deps)(json(payload()));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "UPSTREAM_FAILURE", message: "Unable to complete the closed PR dispute request." } });
  });
  it("guards the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/moderation/disputes/route");
    expect((await route.POST(json(payload()))).status).toBe(401);
  });
});

describe("GET /api/moderation/disputes", () => {
  const get = () => new Request(new URL("/api/moderation/disputes", requestHost));
  it.each([[null, "MODERATOR", 401], [{ user: { id: moderatorId } }, "MEMBER", 403]] as const)(
    "guards session %j and role %s", async (session, role, status) => {
      const deps = dependencies({ getSession: vi.fn().mockResolvedValue(session), getCurrentRole: vi.fn().mockResolvedValue(role) });
      expect((await createClosedPrDisputeQueueGetHandler(deps)(get())).status).toBe(status);
      expect(deps.createService).not.toHaveBeenCalled();
    });
  it("returns the ordered open queue and decided history", async () => {
    const listDisputes = vi.fn().mockResolvedValue([open, decided]);
    const deps = dependencies({ createService: vi.fn().mockResolvedValue({ listDisputes }) });
    const response = await createClosedPrDisputeQueueGetHandler(deps)(get());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([open, decided]);
    expect(listDisputes).toHaveBeenCalledExactlyOnceWith();
  });
  it("answers 502 for a failed queue read", async () => {
    const deps = dependencies({ createService: vi.fn().mockRejectedValue(new Error("db down")) });
    const response = await createClosedPrDisputeQueueGetHandler(deps)(get());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "UPSTREAM_FAILURE", message: "Unable to load the closed PR dispute queue." } });
  });
  it("guards the production export", async () => {
    productionAuth.mockResolvedValue(null);
    const route = await import("@/app/api/moderation/disputes/route");
    expect((await route.GET(get())).status).toBe(401);
  });
});
