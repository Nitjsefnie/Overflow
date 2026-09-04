import { describe, expect, it, vi } from "vitest";

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
import { ModerationServiceError, type AccountAudit, type RecalibrationClosure } from "@/lib/moderation/service";

const moderatorSession = { user: { id: "00000000-0000-4000-8000-000000000001", role: "MODERATOR" as const } };
const memberSession = { user: { id: "00000000-0000-4000-8000-000000000002", role: "MEMBER" as const } };
const targetAccountId = "00000000-0000-4000-8000-000000000003";
const auditId = "00000000-0000-4000-8000-000000000004";

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

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://overflow.example/api/moderation", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
}> = {}) {
  return {
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
