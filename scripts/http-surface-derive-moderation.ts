import { createModerationClosePatchHandler, createModerationPostHandler } from "../src/app/api/moderation/route.ts";
import { createModerationAuditsGetHandler } from "../src/app/api/moderation/audits/route.ts";
import { createModerationUnwritableClosuresGetHandler } from "../src/app/api/moderation/unwritable-closures/route.ts";
import { createModerationCohortGetHandler } from "../src/app/api/moderation/cohort/route.ts";
import { createModerationRecalibrationGetHandler } from "../src/app/api/moderation/recalibration/route.ts";
import {
  createRederivationGetHandler,
  createRederivationPostHandler,
} from "../src/app/api/moderation/rederivation/route.ts";
import {
  createModeratorGetHandler,
  createModeratorPostHandler,
} from "../src/app/api/moderation/moderators/route.ts";
import { createModerationAuditPatchHandler } from "../src/app/api/moderation/[id]/route.ts";
import { createModerationAdjustmentPostHandler } from "../src/app/api/moderation/recalibration/adjustment/route.ts";
import { createModerationReversalPostHandler } from "../src/app/api/moderation/adjustments/reversal/route.ts";
import {
  createSettlementOverrideListGetHandler,
  createSettlementOverridePostHandler,
} from "../src/app/api/overrides/route.ts";
import { createSettlementOverridePatchHandler } from "../src/app/api/overrides/[id]/route.ts";
import {
  bodyShape,
  memberRequest,
  mutationRequest,
  withAppUrl,
  type HttpShape,
} from "./http-surface-derive.ts";
import {
  fixtureAdjustmentInput,
  fixtureAuditActionInput,
  fixtureAuditId,
  fixtureCloseRecalibrationInput,
  fixtureModerationAuditsRouteDependencies,
  fixtureModerationCreditRouteDependencies,
  fixtureModerationRouteDependencies,
  fixtureModerationUnwritableClosuresRouteDependencies,
  fixtureModeratorRouteDependencies,
  fixtureOverrideDecisionInput,
  fixtureOverrideDecisionRouteDependencies,
  fixtureOverrideInput,
  fixtureOverrideListRouteDependencies,
  fixtureOverrideRequestId,
  fixtureOverrideRouteDependencies,
  fixtureOpenAuditInput,
  fixtureRederivationInput,
  fixtureRederivationRouteDependencies,
  fixtureReversalInput,
  fixtureTargetId,
} from "./http-surface-fixtures.ts";

export async function deriveGetModerationAudits(): Promise<HttpShape> {
  return bodyShape(
    await createModerationAuditsGetHandler(fixtureModerationAuditsRouteDependencies())(
      memberRequest("/api/moderation/audits"),
    ),
  );
}

export async function deriveGetModerationUnwritableClosures(): Promise<HttpShape> {
  return bodyShape(
    await createModerationUnwritableClosuresGetHandler(
      fixtureModerationUnwritableClosuresRouteDependencies(),
    )(memberRequest("/api/moderation/unwritable-closures")),
  );
}

export async function deriveGetModerationCohort(): Promise<HttpShape> {
  const query = new URLSearchParams({
    targetAccountId: fixtureTargetId,
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
  });
  return bodyShape(
    await createModerationCohortGetHandler(fixtureModerationRouteDependencies())(
      memberRequest(`/api/moderation/cohort?${query}`),
    ),
  );
}

export async function deriveGetModerationRecalibration(): Promise<HttpShape> {
  const query = new URLSearchParams({ targetAccountId: fixtureTargetId });
  return bodyShape(
    await createModerationRecalibrationGetHandler(fixtureModerationCreditRouteDependencies())(
      memberRequest(`/api/moderation/recalibration?${query}`),
    ),
  );
}

export async function deriveGetRederivation(): Promise<HttpShape> {
  return bodyShape(
    await createRederivationGetHandler(fixtureRederivationRouteDependencies())(
      memberRequest("/api/moderation/rederivation"),
    ),
  );
}

export async function deriveGetModerators(): Promise<HttpShape> {
  return bodyShape(
    await createModeratorGetHandler(fixtureModeratorRouteDependencies())(
      memberRequest("/api/moderation/moderators"),
    ),
  );
}

export async function derivePostModerators(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModeratorPostHandler(fixtureModeratorRouteDependencies())(
        mutationRequest("/api/moderation/moderators", "POST", {
          targetAccountId: fixtureTargetId,
          moderator: true,
        }),
      ),
    ),
  );
}

