import { z } from "zod";
import {
  errorResponse,
  moderationErrorResponse,
  type ModerationRouteDependencies,
} from "@/app/api/moderation/route";
import { requiredModeratorSession, type ModerationRouteSession } from "@/lib/moderation/route-auth";
import { AccountModerationService } from "@/lib/moderation/service";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The audit body carries one reason capped at 2000 characters by reasonText();
 * 2000 three-byte UTF-8 characters is ~6 KB, so the limit is 8 KiB rather than
 * the 4 KiB the small single-field bodies get, and a legitimate max-length
 * reason is never refused as oversize (issue 661).
 */
const MODERATION_AUDIT_BODY_LIMIT_BYTES = 8 * 1024; // 8 KiB

export const auditActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dismiss"), reason: reasonText() }).strict(),
  z.object({ action: z.literal("substantiate"), reason: reasonText() }).strict(),
]);

export type ModerationAuditRouteContext = {
  params: Promise<{ id: string }>;
};

export function createModerationAuditPatchHandler(dependencies: ModerationRouteDependencies) {
  return async function patchModerationAudit(
    request: Request,
    context: ModerationAuditRouteContext,
  ): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const auditId = await readAuditId(context);
    if (auditId === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }
    const input = await parseAuditAction(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const service = await dependencies.createService();
      const audit =
        input.action === "dismiss"
          ? await service.dismissAccountAudit(session.user, auditId, input.reason, session.credential)
          : await service.substantiateAccountAudit(session.user, auditId, input.reason, session.credential);
      logPrivilegedAction({
        action: input.action === "dismiss" ? "audit.dismiss" : "audit.substantiate",
        actorId: session.user.id,
        credential: session.credential,
        clientAddress: readClientAddress(request),
        subject: { auditId, targetAccountId: audit.targetAccountId },
      });
      return Response.json({ audit });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export const PATCH = createModerationAuditPatchHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
});

async function getProductionSession(): Promise<ModerationRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    return null;
  }
  return { user: { id: user.id } };
}

async function readAuditId(context: ModerationAuditRouteContext): Promise<string | null> {
  try {
    const id = (await context.params).id;
    return z.string().uuid().safeParse(id).success ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseAuditAction(
  request: Request,
): Promise<{ action: "dismiss" | "substantiate"; reason: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, MODERATION_AUDIT_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = auditActionSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
