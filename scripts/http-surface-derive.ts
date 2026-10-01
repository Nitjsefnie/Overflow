import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GET as getVersionRoute } from "../src/app/api/version/route.ts";
import {
  createReadinessGetHandler,
  type ReadinessRouteDependencies,
} from "../src/app/api/readiness/route.ts";
import {
  createDashboardGetHandler,
  type DashboardRouteDependencies,
} from "../src/app/api/dashboard/route.ts";
import { createIssuesGetHandler, type IssuesRouteDependencies } from "../src/app/api/issues/route.ts";
import {
  createSettlementsGetHandler,
  type SettlementsRouteDependencies,
} from "../src/app/api/settlements/route.ts";
import {
  createSettlementProofGetHandler,
  type SettlementProofRouteDependencies,
} from "../src/app/api/settlements/[id]/route.ts";
import {
  createCalibrationGetHandler,
  type CalibrationRouteDependencies,
} from "../src/app/api/calibration/route.ts";
import {
  createApiTokenPostHandler,
  type ApiTokenIssuer,
  type ApiTokenRouteDependencies,
  type ApiTokenRouteSession,
} from "../src/app/api/tokens/route.ts";

/**
 * The HTTP surface snapshot's shared machinery (issue 912): what the recorded
 * shape language is, what counts as compatible with a recorded shape, the
 * snapshot base-commit resolution both snapshot tests share, and the
 * derivation of the documented routes' success shapes.
 *
 * The snapshot discipline mirrors the MCP tool-surface one (issue 654): the
 * recorded file scripts/http-surface-snapshot.json is regenerated only by
 * scripts/update-http-surface-snapshot.ts, a documented shape's breaking
 * change fails the snapshot test without an explicit version move, and
 * additive changes stay green (policy in API.md "Stability and versioning").
 *
 * The route handlers are dependency-injected factories, so the derivation
 * invokes each factory with stub dependencies typed against the route's real
 * dependency interface — never a module-level singleton — returning
 * representative typed values (ISO strings for timestamps, uuid-ish strings
 * for ids, nonempty arrays for lists), and reads the shape off the Response
 * the handler answers.
 */

/**
 * The shape language the snapshot records: the scalar type names JSON
 * serializes to, "unknown" for a list whose element shape nothing revealed
 * (an empty array at derivation time), and a nested field→shape map for
 * objects. Array shapes are their element shape — a list of strings records
 * "string", a list of objects records that object's map.
 */
export type HttpShape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "unknown"
  | { [field: string]: HttpShape };

/**
 * The shape of one JSON value, with object fields sorted so a recorded
 * snapshot diffs stably. Arrays take their first element's shape; an empty
 * array records "unknown".
 */
export function shapeOf(value: unknown): HttpShape {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "unknown" : shapeOf(value[0]!);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([field, item]) => [field, shapeOf(item)]),
    );
  }
  return typeof value as HttpShape;
}

function isShapeObject(shape: HttpShape): shape is { [field: string]: HttpShape } {
  return typeof shape === "object" && shape !== null;
}

/**
 * Whether a derived shape stays compatible with a recorded one, per the
 * SemVer-with-notice policy: every field the recording pinned must still be
 * served with a compatible shape — the same scalar name, a nested object
 * recursing field by field, arrays comparing through their element shapes —
 * while fields the recording did not pin are additive and always compatible.
 * A recorded null matches only a derived null.
 */
export function shapesCompatible(recorded: HttpShape, derived: HttpShape): boolean {
  const recordedObject = isShapeObject(recorded);
  const derivedObject = isShapeObject(derived);
  if (recordedObject || derivedObject) {
    if (!recordedObject || !derivedObject) {
      return false;
    }
    return Object.entries(recorded).every(([field, fieldShape]) =>
      Object.hasOwn(derived, field) && shapesCompatible(fieldShape, derived[field]!),
    );
  }
  // A recording made while a list revealed no element shape pins nothing
  // about it, so any later revealed shape is additive.
  return recorded === "unknown" || recorded === derived;
}

// ---------------------------------------------------------------------------
// The snapshot base-commit resolution, shared by both snapshot tests (the MCP
// test predates it and now imports these).
// ---------------------------------------------------------------------------

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function firstParentOfMerge(fields: string[]): string | undefined {
  // CI merge refs and rebase merges use first parent; ordinary local HEADs fall through to merge-base.
  return fields.length >= 3 ? fields[1] : undefined;
}

