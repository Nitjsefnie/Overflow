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
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * Every moderation body is a small JSON document whose free-text fields
 * reasonText() caps at 2000 characters, so 32 KiB bounds the read with wide
 * margin (issue 661).
 */
const MODERATION_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

export const openAccountAuditSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    repositoryId: z.string().uuid().optional(),
    sampleStartedAt: z.string(),
    sampleEndedAt: z.string(),
    reason: reasonText(),
  })
  .strict();

const closeRecalibrationSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    plan: reasonText(),
  })
  .strict();

export type ModerationRouteService = Pick<
  AccountModerationService,
  | "previewCalibrationCohort"
  | "openAccountAudit"
  | "dismissAccountAudit"
  | "substantiateAccountAudit"
  | "closeRecalibration"
  | "reverseBan"
>;

export type ModerationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
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
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const audit = await (await dependencies.createService()).openAccountAudit(
        session.user,
        input,
        session.credential,
      );
      logPrivilegedAction({
        action: "audit.open",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { auditId: audit.id, targetAccountId: input.targetAccountId },
      });
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
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const recalibration: RecalibrationClosure = await (await dependencies.createService()).closeRecalibration(
        session.user,
        input.targetAccountId,
        input.plan,
        session.credential,
      );
      logPrivilegedAction({
        action: "recalibration.close",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { targetAccountId: input.targetAccountId },
      });
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

/**
 * Each helper reads the body through readBodyWithinLimit and parses it with
 * its schema. It returns "tooLarge" when the body crosses the route's limit —
 * the caller answers 413 — and null for an unparsable or schema-invalid body,
 * exactly as request.json()'s rejection did before the bounded reader. A body
 * read that itself fails also keeps the null answer.
 */
async function parseOpenAccountAuditInput(
  request: Request,
): Promise<OpenAccountAuditInput | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = openAccountAuditSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function parseCloseRecalibrationInput(
  request: Request,
): Promise<{ targetAccountId: string; plan: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = closeRecalibrationSchema.safeParse(JSON.parse(body.toString("utf8")));
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
