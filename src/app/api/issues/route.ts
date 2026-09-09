import {
  listEligibleIssues,
  type EligibleIssueFilters,
  type EligibleIssueProjection,
} from "@/lib/dashboard/queries";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type IssuesRouteDependencies = MemberRouteDependencies & {
  listEligibleIssues: (
    accountId: string,
    filters?: EligibleIssueFilters,
  ) => Promise<EligibleIssueProjection[]>;
};

export function createIssuesGetHandler(dependencies: IssuesRouteDependencies) {
  return async function getIssues(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the moderation cohort
    // preview: a programmatic GET sends no Origin header at all, so guarding it
    // would reject every script client. The member gate still resolves a
    // bearer credential from the headers.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const issues = await dependencies.listEligibleIssues(
        session.user.id,
        parseIssueFilters(request),
      );
      return Response.json(issues);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the eligible issues.");
    }
  };
}

export const GET = createIssuesGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  listEligibleIssues,
});

/**
 * The issues page's own filter parsing, over the URL a request carries:
 * a filter reaches the query only when it names exactly one value, and any
 * claim state the page's select cannot produce falls back to the unclaimed
 * board.
 */
function parseIssueFilters(request: Request): EligibleIssueFilters {
  const searchParams = new URL(request.url).searchParams;
  const repository = singleValue(searchParams, "repository");
  const openingLabel = singleValue(searchParams, "openingLabel");
  const requestedClaimState = singleValue(searchParams, "claimState");
  const claimState =
    requestedClaimState === "CLAIMED" || requestedClaimState === "ALL" ? requestedClaimState : "OPEN";
  return { repository, openingLabel, claimState };
}

function singleValue(searchParams: URLSearchParams, name: string): string | undefined {
  const values = searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}
