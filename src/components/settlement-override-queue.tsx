import { SettlementOverrideDecision } from "@/components/settlement-override-decision";
import type { OpenSettlementOverrideRequest } from "@/lib/overrides/service";

type SettlementOverrideQueueProps = {
  requests: readonly OpenSettlementOverrideRequest[];
};

/**
 * Corrections awaiting a decision, each shown with the evidence its issue was
 * priced from: the issue, the closing pull request, what the ledger recorded,
 * and the review rounds that were deducted.
 *
 * A self-worked closure is a calibration rather than a settlement, so it is
 * shown from the calibration instead — its figures are the ones a correction
 * moves, and no credits are at stake. Saying the outcome is gone is reserved
 * for a request neither row backs, which is the only case where it is true.
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
            request.calibration === null ? (
              <p className="mono-meta">The settled outcome for this issue is no longer materialized.</p>
            ) : (
              <>
                <p>
                  <a href={request.calibration.pullRequestUrl}>
                    #{request.calibration.pullRequestNumber} {request.calibration.pullRequestTitle}
                  </a>
                </p>
                <dl className="override-evidence">
                  <div>
                    <dt>Self-worked by</dt>
                    <dd>{request.calibration.ownerLogin}</dd>
                  </div>
                  <div>
                    <dt>Opening comparison</dt>
                    <dd>{request.calibration.openingComparisonPoints}</dd>
                  </div>
                  <div>
                    <dt>Actual difficulty</dt>
                    <dd>
                      {request.calibration.actualPoints === null
                        ? "Never recorded"
                        : `${request.calibration.actualLabel ?? "no label"} · ${request.calibration.actualPoints}`}
                    </dd>
                  </div>
                </dl>
                <p className="mono-meta">
                  The sponsor closed this issue themselves, so the fold recorded a calibration and no credits
                  moved. Granting a correction changes the calibration figure, not a balance.
                </p>
              </>
            )
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
