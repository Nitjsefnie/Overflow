import { describe, expect, it, vi } from "vitest";
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

// Live-verified resource_label_events shape: the label travels as an embedded
// object and the action as "add" | "remove".
const addedLabelEvent = {
  id: 142,
  user: { id: 1, username: "sponsor" },
  created_at: "2026-09-10T08:00:00.000Z",
  resource_type: "Issue",
  resource_id: 253,
  label: { id: 73, name: "delivered::6", color: "#34495E", description: "" },
  action: "add",
};

const removedLabelEvent = {
  ...addedLabelEvent,
  id: 143,
  created_at: "2026-09-11T08:30:00Z",
  label: { id: 74, name: "offered::3", color: "#0033CC", description: "" },
  action: "remove",
};

// A label GitLab can no longer name (deleted since the event): no readable
// evidence, so the mapping must drop it rather than invent a label name.
const deletedLabelEvent = {
  ...addedLabelEvent,
  id: 144,
  label: null,
};

// The length-0 name arm: an event whose label object carries an empty name
// carries no readable evidence either, so the mapping must skip it.
const emptyNameLabelEvent = {
  ...addedLabelEvent,
  id: 145,
  label: { id: 75, name: "" },
};

// Live-verified notes shape: activity records carry `system: true` on the
// same endpoint, and `updated_at` is the only edit witness a note carries.
const systemNote = {
  id: 302,
  body: "closed",
  author: { id: 1, username: "sponsor" },
  created_at: "2026-09-10T09:22:45Z",
  updated_at: "2026-09-10T09:22:45Z",
  system: true,
  noteable_id: 377,
  noteable_type: "Issue",
  project_id: 5,
  resolvable: false,
  confidential: false,
  internal: false,
};

const note = {
  ...systemNote,
  id: 305,
  body: "Fixed by the merge request.",
  created_at: "2026-09-10T09:56:03Z",
  updated_at: "2026-09-10T09:56:03Z",
  system: false,
};

const editedNote = {
  ...note,
  id: 306,
  body: "corrected after the merge",
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-11T09:00:00Z",
};

