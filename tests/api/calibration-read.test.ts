import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createCalibrationGetHandler,
  type CalibrationRouteDependencies,
} from "@/app/api/calibration/route";
import type { CalibrationComparison } from "@/lib/calibration/statistics";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";

const memberId = "00000000-0000-4000-8000-000000000001";

const comparison: CalibrationComparison = {
  selfWork: { count: 12, meanDelta: 0.75, medianDelta: 1 },
  outsider: { count: 30, meanDelta: -0.25, medianDelta: 0 },
  differenceBetweenMeans: 1,
};

const selfWorkCalibration: SelfWorkCalibrationProjection = {
  id: "00000000-0000-4000-8000-000000000002",
  repositoryName: "octo/overflow",
  issueNumber: 134,
  issueTitle: "Read API for the settlement ledger",
  openingComparisonPoints: 5,
  actualPoints: 4,
  mergedAt: "2026-09-09T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: both calibration queries are mocks on the injected
 * dependencies, so each case drives one arm of the route against the member
 * gate.
 */
type CalibrationDependencyMocks = {
  [K in keyof CalibrationRouteDependencies]: Mock;
};

function calibrationDependencies(overrides: Partial<CalibrationDependencyMocks> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    getCalibrationComparison: vi.fn().mockResolvedValue(comparison),
    listSelfWorkCalibrations: vi.fn().mockResolvedValue([selfWorkCalibration]),
    ...overrides,
  };
}

function calibrationRequest(): Request {
  return new Request("https://overflow.example/api/calibration");
}

describe("GET /api/calibration", () => {
  it("answers an anonymous request with the 401 sign-in refusal, before either query runs", async () => {
    const dependencies = calibrationDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.getCalibrationComparison).not.toHaveBeenCalled();
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
  });

  it("answers a member whose account no longer exists with the 403 member refusal, before either query runs", async () => {
    const dependencies = calibrationDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(dependencies.getCalibrationComparison).not.toHaveBeenCalled();
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
  });

  it("answers 200 with the comparison and the self-work calibrations the queries returned", async () => {
    const dependencies = calibrationDependencies();

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comparison,
      selfWork: [selfWorkCalibration],
    });
    expect(dependencies.getCalibrationComparison).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(dependencies.listSelfWorkCalibrations).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  it("answers a comparison query failure with the route's 502, without reading the calibrations", async () => {
    const dependencies = calibrationDependencies({
      getCalibrationComparison: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the calibration comparison." },
    });
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
  });

  it("keeps the comparison answerable when the self-work calibrations cannot be read, answering selfWork null", async () => {
    const dependencies = calibrationDependencies({
      listSelfWorkCalibrations: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comparison,
      selfWork: null,
    });
  });
});
