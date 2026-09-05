import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

type UnwritableClosureQueueProps = {
  closures: readonly UnwritableClosureProjection[];
};

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
          {closure.settlementId === null ? (
            <p className="mono-meta">No settlement is materialized for this closure, so there is nothing to correct.</p>
          ) : (
            <>
              <p>
                <a href={`/settlements/${closure.settlementId}`}>Open the settlement to request a correction</a>
              </p>
              {closure.latestCorrection === null ? null : (
                <p className="mono-meta">
                  Correction {closure.latestCorrection.state.toLowerCase()} · reported {closure.latestCorrection.requestedAt}
                </p>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
