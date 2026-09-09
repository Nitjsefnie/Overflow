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
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

const recalibrationQuerySchema = z
  .object({
    targetAccountId: z.string().uuid(),
  })
  .strict();

/**
 * The moderator-facing recalibration figure (issue 330): the trigger verdict
 * over the latest SUBSTANTIATED audit's stored snapshot, beside every credit
 * adjustment already applied to the account.
 */
export function createModerationRecalibrationGetHandler(dependencies: ModerationCreditRouteDependencies) {
  return async function getModerationRecalibration(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the cohort preview:
    // rejectUntrustedRequest refuses a request carrying no Origin header, and a
    // same-origin browser fetch() GET sends none, so guarding this verb would
    // refuse every read the moderation page makes. The gate still resolves a
    // bearer credential from the headers.
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const targetAccountId = parseRecalibrationQuery(request);
    if (targetAccountId === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const preview = await (await dependencies.createService()).previewRecalibration(
        session.user,
        targetAccountId,
      );
      return Response.json({ preview });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const GET = createModerationRecalibrationGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore(), new PostgresRecalibrationCreditStore());
  },
});

function parseRecalibrationQuery(request: Request): string | null {
  const searchParams = new URL(request.url).searchParams;
  for (const name of searchParams.keys()) {
    if (searchParams.getAll(name).length > 1) {
      return null;
    }
  }
  const result = recalibrationQuerySchema.safeParse(Object.fromEntries(searchParams));
  return result.success ? result.data.targetAccountId : null;
}
