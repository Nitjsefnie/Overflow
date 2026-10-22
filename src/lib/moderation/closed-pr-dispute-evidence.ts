import { z } from "zod";
import type { SqlClient } from "@/lib/db/types";
import type { ClosedPrDisputeComparison, ClosedPrDisputePullRequest } from "@/lib/moderation/closed-pr-dispute-service";

const reviewState = z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
export const reviewEvidence = z.object({ reviews: z.array(z.object({
  id: z.number().int().positive(), state: reviewState, submittedAt: z.string().nullable(),
  dismissal: z.object({ at: z.string(), previousState: reviewState.nullable() }).nullable(),
})) });

/** Read only retained evidence; missing or omitted facts remain visibly absent. */
export async function disputeComparisons(sql: SqlClient, requestIds: string[]): Promise<Map<string, ClosedPrDisputeComparison>> {
  if (requestIds.length === 0) return new Map();
  const rows = await sql<{
    id: string; owner_name: string; provider: string; instance_url: string | null; landed_commit_url: string | null;
    closed_number: number; closed_title: string; closed_payload: unknown;
    landing_number: number | null; landing_title: string | null; landing_payload: unknown;
  }[]>`
    select requests.id, repositories.owner_name, repositories.provider, repositories.instance_url, requests.landed_commit_url,
      closed.pull_request_number as closed_number, closed.title as closed_title, closed_fact.payload as closed_payload,
      landing.pull_request_number as landing_number, landing.title as landing_title, landing_fact.payload as landing_payload
    from closed_pr_dispute_requests requests
    join pull_requests closed on closed.id = requests.pull_request_id
    join registered_repositories repositories on repositories.id = closed.repository_id
    left join pull_requests landing on landing.id = requests.landed_pull_request_id
    left join repository_reconciliation_evidence_facts closed_fact on closed_fact.repository_id = closed.repository_id
      and closed_fact.kind = 'pull_request' and closed_fact.subject_key = closed.github_pull_request_id::text
    left join repository_reconciliation_evidence_facts landing_fact on landing_fact.repository_id = landing.repository_id
      and landing_fact.kind = 'pull_request' and landing_fact.subject_key = landing.github_pull_request_id::text
    where requests.id = any(${requestIds}::uuid[])
  `;
  return new Map(rows.map((row) => {
    const origin = row.provider === "github" ? "https://github.com" : row.instance_url!;
    const prefix = `${origin}/${row.owner_name}/${row.provider === "github" ? "pull" : "-/merge_requests"}/`;
    const pr = (number: number, title: string, payload: unknown): ClosedPrDisputePullRequest => {
      const reviews = reviewEvidence.safeParse(payload);
      const diff = z.object({ rawDiff: z.string() }).safeParse(payload);
      return { number, title, url: `${prefix}${number}`, reviews: reviews.success ? reviews.data.reviews : null,
        rawDiff: diff.success ? diff.data.rawDiff : null };
    };
    let commitUrl: string | null = null;
    try {
      const url = new URL(row.landed_commit_url!);
      const commitPrefix = `/${row.owner_name}/${row.provider === "github" ? "commit" : "-/commit"}/`;
      if (url.protocol === "https:" && url.origin === origin && url.username === "" && url.password === ""
        && url.pathname.startsWith(commitPrefix) && /^[a-zA-Z0-9]+$/.test(url.pathname.slice(commitPrefix.length))) commitUrl = url.href;
    } catch { /* No usable forge commit link was supplied. */ }
    return [row.id, { closedPullRequest: pr(row.closed_number, row.closed_title, row.closed_payload),
      landedPullRequest: row.landing_number === null ? null : pr(row.landing_number, row.landing_title!, row.landing_payload),
      landedCommitUrl: commitUrl }];
  }));
}
