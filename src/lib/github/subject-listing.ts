import type { WalkSubject } from "@/lib/forge/subject-listing";
import type { GitHubGateway } from "@/lib/github/client";
import type { GitHubRepositoryReference } from "@/lib/github/types";
import { withFreshSweepReads } from "@/lib/fold/sweep-pass";

/** Uses the gateway's budget-checked transport; cursors retain the next Link's query. */
export async function listSubjectPage(
  deps: Pick<GitHubGateway, "request">,
  reference: GitHubRepositoryReference,
  options: { since?: string; cursor: string | null },
): Promise<{ subjects: WalkSubject[]; nextCursor: string | null }> {
  const path = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/issues`;
  const query = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: "100" });
  if (options.since !== undefined) query.set("since", options.since);
  const response = await withFreshSweepReads(() => deps.request(`${path}${options.cursor ?? `?${query}`}`));
  const rows: Array<{ id: number; number: number; updated_at?: string; pull_request?: unknown }> = JSON.parse(response.body);
  const subjects = rows.map((row): WalkSubject => {
    const updatedAt = new Date(row.updated_at ?? "");
    if (typeof row.updated_at !== "string" || Number.isNaN(updatedAt.getTime())) {
      throw new Error(`GitHub subject ${row.id} has an invalid updated_at timestamp.`);
    }
    return { id: row.id, number: row.number, kind: "pull_request" in row ? "pull_request" : "issue", updatedAt };
  });
  const next = response.headers.get("link")?.split(",").find((link) => /;\s*rel=(?:"next"|next)(?:\s*;|\s*$)/.test(link));
  const target = next === undefined ? undefined : /<([^>]+)>/.exec(next)?.[1];
  // Only the query travels back to the transport, which owns its API base URL.
  const nextCursor = target === undefined ? null : new URL(target, "https://api.github.com").search;
  return { subjects, nextCursor };
}
