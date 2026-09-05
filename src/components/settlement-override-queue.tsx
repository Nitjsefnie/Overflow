import { SettlementOverrideDecision } from "@/components/settlement-override-decision";
import type { OpenSettlementOverrideRequest } from "@/lib/overrides/service";

type SettlementOverrideQueueProps = {
  requests: readonly OpenSettlementOverrideRequest[];
};

/**
 * Settlement corrections awaiting a decision, each shown with the evidence the
 * settlement was built from: the issue, the closing pull request, what the
 * ledger settled it at, and the review rounds that were deducted.
 */
export function SettlementOverrideQueue({ requests }: SettlementOverrideQueueProps) {
  if (requests.length === 0) {
    return <p>No settlement corrections are waiting.</p>;
  }

  return (
    <ol className="override-queue">
      {requests.map((request) => (
        <li key={request.id}>
          <p>
            <strong>{request.requesterLogin}</strong> · {request.repositoryName} · reported {request.requestedAt}
          </p>
          <p>
            <a href={request.issueUrl}>
              #{request.issueNumber} {request.issueTitle}
            </a>
          </p>
          <p className="override-reason">“{request.reason}”</p>
          {request.settlement === null ? (
            <p className="mono-meta">The settlement for this issue is no longer materialized.</p>
          ) : (
            <>
              <p>
                <a href={request.settlement.pullRequestUrl}>
                  #{request.settlement.pullRequestNumber} {request.settlement.pullRequestTitle}
                </a>
              </p>
              <dl className="override-evidence">
                <div>
                  <dt>Status</dt>
                  <dd>{request.settlement.status}</dd>
                </div>
                <div>
                  <dt>Opening comparison</dt>
                  <dd>{request.settlement.openingComparisonPoints}</dd>
                </div>
                <div>
                  <dt>Settled points</dt>
                  <dd>
                    {request.settlement.settledPoints === null
                      ? "Unsettled"
                      : `${request.settlement.settledLabel ?? "no label"} · ${request.settlement.settledPoints}`}
                  </dd>
                </div>
                <div>
                  <dt>Review rounds</dt>
                  <dd>{request.settlement.reviewRounds}</dd>
                </div>
                <div>
                  <dt>Credits moved</dt>
                  <dd>{request.settlement.credits}</dd>
                </div>
              </dl>
            </>
          )}
          <SettlementOverrideDecision requestId={request.id} issueNumber={request.issueNumber} />
        </li>
      ))}
    </ol>
  );
}
