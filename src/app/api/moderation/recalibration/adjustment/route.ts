import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  moderationErrorResponse,
  type ModerationCreditRouteDependencies,
} from "@/app/api/moderation/route";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresRecalibrationCreditStore } from "@/lib/moderation/credit-adjustment-store";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { AccountModerationService } from "@/lib/moderation/service";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

const adjustmentSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    reason: z.string(),
  })
  .strict();

/**
 * Applies the compensating credit adjustment the latest SUBSTANTIATED audit's
 * stored snapshot supports (issue 330).
 */
export function createModerationAdjustmentPostHandler(dependencies: ModerationCreditRouteDependencies) {
  return async function postModerationAdjustment(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseAdjustmentInput(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const adjustment = await (await dependencies.createService()).applyRecalibrationCreditAdjustment(
        session.user,
        input.targetAccountId,
        input.reason,
      );
      return Response.json({ adjustment }, { status: 201 });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const POST = createModerationAdjustmentPostHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore(), new PostgresRecalibrationCreditStore());
  },
});

async function parseAdjustmentInput(
  request: Request,
): Promise<{ targetAccountId: string; reason: string } | null> {
  try {
    const result = adjustmentSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
