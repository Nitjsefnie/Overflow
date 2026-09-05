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
    // rejectUntrustedRequest rejects a missing Origin header, but same-origin browser
    // fetch() GETs send none, so applying it here would reject every moderation-page preview.
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
  const searchParams = new URL(request.url).searchParams;
  for (const name of searchParams.keys()) {
    if (searchParams.getAll(name).length > 1) {
      return null;
    }
  }
  const result = cohortQuerySchema.safeParse(Object.fromEntries(searchParams));
  return result.success ? result.data : null;
}