export function pickBase({
  parentFields,
  mergeBase,
  headParentResolved,
}: {
  parentFields: string[];
  mergeBase?: string;
  headParentResolved?: string;
}): string | undefined {
  const firstParent = firstParentOfMerge(parentFields);
  if (firstParent !== undefined) return firstParent;
  if (mergeBase && mergeBase !== parentFields[0]) return mergeBase;
  return headParentResolved;
}

/**
 * The commit the recorded snapshot is compared against: the env override when
 * the caller names one (HTTP_SNAPSHOT_BASE_COMMIT, MCP_SNAPSHOT_BASE_COMMIT),
 * else the first parent of a merge, else the merge base with origin/main,
 * else HEAD's parent. Each snapshot test names its own override variable and
 * its own label for the failure message.
 */
export function baseCommit(envOverride: string | undefined, label: string): string {
  if (envOverride !== undefined) {
    return git(["rev-parse", "--verify", "--end-of-options", `${envOverride}^{commit}`]);
  }

  const parentFields = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
  const mergeParent = pickBase({ parentFields });
  if (mergeParent !== undefined) return mergeParent;

  const result = spawnSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const mergeBase = result.status === 0 ? result.stdout.trim() || undefined : undefined;
  const branchBase = pickBase({ parentFields, mergeBase });
  if (branchBase !== undefined) return branchBase;

  const parentResult = spawnSync("git", ["rev-parse", "--verify", "HEAD^1"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const headParentResolved = parentResult.status === 0 ? parentResult.stdout.trim() || undefined : undefined;
  const base = pickBase({ parentFields, mergeBase, headParentResolved });
  if (base !== undefined) return base;
  throw new Error(
    `The ${label} snapshot base could not be resolved; git fetch origin main, ` +
      "and if this is a shallow checkout fetch full history with git fetch --unshallow.",
  );
}

// ---------------------------------------------------------------------------
// The derivation: each documented route, invoked through its factory with
// stub dependencies, and the shape of the success body it answers.
// ---------------------------------------------------------------------------

/** Every derivation stub answers as this account. */
const memberId = "00000000-0000-4000-8000-000000000001";

/** A fixed instant the timestamp-bearing stubs derive from — no wall clock in a snapshot. */
const derivationNowMs = Date.parse("2026-01-15T12:00:00.000Z");

const memberDependencies = {
  getSession: async () => ({ user: { id: memberId, role: "MEMBER" as const } }),
  findAccountByTokenHash: async () => null,
  getCurrentRole: async () => "MEMBER" as const,
};

async function bodyShape(response: Response): Promise<HttpShape> {
  return shapeOf(await response.json());
}

function memberRequest(path: string): Request {
  return new Request(`https://overflow.example${path}`);
}

/**
 * The origin guard reads APP_URL at call time, so the token derivation pins
 * it for the duration of its request and restores whatever was set — the
 * derivation must not leak environment into the process it runs in.
 */
async function withAppUrl<T>(run: () => Promise<T>): Promise<T> {
  const configured = process.env.APP_URL;
  process.env.APP_URL = "https://overflow.example";
  try {
    return await run();
  } finally {
    if (configured === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = configured;
    }
  }
}

async function deriveGetVersion(): Promise<HttpShape> {
  return bodyShape(await getVersionRoute());
}

async function deriveGetReadiness(): Promise<HttpShape> {
  const dependencies: ReadinessRouteDependencies = {
    probe: async () => ({ status: "ready" }),
    now: () => derivationNowMs,
  };
  return bodyShape(await createReadinessGetHandler(dependencies)());
}

async function derivePostTokens(): Promise<HttpShape> {
  const session: ApiTokenRouteSession = {
    user: { id: memberId, role: "MEMBER", authenticatedAt: derivationNowMs / 1000 },
  };
  const dependencies: ApiTokenRouteDependencies = {
    getSession: async () => session,
    getCurrentRole: async () => "MEMBER",
    createTokenStore: async (): Promise<ApiTokenIssuer> => ({
      issueToken: async () => ({
        createdAt: new Date(derivationNowMs),
        expiresAt: new Date(derivationNowMs + 30 * 60 * 1000),
        confirmedAt: null,
      }),
    }),
    now: () => derivationNowMs,
  };
  return withAppUrl(async () =>
    bodyShape(
      await createApiTokenPostHandler(dependencies)(
        new Request("https://overflow.example/api/tokens", {
          method: "POST",
          headers: { origin: "https://overflow.example" },
        }),
      ),
    ),
  );
}

const recentSettlement = {
  id: "00000000-0000-4000-8000-000000000002",
  status: "SETTLED" as const,
  repositoryName: "octo/overflow",
  issueNumber: 912,
  issueTitle: "HTTP response-shape snapshot",
  issueUrl: "https://github.com/Nitjsefnie/Overflow/issues/912",
  pullRequestNumber: 920,
  pullRequestTitle: "HTTP response-shape snapshot",
  pullRequestUrl: "https://github.com/Nitjsefnie/Overflow/pull/920",
  proofSha256: "a".repeat(64),
  credits: 3,
  reviewRounds: 1,
  settledAt: "2026-01-15T12:00:00.000Z",
};

async function deriveGetDashboard(): Promise<HttpShape> {
  const dependencies: DashboardRouteDependencies = {
    ...memberDependencies,
    getDashboard: async () => ({
      settledBalance: 120,
      earnedTotal: 300,
      givenTotal: 180,
      reservedPoints: 40,
      availableHeadroom: 80,
      enforcementState: "ACTIVE",
      recentSettlements: [recentSettlement],
      openClaims: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          repositoryName: "octo/overflow",
          issueNumber: 911,
          title: "An open claim",
          url: "https://github.com/Nitjsefnie/Overflow/issues/911",
          assigneeGitHubLogin: "claimant",
          openingName: "Opening",
          openingLabel: "opening:medium",
          reservePoints: 4,
        },
      ],
      registeredRepositories: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          ownerName: "octo/overflow",
          visibility: "PUBLIC",
          active: true,
          openingName: "Opening",
          actualName: "Actual",
          unavailableReason: null,
          reconciliationState: "IDLE" as const,
          reconciliationLastFailureAt: new Date(derivationNowMs),
        },
      ],
      enforcementNotices: [
        {
          id: "00000000-0000-4000-8000-000000000005",
          priorState: "NONE",
          newState: "ACTIVE",
          reason: "A calibration audit opened.",
          createdAt: "2026-01-15T11:00:00.000Z",
        },
      ],
      openAudit: {
        id: "00000000-0000-4000-8000-000000000006",
        openedAt: "2026-01-15T10:00:00.000Z",
      },
    }),
  };
  return bodyShape(await createDashboardGetHandler(dependencies)(memberRequest("/api/dashboard")));
}

