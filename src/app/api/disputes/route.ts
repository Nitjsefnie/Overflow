import { errorResponse } from "@/lib/http/error-response";
import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { closedPrDisputeErrorResponse } from "@/lib/moderation/closed-pr-dispute-route";
import {
  ClosedPrDisputeService,
  type ClosedPrDisputeFilingInput,
} from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { guardByCredential } from "@/lib/security/route-credential";
import {
  getProductionSession,
  requiredMemberSession,
  type MemberRouteSession,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

const DISPUTES_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

export const closedPrDisputeSchema = z
  .object({
    pullRequestId: z.string().uuid(),
    reason: reasonText(),
    landedPullRequestUrl: z.string().trim().url().optional(),
    landedCommitUrl: z.string().trim().url().optional(),
  })
  .strict();

export type ClosedPrDisputeRouteDependencies = {
  getSession: () => Promise<MemberRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<ClosedPrDisputeServiceShape>;
};

export type ClosedPrDisputeServiceShape = Pick<ClosedPrDisputeService, "fileDispute" | "listDisputes">;

export function createClosedPrDisputePostHandler(dependencies: ClosedPrDisputeRouteDependencies) {
  return async function postClosedPrDispute(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseDisputeRequest(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid closed PR dispute request.");
    }

    try {
      const service = await dependencies.createService();
      const recorded = await service.fileDispute({ id: session.user.id }, input);
      return Response.json({ request: recorded });
    } catch (error) {
      return closedPrDisputeErrorResponse(error);
    }
  };
}

export function createClosedPrDisputeListGetHandler(dependencies: ClosedPrDisputeRouteDependencies) {
  return async function getClosedPrDisputeList(request: Request): Promise<Response> {
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const service = await dependencies.createService();
      return Response.json(await service.listDisputes({ id: session.user.id }));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load your closed PR dispute requests.");
    }
  };
}

async function parseDisputeRequest(
  request: Request,
): Promise<ClosedPrDisputeFilingInput | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, DISPUTES_BODY_LIMIT_BYTES);
    if (raw === null) {
      return "tooLarge";
    }
    const parsed = closedPrDisputeSchema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

const productionDependencies: ClosedPrDisputeRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new ClosedPrDisputeService(new PostgresClosedPrDisputeStore());
  },
};

export const POST = createClosedPrDisputePostHandler(productionDependencies);
export const GET = createClosedPrDisputeListGetHandler(productionDependencies);
