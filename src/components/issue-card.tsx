import type { EligibleIssueProjection } from "@/lib/dashboard/eligible-issues";
import { formatInstant } from "@/lib/format-instant";
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
        {issue.asksOutsideRepository ? (
          <p className="issue-card-outside-repository">
            Marked as asking for actions outside its repository: decline it, or work it in a sandbox.
          </p>
        ) : null}
        <div className="issue-card-done-when">
          {issue.doneWhen === null ? (
            <p>No done-when statement from the sponsor.</p>
          ) : (
            <>
              <p>The sponsor&apos;s done-when statement. {issue.doneWhen.notice}</p>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{issue.doneWhen.text}</pre>
            </>
          )}
        </div>
        {issue.sponsorLogin !== undefined ? <p>Sponsor: {issue.sponsorLogin}</p> : null}
        {issue.claimState !== undefined ? <p>Claim: {claimPhrase(issue.claimState, issue.assigneeGitHubLogin)}</p> : null}
        {issue.availableHeadroom !== undefined ? <p>Headroom: {formatSigned(issue.availableHeadroom)}</p> : null}
        <p className="mono-meta">Opened {formatInstant(issue.createdAt)}</p>
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
