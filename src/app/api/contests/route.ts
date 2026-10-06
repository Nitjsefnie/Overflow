import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { sanctionContestErrorResponse } from "@/lib/moderation/sanction-contest-route";
import {
  SanctionContestService,
  type SanctionContestRequest,
} from "@/lib/moderation/sanction-contest-service";
import { PostgresSanctionContestStore } from "@/lib/moderation/sanction-contest-store";
import { guardByCredential } from "@/lib/security/route-credential";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteSession,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The filing body is one event id plus a reason reasonText() caps at 2000
 * characters, so 32 KiB bounds the read with wide margin (issue 661).
 */
const CONTESTS_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

// Strict, so a body carrying anything beyond the event id and the reason
// matches nothing.
export const sanctionContestSchema = z
  .object({
    sanctionEventId: z.string().uuid(),
    reason: reasonText(),
  })
  .strict();


export type SanctionContestRouteDependencies = {
  getSession: () => Promise<MemberRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<SanctionContestServiceShape>;
};

/**
 * The slice of the service the routes use, so a test's fake can carry one
 * method without the other.
 */
export type SanctionContestServiceShape = {
  fileSanctionContest(
    account: { id: string },
    input: { sanctionEventId: string; reason: string },
  ): Promise<SanctionContestRequest>;
  listContests(account: { id: string }): Promise<SanctionContestRequest[]>;
};

export function createSanctionContestPostHandler(dependencies: SanctionContestRouteDependencies) {
  return async function postSanctionContest(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseContestRequest(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid sanction contest request.");
    }

    try {
      const service = await dependencies.createService();
      const recorded = await service.fileSanctionContest({ id: session.user.id }, input);
      return Response.json({ request: recorded });
    } catch (error) {
      return sanctionContestErrorResponse(error);
    }
  };
}

export function createSanctionContestListGetHandler(dependencies: SanctionContestRouteDependencies) {
  return async function getSanctionContestList(request: Request): Promise<Response> {
    // Unorigin-guarded like the settlement-corrections read: a programmatic
    // GET sends no Origin header, and this read is same-account by
    // construction — the session it resolves is the only account it reads.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const service = await dependencies.createService();
      return Response.json(await service.listContests({ id: session.user.id }));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load your sanction contest requests.");
    }
  };
}

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema:
 * "tooLarge" when the body crosses the route's limit (the caller answers 413),
 * null for an unparsable or schema-invalid body, mirroring the overrides
 * route's reader.
 */
async function parseContestRequest(
  request: Request,
): Promise<{ sanctionEventId: string; reason: string } | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, CONTESTS_BODY_LIMIT_BYTES);
    if (raw === null) {
      return "tooLarge";
    }
    const parsed = sanctionContestSchema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!parsed.success) {
      return null;
    }
    return { sanctionEventId: parsed.data.sanctionEventId, reason: parsed.data.reason };
  } catch {
    return null;
  }
}

export const POST = createSanctionContestPostHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SanctionContestService(new PostgresSanctionContestStore());
  },
});

export const GET = createSanctionContestListGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SanctionContestService(new PostgresSanctionContestStore());
  },
});
