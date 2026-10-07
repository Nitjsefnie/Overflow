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
 * The adjustment body is one account id plus a reason reasonText() caps at
 * 2000 characters, so 32 KiB bounds the read with wide margin (issue 661).
 */
const MODERATION_ADJUSTMENT_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

const adjustmentSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    // The service's normalizer stays the blank-reason authority for this
    // field, exactly as before the cap: a blank reason still reaches it for
    // its structured INVALID_INPUT answer, while the length cap is enforced
    // here, on the trimmed value, before any service work.
    reason: reasonText({ allowBlank: true }),
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
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const adjustment = await (await dependencies.createService()).applyRecalibrationCreditAdjustment(
        session.user,
        input.targetAccountId,
        input.reason,
        session.credential,
      );
      logPrivilegedAction({
        action: "credit-adjustment.create",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { adjustmentId: adjustment.id, targetAccountId: input.targetAccountId },
      });
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

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseAdjustmentInput(
  request: Request,
): Promise<{ targetAccountId: string; reason: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_ADJUSTMENT_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = adjustmentSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
