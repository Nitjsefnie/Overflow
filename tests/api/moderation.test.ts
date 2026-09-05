import { describe, expect, it, vi } from "vitest";
import {
  expectNoDependencyCall,
  guardedRequests,
  requestHost,
  unusedDependencies,
  useTrustedOrigin,
} from "../support/trusted-origin";

const { productionAuth, productionRole } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));

import {
  createModerationClosePatchHandler,
  createModerationPostHandler,
} from "@/app/api/moderation/route";
import {
  PATCH as productionAuditPatch,
  createModerationAuditPatchHandler,
} from "@/app/api/moderation/[id]/route";
import { createModeratorPostHandler } from "@/app/api/moderation/moderators/route";
import {
  GET as productionCohortGet,
  createModerationCohortGetHandler,
} from "@/app/api/moderation/cohort/route";
import {
  ModerationServiceError,
  type AccountAudit,
  type CalibrationCohortPreview,
  type ModeratorRoleChange,
  type RecalibrationClosure,
} from "@/lib/moderation/service";

const moderatorSession = { user: { id: "00000000-0000-4000-8000-000000000001", role: "MODERATOR" as const } };
const memberSession = { user: { id: "00000000-0000-4000-8000-000000000002", role: "MEMBER" as const } };
const targetAccountId = "00000000-0000-4000-8000-000000000003";
const repositoryScopeId = "00000000-0000-4000-8000-000000000005";
const auditId = "00000000-0000-4000-8000-000000000004";

useTrustedOrigin();

describe("account moderation API", () => {
  it("revokes an already-issued moderator session immediately after the database role is demoted", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue("MEMBER");
    const createService = vi.fn(async () => serviceHarness());
    const handler = createModerationPostHandler({
      getSession: async () => moderatorSession,
      getCurrentRole,
      createService,
    } as Parameters<typeof createModerationPostHandler>[0]);

    const response = await handler(jsonRequest(openPayload()));

    expect(response.status).toBe(403);
    expect(getCurrentRole).toHaveBeenCalledWith(moderatorSession.user.id);
    expect(createService).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });

  it("returns a structured 401 before parsing an unauthenticated audit request", async () => {
    const handler = createModerationPostHandler({
      getSession: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness(),
    });

    const response = await handler(jsonRequest({ correctedCredits: 99 }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("returns a structured 403 for a non-moderator", async () => {
    const handler = createModerationPostHandler({
      getSession: async () => memberSession,
      getCurrentRole: async () => "MEMBER",
      createService: async () => serviceHarness(),
    });

    const response = await handler(jsonRequest(openPayload()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });

  it("returns a structured 422 for an invalid payload instead of accepting settlement corrections", async () => {
    const handler = createModerationPostHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness(),
    });

    const response = await handler(jsonRequest({ ...openPayload(), correctedCredits: 99 }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
    });
  });

  it.each([
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["INSUFFICIENT_SAMPLES", 422],
  ] as const)("maps a %s service outcome to structured HTTP %s", async (code, status) => {
    const handler = createModerationPostHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () =>
        serviceHarness({
          open: async () => {
            throw new ModerationServiceError(code, "internal detail must not change the route contract");
          },
        }),
    });

    const response = await handler(jsonRequest(openPayload()));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: "Unable to process moderation request." },
    });
  });

  it("returns a sanitized 500 without database or upstream details", async () => {
    const handler = createModerationPostHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () =>
        serviceHarness({
          open: async () => {
            throw new Error("postgresql://moderator:password@db.example/overflow");
          },
        }),
    });

    const response = await handler(jsonRequest(openPayload()));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unable to process moderation request." },
    });
    expect(JSON.stringify(body)).not.toContain("postgresql");
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("allows only dismissal or substantiation for a specific audit id", async () => {
    const handler = createModerationAuditPatchHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness(),
    });

    const response = await handler(
      jsonRequest({ action: "substantiate", reason: "The snapshot supports the account-level pattern." }, "PATCH"),
      { params: Promise.resolve({ id: auditId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ audit: auditFixture({ state: "SUBSTANTIATED" }) });
  });

  it("uses the real production audit resolver for direct 401 and 403 responses", async () => {
    productionAuth.mockResolvedValueOnce(null);
    const unauthenticated = await productionAuditPatch(
      jsonRequest({ action: "dismiss", reason: "No session may decide an audit." }, "PATCH"),
      { params: Promise.resolve({ id: auditId }) },
    );
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });

    productionAuth.mockResolvedValueOnce(memberSession);
    productionRole.mockResolvedValueOnce("MEMBER");
    const memberResponse = await productionAuditPatch(
      jsonRequest({ action: "dismiss", reason: "A member cannot decide an audit." }, "PATCH"),
      { params: Promise.resolve({ id: auditId }) },
    );
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });

  it("requires a plan and moderator session before closing recalibration", async () => {
    const handler = createModerationClosePatchHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness(),
    });

    const invalidResponse = await handler(jsonRequest({ targetAccountId, plan: "  " }, "PATCH"));
    expect(invalidResponse.status).toBe(422);

    const response = await handler(
      jsonRequest(
        {
          targetAccountId,
          plan: "Review ten completed contributions before applying an opening label.",
        },
        "PATCH",
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      recalibration: {
        targetAccountId,
        priorState: "RECALIBRATING",
        targetState: "ACTIVE",
        confirmedPatternCount: 2,
        reactivatedRepositoryCount: 2,
      },
    });
  });
});

