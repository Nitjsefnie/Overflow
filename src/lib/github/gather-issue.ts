import { withFreshSweepReads } from "@/lib/fold/sweep-pass";
import { drainIssueReads, readIssueClosingPullRequests, readIssueOpeningEvidence } from "@/lib/github/drain-issue-reads";
import type { GitHubIssueListOptions } from "@/lib/github/client";
import type { GitHubIssueComment, GitHubIssueHistoryEvent, GitHubPullRequest } from "@/lib/github/types";

type Timeline = { history: GitHubIssueHistoryEvent[]; comments: GitHubIssueComment[] };
export type IssueTimelineWitness = { count: number | undefined; ids: Set<string> | undefined };
type IssueGatherReads = {
  labels(): Promise<string[]>;
  timeline(initial: boolean): Promise<Timeline>;
  closing(): Promise<GitHubPullRequest[]>;
  witness(): Promise<[number | undefined, Set<string> | undefined]>;
};

/** Shared opening/closing drains and independent timeline completeness checks. */
export async function gatherIssueEvidence(
  number: number, hasInitialTimeline: boolean, reads: IssueGatherReads,
  options: GitHubIssueListOptions | undefined, witness: IssueTimelineWitness,
) {
  const targeted = options?.timelineCriticalLabels !== undefined || options?.timelineWatchedLabels !== undefined;
  const [opening, closing] = await drainIssueReads([
    readIssueOpeningEvidence(
      reads.labels(),
      reads.timeline(true)),
    readIssueClosingPullRequests(reads.closing())]);
  const { labels, timeline, openingEvidenceUnreadable } = opening;
  // Check both fully assembled connections. A nested timeline can claim it is
  // complete while omitting events or comments, even when totalCount agrees.
  const labeled = new Set(timeline.history.flatMap((event) => event.kind === "LABELED" ? [event.label] : []));
  const expectedCount = witness.count;
  const expectedIds = witness.ids;
  const criticalLabels = labels.filter((label) => options?.timelineCriticalLabels?.has(label));
  const hasMissingCriticalLabel = (value: typeof timeline) => criticalLabels.some((label) =>
    !value.history.some((event) => event.kind === "LABELED" && event.label === label),
  );
  const matchesEvidence = (value: typeof timeline) => timelineMatchesEvidence(value, expectedCount, expectedIds);
  const suspect = !openingEvidenceUnreadable && targeted && (!matchesEvidence(timeline) || (hasInitialTimeline && labels.some((label) =>
    options?.timelineCriticalLabels?.has(label)
    || (options?.timelineWatchedLabels?.has(label) && !labeled.has(label)),
  )));
  const authoritativeTimeline = suspect ? await withFreshSweepReads(() => reads.timeline(false)) : timeline;
  if (!openingEvidenceUnreadable && targeted && (!matchesEvidence(authoritativeTimeline) || hasMissingCriticalLabel(authoritativeTimeline))) {
    // A rewrite can make scan-time witnesses stale; re-take them after the reread,
    // which replaces the earlier one; persistent disagreement or a missing standing critical label still refuses.
    const [freshCount, freshIds] = await withFreshSweepReads(() => reads.witness());
    if (!timelineMatchesEvidence(authoritativeTimeline, freshCount, freshIds) || hasMissingCriticalLabel(authoritativeTimeline)) {
      throw new Error(`GitHub issue ${number} timeline completeness could not be verified.`);
    }
  }
  return { labels, history: authoritativeTimeline.history, comments: authoritativeTimeline.comments, ...closing,
    ...(openingEvidenceUnreadable && { openingEvidenceUnreadable: true as const }) };
}

/** Unique ids match the exact count and contain the REST lower bound.
 * Positive counts need a witness; history also needs an event witness. */
function timelineMatchesEvidence(
  timeline: { history: Array<{ id: string }>; comments: Array<{ id: string }> },
  expectedCount: number | undefined,
  expectedIds: Set<string> | undefined,
): boolean {
  const ids = [...timeline.history, ...timeline.comments].map(({ id }) => id);
  const uniqueIds = new Set(ids);

  return ids.length === expectedCount && uniqueIds.size === expectedCount
    && expectedIds !== undefined && (expectedCount === 0 || expectedIds.size > 0)
    && [...expectedIds].every((id) => uniqueIds.has(id))
    && (timeline.history.length === 0 || timeline.history.some(({ id }) => expectedIds.has(id)));
}
