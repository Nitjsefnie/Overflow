import type { WalkSubject } from "@/lib/forge/subject-listing";
import type { GitHubRepositoryReference } from "@/lib/github/types";
import type { GitLabRestResponse } from "@/lib/gitlab/client";
import { responseJsonArray } from "@/lib/gitlab/api-error";
import { withFreshSweepReads } from "@/lib/fold/sweep-pass";

export type GitLabSubjectsPageOptions = {
  collection: "issue" | "pull_request";
  updatedAfter: string | null;
  updatedBefore?: string;
  page?: number;
};
type SubjectRow = { id: number; iid: number; updated_at: string };

/** Reads one sorted raw page; the caller visits every row with staging-aware deduplication.
 * CollectionWalkBound caps its timestamp slice and local offset continuation.
 * This reader persists no state; page is window-local.
 */
export async function listGitLabSubjectsPage(
  deps: { request(path: string): Promise<GitLabRestResponse> },
  reference: GitHubRepositoryReference,
  options: GitLabSubjectsPageOptions,
): Promise<{ subjects: WalkSubject[]; nextAnchor: string | null; exhausted: boolean }> {
  const collection = options.collection === "issue" ? "issues" : "merge_requests";
  const path = `/projects/${encodeURIComponent(`${reference.owner}/${reference.name}`)}/${collection}`;
  const query = new URLSearchParams({ state: "all", per_page: "100", order_by: "updated_at", sort: "asc", page: String(options.page ?? 1) });
  if (options.updatedAfter !== null) query.set("updated_after", options.updatedAfter);
  if (options.updatedBefore !== undefined) query.set("updated_before", options.updatedBefore);
  const target = `${path}?${query}`;
  const response = await withFreshSweepReads(() => deps.request(target));
  const rows = await responseJsonArray<SubjectRow>(response, target);
  for (const row of rows) {
    if (typeof row.updated_at !== "string" || Number.isNaN(Date.parse(row.updated_at))) {
      throw new Error(`GitLab subject ${row.id} has an invalid updated_at timestamp.`);
    }
  }
  rows.sort(compareRows);
  return {
    subjects: rows.map((row) => ({ id: row.id, number: row.iid, kind: options.collection, updatedAt: new Date(row.updated_at) })),
    nextAnchor: rows.at(-1)?.updated_at ?? null,
    exhausted: rows.length < 100,
  };
}

function compareRows(left: SubjectRow, right: SubjectRow): number {
  const milliseconds = Date.parse(left.updated_at) - Date.parse(right.updated_at);
  if (milliseconds !== 0) return milliseconds;
  // Date.parse drops sub-millisecond digits; compare fractions at a common precision.
  const leftFraction = /\.(\d+)/.exec(left.updated_at)?.[1] ?? "";
  const rightFraction = /\.(\d+)/.exec(right.updated_at)?.[1] ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(precision, "0").localeCompare(rightFraction.padEnd(precision, "0")) || left.id - right.id;
}