export async function derivePostModeration(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModerationPostHandler(fixtureModerationRouteDependencies())(
        mutationRequest("/api/moderation", "POST", fixtureOpenAuditInput),
      ),
    ),
  );
}

export async function derivePatchModerationAudit(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModerationAuditPatchHandler(fixtureModerationRouteDependencies())(
        mutationRequest(`/api/moderation/${fixtureAuditId}`, "PATCH", fixtureAuditActionInput),
        { params: Promise.resolve({ id: fixtureAuditId }) },
      ),
    ),
  );
}

export async function derivePatchModerationClose(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModerationClosePatchHandler(fixtureModerationRouteDependencies())(
        mutationRequest("/api/moderation", "PATCH", fixtureCloseRecalibrationInput),
      ),
    ),
  );
}

export async function derivePostModerationAdjustment(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModerationAdjustmentPostHandler(fixtureModerationCreditRouteDependencies())(
        mutationRequest("/api/moderation/recalibration/adjustment", "POST", fixtureAdjustmentInput),
      ),
    ),
  );
}

export async function derivePostModerationReversal(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createModerationReversalPostHandler(fixtureModerationCreditRouteDependencies())(
        mutationRequest("/api/moderation/adjustments/reversal", "POST", fixtureReversalInput),
      ),
    ),
  );
}

export async function derivePostRederivation(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createRederivationPostHandler(fixtureRederivationRouteDependencies())(
        mutationRequest("/api/moderation/rederivation", "POST", fixtureRederivationInput),
      ),
    ),
  );
}

export async function derivePostOverride(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createSettlementOverridePostHandler(fixtureOverrideRouteDependencies())(
        mutationRequest("/api/overrides", "POST", fixtureOverrideInput),
      ),
    ),
  );
}

export async function deriveGetOverrides(): Promise<HttpShape> {
  return bodyShape(
    await createSettlementOverrideListGetHandler(fixtureOverrideListRouteDependencies())(
      memberRequest("/api/overrides"),
    ),
  );
}

export async function derivePatchOverride(): Promise<HttpShape> {
  return withAppUrl(async () =>
    bodyShape(
      await createSettlementOverridePatchHandler(fixtureOverrideDecisionRouteDependencies())(
        mutationRequest(`/api/overrides/${fixtureOverrideRequestId}`, "PATCH", fixtureOverrideDecisionInput),
        { params: Promise.resolve({ id: fixtureOverrideRequestId }) },
      ),
    ),
  );
}

/**
 * The moderation and override routes' shapes (issue 912, task 3), keyed
 * "METHOD /path" in the spelling API.md documents dynamic segments with
 * (<id> for [id]). The derivation is split off
 * scripts/http-surface-derive.ts because that module's tooling ceiling
 * (800 lines) has no room for sixteen more per-route functions; the record
 * this returns is spread into deriveHttpSurfaceShapes, and the stubs live in
 * scripts/http-surface-fixtures.ts like every other route's.
 */
export async function moderationSurfaceShapes(): Promise<Record<string, HttpShape>> {
  return {
    "GET /api/moderation/audits": await deriveGetModerationAudits(),
    "GET /api/moderation/unwritable-closures": await deriveGetModerationUnwritableClosures(),
    "GET /api/moderation/cohort": await deriveGetModerationCohort(),
    "GET /api/moderation/recalibration": await deriveGetModerationRecalibration(),
    "GET /api/moderation/rederivation": await deriveGetRederivation(),
    "GET /api/moderation/moderators": await deriveGetModerators(),
    "POST /api/moderation/moderators": await derivePostModerators(),
    "POST /api/moderation": await derivePostModeration(),
    "PATCH /api/moderation/<id>": await derivePatchModerationAudit(),
    "PATCH /api/moderation": await derivePatchModerationClose(),
    "POST /api/moderation/recalibration/adjustment": await derivePostModerationAdjustment(),
    "POST /api/moderation/adjustments/reversal": await derivePostModerationReversal(),
    "POST /api/moderation/rederivation": await derivePostRederivation(),
    "POST /api/overrides": await derivePostOverride(),
    "GET /api/overrides": await deriveGetOverrides(),
    "PATCH /api/overrides/<id>": await derivePatchOverride(),
  };
}
