import { SanctionContestError } from "@/lib/moderation/sanction-contest-service";
import { errorResponse } from "@/lib/security/member-route-auth";

/**
 * Maps a sanction-contest failure onto the member routes' shared error
 * envelope, for every route that serves the disputes framework's sanction
 * case. It lives beside the service rather than inside either route so no
 * route imports another route: the mapping is one shared behavior with one
 * spelling, and a route module stays handler-only.
 */
export function sanctionContestErrorResponse(error: unknown): Response {
  if (!(error instanceof SanctionContestError)) {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to complete the sanction contest request.");
  }
  switch (error.code) {
    case "NOT_FOUND":
      return errorResponse(404, error.code, error.message);
    case "CONFLICT":
      return errorResponse(409, error.code, error.message);
    case "FORBIDDEN":
      // The deciding-moderator rule: the imposer may not decide while another
      // moderator can. Same status the moderator gate refuses a non-moderator
      // with, different message — the rule it names is the disputes rule.
      return errorResponse(403, error.code, error.message);
    default:
      return errorResponse(422, error.code, error.message);
  }
}
