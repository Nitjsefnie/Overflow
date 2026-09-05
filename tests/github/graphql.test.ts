import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubApiError } from "@/lib/github/errors";
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
  it("logs optional per-page cost only with DEBUG_GITHUB_COST enabled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const queries: string[] = [];
    let includeRateLimit = true;
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async (_input, init) => {
        queries.push(JSON.parse(String(init?.body)).query);
        return Response.json({ data: {
          repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          ...(includeRateLimit ? { rateLimit: { cost: 17, remaining: 4983 } } : {}),
        } });
      },
    });
    try {
      vi.stubEnv("DEBUG_GITHUB_COST", undefined);
      await gateway.listIssues({ owner: "octo", name: "overflow" });
      expect(info).not.toHaveBeenCalled();
      vi.stubEnv("DEBUG_GITHUB_COST", "1");
      await gateway.listIssues({ owner: "octo", name: "overflow" });
      expect(info.mock.calls).toEqual([["GitHub RepositoryIssues cost", {
        repository: "octo/overflow", cursor: null, cost: 17, remaining: 4983,
      }]]);
      includeRateLimit = false;
      await expect(gateway.listIssues({ owner: "octo", name: "overflow" })).resolves.toEqual([]);
      expect(info).toHaveBeenCalledTimes(1);
      expect(queries.every((query) => /rateLimit\s*\{\s*cost\s+remaining\s*\}/.test(query))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      info.mockRestore();
    }
  });

  it.each([
    { connection: "labels", first: 20, total: 25, operation: "IssueLabels" },
    { connection: "timelineItems", first: 50, total: 60, operation: "IssueTimeline" },
  ])("assembles all $total $connection from a smaller nested page and its remainder", async ({ connection, first, total, operation }) => {
    const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
    const queries: string[] = [];
    const nodes = Array.from({ length: total }, (_, index) => connection === "labels"
      ? { name: `label-${index}` }
      : {
          __typename: "LabeledEvent", id: `event-${index}`, actor: { login: "owner" },
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(), label: { name: `label-${index}` },
        });
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async (_input, init) => {
        const { query, variables } = JSON.parse(String(init?.body));
        const requestedOperation = /query (\w+)/.exec(query)![1]!;
        requests.push({ operation: requestedOperation, variables });
        queries.push(query);
        if (requestedOperation === "RepositoryIssues") {
          return Response.json({ data: { repository: { issues: {
            nodes: [{ ...issueNode(101, 1, "Overflow"), [connection]: {
              nodes: nodes.slice(0, first), pageInfo: { hasNextPage: true, endCursor: "nested-next" },
            } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } } });
        }
        return Response.json({ data: { repository: { issue: { [connection]: {
          nodes: nodes.slice(first), pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      },
    });
    const [issue] = await gateway.listIssues({ owner: "octo", name: "overflow" });
    expect(connection === "labels" ? issue?.labels : issue?.history.map((event) => event.id))
      .toEqual(Array.from({ length: total }, (_, index) => `${connection === "labels" ? "label" : "event"}-${index}`));
    expect(requests).toEqual([
      { operation: "RepositoryIssues", variables: { owner: "octo", name: "overflow", cursor: null } },
      { operation, variables: { owner: "octo", name: "overflow", issueNumber: 1, cursor: "nested-next" } },
    ]);
    expect(queries[0]).toMatch(new RegExp(`${connection}\\(\\s*first: ${first}\\b`));
  });

  it("appends closing references after the nested twenty using one overflow request", async () => {
    const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
    const nodes = Array.from({ length: 21 }, (_, index) => pullRequestNode(201 + index, 11 + index));
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async (_input, init) => {
        const { query, variables } = JSON.parse(String(init?.body));
        const operation = /query (\w+)/.exec(query)![1]!;
        requests.push({ operation, variables });
        if (operation === "RepositoryIssues") {
          return Response.json({ data: { repository: { issues: {
            nodes: [{ ...issueNode(101, 1, "Many references"), closedByPullRequestsReferences: {
              nodes: nodes.slice(0, 20), pageInfo: { hasNextPage: true, endCursor: "closing-next" },
            } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } } });
        }
        return Response.json({ data: { repository: { issue: { closedByPullRequestsReferences: {
          nodes: nodes.slice(20), pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      },
    });

    const [issue] = await gateway.listIssues({ owner: "octo", name: "overflow" });
    expect(issue?.closingPullRequests).toEqual(nodes.map((node) => ({
      id: node.databaseId, number: node.number, title: node.title, body: node.body, url: node.url,
      state: node.state, mergedAt: node.mergedAt, mergeCommitOid: node.mergeCommit.oid,
      finalCommitAt: node.commits.nodes[0]!.commit.committedDate, authorLogin: node.author.login,
    })));
    expect(requests).toEqual([
      { operation: "RepositoryIssues", variables: { owner: "octo", name: "overflow", cursor: null } },
      { operation: "ClosingPullRequests", variables: {
        owner: "octo", name: "overflow", issueNumber: 1, cursor: "closing-next",
      } },
    ]);
  });

  it("collects paginated immutable issue label, assignment, and owner-comment history", async () => {
    const historyCursors: Array<string | null> = [];
    const queries: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { cursor: string | null; issueNumber?: number };
        };
        queries.push(request.query);
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
                      lastEditedAt: "2026-09-01T11:35:00.000Z",
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
          lastEditedAt: "2026-09-01T11:35:00.000Z",
        },
      ],
    });
    expect(historyCursors).toEqual(["history-cursor-2"]);
    for (const query of queries) {
      expect(query).toMatch(/\.\.\. on IssueComment \{[^}]*lastEditedAt/);
    }
  });

  it.each([
    { response: "null", editField: { lastEditedAt: null } },
    { response: "omitted", editField: {} },
  ])("maps $response lastEditedAt to null for an unedited issue comment", async ({ editField }) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        data: {
          repository: {
            issues: {
              nodes: [{
                ...issueNode(101, 1, "Unedited comment"),
                timelineItems: {
                  nodes: [{
                    __typename: "IssueComment",
                    id: "unedited-comment",
                    databaseId: 502,
                    createdAt: "2026-09-01T11:30:00.000Z",
                    ...editField,
                    author: { login: "owner" },
                    body: "Owner rationale for delivered/6.",
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues[0]?.comments[0]).toMatchObject({
      id: "unedited-comment",
      lastEditedAt: null,
    });
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
        closingPullRequests: [],
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
        closingPullRequests: [],
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
        authorGitHubUserId: 7001,
      },
    ]);
    expect(query).toMatch(/closedByPullRequestsReferences\(first:\s*100/);
    expect(query).toContain("includeClosedPrs: true");
    expect(query).toMatch(/author\s*\{\s*login\s*\.\.\.\s*on\s+User\s*\{\s*databaseId\s*\}\s*\}/);
    expect(query).not.toContain("timelineItems");
    expect(askedForRestTimeline).toBe(false);
  });

  it("preserves distinct author ids for closing pull requests in one response", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        data: {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                nodes: [
                  pullRequestNode(202, 5, { login: "first-contributor", databaseId: 7002 }),
                  pullRequestNode(203, 6, { login: "second-contributor", databaseId: 31337 }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    });

    await expect(
      gateway.getIssueClosingPullRequests({ owner: "octo", name: "overflow" }, 1),
    ).resolves.toEqual([
      expect.objectContaining({ id: 202, authorGitHubUserId: 7002 }),
      expect.objectContaining({ id: 203, authorGitHubUserId: 31337 }),
    ]);
  });

  it("carries no author id when the closing pull request author is not a GitHub user", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () =>
        Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [
                    pullRequestNode(202, 5, { login: "dependabot[bot]" }),
                    pullRequestNode(203, 6, null),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    });

    await expect(
      gateway.getIssueClosingPullRequests({ owner: "octo", name: "overflow" }, 1),
    ).resolves.toEqual([
      expect.objectContaining({ id: 202, authorLogin: "dependabot[bot]", authorGitHubUserId: null }),
      expect.objectContaining({ id: 203, authorLogin: null, authorGitHubUserId: null }),
    ]);
  });

  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "carries no author id for an invalid databaseId of %s",
    async (databaseId) => {
      const gateway = new GitHubGateway({
        accessToken: "test-access-token",
        fetch: async () => Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4, { login: "contributor", databaseId })],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      });

      await expect(
        gateway.getIssueClosingPullRequests({ owner: "octo", name: "overflow" }, 1),
      ).resolves.toEqual([
        expect.objectContaining({ id: 201, authorLogin: "contributor", authorGitHubUserId: null }),
      ]);
    },
  );

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
      authorGitHubUserId: 7001,
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

  it("collects pull request reviews and their dismissals through cursor-paginated GraphQL", async () => {
    const reviewCursors: Array<string | null> = [];
    const dismissalRequests: Array<{
      query: string;
      variables: { owner: string; name: string; pullRequestNumber: number; cursor: string | null };
    }> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { owner: string; name: string; pullRequestNumber: number; cursor: string | null };
        };
        if (request.query.includes("query PullRequestReviewDismissals")) {
          dismissalRequests.push(request);
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  timelineItems: {
                    nodes: request.variables.cursor === null
                      ? [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED", review: { databaseId: 301 } }]
                      : [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T11:00:00.000Z", previousReviewState: "APPROVED", review: { databaseId: 303 } }],
                    pageInfo: request.variables.cursor === null
                      ? { hasNextPage: true, endCursor: "dismissal-cursor-2" }
                      : { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        reviewCursors.push(request.variables.cursor);
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: request.variables.cursor === null
                    ? [{ ...reviewNode(301, "DISMISSED"), submittedAt: "2026-09-04T10:00:00.000Z" }]
                    : [reviewNode(303, "DISMISSED"), reviewNode(302, "APPROVED")],
                  pageInfo: request.variables.cursor === null
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
      {
        id: 301,
        state: "DISMISSED",
        submittedAt: "2026-09-04T10:00:00.000Z",
        dismissal: { at: "2026-09-04T13:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
      {
        id: 303,
        state: "DISMISSED",
        submittedAt: "2026-09-04T12:00:00.000Z",
        dismissal: { at: "2026-09-04T11:00:00.000Z", previousState: "APPROVED" },
      },
      { id: 302, state: "APPROVED", submittedAt: "2026-09-04T12:00:00.000Z", dismissal: null },
    ]);
    expect(reviewCursors).toEqual([null, "review-cursor-2"]);
    expect(dismissalRequests.map((request) => request.variables)).toEqual([
      { owner: "octo", name: "overflow", pullRequestNumber: 4, cursor: null },
      { owner: "octo", name: "overflow", pullRequestNumber: 4, cursor: "dismissal-cursor-2" },
    ]);
    for (const { query } of dismissalRequests) {
      expect(query).toMatch(/timelineItems\([^)]*itemTypes:\s*\[REVIEW_DISMISSED_EVENT\]/);
      expect(query).toMatch(/timelineItems\([^)]*after:\s*\$cursor\b/);
      expect(query).toMatch(/\.\.\. on ReviewDismissedEvent\s*\{[^}]*\bcreatedAt\b/);
      expect(query).toMatch(/\.\.\. on ReviewDismissedEvent\s*\{[^}]*\bpreviousReviewState\b/);
      expect(query).toMatch(/\.\.\. on ReviewDismissedEvent\s*\{[^}]*\breview\s*\{\s*databaseId\s*\}/);
    }
  });

  it("rejects a review with a null database id", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        const connection = request.query.includes("query PullRequestReviewDismissals")
          ? { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
          : { reviews: {
            nodes: [{ ...reviewNode(301, "DISMISSED"), databaseId: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } };
        return Response.json({ data: { repository: { pullRequest: connection } } });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4))
      .rejects.toThrow("GitHub GraphQL response was invalid.");
  });

  it("preserves a null submittedAt for a pending review", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        const connection = request.query.includes("query PullRequestReviewDismissals")
          ? { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
          : { reviews: {
            nodes: [{ ...reviewNode(304, "PENDING"), submittedAt: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } };
        return Response.json({ data: { repository: { pullRequest: connection } } });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4)).resolves.toEqual([
      { id: 304, state: "PENDING", submittedAt: null, dismissal: null },
    ]);
  });

  it.each(["COMMENTED", "APPROVED"])("attaches a dismissal whose previous review state was %s", async (previousState) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        const connection = request.query.includes("query PullRequestReviewDismissals")
          ? { timelineItems: {
            nodes: [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T13:00:00.000Z", previousReviewState: previousState, review: { databaseId: 305 } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } }
          : { reviews: {
            nodes: [reviewNode(305, "DISMISSED")],
            pageInfo: { hasNextPage: false, endCursor: null },
          } };
        return Response.json({ data: { repository: { pullRequest: connection } } });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4)).resolves.toEqual([
      {
        id: 305,
        state: "DISMISSED",
        submittedAt: "2026-09-04T12:00:00.000Z",
        dismissal: { at: "2026-09-04T13:00:00.000Z", previousState },
      },
    ]);
  });

  it.each([
    { response: "no event", nodes: [] },
    {
      response: "null review",
      nodes: [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED", review: null }],
    },
    {
      response: "null review id",
      nodes: [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED", review: { databaseId: null } }],
    },
    {
      response: "unrelated event",
      nodes: [{ __typename: "UnrelatedEvent", createdAt: "2026-09-04T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED", review: { databaseId: 301 } }],
    },
  ])("leaves a dismissed review with $response unattributed", async ({ nodes }) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        if (request.query.includes("query PullRequestReviewDismissals")) {
          return Response.json({
            data: { repository: { pullRequest: { timelineItems: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } },
          });
        }
        return Response.json({
          data: { repository: { pullRequest: { reviews: { nodes: [reviewNode(301, "DISMISSED")], pageInfo: { hasNextPage: false, endCursor: null } } } } },
        });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4)).resolves.toEqual([
      { id: 301, state: "DISMISSED", submittedAt: "2026-09-04T12:00:00.000Z", dismissal: null },
    ]);
  });

  it.each([
    { response: "null", stateField: { previousReviewState: null } },
    { response: "omitted", stateField: {} },
  ])("keeps a dismissal with $response previous state as unknown", async ({ stateField }) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        const connection = request.query.includes("query PullRequestReviewDismissals")
          ? { timelineItems: {
            nodes: [{ __typename: "ReviewDismissedEvent", createdAt: "2026-09-04T13:00:00.000Z", ...stateField, review: { databaseId: 301 } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } }
          : { reviews: {
            nodes: [reviewNode(301, "DISMISSED")],
            pageInfo: { hasNextPage: false, endCursor: null },
          } };
        return Response.json({ data: { repository: { pullRequest: connection } } });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4)).resolves.toEqual([
      {
        id: 301,
        state: "DISMISSED",
        submittedAt: "2026-09-04T12:00:00.000Z",
        dismissal: { at: "2026-09-04T13:00:00.000Z", previousState: null },
      },
    ]);
  });

  it("rejects a missing pull request dismissal connection", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        const pullRequest = request.query.includes("query PullRequestReviewDismissals")
          ? null
          : { reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        return Response.json({ data: { repository: { pullRequest } } });
      },
    });

    await expect(gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4))
      .rejects.toThrow("GitHub GraphQL response was invalid.");
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
    closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    timelineItems: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function pullRequestNode(
  id: number,
  number: number,
  author: { login: string; databaseId?: number | null } | null = { login: "contributor", databaseId: 7001 },
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
    author,
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


describe.each(["GraphQL", "REST"] as const)("%s HTTP failures", (transport) => {
  function request(fetch: typeof globalThis.fetch, timeoutMs?: number) {
    const options = { accessToken: "test-access-token", fetch, timeoutMs };
    return transport === "GraphQL"
      ? new GitHubGraphqlClient(options).query("query { viewer { login } }", {})
      : new GitHubGateway(options).getRepository({ owner: "octo", name: "overflow" });
  }

  it.each([
    ["secondary limit", 403, {}, "You have exceeded a secondary rate limit.", true, null],
    ["mixed-case secondary limit", 429, {}, "SECONDARY RATE LIMIT", true, null],
    ["abuse detection", 403, {}, "AbUsE DeTeCtIoN mechanism triggered.", true, null],
    ["abuse detection on 429", 429, {}, "abuse detection", true, null],
    ["exhausted primary limit", 403, { "x-ratelimit-remaining": "0" }, "Forbidden", true, null],
    ["authorization failure", 401, {}, "Bad credentials", false, null],
    ["forbidden without limit signals", 403, {}, "Resource not accessible", false, null],
    ["429 without limit signals", 429, {}, "Too many requests", false, null],
    ["numeric retry delay", 403, { "retry-after": "60" }, "Forbidden", true, 60],
    ["nonnumeric retry delay", 403, { "retry-after": "soon" }, "Forbidden", true, null],
    ["unsafe retry delay", 429, { "retry-after": "9007199254740992" }, "Forbidden", true, null],
    ["non-limit status with signals", 401, { "retry-after": "60", "x-ratelimit-remaining": "0" }, "secondary rate limit", false, 60],
  ] satisfies Array<[string, number, Record<string, string>, string, boolean, number | null]>)(
    "reports %s", async (_case, status, headers, body, rateLimited, retryAfterSeconds) => {
      const error = await request(async () => new Response(body, { status, headers }))
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ status, rateLimited, retryAfterSeconds, body });
    },
  );

  it("caps the diagnostic body while classifying the full response", async () => {
    const error = await request(async () => new Response("x".repeat(500) + "secondary rate limit", { status: 403 }))
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 403, rateLimited: true, body: "x".repeat(500) });
    expect((error as GitHubApiError).body).toHaveLength(500);
  });

  it("preserves the HTTP failure when its body was already consumed", async () => {
    const response = new Response("Forbidden", { status: 403, headers: { "retry-after": "60" } });
    await response.text();
    const error = await request(async () => response).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 403, rateLimited: true, retryAfterSeconds: 60, body: null });
  });

  it("preserves the HTTP failure when reading its body is aborted", async () => {
    vi.useFakeTimers();
    const interactions: string[] = [];
    try {
      const result = request(async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            interactions.push("body aborted");
            controller.error(new Error("body read aborted"));
          }, { once: true });
        },
      }), { status: 403, headers: { "x-ratelimit-remaining": "0" } }), 100)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      const error = await result;

      expect(error).toMatchObject({ status: 403, rateLimited: true, body: null });
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(interactions).toEqual(["body aborted"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GitHubGraphqlClient transport errors", () => {
  it("sanitizes a transport error whose message impersonates an HTTP failure", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "test-access-token",
      fetch: async () => { throw new Error("GitHub API request failed with status 403."); },
    });

    await expect(client.query("query { viewer { login } }", {})).rejects.toThrow("GitHub GraphQL request failed.");
  });
});
