import { errorResponse } from "@/lib/http/error-response";
import { ClosedPrDisputeError } from "@/lib/moderation/closed-pr-dispute-service";

export function closedPrDisputeErrorResponse(error: unknown): Response {
  if (!(error instanceof ClosedPrDisputeError)) {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to complete the closed PR dispute request.");
  }
  // Literal status/code pairs keep the HTTP failure derivation auditable.
  switch (error.code) {
    case "FORBIDDEN": return errorResponse(403, "FORBIDDEN", error.message);
    case "ALREADY_GRANTED": return errorResponse(409, "ALREADY_GRANTED", error.message);
    case "CONFLICT": return errorResponse(409, "CONFLICT", error.message);
    case "INVALID_INPUT": return errorResponse(422, "INVALID_INPUT", error.message);
    case "NOT_FOUND": return errorResponse(404, "NOT_FOUND", error.message);
    case "INSUFFICIENT_EVIDENCE": return errorResponse(422, "INSUFFICIENT_EVIDENCE", error.message);
  }
}
