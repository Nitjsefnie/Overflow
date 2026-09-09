import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createModerationAuditsGetHandler,
  type ModerationAuditsRouteDependencies,
} from "@/app/api/moderation/audits/route";
import type { OpenAuditProjection } from "@/lib/dashboard/queries";

const moderatorId = "00000000-0000-4000-8000-000000000004";

const plainOpenAudit: OpenAuditProjection = {
  id: "00000000-0000-4000-8000-00000000000a",
  targetAccountId: "00000000-0000-4000-8000-000000000001",
  targetLogin: "target-user",
  reporterLogin: "reporter-user",
  repositoryName: "octo/overflow",
  openedAt: "2026-09-01T00:00:00.000Z",
  settledSampleSize: 24,
  differenceBetweenMeans: 1,
};

const detailedOpenAudit: OpenAuditProjection = {
  id: "00000000-0000-4000-8000-00000000000b",
  targetAccountId: "00000000-0000-4000-8000-000000000002",
  targetLogin: "other-target-user",
  reporterLogin: "other-reporter-user",
  repositoryName: null,
  openedAt: "2026-09-02T00:00:00.000Z",
  settledSampleSize: 30,
  differenceBetweenMeans: -1,
  state: "OPEN",
  priorEnforcementState: "CLEAN",
  sampleStartedAt: "2026-09-02T00:00:00.000Z",
  sampleEndedAt: "2026-09-09T00:00:00.000Z",
  cohortDefinition: { minimumSampleSize: 24 },
  cohortStatistics: { differenceBetweenMeans: -1 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the audit query is a mock on the injected
 * dependencies, so each case drives the moderator gate against the read.
 */
type ModerationAuditsDependencyMocks = {
  [K in keyof ModerationAuditsRouteDependencies]: Mock;
};

function auditsDependencies(overrides: Partial<ModerationAuditsDependencyMocks> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: moderatorId, role: "MODERATOR" } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    listOpenAudits: vi.fn().mockResolvedValue([plainOpenAudit, detailedOpenAudit]),
    ...overrides,
  };
}

function auditsRequest(): Request {
  return new Request("https://overflow.example/api/moderation/audits");
}

describe("GET /api/moderation/audits", () => {
  it("answers an anonymous request with the 401 sign-in refusal, before the query runs", async () => {
    const dependencies = auditsDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createModerationAuditsGetHandler(dependencies)(auditsRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.listOpenAudits).not.toHaveBeenCalled();
  });

  it("answers a member whose database role is not moderator with the 403 refusal, before the query runs", async () => {
    const dependencies = auditsDependencies({
      getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    });

    const response = await createModerationAuditsGetHandler(dependencies)(auditsRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
    expect(dependencies.listOpenAudits).not.toHaveBeenCalled();
  });

  it("answers a moderation-queue read failure with the route's 502 upstream refusal", async () => {
    const dependencies = auditsDependencies({
      listOpenAudits: vi.fn().mockRejectedValue(new Error("ledger outage")),
    });

    const response = await createModerationAuditsGetHandler(dependencies)(auditsRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the moderation queue." },
    });
  });

  it("answers 200 with the open audits the query returned", async () => {
    const dependencies = auditsDependencies();

    const response = await createModerationAuditsGetHandler(dependencies)(auditsRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([plainOpenAudit, detailedOpenAudit]);
    expect(dependencies.listOpenAudits).toHaveBeenCalledExactlyOnceWith();
  });
});
