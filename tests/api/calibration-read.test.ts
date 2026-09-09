import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createCalibrationGetHandler,
  type CalibrationRouteDependencies,
} from "@/app/api/calibration/route";
import type {
  CalibrationComparison,
  RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";

const memberId = "00000000-0000-4000-8000-000000000001";

const comparison: CalibrationComparison = {
  selfWork: { count: 12, meanDelta: 0.75, medianDelta: 1 },
  outsider: { count: 30, meanDelta: -0.25, medianDelta: 0 },
  differenceBetweenMeans: 1,
};

const byRepository: RepositoryCalibrationEntry[] = [
  {
    githubRepositoryId: 92731604,
    repositoryName: "Nitjsefnie-Harness-Commons/daedalus",
    comparison: {
      selfWork: { count: 8, meanDelta: 0.5, medianDelta: 1 },
      outsider: { count: 20, meanDelta: -0.5, medianDelta: 0 },
      differenceBetweenMeans: 1,
    },
  },
  {
    githubRepositoryId: 92731750,
    repositoryName: "Nitjsefnie/Overflow",
    comparison: {
      selfWork: { count: 4, meanDelta: 1.25, medianDelta: 1 },
      outsider: { count: 0, meanDelta: 0, medianDelta: 0 },
      differenceBetweenMeans: null,
    },
  },
];

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
    getCalibrationComparisonByRepository: vi.fn().mockResolvedValue(byRepository),
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
    expect(dependencies.getCalibrationComparisonByRepository).not.toHaveBeenCalled();
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
    expect(dependencies.getCalibrationComparisonByRepository).not.toHaveBeenCalled();
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
  });

  it("answers 200 with the comparison, the per-repository breakdown, and the self-work calibrations the queries returned", async () => {
    const dependencies = calibrationDependencies();

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comparison,
      byRepository,
      selfWork: [selfWorkCalibration],
    });
    expect(dependencies.getCalibrationComparison).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(dependencies.getCalibrationComparisonByRepository).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(dependencies.listSelfWorkCalibrations).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  // The two comparison queries read independent rows, so they are issued
  // together: awaiting the first before asking for the second puts two
  // unindexed scans back to back on every request. Both are left in flight
  // while the issue order is read, then the first is released. Either
  // rejection still takes the route's 502 — the cases below pin that.
  it("issues both calibration queries together, while the first is still unanswered", async () => {
    const started: string[] = [];
    let releaseComparison: (value: CalibrationComparison) => void = () => {};
    const dependencies = calibrationDependencies({
      getCalibrationComparison: vi.fn(() => {
        started.push("comparison");
        return new Promise<CalibrationComparison>((resolve) => {
          releaseComparison = resolve;
        });
      }),
      getCalibrationComparisonByRepository: vi.fn(() => {
        started.push("byRepository");
        return Promise.resolve(byRepository);
      }),
    });

    const handled = createCalibrationGetHandler(dependencies)(calibrationRequest());
    await vi.waitFor(() => expect(started).toContain("comparison"));

    expect(started).toEqual(["comparison", "byRepository"]);

    releaseComparison(comparison);
    const response = await handled;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comparison,
      byRepository,
      selfWork: [selfWorkCalibration],
    });
  });

  // The breakdown is part of the answer, not a decoration on it: a member
  // reading one repository's figure must never be shown a page that silently
  // dropped the repository it could not read.
  it("answers a breakdown query failure with the route's 502, without reading the calibrations", async () => {
    const dependencies = calibrationDependencies({
      getCalibrationComparisonByRepository: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the calibration comparison." },
    });
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
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
      byRepository,
      selfWork: null,
    });
  });
});
