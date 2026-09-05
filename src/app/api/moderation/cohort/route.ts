import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  moderationErrorResponse,
  requiredModeratorSession,
  type ModerationRouteDependencies,
} from "@/app/api/moderation/route";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { AccountModerationService, type OpenAccountAuditInput } from "@/lib/moderation/service";

const cohortQuerySchema = z
  .object({
    targetAccountId: z.string().uuid(),
    repositoryId: z.string().uuid().optional(),
    sampleStartedAt: z.string(),
    sampleEndedAt: z.string(),
  })
  .strict();

export function createModerationCohortGetHandler(dependencies: ModerationRouteDependencies) {
  return async function getModerationCohort(request: Request): Promise<Response> {
    // No origin guard: a preview only reads, exactly like the moderators listing.
    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = parseCohortQuery(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const preview = await (await dependencies.createService()).previewCalibrationCohort(session.user, input);
      return Response.json({ preview });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const GET = createModerationCohortGetHandler({
  getSession: getProductionSession,
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

function parseCohortQuery(request: Request): Omit<OpenAccountAuditInput, "reason"> | null {
  const result = cohortQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  return result.success ? result.data : null;
}
