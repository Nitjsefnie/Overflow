import { describe, expect, it } from "vitest";
import { GitLabGateway, GitLabApiError } from "@/lib/gitlab/client";

/**
 * Fixtures model the contract's live-verified shapes: real field names from
 * the forge-evidence probe (an untracked working document, recoverable from
 * git history: commit cf1a5db added it for issue 296), including the
 * three-SHA merge evidence of gap 5 and the absent state_reason of item 16.
 */

const project = {
  id: 278964,
  name: "gitlab",
  path: "gitlab",
  path_with_namespace: "gitlab-org/gitlab",
  visibility: "public",
  web_url: "https://gitlab.com/gitlab-org/gitlab",
  namespace: { id: 1, name: "GitLab.org", path: "gitlab-org", kind: "group" },
  permissions: { project_access: { access_level: 40 } },
};

const mergeRequest = {
  id: 5_500_001,
  iid: 17,
  project_id: 278964,
  title: "Fix the fold",
  description: "Closes #12",
  state: "merged",
  web_url: "https://gitlab.com/gitlab-org/gitlab/-/merge_requests/17",
  author: { id: 900, username: "contributor" },
  created_at: "2026-09-11T08:00:00.000Z",
  updated_at: "2026-09-11T12:00:00Z",
  merged_at: "2026-09-11T12:00:00.000+02:00",
  merge_commit_sha: "a".repeat(40),
  sha: "b".repeat(40),
  squash_commit_sha: "c".repeat(40),
  merge_status: "can_be_merged",
};

const issue = {
  id: 6_600_001,
  iid: 12,
  project_id: 278964,
  title: "Broken ledger",
  description: "It broke.",
  state: "opened",
  web_url: "https://gitlab.com/gitlab-org/gitlab/-/issues/12",
  author: { id: 901, username: "sponsor" },
  labels: ["delivered::6", "bug"],
  created_at: "2026-09-10T06:00:00.000Z",
  updated_at: "2026-09-11T09:30:00Z",
  closed_at: null,
  // Contract item 16: GitLab carries no state_reason. The field is absent.
  assignees: [{ id: 902, username: "claimer" }],
};

function gateway(fetchImplementation: typeof fetch): GitLabGateway {
  return new GitLabGateway({
    instanceUrl: "https://gitlab.com",
    token: "glpat-test",
    fetch: fetchImplementation,
  });
}

