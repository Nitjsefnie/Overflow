import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import {
  AccountModerationService,
  ModerationServiceError,
  type OpenAccountAuditInput,
  type RecalibrationClosure,
} from "@/lib/moderation/service";

const openAccountAuditSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    repositoryId: z.string().uuid().optional(),
    sampleStartedAt: z.string(),
    sampleEndedAt: z.string(),
    reason: z.string(),
  })
  .strict();

const closeRecalibrationSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    plan: z.string().trim().min(1),
  })
  .strict();

export type ModerationRouteSession = {
  user: { id: string; role: UserRole };
};

export type ModerationRouteService = Pick<
  AccountModerationService,
  "openAccountAudit" | "dismissAccountAudit" | "substantiateAccountAudit" | "closeRecalibration"
>;

export type ModerationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  createService: () => Promise<ModerationRouteService>;
};

export function createModerationPostHandler(dependencies: ModerationRouteDependencies) {
  return async function postModeration(request: Request): Promise<Response> {
    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseOpenAccountAuditInput(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const audit = await (await dependencies.createService()).openAccountAudit(session.user, input);
      return Response.json({ audit }, { status: 201 });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export function createModerationClosePatchHandler(dependencies: ModerationRouteDependencies) {
  return async function patchModeration(request: Request): Promise<Response> {
    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseCloseRecalibrationInput(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const recalibration: RecalibrationClosure = await (await dependencies.createService()).closeRecalibration(
        session.user,
        input.targetAccountId,
        input.plan,
      );
      return Response.json({ recalibration });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const POST = createModerationPostHandler({
  getSession: getProductionSession,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

export const PATCH = createModerationClosePatchHandler({
  getSession: getProductionSession,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

async function getProductionSession(): Promise<ModerationRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (
    typeof user?.id !== "string" ||
    (user.role !== "MEMBER" && user.role !== "MODERATOR")
  ) {
    return null;
  }
  return { user: { id: user.id, role: user.role } };
}

async function requiredModeratorSession(
  dependencies: ModerationRouteDependencies,
): Promise<ModerationRouteSession | Response> {
  let session: ModerationRouteSession | null;
  try {
    session = await dependencies.getSession();
  } catch {
    return errorResponse(500, "INTERNAL_ERROR", "Unable to process moderation request.");
  }
  if (session === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }
  if (session.user.role !== "MODERATOR") {
    return errorResponse(403, "FORBIDDEN", "Moderator authorization is required.");
  }
  return session;
}

async function parseOpenAccountAuditInput(request: Request): Promise<OpenAccountAuditInput | null> {
  try {
    const result = openAccountAuditSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function parseCloseRecalibrationInput(
  request: Request,
): Promise<{ targetAccountId: string; plan: string } | null> {
  try {
    const result = closeRecalibrationSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function moderationErrorResponse(error: unknown): Response {
  if (error instanceof ModerationServiceError) {
    switch (error.code) {
      case "FORBIDDEN":
        return errorResponse(403, error.code, "Unable to process moderation request.");
      case "NOT_FOUND":
        return errorResponse(404, error.code, "Unable to process moderation request.");
      case "CONFLICT":
        return errorResponse(409, error.code, "Unable to process moderation request.");
      case "INVALID_INPUT":
      case "INSUFFICIENT_SAMPLES":
        return errorResponse(422, error.code, "Unable to process moderation request.");
    }
  }
  return errorResponse(500, "INTERNAL_ERROR", "Unable to process moderation request.");
}

export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
