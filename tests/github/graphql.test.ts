import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubGraphqlClient } from "@/lib/github/graphql";

describe("GitHubGraphqlClient failures", () => {
  it("surfaces GitHub RATE_LIMIT type and message through the gateway", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        errors: [{
          type: "RATE_LIMIT",
          code: "graphql_rate_limit",
          message: "API rate limit already exceeded for user ID 75166987.",
        }],
      }),
    });

    await expect(gateway.listIssues({ owner: "octo", name: "overflow" })).rejects.toThrow(
      /RATE_LIMIT.*API rate limit already exceeded for user ID 75166987\./,
    );
  });

  it("includes multiple errors and their supplied paths even alongside partial data", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        data: { repository: null },
        errors: [
          { type: "FORBIDDEN", message: "Resource not accessible", path: ["repository", "issues", 0] },
          { type: "undefinedField", message: "Field removed", path: ["query", "repository", "oldField"] },
        ],
      }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(
      /FORBIDDEN.*Resource not accessible.*\["repository","issues",0\].*undefinedField.*Field removed.*\["query","repository","oldField"\]/,
    );
  });

  it.each([
    {}, { errors: null }, { errors: "bad" }, { errors: {} }, { errors: 42 },
    { errors: [] }, { errors: [null, false, 42, "bad", []] },
    { errors: [{}] }, { errors: [{ type: {}, message: [], path: {} }] },
    null,
  ])("normalizes malformed or missing errors to a readable failure: %j", async (payload) => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json(payload),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub GraphQL request failed\./);
  });

  it.each([
    [{ type: "FORBIDDEN" }, "FORBIDDEN"],
    [{ message: "Field removed" }, "Field removed"],
    [{ type: "FORBIDDEN", message: "Denied", path: [null, {}] }, "Denied"],
  ])("keeps available fields when other fields are missing or malformed: %j", async (entry, detail) => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json({ errors: [null, entry] }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(String(detail));
  });

  it("bounds the summary to five errors and 512 characters per field with truncation markers", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json({ errors: [
        ...Array.from({ length: 5 }, (_, index) => ({
          type: `ERROR_${index}${"t".repeat(10_000)}`,
          message: `message_${index}${"m".repeat(10_000)}`,
          path: Array.from({ length: 100 }, () => "p".repeat(10_000)),
        })),
        { type: "OMITTED", message: "must not appear" },
      ] }),
    });

    const error = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("ERROR_4");
    expect(message).toContain("message_4");
    expect(message).toContain("OMITTED");
    expect(message).toContain("1 more error(s) without full details");
    expect(message).not.toContain("m".repeat(513));
    expect(message).toContain("…");
    expect(message).toContain("1 more error");
    expect(message.length).toBeLessThanOrEqual(8_000);
  });

  it("aborts a stalled request with the exact existing timeout message", async () => {
    let signal: AbortSignal | null | undefined;
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      timeoutMs: 1,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new Error("private details")), { once: true });
      }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub request timed out\.$/);
    expect(signal?.aborted).toBe(true);
  });

  it("preserves the exact non-2xx message without the response body", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => new Response("private details", { status: 502 }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub API request failed with status 502\.$/);
  });

  it.each([
    new Error("private network details"), "private rejection", null,
    new Error("GitHub request timed out."),
    new Error("GitHub API request failed with status 401."),
  ])("normalizes unrelated rejections structurally: %j", async (failure) => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => { throw failure; },
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub GraphQL request failed\.$/);
  });

  it("normalizes JSON parse failures", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => new Response("private invalid JSON"),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub GraphQL request failed\.$/);
  });
});