function jsonRouter(routes: Array<[string, unknown] | [string, unknown, number]>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const match = routes.find(([pattern]) => request.url.includes(pattern));
    if (match === undefined) {
      return new Response("no route", { status: 404 });
    }
    const [, body, status = 200] = match;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("GitLabGateway", () => {
  it("looks a project up by numeric id and by urlencoded path", async () => {
    const requests: string[] = [];
    const byId = gateway(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer glpat-test");
      return new Response(JSON.stringify(project), { status: 200, headers: { "content-type": "application/json" } });
    });
    const repository = await byId.getRepositoryById(278964);
    expect(repository).toMatchObject({
      id: 278964,
      owner: "gitlab-org",
      name: "gitlab",
      fullName: "gitlab-org/gitlab",
      visibility: "PUBLIC",
      url: "https://gitlab.com/gitlab-org/gitlab",
      ownerType: "ORGANIZATION",
      canAdminister: true,
    });

    const byPath = gateway(async (input) => {
      const request = new Request(input);
      requests.push(request.url);
      return new Response(JSON.stringify(project), { status: 200, headers: { "content-type": "application/json" } });
    });
    const fromPath = await byPath.getRepository({ owner: "gitlab-org", name: "gitlab" });
    expect(fromPath.id).toBe(278964);
    expect(requests.some((url) => url.includes("/projects/gitlab-org%2Fgitlab"))).toBe(true);
  });

  it("maps name to the path slug, not the display name", async () => {
    const displayNamed = {
      ...project,
      id: 42,
      name: "My Project",
      path: "my-project",
      path_with_namespace: "group/my-project",
      web_url: "https://gitlab.com/group/my-project",
      namespace: { id: 2, name: "Group", path: "group", kind: "group" },
    };
    const client = gateway(async () => new Response(JSON.stringify(displayNamed), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const repository = await client.getRepository({ owner: "group", name: "my-project" });
    expect(repository).toMatchObject({
      id: 42,
      owner: "group",
      name: "my-project",
      fullName: "group/my-project",
      ownerType: "ORGANIZATION",
    });
  });

  it("keeps the joined parent path as owner for a nested group, name as the slug", async () => {
    const nested = {
      ...project,
      id: 43,
      name: "My Project",
      path: "my-project",
      path_with_namespace: "group/sub/my-project",
      web_url: "https://gitlab.com/group/sub/my-project",
      namespace: { id: 3, name: "Sub", path: "sub", kind: "group" },
    };
    const client = gateway(async () => new Response(JSON.stringify(nested), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const repository = await client.getRepository({ owner: "group/sub", name: "my-project" });
    expect(repository.owner).toBe("group/sub");
    expect(repository.name).toBe("my-project");
    // owner/name joined addresses the project: it must equal the full path.
    expect(`${repository.owner}/${repository.name}`).toBe(repository.fullName);
    expect(repository.ownerType).toBe("ORGANIZATION");
  });

  it("captures the merge evidence and all three SHAs from the MR object", async () => {
    const client = gateway(jsonRouter([
      ["/merge_requests/17", mergeRequest],
    ]));
    const pullRequest = await client.getPullRequest(
      { owner: "gitlab-org", name: "gitlab" },
      17,
    );
    expect(pullRequest).toMatchObject({
      id: 5_500_001,
      number: 17,
      repositoryGitHubId: 278964,
      repositoryNameWithOwner: "gitlab-org/gitlab",
      state: "MERGED",
      mergedAt: "2026-09-11T10:00:00.000Z",
      mergeCommitOid: "a".repeat(40),
      authorLogin: "contributor",
      authorGitHubUserId: 900,
    });
    // Gap 5: GitLab names three commit SHAs on a merged MR; all three travel.
    expect(pullRequest.sourceSha).toBe("b".repeat(40));
    expect(pullRequest.squashCommitSha).toBe("c".repeat(40));
    // Timestamp normalization happens once, at the gateway boundary: the
    // fixtures above carry all three GitLab timestamp shapes and come back ISO UTC.
    expect(pullRequest.mergedAt).toBe("2026-09-11T10:00:00.000Z");
  });

  it("maps issues with null state_reason, embedded labels and normalized timestamps", async () => {
    const client = gateway(jsonRouter([
      ["/issues", [issue]],
    ]));
    const issues = await client.listIssues({ owner: "gitlab-org", name: "gitlab" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 6_600_001,
      number: 12,
      state: "OPEN",
      stateReason: null,
      labels: ["delivered::6", "bug"],
      authorLogin: "sponsor",
      authorGitHubUserId: 901,
      claimAssigneeGitHubLogin: "claimer",
      claimAssigneeGitHubUserId: 902,
      updatedAt: "2026-09-11T09:30:00.000Z",
    });
  });

  it("maps a single issue by iid and nulls the absent state_reason", async () => {
    const client = gateway(jsonRouter([
      ["/issues/12", issue],
    ]));
    const single = await client.getIssue({ owner: "gitlab-org", name: "gitlab" }, { id: 6_600_001, number: 12 });
    expect(single).not.toBeNull();
    expect(single!.stateReason).toBeNull();
    expect(single!.state).toBe("OPEN");
  });

  it("returns no reviews, ever, per contract decision 2", async () => {
    let requested = 0;
    const client = gateway(async () => {
      requested++;
      return new Response("[]", { status: 200 });
    });
    const reviews = await client.getPullRequestReviews({ owner: "gitlab-org", name: "gitlab" }, 17);
    expect(reviews).toEqual([]);
    expect(requested).toBe(0);
  });

  it("returns no workflow files, ever, per item 30's NOT SUPPLIED grade", async () => {
    let requested = 0;
    const client = gateway(async () => {
      requested++;
      return new Response("[]", { status: 200 });
    });
    const evidence = await client.listWorkflowFiles({ owner: "gitlab-org", name: "gitlab" });
    expect(evidence).toEqual([]);
    expect(requested).toBe(0);
  });

  it("falls back to the labels embedded in the issues list when the labels endpoint refuses", async () => {
    const client = gateway(jsonRouter([
      ["/labels", { message: "403 Forbidden" }, 403],
      ["/issues", [issue, { ...issue, iid: 13, labels: ["extra"] }]],
    ]));
    const labels = await client.listRepositoryLabels({ owner: "gitlab-org", name: "gitlab" });
    expect(labels).toEqual(new Set(["delivered::6", "bug", "extra"]));
  });

  it("reads the labels endpoint when it answers", async () => {
    const client = gateway(jsonRouter([
      ["/labels", [{ name: "delivered::6" }, { name: "bug" }]],
    ]));
    const labels = await client.listRepositoryLabels({ owner: "gitlab-org", name: "gitlab" });
    expect(labels).toEqual(new Set(["delivered::6", "bug"]));
  });

  it("reads closing issues and closing merge requests through the live-verified endpoints", async () => {
    const client = gateway(jsonRouter([
      ["/closes_issues", [{ id: 6_600_001, iid: 12, project_id: 278964 }]],
      ["/closed_by", [mergeRequest]],
    ]));
    const closingIssues = await client.getPullRequestClosingIssues(
      { owner: "gitlab-org", name: "gitlab" },
      { id: 5_500_001, number: 17 },
    );
    expect(closingIssues).toEqual([{ id: 6_600_001, number: 12, repositoryGitHubId: 278964 }]);
    const closingPullRequests = await client.getIssueClosingPullRequests(
      { owner: "gitlab-org", name: "gitlab" },
      12,
    );
    expect(closingPullRequests).toHaveLength(1);
    expect(closingPullRequests[0]).toMatchObject({ number: 17, state: "MERGED", mergeCommitOid: "a".repeat(40) });
  });

  it("passes the since cursor as updated_after on issue reads", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      const request = new Request(input);
      requests.push(request.url);
      return new Response(JSON.stringify([issue]), { status: 200, headers: { "content-type": "application/json" } });
    });
    await client.listIssues({ owner: "gitlab-org", name: "gitlab" }, { since: "2026-09-11T00:00:00.000Z" });
    expect(requests.some((url) => url.includes("updated_after=2026-09-11T00%3A00%3A00.000Z"))).toBe(true);
  });

  it("paginates by keyset, following the cursor across pages", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      const request = new Request(input);
      requests.push(request.url);
      if (request.url.includes("cursor=")) {
        return new Response(JSON.stringify([{ ...issue, iid: 13 }]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([issue]), {
        status: 200,
        headers: { "content-type": "application/json", "x-next-page-cursor": "cursor-after-page-1" },
      });
    });
    const issues = await client.listIssues({ owner: "gitlab-org", name: "gitlab" });
    expect(issues).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("pagination=keyset");
    expect(requests[0]).toContain("order_by=id");
    expect(requests[1]).toContain("cursor=cursor-after-page-1");
  });

  it("returns the raw diff body", async () => {
    const client = gateway(async (input) => {
      const request = new Request(input);
      expect(request.url).toContain("/merge_requests/17/diff");
      return new Response("diff --git a/x b/x", { status: 200 });
    });
    expect(await client.getPullRequestDiff({ owner: "gitlab-org", name: "gitlab" }, 17))
      .toBe("diff --git a/x b/x");
  });

  it("creates and deletes hooks with the project-scoped shapes, and ensures the event flags", async () => {
    const bodies: unknown[] = [];
    const client = gateway(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.includes("/hooks")) {
        bodies.push(await request.json());
        return new Response(JSON.stringify({ id: 77 }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && request.url.includes("/hooks/77")) {
        return new Response(JSON.stringify({
          id: 77, url: "https://overflow.example/api/github/webhooks",
          issues_events: false, merge_requests_events: false, push_events: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "PUT" && request.url.includes("/hooks/77")) {
        bodies.push(await request.json());
        return new Response(JSON.stringify({ id: 77 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "DELETE" && request.url.includes("/hooks/77")) {
        return new Response(null, { status: 204 });
      }
      return new Response("no route", { status: 404 });
    });
    const webhook = await client.createWebhook(
      { owner: "gitlab-org", name: "gitlab" },
      { callbackUrl: "https://overflow.example/api/github/webhooks", secret: "s3cret" },
    );
    expect(webhook).toEqual({ id: 77 });
    expect(bodies[0]).toMatchObject({
      url: "https://overflow.example/api/github/webhooks",
      token: "s3cret",
      issue_events: true,
      merge_requests_events: true,
      push_events: false,
    });
    await client.ensureWebhookEvents({ owner: "gitlab-org", name: "gitlab" }, 77, "s3cret");
    expect(bodies[1]).toMatchObject({ issue_events: true, merge_requests_events: true });
    await expect(client.deleteWebhook({ owner: "gitlab-org", name: "gitlab" }, 77)).resolves.toBeUndefined();
  });

  it("raises a typed error carrying the status on a non-2xx", async () => {
    const client = gateway(async () => new Response("unauthorized", { status: 401 }));
    await expect(client.getRepositoryById(278964)).rejects.toMatchObject({
      name: "GitLabApiError",
      status: 401,
    });
    await expect(client.getRepositoryById(278964)).rejects.toBeInstanceOf(GitLabApiError);
  });
});
