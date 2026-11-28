import { RECONCILIATION_FULL_REPAIR_MS } from "@/lib/fold/full-repair-interval";
import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import type { ReconciliationEvidence } from "@/lib/fold/reconciliation-evidence";
import type { GitHubIssue, GitHubRepositoryReference, GitHubSubject } from "@/lib/github/types";

// The listing costs a request per hundred open issues and pull requests: once per interval.
export function openListingDue({ lastOpenListingAt }: Pick<ReconciliationEvidence, "lastOpenListingAt">, at: Date): boolean {
  return lastOpenListingAt == null || at.getTime() - lastOpenListingAt.getTime() >= RECONCILIATION_FULL_REPAIR_MS;
}

export async function unlistedOpenIssues(
  gateway: Pick<ReconciliationGateway, "listOpenIssueIds">,
  reference: GitHubRepositoryReference,
  cached: ReadonlyMap<number, GitHubSubject & Pick<GitHubIssue, "state">>,
): Promise<GitHubSubject[]> {
  const open = [...cached.values()].filter(({ state }) => state === "OPEN");
  if (open.length === 0) return [];
  const listed = new Set(await gateway.listOpenIssueIds(reference));
  return open.filter(({ id }) => !listed.has(id));
}