describe("GitHubGraphqlClient diagnostic retention", () => {
  async function failureFor(errors: unknown): Promise<Error> {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json({ errors }),
    });
    const failure = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    return failure as Error;
  }

  it("retains a sixth RATE_LIMIT category after five schema errors", async () => {
    const error = await failureFor([
      ...Array.from({ length: 5 }, () => ({ type: "undefinedField", message: "Field removed" })),
      { type: "RATE_LIMIT", message: "Rate limit exceeded" },
    ]);

    expect(error.message).toContain("RATE_LIMIT");
    expect(error.message).toContain("undefinedField: Field removed");
    expect(error.message).toContain("RATE_LIMIT: Rate limit exceeded");
    expect(error.message).toContain("4 duplicate error(s) collapsed");
  });

  it.each([
    { label: "identical errors", entry: { type: "RATE_LIMIT", message: "Denied" } },
    { label: "malformed entries", entry: null },
    { label: "long identical types", entry: { type: "t".repeat(512), message: "Denied" } },
  ])("bounds 100,000 $label to the aggregate summary budget", async ({ entry }) => {
    const error = await failureFor(Array.from({ length: 100_000 }, () => entry));

    expect(error.message.length).toBeLessThanOrEqual(8_000);
    expect(error.message).toContain("99999 duplicate error(s) collapsed");
  });

  it("collapses identical pairs while keeping the first occurrence's path", async () => {
    const error = await failureFor([
      { type: "RATE_LIMIT", message: "Denied", path: ["first"] },
      { type: "RATE_LIMIT", message: "Denied", path: ["second"] },
      { type: "RATE_LIMIT", message: "Denied", path: ["third"] },
    ]);

    expect(error.message).toBe('GitHub GraphQL request failed. RATE_LIMIT: Denied path=["first"]; … 2 duplicate error(s) collapsed');
  });

  it("keeps distinct pairs with a shared type or message separate", async () => {
    const error = await failureFor([
      { type: "FORBIDDEN", message: "First reason" },
      { type: "FORBIDDEN", message: "Second reason" },
      { type: "RATE_LIMIT", message: "Second reason" },
      { type: "FORBIDDEN", message: "First reason" },
    ]);

    expect(error.message).toBe("GitHub GraphQL request failed. FORBIDDEN: First reason; FORBIDDEN: Second reason; RATE_LIMIT: Second reason; … 1 duplicate error(s) collapsed");
  });

  it("deduplicates types after five distinct full pairs and counts entries lacking full details", async () => {
    const error = await failureFor([
      ...Array.from({ length: 5 }, (_, index) => ({ type: "SCHEMA", message: `Field ${index}` })),
      { type: "RATE_LIMIT", message: "First limit" },
      { type: "RATE_LIMIT", message: "Second limit" },
      { type: "RATE_LIMIT", message: "First limit" },
    ]);

    expect(error.message).toBe("GitHub GraphQL request failed. SCHEMA: Field 0; SCHEMA: Field 1; SCHEMA: Field 2; SCHEMA: Field 3; SCHEMA: Field 4; RATE_LIMIT; … 3 more error(s) without full details");
  });

  it("marks aggregate overflow and counts every entry without full details", async () => {
    const error = await failureFor(Array.from({ length: 100_000 }, (_, index) => ({
      type: `TYPE_${index}_${"t".repeat(500)}`,
      message: "Denied",
    })));

    expect(error.message.length).toBeLessThanOrEqual(8_000);
    expect(error.message).toContain("99995 more error(s) without full details");
    expect(error.message).toContain("summary budget exceeded");
    expect(() => encodeURIComponent(error.message)).not.toThrow();
  });

  function maximumFullEntries() {
    return Array.from({ length: 5 }, (_, index) => ({
      type: `${index}${"t".repeat(511)}`,
      message: "m".repeat(512),
      path: Array.from({ length: 11 }, () => "p".repeat(46)),
    }));
  }

  it("retains the 7674-unit maximum full prefix within the aggregate ceiling", async () => {
    const error = await failureFor(maximumFullEntries());

    expect(error.message.length).toBeLessThanOrEqual(8_000);
    expect(error.message.length).toBe(7_674);
  });

  it.each([
    { tailLength: 221, expectedLength: 8_000, retained: true },
    { tailLength: 222, expectedLength: 7_777, retained: false },
    { tailLength: 324, expectedLength: 7_777, retained: false },
  ])("checks the exact aggregate boundary with a $tailLength-unit tail type", async ({ tailLength, expectedLength, retained }) => {
    const fullEntries = maximumFullEntries();
    const tailType = "a".repeat(tailLength);
    // 25 entries: both counts have the same two-digit width as the input
    // length. The 103-unit suffix leaves 7,897 units for rendered details.
    const error = await failureFor([
      ...fullEntries,
      ...Array.from({ length: 10 }, () => fullEntries[0]),
      { type: tailType, message: "Tail detail" },
      ...Array.from({ length: 9 }, () => ({ type: "z".repeat(512), message: "Overflow" })),
    ]);

    expect(error.message.length).toBeLessThanOrEqual(8_000);
    expect(error.message.length).toBe(expectedLength);
    expect(error.message.includes(`; ${tailType};`)).toBe(retained);
    expect(error.message).toContain("10 duplicate error(s) collapsed");
    expect(error.message).toContain("10 more error(s) without full details");
    expect(error.message).toContain("summary budget exceeded");
  });

  it.each(["type", "message", "path", "later type"])("redacts repeated reflected tokens in %s", async (field) => {
    const reflected = "before test-access-token middle test-access-token after";
    const entry = {
      type: field === "type" || field === "later type" ? reflected : "FORBIDDEN",
      message: field === "message" ? reflected : "Denied",
      path: field === "path" ? [reflected] : ["repository"],
    };
    const entries = field === "later type"
      ? [...Array.from({ length: 5 }, (_, index) => ({ type: "undefinedField", message: `Field ${index}` })), entry]
      : [entry];
    const error = await failureFor(entries);

    expect(error.message).not.toContain("test-access-token");
    expect(error.message).toContain("[REDACTED]");
  });

  it.each([511, 512, 513])("retains type text deliberately at length %i", async (length) => {
    const error = await failureFor([{ type: "t".repeat(length), message: "Denied" }]);
    const expectedType = length === 513 ? `${"t".repeat(511)}…` : "t".repeat(length);

    expect(error.message).toBe(`GitHub GraphQL request failed. ${expectedType}: Denied`);
  });

  it.each([511, 512, 513])("retains message text deliberately at length %i", async (length) => {
    const error = await failureFor([{ type: "FORBIDDEN", message: "m".repeat(length) }]);
    const expectedMessage = length === 513 ? `${"m".repeat(511)}…` : "m".repeat(length);

    expect(error.message).toBe(`GitHub GraphQL request failed. FORBIDDEN: ${expectedMessage}`);
  });

  it.each(["type", "message"])("does not split a surrogate pair when truncating %s", async (field) => {
    const text = `${"a".repeat(510)}😀b`;
    const error = await failureFor([{
      type: field === "type" ? text : "FORBIDDEN",
      message: field === "message" ? text : "Denied",
    }]);
    const retained = `${"a".repeat(510)}…`;

    expect(error.message).toBe(field === "type"
      ? `GitHub GraphQL request failed. ${retained}: Denied`
      : `GitHub GraphQL request failed. FORBIDDEN: ${retained}`);
    expect(() => encodeURIComponent(error.message)).not.toThrow();
  });

  it("keeps a complete path preview and later segments after a long first segment", async () => {
    const error = await failureFor([{
      type: "FORBIDDEN",
      message: "Denied",
      path: ["p".repeat(512), "issues", 0, "title"],
    }]);
    const preview = error.message.split(" path=")[1];

    expect(preview.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(preview)).toEqual([`${"p".repeat(45)}…`, "issues", 0, "title"]);
  });

  it("bounds escaped path strings without breaking JSON or Unicode", async () => {
    const error = await failureFor([{
      type: "FORBIDDEN",
      message: "Denied",
      path: Array.from({ length: 11 }, () => `${"\u0000".repeat(7)}😀\\\"more`),
    }]);
    const preview = error.message.split(" path=")[1];

    expect(preview.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(preview)).toEqual([
      ...Array.from({ length: 10 }, () => `${"\u0000".repeat(7)}😀…`), "…",
    ]);
  });

  it("distinguishes a malformed path segment from a genuine question mark", async () => {
    const error = await failureFor([{ type: "FORBIDDEN", message: "Denied", path: ["?", {}] }]);

    expect(error.message).toContain('path=["?",null]');
  });

  it.each([
    [10, '["s0","s1","s2","s3","s4","s5","s6","s7","s8","s9"]'],
    [11, '["s0","s1","s2","s3","s4","s5","s6","s7","s8","s9","…"]'],
  ])("retains the first ten short path segments and marks omission at length %i", async (length, preview) => {
    const error = await failureFor([{
      type: "FORBIDDEN",
      message: "Denied",
      path: Array.from({ length: Number(length) }, (_, index) => `s${index}`),
    }]);

    expect(error.message).toBe(`GitHub GraphQL request failed. FORBIDDEN: Denied path=${preview}`);
  });

  it("keeps surfaced whitespace on one log line in every field", async () => {
    const error = await failureFor([{
      type: "FOR\nBIDDEN\tTYPE",
      message: "Access\ndenied\there",
      path: ["repo\nsitory", "is\tsues"],
    }]);

    expect(error.message).toBe('GitHub GraphQL request failed. FOR BIDDEN TYPE: Access denied here path=["repo sitory","is sues"]');
  });

  it("preserves the exact timeout when fetch resolves after abort", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      timeoutMs: 1,
      fetch: async (_input, init) => new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(Response.json({ data: { ok: true } })), { once: true });
      }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub request timed out\.$/);
  });

  it("rethrows an existing GitHub request error with its object identity intact", async () => {
    const original = await failureFor([{ type: "RATE_LIMIT", message: "Limit exceeded" }]);
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => { throw original; },
    });

    await expect(client.query("query {}", {})).rejects.toBe(original);
  });

  it.each([{ errors: [] }, { errors: null }])("intentionally rejects usable data with any defined errors member: %j", async ({ errors }) => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => Response.json({ data: { repository: { name: "overflow" } }, errors }),
    });

    await expect(client.query("query {}", {})).rejects.toThrow(/^GitHub GraphQL request failed\.$/);
  });
});

