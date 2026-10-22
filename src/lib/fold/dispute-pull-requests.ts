import { createHash } from "node:crypto";
import type { FoldIssue, FoldPullRequest, RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";

/** Retain terminal candidates as dispute evidence; pricing selects its merged closer separately. */
export function retainDisputePullRequests(
  snapshot: RepositoryFoldSnapshot,
  issues: readonly FoldIssue[],
  retained: Map<number, FoldPullRequest>,
): void {
  const issueIds = new Set(issues.map((issue) => issue.githubIssueId));
  const authors = new Map(snapshot.repository.provider === "gitlab"
    ? (snapshot.forgeIdentities ?? []).map(({ forgeUserId, user }) => [forgeUserId, user.id])
    : snapshot.users.map((user) => [user.githubUserId, user.id]));
  for (const issue of snapshot.issues) {
    if (!issueIds.has(issue.id)) continue;
    for (const pr of issue.closingPullRequests) {
      if ((pr.state !== "CLOSED" && pr.state !== "MERGED") || !belongsToRegisteredRepository(snapshot.repository, pr)) continue;
      const existing = retained.get(pr.id);
      if (existing !== undefined) {
        // Preserve the selected closer's pricing provenance and add only observed links.
        if (!existing.githubIssueIds.includes(issue.id)) existing.githubIssueIds.push(issue.id);
        existing.githubIssueIds.sort((a, b) => a - b);
        continue;
      }
      retained.set(pr.id, {
        githubPullRequestId: pr.id, number: pr.number, title: pr.title, url: pr.url, state: pr.state,
        mergedAt: pr.mergedAt, mergeCommitOid: pr.mergeCommitOid?.toLowerCase() ?? null, finalCommitAt: pr.finalCommitAt,
        authorId: pr.authorGitHubUserId === null ? null : authors.get(pr.authorGitHubUserId) ?? null,
        authorGitHubLogin: pr.authorLogin, authorGitHubUserId: pr.authorGitHubUserId,
        proofSha256: createHash("sha256").update(pr.rawDiff, "utf8").digest("hex"),
        githubIssueIds: [issue.id], reviewRounds: [],
      });
    }
  }
}
