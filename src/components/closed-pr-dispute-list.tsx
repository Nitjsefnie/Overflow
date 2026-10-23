import { ClosedPrDisputeComparisonView } from "@/components/closed-pr-dispute-comparison";
import { ClosedPrDisputeDecisionControl } from "@/components/closed-pr-dispute-decision";
import { formatInstant } from "@/lib/format-instant";
import type { ClosedPrDisputeRequest } from "@/lib/moderation/closed-pr-dispute-service";

export function ClosedPrDisputeList({ requests, moderation = false }: {
  requests: readonly ClosedPrDisputeRequest[];
  moderation?: boolean;
}) {
  if (requests.length === 0) return <p className="mono-meta">No closed PR disputes are recorded.</p>;
  return (
    <ol className="override-history" aria-label={moderation ? "Closed PR dispute queue and history" : "Your closed PR disputes"}>
      {requests.map((request) => (
        <li key={request.id}>
          <p className="override-state">{request.state === "OPEN" ? "Open — still with a moderator" : `Decided — ${request.decision}`}</p>
          <p>Closed PR: {request.pullRequestId} · issue: {request.issueId}</p>
          {moderation ? <p>Contributor: {request.contributorId}</p> : null}
          <p>Filed {formatInstant(request.createdAt)}: “{request.requestReason}”</p>
          {moderation && request.comparison ? <ClosedPrDisputeComparisonView comparison={request.comparison} landingAccount={request.landedCommitAuthorId} /> : <p>Landed evidence: {request.landedPullRequestId ?? request.landedCommitUrl ?? "not recorded"}</p>}
          {request.decidedReason === null ? null : (
            <p className="mono-meta">
              Decided {request.decidedAt === null ? "at an unknown time" : formatInstant(request.decidedAt)}: “{request.decidedReason}”
              {request.decidedBySoleModerator ? " — decided by the sole moderator" : ""}
            </p>
          )}
          {request.moderatorFigure === null ? null : <p>Figure: {request.moderatorFigure} · Awarded points: {request.awardedPoints}</p>}
          {moderation && request.state === "OPEN" ? <ClosedPrDisputeDecisionControl requestId={request.id} /> : null}
        </li>
      ))}
    </ol>
  );
}
