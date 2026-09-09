import {
  getSettlementProof,
  type SettlementProofProjection,
} from "@/lib/dashboard/queries";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideService,
  type SettlementOverrideRequest,
} from "@/lib/overrides/service";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

/**
 * The correction requests already raised against the settlement, as the
 * settlement page reads them. Null means the history could not be read.
 */
export type SettlementCorrectionsService = {
  listRequestsForSettlement(
    viewer: { id: string },
    settlementId: string,
  ): Promise<SettlementOverrideRequest[]>;
};

export type SettlementProofRouteDependencies = MemberRouteDependencies & {
  getSettlementProof: (
    accountId: string,
    settlementId: string,
  ) => Promise<SettlementProofProjection | null>;
  createCorrectionsService: () => Promise<SettlementCorrectionsService>;
};

type SettlementProofRouteContext = {
  params: Promise<{ id: string }>;
};

export function createSettlementProofGetHandler(dependencies: SettlementProofRouteDependencies) {
  return async function getSettlementProof(request: Request, context: SettlementProofRouteContext): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the issues board: a
    // programmatic GET sends no Origin header at all, so guarding it would
    // reject every script client. The member gate still resolves a bearer
    // credential from the headers.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const { id: settlementId } = await context.params;

    let settlement: SettlementProofProjection | null;
    try {
      settlement = await dependencies.getSettlementProof(session.user.id, settlementId);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the settlement proof.");
    }
    if (settlement === null) {
      // The query only returns settlements the viewer is a party to, so an
      // unknown id and someone else's settlement are the same refusal, and the
      // corrections of a settlement the viewer cannot see are never read.
      return errorResponse(404, "NOT_FOUND", "Settlement proof is not available.");
    }

    let corrections: SettlementOverrideRequest[] | null;
    try {
      const service = await dependencies.createCorrectionsService();
      corrections = await service.listRequestsForSettlement({ id: session.user.id }, settlement.id);
    } catch {
      // The proof is still answerable when the correction history is not: the
      // settlement page renders the same degradation.
      corrections = null;
    }

    return Response.json({ settlement, corrections });
  };
}

export const GET = createSettlementProofGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  getSettlementProof,
  async createCorrectionsService() {
    return new SettlementOverrideService(new PostgresSettlementOverrideStore());
  },
});
