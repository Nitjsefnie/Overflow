import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubRepositoryReference, GitHubSubject } from "@/lib/github/types";

export async function unlistedOpenIssues(
  gateway: Pick<ReconciliationGateway, "listOpenIssueIds">,
  reference: GitHubRepositoryReference,
  cached: ReadonlyMap<number, GitHubSubject & Pick<GitHubIssue, "state">>,
): Promise<GitHubSubject[]> {
  const open = [...cached.values()].filter(({ state }) => state === "OPEN");
  if (open.length === 0) return [];
  const listed = new Set(await gateway.listOpenIssueIds!(reference));
  return open.filter(({ id }) => !listed.has(id));
}