describe("GitHubGateway GraphQL source adapter", () => {
  it("collects paginated immutable issue label, assignment, and owner-comment history", async () => {
    const historyCursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { cursor: string | null; issueNumber?: number };
        };
        if (request.query.includes("query RepositoryIssues")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [
                    {
                      ...issueNode(101, 1, "History issue"),
                      createdAt: "2026-08-30T09:00:00.000Z",
                      author: { login: "owner" },
                      timelineItems: {
                        nodes: [
                          {
                            __typename: "LabeledEvent",
                            id: "label-event-1",
                            createdAt: "2026-08-30T10:00:00.000Z",
                            actor: { login: "owner" },
                            label: { name: "size/M" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "history-cursor-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }

        historyCursors.push(request.variables.cursor);
        return Response.json({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  nodes: [
                    {
                      __typename: "AssignedEvent",
                      id: "assignment-event-1",
                      createdAt: "2026-08-31T09:00:00.000Z",
                      actor: { login: "owner" },
                      assignee: { login: "contributor" },
                    },
                    {
                      __typename: "IssueComment",
                      id: "comment-node-1",
                      databaseId: 501,
                      createdAt: "2026-09-01T11:30:00.000Z",
                      author: { login: "owner" },
                      body: "Owner rationale for delivered/6.",
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues[0]).toMatchObject({
      authorLogin: "owner",
      createdAt: "2026-08-30T09:00:00.000Z",
      history: [
        {
          kind: "LABELED",
          id: "label-event-1",
          actorLogin: "owner",
          label: "size/M",
          createdAt: "2026-08-30T10:00:00.000Z",
        },
        {
          kind: "ASSIGNED",
          id: "assignment-event-1",
          actorLogin: "owner",
          assigneeLogin: "contributor",
          createdAt: "2026-08-31T09:00:00.000Z",
        },
      ],
      comments: [
        {
          id: "comment-node-1",
          databaseId: 501,
          authorLogin: "owner",
          body: "Owner rationale for delivered/6.",
          createdAt: "2026-09-01T11:30:00.000Z",
        },
      ],
    });
    expect(historyCursors).toEqual(["history-cursor-2"]);
  });

  it("collects every cursor-paginated issue page from GitHub GraphQL", async () => {
    const cursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.github.com/graphql");
        const request = JSON.parse(String(init?.body)) as {
          variables: { cursor: string | null };
        };
        cursors.push(request.variables.cursor);

        if (request.variables.cursor === null) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [issueNode(101, 1, "First issue")],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                },
              },
            },
          });
        }

        return Response.json({
          data: {
            repository: {
              issues: {
                nodes: [issueNode(102, 2, "Second issue")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    });

    await expect(gateway.listIssues({ owner: "octo", name: "overflow" })).resolves.toEqual([
      {
        id: 101,
        number: 1,
        title: "First issue",
        body: "Issue body",
        url: "https://github.com/octo/overflow/issues/1",
        state: "OPEN",
        createdAt: "2026-08-30T09:00:00.000Z",
        authorLogin: "owner",
        labels: ["size/M"],
        claimAssigneeGitHubLogin: null,
        history: [],
        comments: [],
      },
      {
        id: 102,
        number: 2,
        title: "Second issue",
        body: "Issue body",
        url: "https://github.com/octo/overflow/issues/2",
        state: "OPEN",
        createdAt: "2026-08-30T09:00:00.000Z",
        authorLogin: "owner",
        labels: ["size/M"],
        claimAssigneeGitHubLogin: null,
        history: [],
        comments: [],
      },
    ]);
    expect(cursors).toEqual([null, "cursor-2"]);
  });

  it("maps only one unambiguous GraphQL assignee as an issue claim lock", async () => {
    let query = "";
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issues: {
                nodes: [
                  issueNode(101, 1, "One assignee", undefined, [{ login: "claim-holder" }]),
                  issueNode(102, 2, "No assignee", undefined, []),
                  issueNode(103, 3, "Several assignees", undefined, [
                    { login: "first" },
                    { login: "second" },
                  ]),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues.map((issue) => issue.claimAssigneeGitHubLogin)).toEqual([
      "claim-holder",
      null,
      null,
    ]);
    expect(query).toMatch(/assignees\(first:\s*2\)/);
  });

  it("collects labels after the first one hundred nodes for every returned issue", async () => {
    const labelRequests: Array<{ issueNumber: number; cursor: string | null }> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { cursor: string | null; issueNumber?: number };
        };

        if (request.query.includes("query RepositoryIssues")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [
                    issueNode(101, 1, "First issue", firstLabelPage("issue-one")),
                    issueNode(102, 2, "Second issue", firstLabelPage("issue-two")),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }

        labelRequests.push({
          issueNumber: request.variables.issueNumber ?? 0,
          cursor: request.variables.cursor,
        });
        return Response.json({
          data: {
            repository: {
              issue: {
                labels: {
                  nodes: [{ name: `required/${request.variables.issueNumber}` }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues.map((issue) => issue.labels)).toEqual([
      [...firstHundredLabels("issue-one"), "required/1"],
      [...firstHundredLabels("issue-two"), "required/2"],
    ]);
    expect(labelRequests).toEqual([
      { issueNumber: 1, cursor: "issue-one-label-cursor" },
      { issueNumber: 2, cursor: "issue-two-label-cursor" },
    ]);
  });

  it("takes closing pull request links only from closedByPullRequestsReferences", async () => {
    let query = "";
    let askedForRestTimeline = false;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        if (String(input) !== "https://api.github.com/graphql") {
          askedForRestTimeline = true;
          return Response.json({
            event: "cross-referenced",
            source: { issue: { number: 999 } },
          });
        }

        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    await expect(
      gateway.getIssueClosingPullRequests({ owner: "octo", name: "overflow" }, 1),
    ).resolves.toEqual([
      {
        id: 201,
        number: 4,
        title: "Closes the issue",
        body: "Pull request body",
        url: "https://github.com/octo/overflow/pull/4",
        state: "MERGED",
        mergedAt: "2026-09-04T12:00:00.000Z",
        mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
        finalCommitAt: "2026-09-04T10:00:00.000Z",
        authorLogin: "contributor",
      },
    ]);
    expect(query).toMatch(/closedByPullRequestsReferences\(first:\s*100/);
    expect(query).toContain("includeClosedPrs: true");
    expect(query).not.toContain("timelineItems");
    expect(askedForRestTimeline).toBe(false);
  });

  it("carries the exact merge commit OID and final PR commit time from GraphQL", async () => {
    let query = "";
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const [pullRequest] = await gateway.getIssueClosingPullRequests(
      { owner: "octo", name: "overflow" },
      1,
    );

    expect(pullRequest).toMatchObject({
      mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
      finalCommitAt: "2026-09-04T10:00:00.000Z",
    });
    expect(query).toMatch(/mergeCommit\s*\{\s*oid\s*\}/);
    expect(query).toMatch(/commits\(last:\s*1\)/);
  });

  it("does not request mutable pull-request labels for settlement pricing", async () => {
    const queries: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        queries.push(request.query);
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4), pullRequestNode(202, 5)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const pullRequests = await gateway.getIssueClosingPullRequests(
      { owner: "octo", name: "overflow" },
      1,
    );

    expect(pullRequests).toHaveLength(2);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/pullRequest\(number:.*labels/s);
  });

  it("collects pull request reviews through cursor-paginated GraphQL", async () => {
    const cursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: { cursor: string | null };
        };
        cursors.push(request.variables.cursor);
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes:
                    request.variables.cursor === null
                      ? [reviewNode(301, "CHANGES_REQUESTED")]
                      : [reviewNode(302, "APPROVED")],
                  pageInfo:
                    request.variables.cursor === null
                      ? { hasNextPage: true, endCursor: "review-cursor-2" }
                      : { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    await expect(
      gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4),
    ).resolves.toEqual([
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-04T12:00:00.000Z" },
      { id: 302, state: "APPROVED", submittedAt: "2026-09-04T12:00:00.000Z" },
    ]);
    expect(cursors).toEqual([null, "review-cursor-2"]);
  });
});

function issueNode(
  id: number,
  number: number,
  title: string,
  labels: LabelConnectionFixture = {
    nodes: [{ name: "size/M" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  assignees: Array<{ login: string }> = [],
) {
  return {
    databaseId: id,
    number,
    title,
    body: "Issue body",
    url: `https://github.com/octo/overflow/issues/${number}`,
    state: "OPEN",
    createdAt: "2026-08-30T09:00:00.000Z",
    author: { login: "owner" },
    labels,
    assignees: { nodes: assignees },
    timelineItems: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function pullRequestNode(
  id: number,
  number: number,
) {
  return {
    databaseId: id,
    number,
    title: "Closes the issue",
    body: "Pull request body",
    url: `https://github.com/octo/overflow/pull/${number}`,
    state: "MERGED",
    mergedAt: "2026-09-04T12:00:00.000Z",
    mergeCommit: { oid: "0123456789abcdef0123456789abcdef01234567" },
    commits: {
      nodes: [{ commit: { committedDate: "2026-09-04T10:00:00.000Z" } }],
    },
    author: { login: "contributor" },
  };
}

function reviewNode(id: number, state: string) {
  return {
    databaseId: id,
    state,
    submittedAt: "2026-09-04T12:00:00.000Z",
  };
}

function firstLabelPage(prefix: string) {
  return {
    nodes: firstHundredLabels(prefix).map((name) => ({ name })),
    pageInfo: { hasNextPage: true, endCursor: `${prefix}-label-cursor` },
  };
}

type LabelConnectionFixture = {
  nodes: Array<{ name: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

function firstHundredLabels(prefix: string): string[] {
  return Array.from({ length: 100 }, (_, index) => `${prefix}/${index + 1}`);
}