async function deriveGetIssues(): Promise<HttpShape> {
  const dependencies: IssuesRouteDependencies = {
    ...memberDependencies,
    listEligibleIssues: async () => [
      {
        id: "00000000-0000-4000-8000-000000000007",
        repositoryName: "octo/overflow",
        issueNumber: 912,
        title: "HTTP response-shape snapshot",
        url: "https://github.com/Nitjsefnie/Overflow/issues/912",
        openingName: "Opening",
        openingLabel: "opening:medium",
        comparisonPoints: 5,
        reservePoints: 4,
        sponsorLogin: "sponsor",
        assigneeGitHubLogin: null,
        claimState: "OPEN" as const,
        availableHeadroom: 80,
        createdAt: "2026-01-10T09:00:00.000Z",
      },
    ],
  };
  return bodyShape(await createIssuesGetHandler(dependencies)(memberRequest("/api/issues?claimState=OPEN")));
}

async function deriveGetSettlements(): Promise<HttpShape> {
  const dependencies: SettlementsRouteDependencies = {
    ...memberDependencies,
    listSettlementHistory: async () => [
      {
        id: recentSettlement.id,
        status: "SETTLED" as const,
        repositoryName: recentSettlement.repositoryName,
        issueNumber: recentSettlement.issueNumber,
        issueTitle: recentSettlement.issueTitle,
        issueUrl: recentSettlement.issueUrl,
        credits: 3,
        reviewRounds: 1,
        balanceEffect: 3,
        settledAt: recentSettlement.settledAt,
      },
    ],
  };
  return bodyShape(await createSettlementsGetHandler(dependencies)(memberRequest("/api/settlements")));
}

