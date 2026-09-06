import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

type UnwritableClosureQueueProps = {
  closures: readonly UnwritableClosureProjection[];
};

/**
 * Closures whose evidence the fold refused, each with the path a member can
 * take to correct the outcome it did write.
 *
 * That outcome is a settlement when someone else closed the issue and a
 * self-work calibration when its sponsor closed it themselves. Only the
 * accounts named on the row can open either page, so the queue names them: a
 * moderator who is not a party has no way in, and saying nothing is correctable
 * is true only for a closure that produced neither row.
 */
export function UnwritableClosureQueue({ closures }: UnwritableClosureQueueProps) {
  if (closures.length === 0) {
    return <p>No closures are waiting on evidence.</p>;
  }

  return (
    <ol className="override-queue">
      {closures.map((closure) => (
        <li key={closure.id}>
          <p>
            <strong>{closure.repositoryName}</strong> · recorded {closure.recordedAt}
          </p>
          <p>
            <a href={closure.issueUrl}>
              #{closure.issueNumber} {closure.issueTitle}
            </a>
          </p>
          {closure.pullRequest === null ? null : (
            <p>
              <a href={closure.pullRequest.url}>
                #{closure.pullRequest.number} {closure.pullRequest.title}
              </a>
            </p>
          )}
          <p className="override-reason">{closure.reason}</p>
          {closure.settlementId !== null ? (
            <>
              <p>
                <a href={`/settlements/${closure.settlementId}`}>Open the settlement to request a correction</a>
              </p>
              {closure.settlementParties === null ? null : (
                <p className="mono-meta">
                  Only a party can request a correction: {closure.settlementParties.creditorLogin === null ? null : (
                    <><code>{closure.settlementParties.creditorLogin}</code> or </>
                  )}<code>{closure.settlementParties.debtorLogin}</code>.
                </p>
              )}
              <LatestCorrection correction={closure.latestCorrection} />
            </>
          ) : closure.calibrationId !== null ? (
            <>
              <p>
                <a href={`/calibration/${closure.calibrationId}`}>Open the calibration to request a correction</a>
              </p>
              {closure.calibrationOwnerLogin === null ? null : (
                <p className="mono-meta">
                  Only the sponsor can request a correction: <code>{closure.calibrationOwnerLogin}</code>.
                </p>
              )}
              <LatestCorrection correction={closure.latestCorrection} />
            </>
          ) : (
            <p className="mono-meta">No settlement is materialized for this closure, so there is nothing to correct.</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function LatestCorrection({ correction }: { correction: UnwritableClosureProjection["latestCorrection"] }) {
  if (correction === null) {
    return null;
  }
  return (
    <p className="mono-meta">
      Correction {correction.state.toLowerCase()} · reported {correction.requestedAt}
    </p>
  );
}
