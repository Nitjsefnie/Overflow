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
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

const auditActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dismiss"), reason: z.string() }).strict(),
  z.object({ action: z.literal("substantiate"), reason: z.string() }).strict(),
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
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderation request.");
    }

    try {
      const service = await dependencies.createService();
      const audit =
        input.action === "dismiss"
          ? await service.dismissAccountAudit(session.user, auditId, input.reason)
          : await service.substantiateAccountAudit(session.user, auditId, input.reason);
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

async function parseAuditAction(
  request: Request,
): Promise<{ action: "dismiss" | "substantiate"; reason: string } | null> {
  try {
    const result = auditActionSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
