import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createCalibrationGetHandler,
  type CalibrationRouteDependencies,
} from "@/app/api/calibration/route";
import type {
  CalibrationComparison,
  RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
import type { CalibrationCohorts, SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";

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

// The one cohort pair the loader returns and both projections derive from.
// Passed by reference through the handler, so the assertions below can pin
// that both projections consumed this exact load.
const cohorts: CalibrationCohorts = {
  selfWorkRows: [
    {
      github_repository_id: 92731604,
      repository_name: "Nitjsefnie-Harness-Commons/daedalus",
      github_issue_id: 1101,
      github_pull_request_id: 2201,
      merged_at: "2026-09-01T00:00:00.000Z",
      proof_sha256: "a".repeat(64),
      offered_difficulty: 5,
      settled_difficulty: 4,
    },
  ],
  outsiderRows: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the calibration reads and derivations are mocks on the
 * injected dependencies, so each case drives one arm of the route against the
 * member gate.
 */
type CalibrationDependencyMocks = {
  [K in keyof CalibrationRouteDependencies]: Mock;
};

function calibrationDependencies(overrides: Partial<CalibrationDependencyMocks> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId, role: "MEMBER" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    loadCalibrationCohorts: vi.fn().mockResolvedValue(cohorts),
    getCalibrationComparison: vi.fn().mockReturnValue(comparison),
    getCalibrationComparisonByRepository: vi.fn().mockReturnValue(byRepository),
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
    expect(dependencies.loadCalibrationCohorts).not.toHaveBeenCalled();
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
    expect(dependencies.loadCalibrationCohorts).not.toHaveBeenCalled();
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
    expect(dependencies.loadCalibrationCohorts).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(dependencies.getCalibrationComparison).toHaveBeenCalledExactlyOnceWith(cohorts);
    expect(dependencies.getCalibrationComparisonByRepository).toHaveBeenCalledExactlyOnceWith(cohorts);
    expect(dependencies.listSelfWorkCalibrations).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  // Both views derive from the one cohort load: the handler reads once and
  // hands the same result to each projection, so a second selection — or two
  // loads that could straddle a commit — has no path into the response.
  it("derives both projections from the single cohort load", async () => {
    const dependencies = calibrationDependencies();

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(200);
    expect(dependencies.loadCalibrationCohorts).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(dependencies.getCalibrationComparison).toHaveBeenCalledExactlyOnceWith(cohorts);
    expect(dependencies.getCalibrationComparisonByRepository).toHaveBeenCalledExactlyOnceWith(cohorts);
  });

  it("answers a cohort load failure with the route's 502, without reading the calibrations", async () => {
    const dependencies = calibrationDependencies({
      loadCalibrationCohorts: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createCalibrationGetHandler(dependencies)(calibrationRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the calibration comparison." },
    });
    expect(dependencies.listSelfWorkCalibrations).not.toHaveBeenCalled();
  });

  // The breakdown is part of the answer, not a decoration on it: a member
  // reading one repository's figure must never be shown a page that silently
  // dropped the repository it could not read. A derivation throwing is the
  // same failure as the load failing — the route answers without either view
  // rather than answering with half of the measurement.
  it("answers a derivation failure with the route's 502, without reading the calibrations", async () => {
    const dependencies = calibrationDependencies({
      getCalibrationComparisonByRepository: vi.fn(() => {
        throw new Error("breakdown outage");
      }),
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