async function deriveGetSettlementProof(): Promise<HttpShape> {
  const dependencies: SettlementProofRouteDependencies = {
    ...memberDependencies,
    getSettlementProof: async () => ({
      id: recentSettlement.id,
      status: "SETTLED" as const,
      repositoryName: recentSettlement.repositoryName,
      issueNumber: recentSettlement.issueNumber,
      issueTitle: recentSettlement.issueTitle,
      issueUrl: recentSettlement.issueUrl,
      pullRequestNumber: 920,
      pullRequestTitle: recentSettlement.pullRequestTitle,
      pullRequestUrl: recentSettlement.pullRequestUrl,
      proofSha256: recentSettlement.proofSha256,
      openingComparisonPoints: 5,
      settledPoints: 3,
      reviewRounds: 1,
      credits: 3,
      settledAt: recentSettlement.settledAt,
      openingName: "Opening",
      actualName: "Actual",
      openingLabel: "opening:medium",
      settledLabel: "opening:medium",
      settledLabelEventId: "00000000-0000-4000-8000-000000000008",
      settledLabelActorLogin: "actor",
      settledLabelAppliedAt: "2026-01-15T12:00:00.000Z",
      settledRationaleCommentId: "00000000-0000-4000-8000-000000000009",
      settledRationaleActorLogin: "actor",
      settledRationaleCommentedAt: "2026-01-15T12:00:00.000Z",
      mergeCommitOid: "b".repeat(40),
      mergedAt: "2026-01-15T11:30:00.000Z",
      balanceEffect: 3,
    }),
    createCorrectionsService: async () => ({
      listRequestsForSettlement: async () => [
        {
          id: "00000000-0000-4000-8000-00000000000a",
          issueId: "00000000-0000-4000-8000-00000000000b",
          requesterId: memberId,
          reason: "The settled difficulty reads high.",
          state: "OPEN" as const,
          settledPoints: null,
          decidedById: null,
          decisionReason: null,
          createdAt: "2026-01-15T12:30:00.000Z",
          decidedAt: null,
        },
      ],
    }),
  };
  return bodyShape(
    await createSettlementProofGetHandler(dependencies)(
      memberRequest("/api/settlements/00000000-0000-4000-8000-000000000002"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) },
    ),
  );
}

async function deriveGetCalibration(): Promise<HttpShape> {
  const dependencies: CalibrationRouteDependencies = {
    ...memberDependencies,
    loadCalibrationCohorts: async () => ({
      selfWorkRows: [
        {
          github_repository_id: 502130001,
          github_issue_id: 293100001,
          github_pull_request_id: 293200001,
          merged_at: "2026-01-15T11:30:00.000Z",
          proof_sha256: "c".repeat(64),
          offered_difficulty: 5,
          settled_difficulty: 4,
          repository_name: "octo/overflow",
        },
      ],
      outsiderRows: [
        {
          github_repository_id: 502130001,
          github_issue_id: 293100002,
          github_pull_request_id: 293200002,
          merged_at: "2026-01-14T11:30:00.000Z",
          proof_sha256: "d".repeat(64),
          offered_difficulty: 5,
          settled_difficulty: 6,
          repository_name: "octo/overflow",
        },
      ],
    }),
    getCalibrationComparison: () => ({
      selfWork: { count: 1, meanDelta: -1, medianDelta: -1 },
      outsider: { count: 1, meanDelta: 1, medianDelta: 1 },
      differenceBetweenMeans: -2,
    }),
    getCalibrationComparisonByRepository: () => [
      {
        repositoryName: "octo/overflow",
        githubRepositoryId: 502130001,
        comparison: {
          selfWork: { count: 1, meanDelta: -1, medianDelta: -1 },
          outsider: { count: 1, meanDelta: 1, medianDelta: 1 },
          differenceBetweenMeans: -2,
        },
      },
    ],
    listSelfWorkCalibrations: async () => [
      {
        id: "00000000-0000-4000-8000-00000000000c",
        repositoryName: "octo/overflow",
        issueNumber: 911,
        issueTitle: "An open claim",
        openingComparisonPoints: 5,
        actualPoints: 4,
        mergedAt: "2026-01-15T11:30:00.000Z",
      },
    ],
  };
  return bodyShape(await createCalibrationGetHandler(dependencies)(memberRequest("/api/calibration")));
}

/**
 * The documented routes Task 1 of the snapshot pins, keyed "METHOD /path" in
 * the spelling API.md documents dynamic segments with (<id> for [id]).
 */
export async function deriveHttpSurfaceShapes(): Promise<Record<string, HttpShape>> {
  return {
    "GET /api/version": await deriveGetVersion(),
    "GET /api/readiness": await deriveGetReadiness(),
    "POST /api/tokens": await derivePostTokens(),
    "GET /api/dashboard": await deriveGetDashboard(),
    "GET /api/issues": await deriveGetIssues(),
    "GET /api/settlements": await deriveGetSettlements(),
    "GET /api/settlements/<id>": await deriveGetSettlementProof(),
    "GET /api/calibration": await deriveGetCalibration(),
  };
}
