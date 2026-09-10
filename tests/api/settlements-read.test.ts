import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettlementsGetHandler } from "@/app/api/settlements/route";
import { createSettlementProofGetHandler } from "@/app/api/settlements/[id]/route";
import type {
  SettlementHistoryProjection,
  SettlementProofProjection,
} from "@/lib/dashboard/queries";
import type { SettlementOverrideRequest } from "@/lib/overrides/service";

const memberId = "00000000-0000-4000-8000-000000000001";
const settlementId = "00000000-0000-4000-8000-000000000002";
const otherSettlementId = "00000000-0000-4000-8000-000000000003";

const historyRow: SettlementHistoryProjection = {
  id: settlementId,
  status: "SETTLED",
  repositoryName: "octo/overflow",
  issueNumber: 134,
  issueTitle: "Read API for the settlement ledger",
  issueUrl: "https://github.com/octo/overflow/issues/134",
  credits: 3,
  reviewRounds: 1,
  balanceEffect: 3,
  settledAt: "2026-09-09T00:00:00.000Z",
};

const proof: SettlementProofProjection = {
  id: settlementId,
  status: "SETTLED",
  repositoryName: "octo/overflow",
  issueNumber: 134,
  issueTitle: "Read API for the settlement ledger",
  issueUrl: "https://github.com/octo/overflow/issues/134",
  pullRequestNumber: 205,
  pullRequestTitle: "Settle the read API work",
  pullRequestUrl: "https://github.com/octo/overflow/pull/205",
  proofSha256: "a".repeat(64),
  openingComparisonPoints: 5,
  settledPoints: 4,
  reviewRounds: 1,
  credits: 3,
  settledAt: "2026-09-09T00:00:00.000Z",
  balanceEffect: 3,
};

const correction: SettlementOverrideRequest = {
  id: "00000000-0000-4000-8000-000000000004",
  issueId: "00000000-0000-4000-8000-000000000005",
  requesterId: memberId,
  reason: "The settled label missed the evidence window.",
  state: "OPEN",
  settledPoints: null,
  decidedById: null,
  decisionReason: null,
  createdAt: "2026-09-09T01:00:00.000Z",
  decidedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the query and the corrections service are mocks on the
 * injected dependencies, so each case drives one arm of the route against the
 * member gate.
 */
function historyDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    listSettlementHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function proofDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    getSettlementProof: vi.fn().mockResolvedValue(proof),
    createCorrectionsService: vi.fn().mockResolvedValue({
      listRequestsForSettlement: vi.fn().mockResolvedValue([correction]),
    }),
    ...overrides,
  };
}

function settlementsRequest(): Request {
  return new Request("https://overflow.example/api/settlements");
}

function settlementProofRequest(): Request {
  return new Request(`https://overflow.example/api/settlements/${settlementId}`);
}

function proofContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/settlements", () => {
  it("answers an anonymous request with the 401 sign-in refusal, before the query runs", async () => {
    const dependencies = historyDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createSettlementsGetHandler(dependencies)(settlementsRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.listSettlementHistory).not.toHaveBeenCalled();
  });

  it("answers a member whose account no longer exists with the 403 member refusal, before the query runs", async () => {
    const dependencies = historyDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createSettlementsGetHandler(dependencies)(settlementsRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(dependencies.listSettlementHistory).not.toHaveBeenCalled();
  });

  it("answers 200 with the settlement history the query returned", async () => {
    const dependencies = historyDependencies({
      listSettlementHistory: vi.fn().mockResolvedValue([historyRow]),
    });

    const response = await createSettlementsGetHandler(dependencies)(settlementsRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([historyRow]);
    expect(dependencies.listSettlementHistory).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  it("answers a query failure with the route's 502", async () => {
    const dependencies = historyDependencies({
      listSettlementHistory: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createSettlementsGetHandler(dependencies)(settlementsRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the settlement history." },
    });
  });
});

describe("GET /api/settlements/[id]", () => {
  it("answers 200 with the settlement proof and the correction requests raised against it", async () => {
    const correctionsService = {
      listRequestsForSettlement: vi.fn().mockResolvedValue([correction]),
    };
    const dependencies = proofDependencies({
      createCorrectionsService: vi.fn().mockResolvedValue(correctionsService),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(settlementId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settlement: proof,
      corrections: [correction],
    });
    expect(dependencies.getSettlementProof).toHaveBeenCalledExactlyOnceWith(
      memberId,
      settlementId,
    );
    expect(correctionsService.listRequestsForSettlement).toHaveBeenCalledExactlyOnceWith(
      { id: memberId },
      settlementId,
    );
  });

  it("answers a settlement the viewer is not a party to with the 404 not-found refusal, without consulting the corrections", async () => {
    const correctionsService = {
      listRequestsForSettlement: vi.fn(),
    };
    const dependencies = proofDependencies({
      getSettlementProof: vi.fn().mockResolvedValue(null),
      createCorrectionsService: vi.fn().mockResolvedValue(correctionsService),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(otherSettlementId),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Settlement proof is not available." },
    });
    expect(correctionsService.listRequestsForSettlement).not.toHaveBeenCalled();
  });

  it("answers a malformed settlement id with the 404 not-found refusal, before the query runs", async () => {
    const dependencies = proofDependencies();

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext("not-a-uuid"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Settlement proof is not available." },
    });
    expect(dependencies.getSettlementProof).not.toHaveBeenCalled();
  });

  it.each(["123", "{not-a-uuid}"])("answers the malformed settlement id %s with the 404 not-found refusal, before the query runs", async (malformedId) => {
    const dependencies = proofDependencies();

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(malformedId),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Settlement proof is not available." },
    });
    expect(dependencies.getSettlementProof).not.toHaveBeenCalled();
  });

  it("answers an anonymous request with the 401 sign-in refusal, before the query runs", async () => {
    const dependencies = proofDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(settlementId),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.getSettlementProof).not.toHaveBeenCalled();
  });

  it("answers a member whose account no longer exists with the 403 member refusal, before the query runs", async () => {
    const dependencies = proofDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(settlementId),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(dependencies.getSettlementProof).not.toHaveBeenCalled();
  });

  it("answers a proof query failure with the route's 502", async () => {
    const dependencies = proofDependencies({
      getSettlementProof: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(settlementId),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the settlement proof." },
    });
  });

  it("keeps the proof answerable when the correction history cannot be read, answering corrections null", async () => {
    const dependencies = proofDependencies({
      createCorrectionsService: vi.fn().mockRejectedValue(new Error("store outage")),
    });

    const response = await createSettlementProofGetHandler(dependencies)(
      settlementProofRequest(),
      proofContext(settlementId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settlement: proof,
      corrections: null,
    });
  });
});
