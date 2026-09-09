import type { EligibleIssueProjection } from "@/lib/dashboard/queries";
import { AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN } from "@/lib/github/types";

type IssueCardProps = {
  issue: EligibleIssueProjection;
};

export function IssueCard({ issue }: IssueCardProps) {
  return (
    <article className="issue-card shadow-offset" aria-labelledby={`issue-${issue.id}`}>
      <div className="issue-card-main">
        <div className="issue-card-heading">
          <p className="mono-meta">
            {issue.repositoryName} · #{issue.issueNumber}
          </p>
          <h2 id={`issue-${issue.id}`}>
            <a href={issue.url}>{issue.title}</a>
          </h2>
        </div>
        {issue.sponsorLogin !== undefined ? <p>Sponsor: {issue.sponsorLogin}</p> : null}
        {issue.claimState !== undefined ? <p>Claim: {claimPhrase(issue.claimState, issue.assigneeGitHubLogin)}</p> : null}
        {issue.availableHeadroom !== undefined ? <p>Headroom: {formatSigned(issue.availableHeadroom)}</p> : null}
        <p className="mono-meta">Opened {issue.createdAt.slice(0, 10)}</p>
      </div>
      <dl className="issue-facts">
        <div>
          <dt>{issue.openingName}</dt>
          <dd>{issue.openingLabel}</dd>
        </div>
        <div>
          <dt>Comparison</dt>
          <dd>{issue.comparisonPoints}</dd>
        </div>
        <div>
          <dt>Reserve</dt>
          <dd>{issue.reservePoints}</dd>
        </div>
      </dl>
    </article>
  );
}

function formatSigned(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : "0";
}

/**
 * The claim line's plain reading. The reserved ambiguous-claim login is a
 * machine value, so the reader gets the situation it stands for, never the
 * sentinel itself.
 */
function claimPhrase(
  claimState: EligibleIssueProjection["claimState"],
  assigneeGitHubLogin: EligibleIssueProjection["assigneeGitHubLogin"],
): string {
  if (claimState !== "CLAIMED") {
    return "unclaimed";
  }
  return assigneeGitHubLogin === AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN
    ? "assignment ambiguous"
    : `assigned to ${assigneeGitHubLogin ?? "unknown"}`;
}