// A note that omits the `system` field entirely: only `system: true` marks
// an activity record, so an unmarked note is a human comment.
const unmarkedNote = {
  id: 307,
  body: "posted before the system flag existed",
  author: { id: 2, username: "contributor" },
  created_at: "2026-09-10T11:00:00Z",
  updated_at: "2026-09-10T11:00:00Z",
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

describe("GitLab collection pagination", () => {
  const repository = { owner: "gitlab-org", name: "gitlab" };
  const projectPath = "/api/v4/projects/gitlab-org%2Fgitlab";
  const issuesUrl = `https://gitlab.com${projectPath}/issues`;
  const closesUrl = `https://gitlab.com${projectPath}/merge_requests/17/closes_issues`;
  const json = (body: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { headers });
  // A hard transport cap turns missing loop guards into prompt, visible failures.
  function collectionClient(
    pathname: string,
    respond: (request: Request, hit: number) => Response,
    cap = 3,
    instanceUrl = "https://gitlab.com",
  ) {
    const requests: Request[] = [];
    const client = new GitLabGateway({
      instanceUrl,
      token: "glpat-test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === pathname) {
          requests.push(request);
          if (requests.length > cap) return new Response("request cap exceeded", { status: 503 });
          return respond(request, requests.length);
        }
        if (new URL(request.url).pathname.endsWith("/merge_requests/17")) return json(mergeRequest);
        return json([]);
      },
    });
    return { client, requests };
  }

  it("follows the next Link relation and preserves opaque parameters", async () => {
    const next = `${issuesUrl}?pagination=keyset&order_by=created_at&sort=asc&per_page=100&created_at=opaque%2Bvalue&id_after=42&cursor=a%2Fb%3D`;
    const { client, requests } = collectionClient(`${projectPath}/issues`, (_, hit) => hit === 1
      ? json([issue], { link: `<${issuesUrl}>; rel="prev"; title="prior, page", <${next}>; title="next, page"; rel="next", <${issuesUrl}>; rel="last"`, "x-next-cursor": "wrong-fallback" })
      : json([{ ...issue, iid: 13 }]));
    const issues = await client.listIssues(repository);
    expect(issues.map((item) => item.number)).toEqual([12, 13]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(next);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer glpat-test");
  });

  it("uses offset pagination for MR commits and reads the latest second-page timestamp", async () => {
    const pathname = `${projectPath}/merge_requests/17/commits`;
    const next = `https://gitlab.com${pathname}?per_page=100&page=2`;
    const { client, requests } = collectionClient(pathname, (_, hit) => hit === 1
      ? json([{ committed_date: "2026-09-11T08:00:00.000Z" }], { link: `<${next}>; rel="next"` })
      : json([{ committed_date: "2026-09-11T11:30:00.000Z" }, { committed_date: "2026-09-11T09:00:00.000Z" }]));
    expect((await client.getPullRequest(repository, 17)).finalCommitAt).toBe("2026-09-11T11:30:00.000Z");
    expect(requests.map((request) => new URL(request.url).search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });

  it("uses offset pagination for closes_issues", async () => {
    const { client, requests } = collectionClient(`${projectPath}/merge_requests/17/closes_issues`, (_, hit) => hit === 1
      ? json([{ id: 6_600_001, iid: 12, project_id: 278964 }], { "x-next-page": "2" })
      : json([{ id: 6_600_002, iid: 13, project_id: 278964 }]));
    expect(await client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 })).toEqual([
      { id: 6_600_001, number: 12, repositoryGitHubId: 278964 },
      { id: 6_600_002, number: 13, repositoryGitHubId: 278964 },
    ]);
    expect(requests.map((request) => new URL(request.url).search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });

  it("uses offset pagination for closed_by", async () => {
    const pathname = `${projectPath}/issues/12/closed_by`;
    const { client, requests } = collectionClient(pathname, (_, hit) => {
      const body = [{ ...mergeRequest, iid: hit + 16, merged_at: null }];
      if (hit === 1) return json(body, { link: `<${pathname}?per_page=100&page=2&opaque=keep%2Bme>; rel="next"`, "x-next-page": "99" });
      if (hit === 2) return json(body, { "x-next-page": "3" });
      return json(body);
    });
    expect((await client.getIssueClosingPullRequests(repository, 12)).map((mr) => mr.number)).toEqual([17, 18, 19]);
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "?per_page=100&page=1", "?per_page=100&page=2&opaque=keep%2Bme", "?per_page=100&page=3&opaque=keep%2Bme",
    ]);
  });

  it.each([
    ["keyset", {}], ["keyset", { "x-next-cursor": "" }], ["keyset", { "x-next-page": "2" }],
    ["offset", {}], ["offset", { "x-next-page": "" }], ["offset", { "x-next-cursor": "cursor" }],
  ] as const)("stops without a supported continuation (%s, %j)", async (mode, headers) => {
    const pathname = mode === "keyset" ? `${projectPath}/issues` : `${projectPath}/merge_requests/17/closes_issues`;
    const { client, requests } = collectionClient(pathname, () => json([], headers));
    const result = mode === "keyset" ? await client.listIssues(repository)
      : await client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 });
    expect(result).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it.each(["abc", "0", "-1", "1", "1.5", "2e0", "0x2", "9007199254740992"])("rejects invalid offset page headers (%s)", async (page) => {
    const { client, requests } = collectionClient(`${projectPath}/merge_requests/17/closes_issues`, () => json([], { "x-next-page": page }));
    await expect(client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 })).rejects.toThrow(/invalid x-next-page/);
    expect(requests).toHaveLength(1);
  });

  it("rejects repeated cursor values", async () => {
    const { client, requests } = collectionClient(`${projectPath}/issues`, () => json([], { "x-next-cursor": "same-cursor" }));
    await expect(client.listIssues(repository)).rejects.toThrow(/repeated.*(cursor|target)/i);
    expect(requests).toHaveLength(2);
  });

  it("rejects repeated normalized Link targets", async () => {
    const { client, requests } = collectionClient(`${projectPath}/issues`, () => json([], {
      link: `<${issuesUrl}?sort=asc&order_by=created_at&pagination=keyset&per_page=%31%30%30>; rel="next"`,
    }));
    await expect(client.listIssues(repository)).rejects.toThrow(/repeated.*target/i);
    expect(requests).toHaveLength(1);
  });

  it("rejects reused cursors on distinct Link targets", async () => {
    const { client, requests } = collectionClient(`${projectPath}/issues`, (_, hit) => json([], {
      link: `<${issuesUrl}?cursor=same&opaque=${hit}>; rel="next"`,
    }));
    await expect(client.listIssues(repository)).rejects.toThrow(/repeated.*cursor/i);
    expect(requests).toHaveLength(2);
  });

  it("rejects a header that moves backwards from the linked offset page", async () => {
    const { client, requests } = collectionClient(`${projectPath}/merge_requests/17/closes_issues`, (_, hit) => hit === 1
      ? json([], { link: `<${closesUrl}?per_page=100&page=5>; rel="next"` })
      : json([], { "x-next-page": "3" }));
    await expect(client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 })).rejects.toThrow(/invalid x-next-page/);
    expect(requests).toHaveLength(2);
  });

  it("follows relative Links under a configured instance prefix", async () => {
    const { client, requests } = collectionClient(`/gitlab${projectPath}/merge_requests/17/closes_issues`, (_, hit) => hit === 1
      ? json([{ id: 6_600_001, iid: 12, project_id: 278964 }], { link: '<?page=2&per_page=100>; rel="next"' })
      : json([{ id: 6_600_002, iid: 13, project_id: 278964 }]), 2, "https://gitlab.com/gitlab");
    expect((await client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 })).map((item) => item.number)).toEqual([12, 13]);
    expect(requests[1]!.url).toBe("https://gitlab.com/gitlab/api/v4/projects/gitlab-org%2Fgitlab/merge_requests/17/closes_issues?page=2&per_page=100");
  });

  it.each([
    `<https://user:pass@gitlab.com${projectPath}/issues?page=2>; rel="next"`,
    `<${issuesUrl}?page=2#fragment>; rel="next"`,
    `<${issuesUrl}?page=2#>; rel="next"`,
    `<https://other.example${projectPath}/issues?page=2>; rel="next"`,
    `<http://gitlab.com${projectPath}/issues?page=2>; rel="next"`,
    `<https://gitlab.com/api/v40/projects/gitlab-org%2Fgitlab/issues?page=2>; rel="next"`,
    `<${closesUrl}?page=2>; rel="next"`,
    `<https://gitlab.com/api/v4/../projects/gitlab-org%2Fgitlab/issues?page=2>; rel="next"`,
    `<https://[invalid>; rel="next"`,
    `${issuesUrl}?page=2; rel="next"`,
    `<${issuesUrl}?page=2>; rel="next`,
    `<${issuesUrl}?page=2>; rel="next", <${issuesUrl}?page=3>; rel="next"`,
  ])("rejects unsafe or malformed next Links (%s)", async (link) => {
    const requests: Request[] = [];
    const client = gateway(async (input, init) => {
      requests.push(new Request(input, init));
      if (requests.length > 2) return new Response("request cap exceeded", { status: 503 });
      return json([], { link });
    });
    await expect(client.listIssues(repository)).rejects.toThrow(/(invalid|unsafe|malformed).*link/i);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer glpat-test");
  });

  it("preserves API failures on continuation pages", async () => {
    const { client, requests } = collectionClient(`${projectPath}/merge_requests/17/closes_issues`, (_, hit) => hit === 1
      ? json([], { "x-next-page": "2" }) : new Response("forbidden", { status: 403 }));
    await expect(client.getPullRequestClosingIssues(repository, { id: 5_500_001, number: 17 })).rejects.toMatchObject({ name: "GitLabApiError", status: 403 });
    expect(requests).toHaveLength(2);
  });

  it("leaves finalCommitAt null when commit pagination fails", async () => {
    const { client, requests } = collectionClient(`${projectPath}/merge_requests/17/commits`, (_, hit) => hit === 1
      ? json([{ committed_date: "2026-09-11T08:00:00.000Z" }], { "x-next-page": "2" })
      : new Response("unavailable", { status: 503 }));
    expect((await client.getPullRequest(repository, 17)).finalCommitAt).toBeNull();
    expect(requests).toHaveLength(2);
  });
});

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

  it("computes canAdminister from the higher of direct project and inherited group access", async () => {
    const serving = async (projectPayload: unknown) => {
      const client = gateway(async () =>
        new Response(JSON.stringify(projectPayload), { status: 200, headers: { "content-type": "application/json" } }));
      const repository = await client.getRepositoryById(278964);
      expect(repository).not.toBeNull();
      return repository!;
    };

    // GitLab reports the effective access level as the higher of the direct
    // project access and the access inherited through the namespace group:
    // a group Maintainer carries project_access === null and group_access at
    // Maintainer, so project_access alone would falsely refuse them.
    const groupMaintainer = await serving({
      ...project,
      permissions: { project_access: null, group_access: { access_level: 40 } },
    });
    expect(groupMaintainer.canAdminister).toBe(true);

    const groupOwnerOverDirectDeveloper = await serving({
      ...project,
      permissions: { project_access: { access_level: 30 }, group_access: { access_level: 50 } },
    });
    expect(groupOwnerOverDirectDeveloper.canAdminister).toBe(true);

    const directMaintainerOverGroupDeveloper = await serving({
      ...project,
      permissions: { project_access: { access_level: 40 }, group_access: { access_level: 30 } },
    });
    expect(directMaintainerOverGroupDeveloper.canAdminister).toBe(true);

    const belowMaintainerOnBoth = await serving({
      ...project,
      permissions: { project_access: { access_level: 30 }, group_access: { access_level: 30 } },
    });
    expect(belowMaintainerOnBoth.canAdminister).toBe(false);

    const noAccessAtAll = await serving({
      ...project,
      permissions: { project_access: null, group_access: null },
    });
    expect(noAccessAtAll.canAdminister).toBe(false);

    // An absent permissions field reports no access either — nothing inferred.
    const absentPermissions = await serving({ ...project, permissions: undefined });
    expect(absentPermissions.canAdminister).toBe(false);
  });

  it("maps GitLab-internal visibility to PRIVATE so a non-public project cannot register", async () => {
    const client = gateway(async () =>
      new Response(JSON.stringify({ ...project, visibility: "internal" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const repository = await client.getRepositoryById(278964);
    expect(repository).not.toBeNull();
    expect(repository!.visibility).toBe("PRIVATE");
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
      ["/resource_label_events", []],
      ["/notes", []],
      ["/closed_by", []],
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
      ["/resource_label_events", [addedLabelEvent, removedLabelEvent, deletedLabelEvent]],
      ["/notes", [systemNote, note, editedNote]],
      ["/closed_by", [mergeRequest]],
      ["/merge_requests/17/commits", [{ committed_date: "2026-09-11T11:30:00.000Z" }]],
      ["/issues/12", issue],
    ]));
    const single = await client.getIssue({ owner: "gitlab-org", name: "gitlab" }, { id: 6_600_001, number: 12 });
    expect(single).not.toBeNull();
    expect(single!.stateReason).toBeNull();
    expect(single!.state).toBe("OPEN");
    expect(single!.history).toEqual([
      {
        kind: "LABELED",
        id: "142",
        actorLogin: "sponsor",
        actorGitHubUserId: 1,
        label: "delivered::6",
        createdAt: "2026-09-10T08:00:00.000Z",
      },
      {
        kind: "UNLABELED",
        id: "143",
        actorLogin: "sponsor",
        actorGitHubUserId: 1,
        label: "offered::3",
        createdAt: "2026-09-11T08:30:00.000Z",
      },
    ]);
    expect(single!.comments).toEqual([
      {
        id: "305",
        databaseId: 305,
        authorLogin: "sponsor",
        authorGitHubUserId: 1,
        body: "Fixed by the merge request.",
        createdAt: "2026-09-10T09:56:03.000Z",
        lastEditedAt: null,
      },
      {
        id: "306",
        databaseId: 306,
        authorLogin: "sponsor",
        authorGitHubUserId: 1,
        body: "corrected after the merge",
        createdAt: "2026-09-10T10:00:00.000Z",
        lastEditedAt: "2026-09-11T09:00:00.000Z",
      },
    ]);
    expect(single!.closingPullRequests).toHaveLength(1);
    expect(single!.closingPullRequests[0]).toMatchObject({
      number: 17,
      state: "MERGED",
      finalCommitAt: "2026-09-11T11:30:00.000Z",
    });
  });

  it("supplies every listed issue's label events, comments and closing merge requests", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      const request = new Request(input);
      requests.push(new URL(request.url).pathname);
      if (request.url.includes("/resource_label_events")) {
        return new Response(JSON.stringify([addedLabelEvent, removedLabelEvent, deletedLabelEvent]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/notes")) {
        return new Response(JSON.stringify([systemNote, note, editedNote]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/closed_by")) {
        return new Response(JSON.stringify([mergeRequest]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/merge_requests/17/commits")) {
        return new Response(JSON.stringify([{ committed_date: "2026-09-11T11:30:00.000Z" }]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/issues")) {
        return new Response(JSON.stringify([issue]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("no route", { status: 404 });
    });
    const issues = await client.listIssues({ owner: "gitlab-org", name: "gitlab" });
    expect(issues).toHaveLength(1);
    // Two requests per listed issue (label events + notes) plus one per merged
    // closing merge request: the always-fresh N+1 cost, counted here.
    expect(requests.filter((path) => path.endsWith("/resource_label_events")))
      .toEqual(["/api/v4/projects/gitlab-org%2Fgitlab/issues/12/resource_label_events"]);
    expect(requests.filter((path) => path.endsWith("/notes")))
      .toEqual(["/api/v4/projects/gitlab-org%2Fgitlab/issues/12/notes"]);
    expect(requests.filter((path) => path.endsWith("/closed_by")))
      .toEqual(["/api/v4/projects/gitlab-org%2Fgitlab/issues/12/closed_by"]);
    expect(requests.filter((path) => path.endsWith("/merge_requests/17/commits")))
      .toEqual(["/api/v4/projects/gitlab-org%2Fgitlab/merge_requests/17/commits"]);
    expect(issues[0]!.history).toHaveLength(2);
    expect(issues[0]!.comments).toHaveLength(2);
    expect(issues[0]!.closingPullRequests).toHaveLength(1);
  });

  it("reads timelines for every listed issue; the targeting controls do not gate the reads", async () => {
    const bareRequests: string[] = [];
    const optionedRequests: string[] = [];
    const routerFor = (record: string[]) => async (input: RequestInfo | URL) => {
      const request = new Request(input);
      record.push(new URL(request.url).pathname);
      const body = request.url.includes("/issues")
        && !request.url.includes("/resource_label_events")
        && !request.url.includes("/notes")
        && !request.url.includes("/closed_by")
        ? [issue] : [];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const bare = await gateway(routerFor(bareRequests))
      .listIssues({ owner: "gitlab-org", name: "gitlab" });
    const optioned = await gateway(routerFor(optionedRequests)).listIssues(
      { owner: "gitlab-org", name: "gitlab" },
      {
        since: "2026-09-11T00:00:00.000Z",
        timelineCriticalLabels: new Set(["delivered::6"]),
        timelineWatchedLabels: new Set(["offered::3"]),
      },
    );
    // The targeting controls select embedded-timeline refreshes on GitHub;
    // GitLab embeds no timeline, so the per-issue reads happen either way.
    // The equalities are only meaningful against non-empty records: assert
    // the per-issue reads happened on BOTH sides before comparing them, so
    // an empty sweep (a mutant that returns empty slices without fetching)
    // can no longer satisfy the differential.
    const bareLabelEventPaths = bareRequests.filter((path) => path.endsWith("/resource_label_events"));
    const optionedLabelEventPaths = optionedRequests.filter((path) => path.endsWith("/resource_label_events"));
    expect(bareLabelEventPaths).toHaveLength(1);
    expect(optionedLabelEventPaths).toHaveLength(1);
    expect(optionedLabelEventPaths).toEqual(bareLabelEventPaths);
    const bareNotePaths = bareRequests.filter((path) => path.endsWith("/notes"));
    const optionedNotePaths = optionedRequests.filter((path) => path.endsWith("/notes"));
    expect(bareNotePaths).toHaveLength(1);
    expect(optionedNotePaths).toHaveLength(1);
    expect(optionedNotePaths).toEqual(bareNotePaths);
    expect(bare).toHaveLength(1);
    expect(optioned).toHaveLength(1);
  });

  it("fails the issue read loudly when a timeline surface refuses", async () => {
    const client = gateway(jsonRouter([
      ["/resource_label_events", { message: "403 Forbidden" }, 403],
      ["/notes", []],
      ["/closed_by", []],
      ["/issues", [issue]],
    ]));
    await expect(client.listIssues({ owner: "gitlab-org", name: "gitlab" }))
      .rejects.toMatchObject({ name: "GitLabApiError", status: 403 });
  });

  // Issue 563: a GitLab issue deleted between the listing request and its
  // per-issue evidence reads answers 404 on the evidence endpoint. That is
  // definitive for that issue alone — the listing resolves without it and the
  // reconciliation run completes for the remaining issues. The repository
  // itself is not gone, so the run must not be recorded as failed.
  it("resolves the listing without an issue whose evidence read answers 404 mid-pass", async () => {
    const client = gateway(jsonRouter([
      ["/issues/12/resource_label_events", []],
      ["/issues/12/notes", []],
      ["/issues/12/closed_by", []],
      ["/issues/13/resource_label_events", { message: "404 Not Found" }, 404],
      ["/issues/13/notes", []],
      ["/issues/13/closed_by", []],
      ["/issues?", [issue, { ...issue, iid: 13, id: 6_600_002 }]],
    ]));
    // The skip is logged, never silent: on a list endpoint a silent skip is
    // easy to misread as "no issues".
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const issues = await client.listIssues({ owner: "gitlab-org", name: "gitlab" });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ id: 6_600_001, number: 12 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("gitlab-org/gitlab");
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("13");
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The boundary the omission must not widen: the listing request's own 404
  // keeps its repository-level meaning (the repository is gone), so it still
  // fails the listing.
  it("fails the whole listing when the issues listing itself answers 404", async () => {
    const client = gateway(jsonRouter([
      ["/issues?", { message: "404 Not Found" }, 404],
    ]));
    await expect(client.listIssues({ owner: "gitlab-org", name: "gitlab" }))
      .rejects.toMatchObject({ name: "GitLabApiError", status: 404 });
  });

  // Negative control for the catch being 404-only: a server error on an
  // issue's evidence read is an upstream problem, not a deletion witness, so
  // it still propagates and fails the run.
  it("propagates a 500 from an issue's evidence read instead of omitting the issue", async () => {
    const client = gateway(jsonRouter([
      ["/issues/12/resource_label_events", []],
      ["/issues/12/notes", []],
      ["/issues/12/closed_by", []],
      ["/issues/13/resource_label_events", { message: "500 Internal Server Error" }, 500],
      ["/issues/13/notes", []],
      ["/issues/13/closed_by", []],
      ["/issues?", [issue, { ...issue, iid: 13, id: 6_600_002 }]],
    ]));
    await expect(client.listIssues({ owner: "gitlab-org", name: "gitlab" }))
      .rejects.toMatchObject({ name: "GitLabApiError", status: 500 });
  });

  it("walks a second page of a per-issue collection on the x-next-page header", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      const request = new Request(input);
      requests.push(request.url);
      if (request.url.includes("/notes")) {
        if (request.url.includes("page=2")) {
          return new Response(JSON.stringify([editedNote]), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify([note]), {
          status: 200,
          headers: { "content-type": "application/json", "x-next-page": "2" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const comments = await client.listIssueComments({ owner: "gitlab-org", name: "gitlab" }, 12);
    expect(comments.map((comment) => comment.id)).toEqual(["305", "306"]);
    const notePages = requests.filter((url) => url.includes("/notes"));
    expect(notePages).toHaveLength(2);
    expect(notePages[0]).toContain("page=1");
    expect(notePages[1]).toContain("page=2");
  });

  it("throws loudly on a malformed x-next-page header instead of looping or truncating", async () => {
    // A bounded mock: under the guard deleted, a malformed header would loop
    // the walk forever; the mock 503s after three requests so the mutant
    // fails fast on a non-matching error instead of burning the test timeout.
    const serve = (header: string) => {
      let hits = 0;
      return gateway(async () => {
        hits += 1;
        if (hits > 3) return new Response("pagination loop", { status: 503 });
        return new Response(JSON.stringify([note]), {
          status: 200,
          headers: { "content-type": "application/json", "x-next-page": header },
        });
      });
    };
    const repository = { owner: "gitlab-org", name: "gitlab" };
    // Non-numeric, and non-advancing: neither may loop the walk nor end it.
    await expect(serve("abc").listIssueComments(repository, 12))
      .rejects.toThrow(/invalid x-next-page/);
    await expect(serve("1").listIssueComments(repository, 12))
      .rejects.toThrow(/invalid x-next-page/);
  });

  it("skips a label event whose label name is empty", async () => {
    const client = gateway(async (input) => {
      const request = new Request(input);
      if (request.url.includes("/resource_label_events")) {
        return new Response(JSON.stringify([addedLabelEvent, emptyNameLabelEvent, deletedLabelEvent]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const history = await client.listIssueLabelEvents({ owner: "gitlab-org", name: "gitlab" }, 12);
    // The union carries ASSIGNED/UNASSIGNED arms without a label field, so
    // the assertion matches on whole events rather than projecting .label.
    expect(history).toEqual([
      expect.objectContaining({ kind: "LABELED", id: "142", label: "delivered::6" }),
    ]);
  });

  it("keeps a note that omits the system field entirely; only system true drops", async () => {
    const client = gateway(async (input) => {
      const request = new Request(input);
      if (request.url.includes("/notes")) {
        return new Response(JSON.stringify([systemNote, unmarkedNote]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const comments = await client.listIssueComments({ owner: "gitlab-org", name: "gitlab" }, 12);
    expect(comments.map((comment) => comment.id)).toEqual(["307"]);
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
      ["/resource_label_events", []],
      ["/notes", []],
      ["/closed_by", []],
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
      // Only the issue listing answers with issues; every per-issue timeline
      // surface answers empty so the fixture never feeds an issue object to
      // the merge-request parser.
      if (!new URL(request.url).pathname.endsWith("/issues")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([issue]), { status: 200, headers: { "content-type": "application/json" } });
    });
    await client.listIssues({ owner: "gitlab-org", name: "gitlab" }, { since: "2026-09-11T00:00:00.000Z" });
    expect(requests.some((url) => url.includes("updated_after=2026-09-11T00%3A00%3A00.000Z"))).toBe(true);
  });

  it("uses created_at keyset ordering and follows x-next-cursor for 101 issues", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      const request = new Request(input);
      requests.push(request.url);
      const listPage = request.url.includes("updated_after") || new URL(request.url).pathname.endsWith("/issues");
      if (!listPage) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requests.filter((url) => new URL(url).pathname.endsWith("/issues")).length > 2) {
        return new Response("pagination loop", { status: 503 });
      }
      if (request.url.includes("cursor=")) {
        return new Response(JSON.stringify([{ ...issue, iid: 112 }]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...issue, iid: index + 12 }))), {
        status: 200,
        headers: { "content-type": "application/json", "x-next-cursor": "cursor-after-page-1" },
      });
    });
    const issues = await client.listIssues({ owner: "gitlab-org", name: "gitlab" });
    expect(issues).toHaveLength(101);
    expect(issues.at(-1)?.number).toBe(112);
    const issuePages = requests.filter((url) => new URL(url).pathname.endsWith("/issues"));
    expect(issuePages).toHaveLength(2);
    expect(new URL(issuePages[0]!).search).toBe("?per_page=100&pagination=keyset&order_by=created_at&sort=asc");
    expect(issuePages[1]).toContain("cursor=cursor-after-page-1");
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
