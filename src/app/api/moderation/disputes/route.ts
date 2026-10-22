import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { errorResponse } from "@/lib/http/error-response";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { closedPrDisputeErrorResponse } from "@/lib/moderation/closed-pr-dispute-route";
import { ClosedPrDisputeService } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { requiredModeratorSession, type ModerationRouteSession } from "@/lib/moderation/route-auth";
import { guardByCredential } from "@/lib/security/route-credential";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { reasonText } from "@/lib/validation/reason";

const MODERATION_DISPUTES_BODY_LIMIT_BYTES = 32 * 1024;
const decisionSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["GRANTED", "DENIED"]),
  figure: z.number().int().min(1).max(10).optional(),
  reason: reasonText(),
}).strict().refine((input) => input.decision !== "GRANTED" || input.figure !== undefined);

export type ClosedPrDisputeModerationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<Pick<ClosedPrDisputeService, "decideDispute" | "listDisputes">>;
};

export function createClosedPrDisputeDecisionPostHandler(dependencies: ClosedPrDisputeModerationRouteDependencies) {
  return async function postClosedPrDisputeDecision(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) return refusal;
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) return session;
    const input = await parseDecisionInput(request);
    if (input === "tooLarge") return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    if (input === null) return errorResponse(422, "INVALID_REQUEST", "Invalid closed PR dispute decision.");
    try {
      const service = await dependencies.createService();
      const recorded = await service.decideDispute(input.requestId, { id: session.user.id }, {
        decision: input.decision, figure: input.figure, decidedReason: input.reason,
      });
      logPrivilegedAction({
        action: "closed_pr.dispute.decide",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { requestId: input.requestId, accountId: recorded.contributorId },
      });
      return Response.json({ request: recorded });
    } catch (error) {
      return closedPrDisputeErrorResponse(error);
    }
  };
}

export function createClosedPrDisputeQueueGetHandler(dependencies: ClosedPrDisputeModerationRouteDependencies) {
  return async function getClosedPrDisputeQueue(request: Request): Promise<Response> {
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) return session;
    try {
      return Response.json(await (await dependencies.createService()).listDisputes());
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the closed PR dispute queue.");
    }
  };
}

async function parseDecisionInput(request: Request): Promise<z.infer<typeof decisionSchema> | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, MODERATION_DISPUTES_BODY_LIMIT_BYTES);
    if (raw === null) return "tooLarge";
    const parsed = decisionSchema.safeParse(JSON.parse(raw.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const productionDependencies: ClosedPrDisputeModerationRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new ClosedPrDisputeService(new PostgresClosedPrDisputeStore());
  },
};
export const POST = createClosedPrDisputeDecisionPostHandler(productionDependencies);
export const GET = createClosedPrDisputeQueueGetHandler(productionDependencies);

async function getProductionSession(): Promise<ModerationRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string") return null;
  return { user: { id: user.id } };
}
