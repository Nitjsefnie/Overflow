import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardGetHandler, serializeDashboard } from "@/app/api/dashboard/route";
import type { DashboardProjection } from "@/lib/dashboard/queries";

const memberId = "00000000-0000-4000-8000-000000000001";

const projection: DashboardProjection = {
  settledBalance: 120,
  earnedTotal: 300,
  givenTotal: 180,
  reservedPoints: 40,
  availableHeadroom: 80,
  recentSettlements: [],
  openClaims: [],
  registeredRepositories: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      ownerName: "octo/overflow",
      visibility: "PUBLIC",
      active: true,
      openingName: "Opening",
      actualName: "Actual",
      unavailableReason: null,
      reconciliationState: "FAILED",
      reconciliationLastFailureAt: new Date("2026-09-01T12:34:56.789Z"),
    },
  ],
  enforcementNotices: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the dashboard query is a mock on the injected
 * dependencies, so each case drives the route against the member gate.
 */
function dashboardDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    getDashboard: vi.fn().mockResolvedValue(projection),
    ...overrides,
  };
}

function dashboardRequest(): Request {
  return new Request("https://overflow.example/api/dashboard");
}

describe("GET /api/dashboard", () => {
  it("answers 200 with the projection the query returned, its reconciliation failure times serialized", async () => {
    const dependencies = dashboardDependencies();

    const response = await createDashboardGetHandler(dependencies)(dashboardRequest());

    expect(response.status).toBe(200);
    // Round-trip: the body is exactly the stub's projection after the route's
    // serializer, so an additive projection field can never fail this suite.
    await expect(response.json()).resolves.toEqual(serializeDashboard(projection));
    expect(
      serializeDashboard(projection).registeredRepositories[0].reconciliationLastFailureAt,
    ).toBe("2026-09-01T12:34:56.789Z");
    expect(dependencies.getDashboard).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  it("keeps a null reconciliation failure time null through the serialization", async () => {
    const nullProjection: DashboardProjection = {
      ...projection,
      registeredRepositories: [
        { ...projection.registeredRepositories[0], reconciliationLastFailureAt: null },
      ],
    };
    const dependencies = dashboardDependencies({
      getDashboard: vi.fn().mockResolvedValue(nullProjection),
    });

    const response = await createDashboardGetHandler(dependencies)(dashboardRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(serializeDashboard(nullProjection));
    expect(
      serializeDashboard(nullProjection).registeredRepositories[0].reconciliationLastFailureAt,
    ).toBe(null);
  });

  it("answers an anonymous request with the 401 sign-in refusal, before the query runs", async () => {
    const dependencies = dashboardDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createDashboardGetHandler(dependencies)(dashboardRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.getDashboard).not.toHaveBeenCalled();
  });

  it("answers a member whose account no longer exists with the 403 member refusal, before the query runs", async () => {
    const dependencies = dashboardDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createDashboardGetHandler(dependencies)(dashboardRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(dependencies.getDashboard).not.toHaveBeenCalled();
  });

  it("answers a dashboard query failure with the route's 502", async () => {
    const dependencies = dashboardDependencies({
      getDashboard: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createDashboardGetHandler(dependencies)(dashboardRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the dashboard." },
    });
  });
});