describe("calibration cohort preview API", () => {
  it("answers a moderator's candidate window with the paired evidence it would audit", async () => {
    const preview = previewFixture();
    const previewCalibrationCohort = vi.fn().mockResolvedValue(preview);
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness({ preview: previewCalibrationCohort }),
    });

    const response = await handler(cohortRequest(cohortQuery()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview });
    expect(previewCalibrationCohort).toHaveBeenCalledWith(
      { id: moderatorSession.user.id, role: "MODERATOR" },
      {
        targetAccountId,
        repositoryId: repositoryScopeId,
        sampleStartedAt: "2026-01-01T00:00:00.000Z",
        sampleEndedAt: "2026-02-01T00:00:00.000Z",
      },
    );
  });

  it("previews an account-wide window when no repository scope is requested", async () => {
    const previewCalibrationCohort = vi.fn().mockResolvedValue(previewFixture({ repositoryId: null }));
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness({ preview: previewCalibrationCohort }),
    });

    const response = await handler(cohortRequest({ ...cohortQuery(), repositoryId: undefined }));

    expect(response.status).toBe(200);
    expect(previewCalibrationCohort).toHaveBeenCalledWith(
      { id: moderatorSession.user.id, role: "MODERATOR" },
      {
        targetAccountId,
        sampleStartedAt: "2026-01-01T00:00:00.000Z",
        sampleEndedAt: "2026-02-01T00:00:00.000Z",
      },
    );
  });

  it("serves a cohort short of the audit floor rather than an error", async () => {
    const preview = previewFixture({
      meetsMinimumSampleSize: false,
      comparison: {
        selfWork: { count: 3, meanDelta: 1, medianDelta: 1 },
        outsider: { count: 12, meanDelta: 0, medianDelta: 0 },
        differenceBetweenMeans: 1,
      },
    });
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness({ preview: async () => preview }),
    });

    const response = await handler(cohortRequest(cohortQuery()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview });
  });

  it("revokes an already-issued moderator session immediately after the database role is demoted", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue("MEMBER");
    const createService = vi.fn(async () => serviceHarness());
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole,
      createService,
    } as Parameters<typeof createModerationCohortGetHandler>[0]);

    const response = await handler(cohortRequest(cohortQuery()));

    expect(response.status).toBe(403);
    expect(getCurrentRole).toHaveBeenCalledWith(moderatorSession.user.id);
    expect(createService).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });

  it("returns a structured 401 for an unauthenticated cohort read", async () => {
    const createService = vi.fn(async () => serviceHarness());
    const handler = createModerationCohortGetHandler({
      getSession: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService,
    } as Parameters<typeof createModerationCohortGetHandler>[0]);

    const response = await handler(cohortRequest(cohortQuery()));

    expect(response.status).toBe(401);
    expect(createService).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it.each([
    ["no target account", { targetAccountId: undefined }],
    ["a target account that is not a uuid", { targetAccountId: "target-account" }],
    ["a repository scope that is not a uuid", { repositoryId: "repository-scope" }],
    ["no sample start", { sampleStartedAt: undefined }],
    ["no sample end", { sampleEndedAt: undefined }],
    ["a misspelled repository scope", { repositoryId: undefined, repository: repositoryScopeId }],
  ] as const)("refuses a cohort request with %s before any database work", async (_label, overrides) => {
    const previewCalibrationCohort = vi.fn();
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness({ preview: previewCalibrationCohort }),
    });

    const response = await handler(cohortRequest({ ...cohortQuery(), ...overrides }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
    });
    expect(previewCalibrationCohort).not.toHaveBeenCalled();
  });

  it.each([
    ["targetAccountId", "00000000-0000-4000-8000-000000000006"],
    ["repositoryId", "00000000-0000-4000-8000-000000000007"],
    ["sampleStartedAt", "2026-01-15T00:00:00.000Z"],
    ["sampleEndedAt", "2026-03-01T00:00:00.000Z"],
  ])("rejects a repeated %s cohort parameter before calling the service", async (name, value) => {
    const previewCalibrationCohort = vi.fn();
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => serviceHarness({ preview: previewCalibrationCohort }),
    });
    const url = new URL(cohortRequest(cohortQuery()).url);
    url.searchParams.append(name, value);

    const response = await handler(new Request(url));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
    });
    expect(previewCalibrationCohort).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", 404],
    ["INVALID_INPUT", 422],
  ] as const)("maps a %s preview outcome to structured HTTP %s", async (code, status) => {
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () =>
        serviceHarness({
          preview: async () => {
            throw new ModerationServiceError(code, "internal detail must not change the route contract");
          },
        }),
    });

    const response = await handler(cohortRequest(cohortQuery()));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: "Unable to process moderation request." },
    });
  });

  it("returns a sanitized 500 without database or upstream details", async () => {
    const handler = createModerationCohortGetHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () =>
        serviceHarness({
          preview: async () => {
            throw new Error("postgresql://moderator:password@db.example/overflow");
          },
        }),
    });

    const response = await handler(cohortRequest(cohortQuery()));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unable to process moderation request." },
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("uses the real production cohort resolver for direct 401 and 403 responses", async () => {
    productionAuth.mockResolvedValueOnce(null);
    const unauthenticated = await productionCohortGet(cohortRequest(cohortQuery()));
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });

    productionAuth.mockResolvedValueOnce(memberSession);
    productionRole.mockResolvedValueOnce("MEMBER");
    const memberResponse = await productionCohortGet(cohortRequest(cohortQuery()));
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });
});

