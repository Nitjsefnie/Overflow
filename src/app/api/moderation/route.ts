import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { requiredModeratorSession, type ModerationRouteSession } from "@/lib/moderation/route-auth";
import {
  AccountModerationService,
  ModerationServiceError,
  type OpenAccountAuditInput,
  type RecalibrationClosure,
} from "@/lib/moderation/service";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

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

export type ModerationRouteService = Pick<
  AccountModerationService,
  | "previewCalibrationCohort"
  | "openAccountAudit"
  | "dismissAccountAudit"
  | "substantiateAccountAudit"
  | "closeRecalibration"
>;

export type ModerationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<ModerationRouteService>;
};

/**
 * The service surface the recalibration credit-adjustment routes call (issue
 * 330). These methods run only on a service constructed with the credit store
 * (the optional second constructor argument) — a requirement a Pick cannot
 * express — so the routes that call them take this narrower dependency type
 * and build both constructor arguments in their own dependency objects,
 * instead of sharing the close route's.
 */
export type ModerationCreditRouteService = Pick<
  AccountModerationService,
  "previewRecalibration" | "applyRecalibrationCreditAdjustment" | "reverseModerationCreditAdjustment"
>;

export type ModerationCreditRouteDependencies = Omit<ModerationRouteDependencies, "createService"> & {
  createService: () => Promise<ModerationCreditRouteService>;
};

export function createModerationPostHandler(dependencies: ModerationRouteDependencies) {
  return async function postModeration(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
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
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
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
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

export const PATCH = createModerationClosePatchHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

export async function getProductionSession(): Promise<ModerationRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    return null;
  }
  return { user: { id: user.id } };
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
