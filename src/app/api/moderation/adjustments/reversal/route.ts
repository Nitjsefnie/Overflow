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

const reversalSchema = z
  .object({
    adjustmentId: z.string().uuid(),
    reason: z.string(),
  })
  .strict();

/**
 * Reverses an applied credit adjustment by mirroring it — negative lines, its
 * own moderation event, the original row untouched (issue 330).
 */
export function createModerationReversalPostHandler(dependencies: ModerationCreditRouteDependencies) {
  return async function postModerationReversal(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseReversalInput(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const reversal = await (await dependencies.createService()).reverseModerationCreditAdjustment(
        session.user,
        input.adjustmentId,
        input.reason,
      );
      return Response.json({ reversal }, { status: 201 });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const POST = createModerationReversalPostHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore(), new PostgresRecalibrationCreditStore());
  },
});

async function parseReversalInput(
  request: Request,
): Promise<{ adjustmentId: string; reason: string } | null> {
  try {
    const result = reversalSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
