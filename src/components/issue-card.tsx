import type { EligibleIssueProjection } from "@/lib/dashboard/queries";

type IssueCardProps = {
  issue: EligibleIssueProjection;
};

export function IssueCard({ issue }: IssueCardProps) {
  return (
    <article className="issue-card shadow-offset" aria-labelledby={`issue-${issue.id}`}>
      <div className="issue-card-heading">
        <p className="mono-meta">
          {issue.repositoryName} · #{issue.issueNumber}
        </p>
        <h2 id={`issue-${issue.id}`}>
          <a href={issue.url}>{issue.title}</a>
        </h2>
      </div>
      <dl className="issue-facts">
        <div>
          <dt>{issue.openingName}</dt>
          <dd>
            {issue.openingName}: {issue.openingLabel}
          </dd>
        </div>
        <div>
          <dt>Comparison</dt>
          <dd>Comparison {issue.comparisonPoints}</dd>
        </div>
        <div>
          <dt>Reserve</dt>
          <dd>Reserve {issue.reservePoints}</dd>
        </div>
      </dl>
      {issue.sponsorLogin !== undefined ? <p>Sponsor: {issue.sponsorLogin}</p> : null}
      {issue.claimState !== undefined ? (
        <p>Claim: {issue.claimState === "CLAIMED" ? `assigned to ${issue.assigneeGitHubLogin ?? "unknown"}` : "unclaimed"}</p>
      ) : null}
      {issue.availableHeadroom !== undefined ? <p>Headroom: {formatSigned(issue.availableHeadroom)}</p> : null}
      <p className="mono-meta">Opened {issue.createdAt.slice(0, 10)}</p>
    </article>
  );
}

function formatSigned(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : "0";
}
