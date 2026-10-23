import type { ClosedPrDisputeComparison, ClosedPrDisputePullRequest } from "@/lib/moderation/closed-pr-dispute-service";

export function ClosedPrDisputeComparisonView({ comparison, landingAccount }: {
  comparison: ClosedPrDisputeComparison; landingAccount: string | null;
}) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))", gap: "1rem" }}>
    <section aria-label="Closed pull request evidence"><h3>Closed pull request</h3><PullRequestEvidence pr={comparison.closedPullRequest} /></section>
    <section aria-label="Landed change evidence"><h3>Landed change</h3>
      {comparison.landedPullRequest ? <PullRequestEvidence pr={comparison.landedPullRequest} />
        : comparison.landedCommitUrl ? <><a href={comparison.landedCommitUrl}>{comparison.landedCommitUrl}</a><p>Landing account: {landingAccount ?? "unknown"}</p><p>No stored commit diff or reviews.</p></>
          : <p>No usable forge link or stored landing evidence.</p>}
    </section>
  </div>;
}

function PullRequestEvidence({ pr }: { pr: ClosedPrDisputePullRequest }) {
  return <>
    <a href={pr.url}>#{pr.number} {pr.title}</a>
    <h4>Stored reviews</h4>
    {pr.reviews === null ? <p>Review evidence unavailable.</p> : pr.reviews.length === 0 ? <p>No stored reviews.</p>
      : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(pr.reviews, null, 2)}</pre>}
    <h4>Stored raw diff</h4>
    {pr.rawDiff === null ? <p>Diff evidence unavailable.</p> : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{pr.rawDiff}</pre>}
  </>;
}
