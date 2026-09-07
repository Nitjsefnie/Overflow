import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

type UnwritableClosureHistoryProps = {
  closures: readonly UnwritableClosureProjection[];
};

export function UnwritableClosureHistory({ closures }: UnwritableClosureHistoryProps) {
  if (closures.length === 0) {
    return <p>No granted closure corrections are recorded.</p>;
  }

  return (
    <ol className="override-queue">
      {closures.map((closure) => (
        <li key={closure.id}>
          <p>
            <strong>{closure.repositoryName}</strong> · recorded <time dateTime={closure.recordedAt}>{closure.recordedAt}</time>
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
          {closure.latestCorrection === null ? null : (
            <p className="mono-meta">
              Correction <data value={closure.latestCorrection.state}>{closure.latestCorrection.state.toLowerCase()}</data> · reported <time dateTime={closure.latestCorrection.requestedAt}>{closure.latestCorrection.requestedAt}</time>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