describe("moderation mutations reachable only from the deployment's own origin", () => {
  const auditContext = () => ({ params: Promise.resolve({ id: auditId }) });

  it("refuses a foreign-origin audit opening before any session or database work", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationPostHandler(dependencies)(
      foreignTextRequest(openPayload()),
    );

    await expectRejection(response, ...foreignOriginRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin audit opening that is not JSON", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationPostHandler(dependencies)(
      trustedTextRequest(openPayload()),
    );

    await expectRejection(response, ...unsupportedMediaTypeRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a foreign-origin recalibration closure before any session or database work", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationClosePatchHandler(dependencies)(
      foreignTextRequest({ targetAccountId, plan: "Forged." }, "PATCH"),
    );

    await expectRejection(response, ...foreignOriginRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin recalibration closure that is not JSON", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationClosePatchHandler(dependencies)(
      trustedTextRequest({ targetAccountId, plan: "Wrong type." }, "PATCH"),
    );

    await expectRejection(response, ...unsupportedMediaTypeRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a foreign-origin audit decision before any session or database work", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationAuditPatchHandler(dependencies)(
      foreignTextRequest({ action: "dismiss", reason: "Forged." }, "PATCH"),
      auditContext(),
    );

    await expectRejection(response, ...foreignOriginRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin audit decision that is not JSON", async () => {
    const dependencies = unusedDependencies();

    const response = await createModerationAuditPatchHandler(dependencies)(
      trustedTextRequest({ action: "dismiss", reason: "Wrong type." }, "PATCH"),
      auditContext(),
    );

    await expectRejection(response, ...unsupportedMediaTypeRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a foreign-origin moderator role change before any session or database work", async () => {
    const dependencies = unusedDependencies();

    const response = await createModeratorPostHandler(dependencies)(
      foreignTextRequest({ targetAccountId, moderator: true }),
    );

    await expectRejection(response, ...foreignOriginRejection);
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin moderator role change that is not JSON", async () => {
    const dependencies = unusedDependencies();

    const response = await createModeratorPostHandler(dependencies)(
      trustedTextRequest({ targetAccountId, moderator: true }),
    );

    await expectRejection(response, ...unsupportedMediaTypeRejection);
    expectNoDependencyCall(dependencies);
  });

  // A server that cannot name its own origin cannot tell a forged request from
  // a real one, so it refuses both rather than trusting whatever arrives.
  it("refuses a moderator role change when APP_URL is unset, without any database work", async () => {
    vi.stubEnv("APP_URL", undefined);
    const dependencies = unusedDependencies();

    const response = await createModeratorPostHandler(dependencies)(
      jsonRequest({ targetAccountId, moderator: true }),
    );

    await expectRejection(
      response,
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
    expectNoDependencyCall(dependencies);
  });

  it("still grants a moderator role change carrying the trusted origin", async () => {
    const setModeratorRole = vi.fn().mockResolvedValue(roleChange);
    const handler = createModeratorPostHandler({
      getSession: async () => moderatorSession,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({ listModerators: async () => [], setModeratorRole }),
    });

    const response = await handler(jsonRequest({ targetAccountId, moderator: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ change: roleChange });
    expect(setModeratorRole).toHaveBeenCalledWith(
      { id: moderatorSession.user.id, role: "MODERATOR" },
      targetAccountId,
      true,
    );
  });
});

const roleChange: ModeratorRoleChange = {
  targetAccountId,
  targetGitHubLogin: "promoted-account",
  role: "MODERATOR",
  actorId: moderatorSession.user.id,
  changedAt: "2026-09-05T10:00:00.000Z",
};

const { json: jsonRequest, foreignText: foreignTextRequest, trustedText: trustedTextRequest } =
  guardedRequests("/api/moderation");

async function expectRejection(
  response: Response,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: { code, message } });
}

const foreignOriginRejection = [403, "FORBIDDEN", "The request origin is not allowed."] as const;
const unsupportedMediaTypeRejection = [
  415,
  "UNSUPPORTED_MEDIA_TYPE",
  "The request must use the application/json content type.",
] as const;

function cohortQuery() {
  return {
    targetAccountId,
    repositoryId: repositoryScopeId,
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
  };
}

function cohortRequest(query: Record<string, string | undefined>): Request {
  const url = new URL("/api/moderation/cohort", requestHost);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return new Request(url, { method: "GET" });
}

function previewFixture(overrides: Partial<CalibrationCohortPreview> = {}): CalibrationCohortPreview {
  return {
    targetAccountId,
    repositoryId: repositoryScopeId,
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
    comparison: {
      selfWork: { count: 12, meanDelta: 1.5, medianDelta: 2 },
      outsider: { count: 11, meanDelta: 0.25, medianDelta: 0 },
      differenceBetweenMeans: 1.25,
    },
    meetsMinimumSampleSize: true,
    ...overrides,
  };
}

function openPayload() {
  return {
    targetAccountId,
    repositoryId: "00000000-0000-4000-8000-000000000005",
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
    reason: "A moderator identified a sustained account-level pattern.",
  };
}

function serviceHarness(overrides: Partial<{
  open: (actor: { id: string; role: "MEMBER" | "MODERATOR" }, input: ReturnType<typeof openPayload>) => Promise<AccountAudit>;
  dismiss: (actor: { id: string; role: "MEMBER" | "MODERATOR" }, id: string, reason: string) => Promise<AccountAudit>;
  substantiate: (actor: { id: string; role: "MEMBER" | "MODERATOR" }, id: string, reason: string) => Promise<AccountAudit>;
  close: (actor: { id: string; role: "MEMBER" | "MODERATOR" }, id: string, plan: string) => Promise<RecalibrationClosure>;
  preview: (
    actor: { id: string; role: "MEMBER" | "MODERATOR" },
    input: ReturnType<typeof cohortQuery>,
  ) => Promise<CalibrationCohortPreview>;
}> = {}) {
  return {
    previewCalibrationCohort: overrides.preview ?? (async () => previewFixture()),
    openAccountAudit: overrides.open ?? (async () => auditFixture()),
    dismissAccountAudit: overrides.dismiss ?? (async () => auditFixture({ state: "DISMISSED" })),
    substantiateAccountAudit: overrides.substantiate ?? (async () => auditFixture({ state: "SUBSTANTIATED" })),
    closeRecalibration:
      overrides.close ??
      (async () => ({
        targetAccountId,
        priorState: "RECALIBRATING" as const,
        targetState: "ACTIVE" as const,
        confirmedPatternCount: 2,
        reactivatedRepositoryCount: 2,
      })),
  };
}

function auditFixture(overrides: Partial<AccountAudit> = {}): AccountAudit {
  return {
    id: auditId,
    targetAccountId,
    repositoryId: "00000000-0000-4000-8000-000000000005",
    state: "OPEN",
    priorState: "ACTIVE",
    targetState: "UNDER_AUDIT",
    confirmedPatternCount: 0,
    cohort: {
      targetAccountId,
      repositoryId: "00000000-0000-4000-8000-000000000005",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
      selfWorkPairs: [],
      outsiderSettlementPairs: [],
      comparison: {
        selfWork: { count: 0, meanDelta: 0, medianDelta: 0 },
        outsider: { count: 0, meanDelta: 0, medianDelta: 0 },
        differenceBetweenMeans: 0,
      },
    },
    ...overrides,
  };
}
