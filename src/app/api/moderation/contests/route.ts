import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { requiredModeratorSession, type ModerationRouteSession } from "@/lib/moderation/route-auth";
import {
  SanctionContestService,
  type OpenContestRequestProjection,
} from "@/lib/moderation/sanction-contest-service";
import { PostgresSanctionContestStore } from "@/lib/moderation/sanction-contest-store";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";
import { sanctionContestErrorResponse } from "@/lib/moderation/sanction-contest-route";

/**
 * The decision body is one request id, the outcome and a reason reasonText()
 * caps at 2000 characters, so 32 KiB bounds the read with wide margin (issue
 * 661).
 */
const MODERATION_CONTESTS_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

// Strict, so a body carrying anything beyond the request id, the decision and
// the reason matches nothing.
const decisionSchema = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(["GRANTED", "DENIED"]),
    reason: reasonText(),
  })
  .strict();

export type SanctionContestModerationRouteService = Pick<
  SanctionContestService,
  "decideContest" | "listOpenContests"
>;

export type SanctionContestModerationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<SanctionContestModerationRouteService>;
};

/**
 * The moderator's decision route for the disputes framework's sanction case
 * (issue 1125): a moderator records GRANTED or DENIED — with a reason — on an
 * OPEN contest request, and reads the OPEN queue the moderation page renders.
 *
 * The not-the-imposing-moderator rule is NOT this route's: it is enforced in
 * the store's transaction, against the database, where the imposer and the
 * live moderator roster are read together. Here a refusal arrives as
 * SanctionContestError("FORBIDDEN") and maps onto the same 403 the moderator
 * gate answers with.
 */
export function createSanctionContestDecisionPostHandler(
  dependencies: SanctionContestModerationRouteDependencies,
) {
  return async function postSanctionContestDecision(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseDecisionInput(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid sanction contest decision.");
    }

    try {
      const service = await dependencies.createService();
      const decided = await service.decideContest({ id: session.user.id }, input);
      logPrivilegedAction({
        action: "sanction.contest.decide",
        actorId: session.user.id,
        credential: session.credential,
        clientAddress: readClientAddress(request),
        subject: { requestId: input.requestId, accountId: decided.accountId },
      });
      return Response.json({ request: decided });
    } catch (error) {
      return sanctionContestErrorResponse(error);
    }
  };
}

/**
 * The moderation queue's read: every OPEN contest request, oldest first.
 * Unorigin-guarded like the other moderator GET reads: a programmatic GET
 * sends no Origin header, and the moderator gate authorizes this read the
 * same way it authorizes every moderation route.
 */
export function createSanctionContestQueueGetHandler(
  dependencies: SanctionContestModerationRouteDependencies,
) {
  return async function getSanctionContestQueue(request: Request): Promise<Response> {
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const contests: OpenContestRequestProjection[] = await (await dependencies.createService()).listOpenContests();
      return Response.json(contests);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the sanction contest queue.");
    }
  };
}

export type SanctionContestDecisionInput = { requestId: string; decision: "GRANTED" | "DENIED"; reason: string };

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema:
 * "tooLarge" when the body crosses the route's limit (the caller answers 413),
 * null for an unparsable or schema-invalid body, exactly as the moderation
 * routes' shared readers do.
 */
async function parseDecisionInput(
  request: Request,
): Promise<SanctionContestDecisionInput | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, MODERATION_CONTESTS_BODY_LIMIT_BYTES);
    if (raw === null) {
      return "tooLarge";
    }
    const parsed = decisionSchema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

// One dependency set for both exports: the two handlers take the same shape,
// and carrying two copies invited an edit to one that left the other behind
// (a store or session wiring changed on POST but not on GET).
const productionDependencies: SanctionContestModerationRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SanctionContestService(new PostgresSanctionContestStore());
  },
};

export const POST = createSanctionContestDecisionPostHandler(productionDependencies);

export const GET = createSanctionContestQueueGetHandler(productionDependencies);

async function getProductionSession(): Promise<ModerationRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    return null;
  }
  return { user: { id: user.id } };
}
