import { GitLabGateway } from "@/lib/gitlab/client";

export function disappearingGitLabFixture(
  phase: "closing" | "diff",
  options: { repositoryId?: number; name?: string; status?: number; reachable?: boolean; merged?: boolean } = {},
) {
  const name = options.name ?? "project";
  const at = "2030-01-01T00:00:00Z";
  const issue = { id: 101, iid: 1, project_id: options.repositoryId ?? 42, title: "Staged before MR absence",
    description: "Opening", state: "opened", web_url: `https://gitlab.test/group/${name}/-/issues/1`,
    author: { id: 12, username: "sponsor" }, labels: [], created_at: at, updated_at: at, closed_at: null };
  const pr = { id: 901, iid: 7, project_id: options.repositoryId ?? 42, title: "MR", description: "",
    state: options.merged ? "merged" : "opened", web_url: `https://gitlab.test/group/${name}/-/merge_requests/7`,
    author: { id: 13, username: "contributor" }, created_at: at, updated_at: at, merged_at: options.merged ? at : null,
    merge_commit_sha: null, sha: null, squash_commit_sha: null };
  let listings = 0;
  const paths: string[] = [];
  const unavailable = () => {
    if (options.status === 0) throw new Error("Synthetic transport failure");
    return new Response("Unavailable", { status: options.status ?? 404 });
  };
  const gateway = new GitLabGateway({ instanceUrl: "https://gitlab.test", token: ["test", "token"].join("-"), fetch: async (input) => {
    const path = new URL(String(input)).pathname.replace(`/api/v4/projects/${encodeURIComponent(`group/${name}`)}`, "");
    paths.push(path);
    if (path === "/issues") return Response.json([issue]);
    if (path === "/issues/1") return Response.json(issue);
    if (["/issues/1/resource_label_events", "/issues/1/notes", "/issues/1/closed_by"].includes(path)) return Response.json([]);
    if (path === "/merge_requests") return Response.json(++listings === 1 ? [pr] : []);
    if (path === "/merge_requests/7/closes_issues") return phase === "closing" ? unavailable() : Response.json([]);
    if (path === "/merge_requests/7/raw_diffs") return unavailable();
    if (path === "/merge_requests/7") return options.reachable ? Response.json(pr) : new Response("Gone", { status: 404 });
    if (path === "/merge_requests/7/commits") return new Response("Commits unavailable", { status: 404 });
    throw new Error(`Unexpected GitLab request ${path}`);
  } });
  return { gateway, paths };
}
