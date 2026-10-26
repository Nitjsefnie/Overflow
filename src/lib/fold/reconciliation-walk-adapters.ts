import type { GitHubGateway, GitHubIssueListOptions } from "@/lib/github/client";
import type { GitLabGateway } from "@/lib/gitlab/client";
import type { GitHubRepositoryReference, GitHubSubject } from "@/lib/github/types";
import { listSubjectPage } from "@/lib/github/subject-listing";
import { walkReconciliation, type ReconciliationWalkInput, type WalkGateway } from "@/lib/fold/reconciliation-walk";

export type ForgeWalkInput = Omit<ReconciliationWalkInput, "listing" | "gateway">;

export async function walkGitHubReconciliation(
  github: GitHubGateway, reference: GitHubRepositoryReference, input: ForgeWalkInput, options?: GitHubIssueListOptions,
) {
  // REST /issues PR rows name the issue identity; staged rows name the immutable PR identity.
  const identities = new Map<number, number>();
  for (const row of await input.pass.readStaged()) {
    if (row.kind !== "pull_request") continue;
    const payload = row.payload as { subject?: GitHubSubject } | null;
    if (payload?.subject?.id === row.subjectKey) identities.set(payload.subject.number, row.subjectKey);
  }
  return walkReconciliation({ ...input,
    listing: {
      kind: "cursor",
      listPage: (options) => listSubjectPage(github, reference, options),
      normalizeSubject: async (subject) => {
        if (subject.kind === "issue") return subject;
        let id = identities.get(subject.number);
        if (id === undefined) {
          const pr = await github.getPullRequest(reference, subject.number);
          if (pr === null) return null;
          id = pr.id;
          identities.set(subject.number, id);
        }
        return { ...subject, id };
      },
    },
    gateway: {
      ...pullRequestReads(github, reference),
      gatherIssue: (subject) => github.gatherIssue(reference, subject, options),
    },
  });
}

export function walkGitLabReconciliation(gitlab: GitLabGateway, reference: GitHubRepositoryReference, input: ForgeWalkInput) {
  return walkReconciliation({ ...input,
    listing: { kind: "timestamp", listPage: (options) => gitlab.listSubjectsPage(reference, options) },
    gateway: { ...pullRequestReads(gitlab, reference), gatherIssue: (subject) => gitlab.getIssue(reference, subject) },
  });
}

function pullRequestReads(gateway: Pick<GitHubGateway, "getPullRequest" | "getPullRequestClosingIssues" | "getPullRequestReviews" | "getPullRequestDiff">,
  reference: GitHubRepositoryReference): Omit<WalkGateway, "gatherIssue"> {
  return {
    getPullRequest: async (subject) => {
      const pr = await gateway.getPullRequest(reference, subject.number);
      if (pr !== null && pr.id !== subject.id) throw new Error("Pull request identity did not match the walk subject.");
      return pr;
    },
    getPullRequestClosingIssues: (subject) => gateway.getPullRequestClosingIssues(reference, subject),
    getPullRequestReviews: (subject) => gateway.getPullRequestReviews(reference, subject.number),
    getPullRequestDiff: (subject) => gateway.getPullRequestDiff(reference, subject.number),
  };
}
