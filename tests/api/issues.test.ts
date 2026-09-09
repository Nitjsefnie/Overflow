import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIssuesGetHandler } from "@/app/api/issues/route";
import type { EligibleIssueProjection } from "@/lib/dashboard/queries";

const memberId = "00000000-0000-4000-8000-000000000001";

const eligibleIssue: EligibleIssueProjection = {
  id: "00000000-0000-4000-8000-00000000000a",
  repositoryName: "octo/overflow",
  issueNumber: 134,
  title: "Read API for the eligible issue board",
  url: "https://github.com/octo/overflow/issues/134",
  openingName: "Scope",
  openingLabel: "size/M",
  comparisonPoints: 5,
  reservePoints: 5,
  createdAt: "2026-09-09T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the query is a mock on the injected dependencies, so
 * each case drives one arm of the route against the member gate.
 */
function issueDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    listEligibleIssues: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function issuesRequest(query = ""): Request {
  return new Request(`https://overflow.example/api/issues${query}`);
}

describe("GET /api/issues", () => {
  it("answers an anonymous request with the 401 sign-in refusal, before the query runs", async () => {
    const dependencies = issueDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createIssuesGetHandler(dependencies)(issuesRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.listEligibleIssues).not.toHaveBeenCalled();
  });

  it("answers a member whose account no longer exists with the 403 member refusal, before the query runs", async () => {
    const dependencies = issueDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createIssuesGetHandler(dependencies)(issuesRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(dependencies.listEligibleIssues).not.toHaveBeenCalled();
  });

  it("answers 200 with the eligible issue board the query returned", async () => {
    const dependencies = issueDependencies({
      listEligibleIssues: vi.fn().mockResolvedValue([eligibleIssue]),
    });

    const response = await createIssuesGetHandler(dependencies)(issuesRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([eligibleIssue]);
    expect(dependencies.listEligibleIssues).toHaveBeenCalledExactlyOnceWith(
      memberId,
      { repository: undefined, openingLabel: undefined, claimState: "OPEN" },
    );
  });

  it("passes the repository and opening label filters through to the query", async () => {
    const dependencies = issueDependencies();

    await createIssuesGetHandler(dependencies)(
      issuesRequest("?repository=octo/overflow&openingLabel=size/M"),
    );

    expect(dependencies.listEligibleIssues).toHaveBeenCalledExactlyOnceWith(
      memberId,
      { repository: "octo/overflow", openingLabel: "size/M", claimState: "OPEN" },
    );
  });

  it.each(["CLAIMED", "ALL"] as const)(
    "passes a recognized %s claim state through to the query",
    async (claimState) => {
      const dependencies = issueDependencies();

      await createIssuesGetHandler(dependencies)(issuesRequest(`?claimState=${claimState}`));

      expect(dependencies.listEligibleIssues).toHaveBeenCalledExactlyOnceWith(
        memberId,
        { repository: undefined, openingLabel: undefined, claimState },
      );
    },
  );

  it.each(["OPEN", "open", "", "WHATEVER"] as const)(
    "answers the unclaimed board when the requested claim state is %s",
    async (requestedClaimState) => {
      const dependencies = issueDependencies();

      await createIssuesGetHandler(dependencies)(
        issuesRequest(`?claimState=${encodeURIComponent(requestedClaimState)}`),
      );

      expect(dependencies.listEligibleIssues).toHaveBeenCalledExactlyOnceWith(
        memberId,
        { repository: undefined, openingLabel: undefined, claimState: "OPEN" },
      );
    },
  );

  it("parses a repeated filter value as absent, as the issues page does", async () => {
    const dependencies = issueDependencies();

    await createIssuesGetHandler(dependencies)(
      issuesRequest("?repository=octo/overflow&repository=other/repo"),
    );

    expect(dependencies.listEligibleIssues).toHaveBeenCalledExactlyOnceWith(
      memberId,
      { repository: undefined, openingLabel: undefined, claimState: "OPEN" },
    );
  });

  it("answers a query failure with the route's 502", async () => {
    const dependencies = issueDependencies({
      listEligibleIssues: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createIssuesGetHandler(dependencies)(issuesRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the eligible issues." },
    });
  });
});
