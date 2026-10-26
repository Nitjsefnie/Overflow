import type { WalkSubject } from "@/lib/forge/subject-listing";
import type { GitHubRepositoryReference } from "@/lib/github/types";
import type { GitLabRestResponse } from "@/lib/gitlab/client";
import { responseJsonArray } from "@/lib/gitlab/api-error";
import { CollectionWalkBound } from "@/lib/gitlab/collection-walk-bound";
import { withFreshSweepReads } from "@/lib/fold/sweep-pass";

export type GitLabSubjectsPageOptions = { collection: "issue" | "pull_request"; updatedAfter: string | null };
type SubjectRow = { id: number; iid: number; updated_at: string };

/** The request dependency owns HTTP admission to the shared sweep budget. */
export async function listGitLabSubjectsPage(
  deps: { request(path: string): Promise<GitLabRestResponse> },
  reference: GitHubRepositoryReference,
  options: GitLabSubjectsPageOptions,
): Promise<{ subjects: WalkSubject[]; nextAnchor: string | null; exhausted: boolean }> {
  const collection = options.collection === "issue" ? "issues" : "merge_requests";
  const path = `/projects/${encodeURIComponent(`${reference.owner}/${reference.name}`)}/${collection}`;
  const query = new URLSearchParams({ state: "all", per_page: "100", order_by: "updated_at", sort: "asc", page: "1" });
  if (options.updatedAfter !== null) query.set("updated_after", options.updatedAfter);
  const read = async () => {
    const target = `${path}?${query}`;
    const response = await withFreshSweepReads(() => deps.request(target));
    const rows = await responseJsonArray<SubjectRow>(response, target);
    for (const row of rows) {
      if (typeof row.updated_at !== "string" || Number.isNaN(Date.parse(row.updated_at))) {
        throw new Error(`GitLab subject ${row.id} has an invalid updated_at timestamp.`);
      }
    }
    return rows.sort(compareRows);
  };
  let rows = await read();
  const nextAnchor = rows.at(-1)?.updated_at ?? null;
  const exhausted = rows.length < 100;
  if (nextAnchor === null) return { subjects: [], nextAnchor, exhausted };
  if (rows.length === 100 && rows.every((row) => row.updated_at === nextAnchor)) {
    // shortcut: offset pagination is relied on only for a single-timestamp page; the anchor stays that timestamp.
    query.set("updated_after", nextAnchor);
    query.set("updated_before", nextAnchor);
    const slice = new CollectionWalkBound<SubjectRow>(path);
    for (let page = 1; ; page++) {
      query.set("page", String(page));
      const batch = await read();
      slice.add(batch);
      if (batch.length < 100) break;
    }
    rows = slice.collected.sort(compareRows);
  } else {
    rows = rows.filter((row) => row.updated_at !== nextAnchor);
  }
  return {
    subjects: rows.map((row) => ({ id: row.id, number: row.iid, kind: options.collection, updatedAt: new Date(row.updated_at) })),
    nextAnchor,
    exhausted,
  };
}

function compareRows(left: SubjectRow, right: SubjectRow): number {
  return Date.parse(left.updated_at) - Date.parse(right.updated_at)
    || left.updated_at.localeCompare(right.updated_at) || left.id - right.id;
}
