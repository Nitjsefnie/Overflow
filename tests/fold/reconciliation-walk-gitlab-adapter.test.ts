import { expect, it } from "vitest";
import { GitLabGateway } from "@/lib/gitlab/client";
import { memoryPass } from "./reconciliation-walk-fixture";

const at = "2026-10-01T00:00:00Z";
const reference = { owner: "group", name: "project" };
const object = { id: 101, iid: 1, project_id: 42, title: "Issue", description: "Opening", state: "closed",
  web_url: "https://gitlab.test/group/project/-/issues/1", author: { id: 12, username: "sponsor" },
  labels: [], created_at: at, updated_at: at, closed_at: at };
const pr = { id: 901, iid: 7, project_id: 42, title: "MR", description: "Closing", state: "merged",
  web_url: "https://gitlab.test/group/project/-/merge_requests/7", author: { id: 13, username: "contributor" },
  created_at: at, updated_at: at, merged_at: at, merge_commit_sha: null, sha: null, squash_commit_sha: null };

function fixture() {
  const paths: string[] = [];
  const gitlab = new GitLabGateway({ instanceUrl: "https://gitlab.test", token: ["test", "token"].join("-"), fetch: async (input) => {
    const url = new URL(String(input)), path = url.pathname.replace("/api/v4/projects/group%2Fproject", "");
    paths.push(path);
    if (path === "/issues") return Response.json([object]);
    // Leave the staged MR out of the listing to exercise its fresh absence witness.
    if (path === "/merge_requests") return Response.json([]);
    if (path === "/issues/1") return Response.json(object);
    if (path === "/issues/1/resource_label_events") return Response.json([{ id: 22, user: { id: 12, username: "sponsor" }, created_at: at, action: "add", label: { name: "M" } }]);
    if (path === "/issues/1/notes") return Response.json([{ id: 23, system: false, body: "Rationale", created_at: at, updated_at: at, author: { id: 12, username: "sponsor" } }]);
    if (path === "/issues/1/closed_by") return Response.json([pr]);
    if (path === "/merge_requests/7/commits") return Response.json([{ committed_date: at, committed_at: at }]);
    if (path === "/merge_requests/7") return Response.json(pr);
    if (path === "/merge_requests/7/closes_issues") return Response.json([{ id: 101, iid: 1, project_id: 42 }]);
    if (path === "/merge_requests/7/raw_diffs") return new Response("gitlab diff");
    throw new Error(`Unexpected path ${path}`);
  } });
  return { gitlab, paths };
}

it("gathers GitLab issue evidence and MR evidence and binds the kind-aware absence witness", async () => {
  const { gitlab, paths } = fixture();
  const pass = memoryPass();
  await pass.stage({ anchor: "pull_request", kind: "pull_request", subjectKey: 901, updatedAt: new Date(at),
    payload: { subject: { id: 901, number: 7 }, evidence: { reviews: [], rawDiff: "old" } } });
  const result = await gitlab.walkReconciliation(reference, { pass, repository: { githubRepositoryId: 42, disputePullRequests: [] } });
  expect(result.issues[0]).toMatchObject({ id: 101, body: "Opening", history: [{ label: "M" }], comments: [{ body: "Rationale" }],
    closingPullRequests: [{ id: 901, authorGitHubUserId: 13, rawDiff: "gitlab diff", reviews: [] }] });
  expect(result.pullRequests).toEqual([{ id: 901, reviews: [], rawDiff: "gitlab diff" }]);
  expect(paths).toContain("/merge_requests/7");
  expect(paths).not.toContain("/issues/7");
});
