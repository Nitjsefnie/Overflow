import { createClosedPrDisputeListGetHandler, createClosedPrDisputePostHandler,
  type ClosedPrDisputeRouteDependencies } from "../src/app/api/disputes/route.ts";
import { createClosedPrDisputeDecisionPostHandler, createClosedPrDisputeQueueGetHandler,
  type ClosedPrDisputeModerationRouteDependencies } from "../src/app/api/moderation/disputes/route.ts";
import type { ClosedPrDisputeRequest } from "../src/lib/moderation/closed-pr-dispute-service.ts";
import { derivedAnswer, memberRequest, mutationRequest, withAppUrl, type DerivedAnswer } from "./http-surface-derive.ts";
import { fixtureMemberId, fixtureTargetId, fixtureOverrideRequestId } from "./http-surface-fixtures.ts";

const filed: ClosedPrDisputeRequest = {
  id: fixtureOverrideRequestId, contributorId: fixtureMemberId, pullRequestId: fixtureTargetId,
  issueId: fixtureTargetId, landedPullRequestId: null, landedCommitUrl: "https://github.com/example/repo/commit/landed",
  requestReason: "The closed change landed elsewhere.", state: "OPEN", decision: null,
  decidedBy: null, decidedBySoleModerator: false, decidedReason: null, decidedAt: null,
  moderatorFigure: null, awardedPoints: null, createdAt: "2026-10-01T10:00:00.000Z",
};
const decided: ClosedPrDisputeRequest = { ...filed, state: "DECIDED", decision: "GRANTED",
  decidedBy: fixtureMemberId, decidedBySoleModerator: true, decidedReason: "The evidence supports the claim.",
  decidedAt: "2026-10-02T10:00:00.000Z", moderatorFigure: 5, awardedPoints: 3 };

export async function disputeSurfaceAnswers(): Promise<Record<string, DerivedAnswer>> {
  const auth = { getSession: async () => ({ user: { id: fixtureMemberId } }),
    findAccountByTokenHash: async () => null };
  const member: ClosedPrDisputeRouteDependencies = { ...auth, getCurrentRole: async () => "MEMBER",
    createService: async () => ({ fileDispute: async () => filed, listDisputes: async () => [filed, decided] }) };
  const moderator: ClosedPrDisputeModerationRouteDependencies = { ...auth, getCurrentRole: async () => "MODERATOR",
    createService: async () => ({ decideDispute: async () => decided, listDisputes: async () => [filed, decided].map((request) => ({ ...request, comparison: {
      closedPullRequest: { number: 12, title: "Original contribution", url: "https://github.com/example/repo/pull/12",
        reviews: [{ id: 1, state: "CHANGES_REQUESTED" as const, submittedAt: "2026-10-01T10:00:00Z", dismissal: null }], rawDiff: "original diff" },
      landedPullRequest: { number: 19, title: "Landing", url: "https://github.com/example/repo/pull/19",
        reviews: [], rawDiff: "landing diff" }, landedCommitUrl: null,
    } })) }) };
  return withAppUrl(async () => ({
    "GET /api/disputes": await derivedAnswer(await createClosedPrDisputeListGetHandler(member)(memberRequest("/api/disputes"))),
    "POST /api/disputes": await derivedAnswer(await createClosedPrDisputePostHandler(member)(mutationRequest("/api/disputes", "POST", {
      pullRequestId: fixtureTargetId, reason: filed.requestReason, landedCommitUrl: filed.landedCommitUrl,
    }))),
    "GET /api/moderation/disputes": await derivedAnswer(await createClosedPrDisputeQueueGetHandler(moderator)(memberRequest("/api/moderation/disputes"))),
    "POST /api/moderation/disputes": await derivedAnswer(await createClosedPrDisputeDecisionPostHandler(moderator)(mutationRequest("/api/moderation/disputes", "POST", {
      requestId: fixtureOverrideRequestId, decision: "GRANTED", figure: 5, reason: decided.decidedReason,
    }))),
  }));
}
