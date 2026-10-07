import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  moderationErrorResponse,
  type ModerationRouteDependencies,
} from "@/app/api/moderation/route";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { AccountModerationService } from "@/lib/moderation/service";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The reversal body is one account id plus a reason reasonText() caps at 2000
 * characters; 2000 three-byte UTF-8 characters is ~6 KB, so 8 KiB bounds the
 * read with wide margin (issue 661) and a legitimate max-length reason is
 * never refused as oversize — the same body class the audit decision route
 * reads under 8 KiB.
 */
const MODERATION_REVERSAL_BODY_LIMIT_BYTES = 8 * 1024; // 8 KiB

const reverseBanSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    reason: reasonText(),
  })
  .strict();

/**
 * Reverses a ban (issue 1072): the account returns to ACTIVE, exactly the
 * repositories the sanction flagged are reactivated with the flag cleared, and
 * the moderator's stated reason rides the BANNED → ACTIVE event. The
 * confirmed-pattern count is deliberately untouched — a later substantiated
 * audit re-bans on its own figures.
 */
export function createModerationReversalPatchHandler(dependencies: ModerationRouteDependencies) {
  return async function patchModerationReversal(request: Request): Promise<Response> {
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
      const reversal = await (await dependencies.createService()).reverseBan(
        session.user,
        input.targetAccountId,
        input.reason,
        session.credential,
      );
      logPrivilegedAction({
        action: "ban.reverse",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { targetAccountId: input.targetAccountId },
      });
      return Response.json({ reversal });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const PATCH = createModerationReversalPatchHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
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
): Promise<{ targetAccountId: string; reason: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_REVERSAL_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = reverseBanSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
