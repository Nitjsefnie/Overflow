import type { EligibleIssueProjection } from "@/lib/dashboard/queries";
import { formatSigned } from "@/lib/format-signed";
import { AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN } from "@/lib/github/types";
import { stripNamePrefix } from "@/lib/strip-name-prefix";

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
          <dd>{stripNamePrefix(issue.openingLabel, issue.openingName)}</dd>
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
