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
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The reversal body is one adjustment id plus a reason reasonText() caps at
 * 2000 characters, so 32 KiB bounds the read with wide margin (issue 661).
 */
const MODERATION_REVERSAL_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

const reversalSchema = z
  .object({
    adjustmentId: z.string().uuid(),
    reason: reasonText(),
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
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const reversal = await (await dependencies.createService()).reverseModerationCreditAdjustment(
        session.user,
        input.adjustmentId,
        input.reason,
        session.credential,
      );
      logPrivilegedAction({
        action: "credit-adjustment.reverse",
        actorId: session.user.id,
        credential: session.credential,
        clientAddress: readClientAddress(request),
        subject: {
          adjustmentId: input.adjustmentId,
          reversalId: reversal.id,
          targetAccountId: reversal.targetAccountId,
        },
      });
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

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseReversalInput(
  request: Request,
): Promise<{ adjustmentId: string; reason: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_REVERSAL_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = reversalSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
