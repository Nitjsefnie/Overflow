import { z } from "zod";
import {
  errorResponse,
  moderationErrorResponse,
  type ModerationRouteDependencies,
  type ModerationRouteSession,
} from "@/app/api/moderation/route";
import { AccountModerationService } from "@/lib/moderation/service";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";

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
    const session = await requiredModeratorSession(dependencies);
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
  try {
    const session = await dependencies.getSession();
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    if (session.user.role !== "MODERATOR") {
      return errorResponse(403, "FORBIDDEN", "Moderator authorization is required.");
    }
    return session;
  } catch {
    return errorResponse(500, "INTERNAL_ERROR", "Unable to process moderation request.");
  }
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
