import { SettlementOverrideDecision } from "@/components/settlement-override-decision";
import type {
  OpenSettlementOverrideRequest,
  SelfWorkCalibrationOverrideEvidence,
  SettlementOverrideEvidence,
} from "@/lib/overrides/service";

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
          {request.settlement !== null ? (
            <SettlementEvidence settlement={request.settlement} />
          ) : request.calibration !== null ? (
            <CalibrationEvidence calibration={request.calibration} />
          ) : (
            <p className="mono-meta">The settled outcome for this issue is no longer materialized.</p>
          )}
          <SettlementOverrideDecision requestId={request.id} issueNumber={request.issueNumber} />
        </li>
      ))}
    </ol>
  );
}

/** What the ledger settled between two accounts, and the credits it moved. */
function SettlementEvidence({ settlement }: { settlement: SettlementOverrideEvidence }) {
  return (
    <>
      <p>
        <a href={settlement.pullRequestUrl}>
          #{settlement.pullRequestNumber} {settlement.pullRequestTitle}
        </a>
      </p>
      <dl className="override-evidence">
        <div>
          <dt>Status</dt>
          <dd>{settlement.status}</dd>
        </div>
        <div>
          <dt>Opening comparison</dt>
          <dd>{settlement.openingComparisonPoints}</dd>
        </div>
        <div>
          <dt>Settled points</dt>
          <dd>
            {settlement.settledPoints === null
              ? "Unsettled"
              : `${settlement.settledLabel ?? "no label"} · ${settlement.settledPoints}`}
          </dd>
        </div>
        <div>
          <dt>Review rounds</dt>
          <dd>{settlement.reviewRounds}</dd>
        </div>
        <div>
          <dt>Credits moved</dt>
          <dd>{settlement.credits}</dd>
        </div>
      </dl>
    </>
  );
}

/**
 * What the sponsor's own closure was calibrated at.
 *
 * The actual figure has three states, and they are not the same news: never
 * recorded at all, recorded under a GitHub label, or points a moderator granted
 * on a closure whose label was rejected — that last one keeps the issue's label
 * null, so the value says the label is missing rather than naming one.
 */
function CalibrationEvidence({ calibration }: { calibration: SelfWorkCalibrationOverrideEvidence }) {
  return (
    <>
      <p>
        <a href={calibration.pullRequestUrl}>
          #{calibration.pullRequestNumber} {calibration.pullRequestTitle}
        </a>
      </p>
      <dl className="override-evidence">
        <div>
          <dt>Self-worked by</dt>
          <dd>{calibration.ownerLogin}</dd>
        </div>
        <div>
          <dt>Opening comparison</dt>
          <dd>{calibration.openingComparisonPoints}</dd>
        </div>
        <div>
          <dt>Actual difficulty</dt>
          <dd>
            {calibration.actualPoints === null
              ? "Never recorded"
              : `${calibration.actualLabel ?? "no label recorded"} · ${calibration.actualPoints}`}
          </dd>
        </div>
      </dl>
      <p className="mono-meta">
        The sponsor closed this issue themselves, so the fold recorded a calibration and no credits moved.
        Granting a correction changes the calibration figure, not a balance.
      </p>
    </>
  );
}
