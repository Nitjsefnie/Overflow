import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubGateway } from "@/lib/github/client";
import { CollectionWalkBound, MAX_WALK_ITEMS, MAX_WALK_PAGES } from "@/lib/github/collection-walk-bound";
import { classifyGitHubRateLimit } from "@/lib/github/errors";
import { GitHubResponseTooLargeError, MAX_SUCCESS_BODY_BYTES } from "@/lib/github/response-text";

describe("GitHubGateway REST transport", () => {
  it("uses GitHub's versioned API headers when reading one explicitly named repository", async () => {
    let capturedRequest: Request | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json({
          id: 42,
          name: "overflow",
          full_name: "octo/overflow",
          private: false,
          html_url: "https://github.com/octo/overflow",
          owner: { login: "octo" },
          permissions: { admin: true },
        });
      },
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).resolves.toEqual({
      id: 42,
      owner: "octo",
      ownerType: "USER",
      name: "overflow",
      fullName: "octo/overflow",
      visibility: "PUBLIC",
      url: "https://github.com/octo/overflow",
      canAdminister: true,
    });

    expect(capturedRequest?.url).toBe("https://api.github.com/repos/octo/overflow");
    expect(capturedRequest?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(capturedRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it.each([
    ["Organization", "ORGANIZATION"],
    ["User", "USER"],
    ["Unknown", "USER"],
    [undefined, "USER"],
  ])("maps REST owner type %s to %s", async (type, ownerType) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        id: 42,
        name: "overflow",
        full_name: "real-owner/overflow",
        private: false,
        html_url: "https://github.com/real-owner/overflow",
        owner: { login: "real-owner", type },
        permissions: { admin: true },
      }),
    });

    await expect(gateway.getRepository({ owner: "old-owner", name: "overflow" })).resolves.toMatchObject({
      owner: "real-owner",
      ownerType,
    });
  });

  it.each([403, 404, 502])("carries HTTP status %s in a GitHubApiError", async (status) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("private response test-access-token", { status }),
    });

    const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ status, message: `GitHub API request failed with status ${status}.` });
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("GitHubApiError");
  });

  it("sanitizes a transport error even when its text resembles an HTTP error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => { throw new Error("GitHub API request failed with status 403."); },
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toMatchObject({
      message: "GitHub request failed: /repos/octo/overflow",
    });
  });

  it("preserves a network-level transport failure as the cause and names the request path", async () => {
    const networkError = new Error("getaddrinfo ENOTFOUND api.github.invalid");
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => { throw networkError; },
    });

    const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "GitHub request failed: /repos/octo/overflow" });
    expect((error as Error).cause).toBe(networkError);
  });

  it.each([
    ["absent headers", {}, false, null],
    ["remaining zero", { "x-ratelimit-remaining": "0" }, true, null],
    ["remaining nonzero", { "x-ratelimit-remaining": "1" }, false, null],
    ["remaining nonliteral zero", { "x-ratelimit-remaining": "00" }, false, null],
    ["retry delay", { "retry-after": "60" }, true, 60],
    ["zero retry delay", { "retry-after": "0" }, true, 0],
    ["leading-zero retry delay", { "retry-after": "00060" }, true, 60],
    ["all-zero retry delay", { "retry-after": "000" }, true, 0],
    ["four-digit retry delay", { "retry-after": "3600" }, true, 3600],
    ["maximum safe retry delay", { "retry-after": "9007199254740991" }, true, 9007199254740991],
    ["empty retry delay", { "retry-after": "" }, true, null],
    ["negative retry delay", { "retry-after": "-1" }, true, null],
    ["fractional retry delay", { "retry-after": "1.5" }, true, null],
    ["date retry delay", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, true, null],
    ["invalid retry delay", { "retry-after": "60-private-body" }, true, null],
    ["unsafe retry delay", { "retry-after": "9007199254740993" }, true, null],
    ["other header", { "x-ratelimit-reset": "0" }, false, null],
  ] satisfies Array<[string, Record<string, string>, boolean, number | null]>)(
    "carries only safe rate-limit metadata for %s", async (_case, headers, rateLimited, retryAfterSeconds) => {
      const gateway = new GitHubGateway({
        accessToken: "test-access-token",
        fetch: async () => new Response("private-body test-access-token", {
          status: 403,
          headers: { ...headers, "x-private": "private-header" },
        }),
      });

      const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
      expect(error).toMatchObject({
        name: "GitHubApiError",
        status: 403,
        message: "GitHub API request failed with status 403.",
        rateLimited,
        retryAfterSeconds,
      });
      expect(JSON.stringify(error)).not.toMatch(/private-body|private-header|test-access-token|headers|body/);
    },
  );

  it.each([401, 404, 422, 500, 503])("keeps retry timing without inferring throttling for HTTP %s", async (status) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("private-body", {
        status,
        headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
      }),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toMatchObject({
      status,
      rateLimited: false,
      retryAfterSeconds: 60,
    });
  });

  it.each([
    [{ "x-ratelimit-remaining": "0" }, null],
    [{ "retry-after": "60" }, 60],
  ] satisfies Array<[Record<string, string>, number | null]>)("marks HTTP 429 with %j as rate limited in the transport", async (headers, retryAfterSeconds) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("private-body", { status: 429, headers }),
    });

    const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 429, rateLimited: true, retryAfterSeconds });
  });

  it("aborts a stalled GitHub request and exposes only a sanitized timeout error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("upstream body contained test-access-token")),
            { once: true },
          );
        }),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toThrow(
      "GitHub request timed out.",
    );
  });

  it("does not leak an upstream response body or access token in an HTTP error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () =>
        new Response('{"message":"test-access-token and private upstream details"}', {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).rejects.toThrow(
      "GitHub API request failed with status 502.",
    );
  });

  it("lists repository labels from a single page without sending any label write", async () => {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json([{ name: "size/S" }, { name: "bug" }]);
      },
    });

    await expect(gateway.listRepositoryLabels({ owner: "octo", name: "overflow" })).resolves.toEqual(
      new Set(["size/S", "bug"]),
    );

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.github.com/repos/octo/overflow/labels?per_page=100&page=1",
    ]);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("lists repository labels across every page the Link header announces and never sends a POST to /labels", async () => {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("page=1")) {
          return new Response(JSON.stringify([{ name: "size/S" }, { name: "bug" }]), {
            headers: { link: '</repos/octo/overflow/labels?page=2&per_page=100>; rel="next"' },
          });
        }
        return Response.json([{ name: "size/M" }, { name: "size/S" }]);
      },
    });

    await expect(gateway.listRepositoryLabels({ owner: "octo", name: "overflow" })).resolves.toEqual(
      new Set(["size/S", "bug", "size/M"]),
    );

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.github.com/repos/octo/overflow/labels?per_page=100&page=1",
      "GET https://api.github.com/repos/octo/overflow/labels?per_page=100&page=2",
    ]);
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/labels")))
      .toEqual([]);
  });

  it("creates and removes a repository webhook with the configured callback secret", async () => {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          return Response.json({ id: 81 }, { status: 201 });
        }
        return new Response(null, { status: 204 });
      },
    });
    const repository = { owner: "octo", name: "overflow" };

    await expect(
      gateway.createWebhook(repository, {
        callbackUrl: "https://overflow.example/api/github/webhooks",
        secret: "webhook-secret-for-test",
      }),
    ).resolves.toEqual({ id: 81 });
    await expect(gateway.deleteWebhook(repository, 81)).resolves.toBeUndefined();

    expect(await requests[0]?.json()).toEqual({
      active: true,
      config: {
        content_type: "json",
        secret: "webhook-secret-for-test",
        url: "https://overflow.example/api/github/webhooks",
      },
      events: ["issues", "pull_request", "pull_request_review", "issue_comment"],
      name: "web",
    });
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.url).toBe("https://api.github.com/repos/octo/overflow/hooks/81");
  });

  it("requests a pull request diff through the GitHub diff media type", async () => {
    let request: Request | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response("diff --git a/a.ts b/a.ts", { status: 200 });
      },
    });

    await expect(
      gateway.getPullRequestDiff({ owner: "octo", name: "overflow" }, 4),
    ).resolves.toBe("diff --git a/a.ts b/a.ts");
    expect(request?.headers.get("accept")).toBe("application/vnd.github.v3.diff");
  });
});

// Issue 878: a label walk ends only when the instance stops advertising a
// continuation, and a rel="next" that is fresh on EVERY response is not a
// repeated one, so nothing about the Link header itself can stop it. The bound
// is what makes such a walk terminate, and it terminates it loudly.
describe("GitHubGateway collection walk bound", () => {
  // GitHub clamps `per_page` at 100 on this endpoint and the walk always asks
  // for the maximum, so a full page is 100 rows.
  const fullPage = 100;
  const fullPagesToTheRowCeiling = MAX_WALK_ITEMS / fullPage;
  const overPages = new RegExp(`GitHub returned more than ${MAX_WALK_PAGES} pages`);
  const overRows = new RegExp(`GitHub returned more than ${MAX_WALK_ITEMS} rows`);
  const repository = { owner: "octo", name: "overflow" };
  const labels = (body: unknown, link?: string) =>
    new Response(JSON.stringify(body), link === undefined ? {} : { headers: { link } });
  const nextLink = (page: number) => `</repos/octo/overflow/labels?per_page=100&page=${page}>; rel="next"`;

  // A hard transport cap turns a missing loop guard into a prompt, visible
  // failure: an unbounded walk answers with the 503 below instead of hanging.
  function labelGateway(respond: (hit: number) => Response, cap = 3) {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        if (requests.length > cap) return new Response("request cap exceeded", { status: 503 });
        return respond(requests.length);
      },
    });
    return { gateway, requests };
  }

  it("stops a label walk whose rel=\"next\" is fresh on every page", async () => {
    const { gateway, requests } = labelGateway((hit) => labels([], nextLink(hit + 1)), MAX_WALK_PAGES + 5);

    await expect(gateway.listRepositoryLabels(repository)).rejects.toThrow(overPages);
    expect(requests).toHaveLength(MAX_WALK_PAGES + 1);
  });

  it("stops on the row ceiling when the instance only ever sends full pages", async () => {
    // The page ceiling would allow twice this many requests, so only the row
    // ceiling can be the one that fires here.
    const { gateway, requests } = labelGateway((hit) =>
      labels(Array.from({ length: fullPage }, (_, index) => ({ name: `label-${hit}-${index}` })), nextLink(hit + 1)),
      MAX_WALK_PAGES + 5);

    await expect(gateway.listRepositoryLabels(repository)).rejects.toThrow(overRows);
    expect(requests).toHaveLength(fullPagesToTheRowCeiling + 1);
  });

  // The row check must run BEFORE the rows are appended: spreading a page
  // larger than the engine's argument limit dies with a RangeError long before
  // the typed error can be raised, and a RangeError IS an Error, so the error
  // NAME is what separates the two paths.
  it.each([MAX_WALK_ITEMS + 1, 150_000])(
    "stops on a single page of %i rows with the typed error, not a stack overflow",
    async (rows) => {
      const { gateway, requests } = labelGateway(() =>
        labels(Array.from({ length: rows }, (_, index) => ({ name: `label-${index}` }))));

      const error = await gateway.listRepositoryLabels(repository).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("Error");
      expect((error as Error).message).toMatch(overRows);
      expect(requests).toHaveLength(1);
    });

  // The other side of the same boundary: a walk that lands EXACTLY on the
  // ceiling has done nothing wrong, and its whole collection comes back.
  it("returns a single page that lands exactly on the row ceiling", async () => {
    const { gateway, requests } = labelGateway(() =>
      labels(Array.from({ length: MAX_WALK_ITEMS }, (_, index) => ({ name: `label-${index}` }))));

    const found = await gateway.listRepositoryLabels(repository);
    expect(found.size).toBe(MAX_WALK_ITEMS);
    expect(requests).toHaveLength(1);
  });

  // The two ceilings are a POLICY choice, not a runtime derivation, and both
  // request-count assertions above are built FROM them — so a mutant that
  // quietly lowers either one shrinks what a legitimate walk may read while
  // every behavioural test stays green. Pin the values, and pin the invariant
  // that keeps the row ceiling reachable at all.
  it("pins the walk ceilings this module ships", () => {
    expect(MAX_WALK_PAGES).toBe(200);
    expect(MAX_WALK_ITEMS).toBe(10_000);
    // A full page holds 100 rows, so on a full-page walk the row ceiling must
    // fire before the page ceiling. If it does not, the row ceiling is shadowed
    // by the page ceiling and can never throw.
    expect(MAX_WALK_ITEMS).toBeLessThan(MAX_WALK_PAGES * 100);
  });

  it("walks a legitimate three-page label catalog to its end", async () => {
    const { gateway, requests } = labelGateway((hit) => hit < 3
      ? labels([{ name: `label-${hit}` }], nextLink(hit + 1))
      : labels([{ name: "label-3" }]));

    await expect(gateway.listRepositoryLabels(repository)).resolves.toEqual(
      new Set(["label-1", "label-2", "label-3"]),
    );
    expect(requests).toHaveLength(3);
  });

  // The bound collects raw rows; a name that is not a string is still not a
  // label, and bounding the walk must not change what the Set holds.
  it("skips a label row whose name is not a string", async () => {
    const { gateway } = labelGateway(() => labels([{ name: "bug" }, { name: 7 }, { name: null }]));

    await expect(gateway.listRepositoryLabels(repository)).resolves.toEqual(new Set(["bug"]));
  });
});

// The row ceiling is a MEMORY ceiling, so what the bound still holds at the
// throw is part of its contract: a page past the budget must be refused BEFORE
// it is appended, or the rows the budget just rejected are retained anyway. The
// gateway-level cases above can only see that an error was raised, and an
// implementation that appends first and checks second still raises one — so the
// ordering has to be asserted here, on the bound's own retained state.
describe("the GitHub collection walk bound", () => {
  it("refuses an oversized page without retaining any of it", () => {
    const bound = new CollectionWalkBound<{ name: string }>("probe");

    expect(() => bound.add(Array.from({ length: MAX_WALK_ITEMS + 1 }, (_, index) => ({ name: `l-${index}` }))))
      .toThrow(/rows of probe, past the collection-walk bound/);
    // Asserted as a LENGTH, not as an empty array: a failure here prints a count
    // instead of the ten thousand rows the inverted ordering retained.
    expect(bound.collected).toHaveLength(0);
  });

  it("keeps a page that lands exactly on the row ceiling", () => {
    const bound = new CollectionWalkBound<{ name: string }>("probe");
    const page = Array.from({ length: MAX_WALK_ITEMS }, (_, index) => ({ name: `l-${index}` }));

    bound.add(page);

    expect(bound.collected).toHaveLength(MAX_WALK_ITEMS);
    expect(bound.collected[0]).toEqual({ name: "l-0" });
    expect(bound.collected[MAX_WALK_ITEMS - 1]).toEqual({ name: `l-${MAX_WALK_ITEMS - 1}` });
  });

  // Both ceilings carry the collection the constructor was given, so neither
  // message can be hardcoded to the one collection the gateway happens to walk.
  it("names the collection it was given when the page budget runs out", () => {
    const bound = new CollectionWalkBound<{ name: string }>("probe");
    for (let page = 0; page < MAX_WALK_PAGES; page += 1) bound.add([]);

    expect(() => bound.add([])).toThrow(/pages of probe, past the collection-walk bound/);
  });
});

describe("GitHubGateway workflow files", () => {
  it("reads a zero-byte workflow as empty evidence text", async () => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return requestedUrls.length === 1
          ? Response.json([{ type: "file", name: "empty.yml", path: ".github/workflows/empty.yml", size: 0 }])
          : new Response(null);
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([
      { path: ".github/workflows/empty.yml", content: "" },
    ]);
    expect(requestedUrls).toHaveLength(2);
  });

  it.each([
    ["CRLF line endings", "on: issue_comment\r\njobs:\r\n  claim:\r\n"],
    ["more than 1 KiB", `on: issue_comment\n# ${"x".repeat(2048)}\n`],
  ])("returns raw text with %s unchanged", async (_label, content) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => String(input).endsWith("/workflows")
        ? Response.json([{ type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: content.length }])
        : new Response(content),
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    expect(workflows[0]?.content).toBe(content);
  });

  it("selects the first 50 paths even when filename order disagrees", async () => {
    const paths = Array.from({ length: 51 }, (_, index) => `.github/workflows/${String(index).padStart(2, "0")}.yml`);
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return requestedUrls.length === 1
          ? Response.json(paths.map((path, index) => ({
            type: "file", name: `${String(50 - index).padStart(2, "0")}.yml`, path, size: 10,
          })))
          : new Response("workflow text");
      },
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    expect(workflows.map(({ path }) => path)).toEqual(paths.slice(0, 50));
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      ...paths.slice(0, 50).map((path) => `https://api.github.com/repos/octo/overflow/contents/${path}`),
    ]);
  });

  it("uses code-unit order to select A.yml over a.yml at the 50-file cutoff", async () => {
    const names = Array.from({ length: 49 }, (_, index) => `${String(index).padStart(2, "0")}.yml`);
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return requestedUrls.length === 1
          ? Response.json([...names, "a.yml", "A.yml"].map((name) => ({
            type: "file", name, path: `.github/workflows/${name}`, size: 10,
          })))
          : new Response("workflow text");
      },
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    expect(workflows).toHaveLength(50);
    expect(workflows[49]?.path).toBe(".github/workflows/A.yml");
    expect(requestedUrls).not.toContain("https://api.github.com/repos/octo/overflow/contents/.github/workflows/a.yml");
  });

  it("cancels a single oversized chunk immediately, skips the file, and returns later files", async () => {
    let pulls = 0;
    let cancelled = false;
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (requestedUrls.length === 1) {
          return Response.json([
            { type: "file", name: "a.yml", path: ".github/workflows/a.yml", size: 1 },
            { type: "file", name: "b.yml", path: ".github/workflows/b.yml", size: 10 },
          ]);
        }
        if (url.endsWith("/a.yml")) {
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(new Uint8Array(8 * 1024 * 1024));
              else if (pulls === 2) controller.enqueue(new Uint8Array([120]));
              else controller.close();
            },
            cancel() { cancelled = true; },
          }, { highWaterMark: 0 }));
        }
        return new Response("on: issue_comment");
      },
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
    expect(workflows).toEqual([{ path: ".github/workflows/b.yml", content: "on: issue_comment" }]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/a.yml",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/b.yml",
    ]);
  });

  it("cancels an oversized raw stream, skips it, and preserves a byte-boundary UTF-8 file", async () => {
    const boundaryText = "🙂".repeat(65536);
    const boundaryBytes = new TextEncoder().encode(boundaryText);
    let oversizedPulls = 0;
    let oversizedCancelled = false;
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (requestedUrls.length === 1) {
          return Response.json([
            { type: "file", name: "a.yml", path: ".github/workflows/a.yml", size: 1 },
            { type: "file", name: "b.yml", path: ".github/workflows/b.yml", size: 1 },
          ]);
        }
        if (url.endsWith("/a.yml")) {
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              oversizedPulls += 1;
              if (oversizedPulls === 1) controller.enqueue(boundaryBytes);
              else if (oversizedPulls === 2) controller.enqueue(new Uint8Array([120]));
              else controller.close();
            },
            cancel() { oversizedCancelled = true; },
          }, { highWaterMark: 0 }));
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            // Split a multibyte code point between chunks to exercise decoding.
            controller.enqueue(boundaryBytes.slice(0, 131073));
            controller.enqueue(boundaryBytes.slice(131073));
            controller.close();
          },
        }));
      },
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    expect(oversizedCancelled).toBe(true);
    expect(oversizedPulls).toBe(2);
    expect(workflows).toEqual([{ path: ".github/workflows/b.yml", content: boundaryText }]);
    expect(requestedUrls).toHaveLength(3);
  });

  it.each([null, {}, "not an array"])("treats a non-array listing %j as no evidence", async (listing) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json(listing),
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([]);
  });

  it.each([
    ["null entry", null],
    ["missing path", { type: "file", name: "claim.yml", size: 20 }],
    ["empty path", { type: "file", name: "claim.yml", path: "", size: 20 }],
    ["null size", { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: null }],
    ["negative size", { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: -1 }],
    ["string size", { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: "20" }],
    ["fractional size", { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: 1.5 }],
    ["non-string name", { type: "file", name: ["claim.yml"], path: ".github/workflows/claim.yml", size: 20 }],
  ])("skips a malformed %s and still reads valid entries", async (_label, entry) => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        if (requestedUrls.length === 1) {
          return Response.json([entry, { type: "file", name: "valid.yml", path: ".github/workflows/valid.yml", size: 10 }]);
        }
        return new Response("workflow text");
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([
      { path: ".github/workflows/valid.yml", content: "workflow text" },
    ]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/valid.yml",
    ]);
  });

  it.each(["ascending", "descending"])("reads only the first 50 eligible paths from an %s listing", async (order) => {
    const names = Array.from({ length: 52 }, (_, index) => `${String(index).padStart(2, "0")}.yml`);
    const entries = names.map((name) => ({ type: "file", name, path: `.github/workflows/${name}`, size: 10 }));
    if (order === "descending") {
      entries.reverse();
    }
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        if (requestedUrls.length === 1) {
          return Response.json([
            { type: "file", name: "!notes.txt", path: ".github/workflows/!notes.txt", size: 10 },
            { type: "dir", name: "!nested.yml", path: ".github/workflows/!nested.yml", size: 10 },
            { type: "file", name: "!large.yml", path: ".github/workflows/!large.yml", size: 262145 },
            ...entries,
          ]);
        }
        return new Response("workflow text");
      },
    });

    const workflows = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" });
    const expectedNames = names.slice(0, 50);
    expect(workflows).toHaveLength(50);
    expect(workflows).toEqual(expectedNames.map((name) => ({
      path: `.github/workflows/${name}`,
      content: "workflow text",
    })));
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      ...expectedNames.map((name) => `https://api.github.com/repos/octo/overflow/contents/.github/workflows/${name}`),
    ]);
    expect(workflows[0]?.path).toBe(".github/workflows/00.yml");
    expect(workflows[49]?.path).toBe(".github/workflows/49.yml");
  });

  it.each([
    ["notes.txt", "file"],
    ["README.md", "file"],
    ["claim.yml.txt", "file"],
    ["claim-yml", "file"],
    ["nested.yml", "dir"],
    ["linked.yaml", "symlink"],
  ])("does not read %s entries of type %s", async (name, type) => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        if (requestedUrls.length === 1) {
          return Response.json([
            { type, name, path: `.github/workflows/${name}`, size: 10 },
            { type: "file", name: "claim.YML", path: ".github/workflows/claim.YML", size: 10 },
            { type: "file", name: "review.YaMl", path: ".github/workflows/review.YaMl", size: 10 },
          ]);
        }
        return new Response("on: issue_comment");
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([
      { path: ".github/workflows/claim.YML", content: "on: issue_comment" },
      { path: ".github/workflows/review.YaMl", content: "on: issue_comment" },
    ]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/claim.YML",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/review.YaMl",
    ]);
  });

  it("skips files over 256 KiB and reads files exactly at the limit", async () => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        if (requestedUrls.length === 1) {
          return Response.json([
            { type: "file", name: "large.yml", path: ".github/workflows/large.yml", size: 262145 },
            { type: "file", name: "limit.yml", path: ".github/workflows/limit.yml", size: 262144 },
          ]);
        }
        return new Response("workflow text");
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([
      { path: ".github/workflows/limit.yml", content: "workflow text" },
    ]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows/limit.yml",
    ]);
  });

  it("lists workflows and reads their raw text using encoded repository and file paths", async () => {
    const requests: Request[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) {
          return Response.json([
            { type: "file", name: "claim #1.yml", path: ".github/workflows/claim #1.yml", size: 20 },
            { type: "file", name: "review.yaml", path: ".github/workflows/review.yaml", size: 10 },
          ]);
        }
        return new Response(requests.length === 2 ? "on: issue_comment\n" : "on: pull_request\n");
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo/team", name: "over flow" })).resolves.toEqual([
      { path: ".github/workflows/claim #1.yml", content: "on: issue_comment\n" },
      { path: ".github/workflows/review.yaml", content: "on: pull_request\n" },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/octo%2Fteam/over%20flow/contents/.github/workflows",
      "https://api.github.com/repos/octo%2Fteam/over%20flow/contents/.github/workflows/claim%20%231.yml",
      "https://api.github.com/repos/octo%2Fteam/over%20flow/contents/.github/workflows/review.yaml",
    ]);
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
    expect(requests.map((request) => request.headers.get("accept"))).toEqual([
      "application/vnd.github+json",
      "application/vnd.github.raw",
      "application/vnd.github.raw",
    ]);
  });

  it("returns an empty array when the workflows directory is absent", async () => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response("Not Found", { status: 404 });
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).resolves.toEqual([]);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/octo/overflow/contents/.github/workflows",
    ]);
  });

  it.each([403, 429, 500, 502, 503])("propagates listing HTTP %s with its error metadata", async (status) => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("upstream failure", { status, headers: { "retry-after": "60" } }),
    });

    const error = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status,
      rateLimited: status === 403 || status === 429,
      retryAfterSeconds: 60,
      body: "upstream failure",
    });
  });

  it("preserves the error instance raised by the request helper", async () => {
    const upstreamError = new GitHubApiError(503);
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => { throw upstreamError; },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).rejects.toBe(upstreamError);
  });

  it("preserves a network-level listing failure as the cause and names the request path", async () => {
    const networkError = new Error("getaddrinfo ENOTFOUND api.github.invalid");
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => { throw networkError; },
    });

    const error = await gateway.listWorkflowFiles({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "GitHub request failed: /repos/octo/overflow/contents/.github/workflows" });
    expect((error as Error).cause).toBe(networkError);
  });

  it.each([404, 500])("propagates a file-read HTTP %s instead of skipping the file", async (status) => {
    const requestedUrls: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        if (requestedUrls.length === 1) {
          return Response.json([
            { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: 20 },
          ]);
        }
        return new Response("File read failed", { status });
      },
    });

    await expect(gateway.listWorkflowFiles({ owner: "octo", name: "overflow" })).rejects.toMatchObject({ status });
    expect(requestedUrls).toHaveLength(2);
  });
});

describe("GitHubGateway repository resolution by id", () => {
  it("reads the repository GitHub currently holds under a registered numeric id", async () => {
    let capturedRequest: Request | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json({
          id: 42,
          name: "overflow",
          full_name: "renamed-owner/overflow",
          private: false,
          html_url: "https://github.com/renamed-owner/overflow",
          owner: { login: "renamed-owner", type: "Organization" },
          permissions: { admin: true },
        });
      },
    });

    await expect(gateway.getRepositoryById(42)).resolves.toEqual({
      id: 42,
      owner: "renamed-owner",
      ownerType: "ORGANIZATION",
      name: "overflow",
      fullName: "renamed-owner/overflow",
      visibility: "PUBLIC",
      url: "https://github.com/renamed-owner/overflow",
      canAdminister: true,
    });

    expect(capturedRequest?.url).toBe("https://api.github.com/repositories/42");
    expect(capturedRequest?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(capturedRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("reports a repository that has turned private", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => Response.json({
        id: 42,
        name: "overflow",
        full_name: "octo/overflow",
        private: true,
        html_url: "https://github.com/octo/overflow",
        owner: { login: "octo" },
      }),
    });

    await expect(gateway.getRepositoryById(42)).resolves.toMatchObject({
      visibility: "PRIVATE",
      ownerType: "USER",
      canAdminister: false,
    });
  });

  it("answers null when GitHub no longer serves the numeric id", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response('{"message":"Not Found"}', { status: 404 }),
    });

    await expect(gateway.getRepositoryById(42)).resolves.toBeNull();
  });

  it("reads a 404 carrying throttle signals as gone rather than as a rate limit", async () => {
    const headers = { "x-ratelimit-remaining": "0", "retry-after": "60" };
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response('{"message":"Not Found"}', { status: 404, headers }),
    });

    await expect(gateway.getRepositoryById(42)).resolves.toBeNull();
    // Answering null is only correct while src/lib/github/errors.ts confines
    // rate-limit classification to 403 and 429: a 404 that could be classified as
    // throttled would be retired as gone instead of retried.
    expect(classifyGitHubRateLimit(404, new Headers(headers), '{"message":"Not Found"}'))
      .toMatchObject({ rateLimited: false });
  });

  it.each([403, 429, 500, 502, 503])(
    "propagates HTTP %s rather than reporting the repository as gone",
    async (status) => {
      const gateway = new GitHubGateway({
        accessToken: "test-access-token",
        fetch: async () => new Response("private-body", { status }),
      });

      const error = await gateway.getRepositoryById(42).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ status, rateLimited: false });
    },
  );

  it("propagates a throttled response as a rate-limited error", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response("private-body", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
      }),
    });

    const error = await gateway.getRepositoryById(42).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 403, rateLimited: true, retryAfterSeconds: 60 });
  });

  it("propagates a timeout rather than reporting the repository as gone", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    await expect(gateway.getRepositoryById(42)).rejects.toThrow("GitHub request timed out.");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    "refuses to place %s in the request path",
    async (githubRepositoryId) => {
      const requestedUrls: string[] = [];
      const gateway = new GitHubGateway({
        accessToken: "test-access-token",
        fetch: async (input) => {
          requestedUrls.push(String(input));
          return Response.json({});
        },
      });

      await expect(gateway.getRepositoryById(githubRepositoryId)).rejects.toThrow(
        "GitHub repository id must be a positive safe integer.",
      );
      expect(requestedUrls).toEqual([]);
    },
  );
});

describe("GitHubGateway success-body byte cap", () => {
  const cap = MAX_SUCCESS_BODY_BYTES;

  // Streams one chunk of exactly the cap and then one further byte, and never
  // closes: enforcing the cap must reject before the next read, so a client
  // that buffers whole instead hangs on the next read until the deadline and
  // fails this test through the timeout error rather than passing it.
  it("rejects a success body over the cap with a typed error and cancels the stream", async () => {
    let cancelled = false;
    let pulls = 0;
    const capChunk = new Uint8Array(cap);
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      timeoutMs: 250,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(capChunk);
          else if (pulls === 2) controller.enqueue(new Uint8Array([120]));
          // Never closes: full buffering instead of the cap would hang the
          // next read until the deadline and reject with the timeout error.
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 })),
    });

    const error = await gateway.getRepository({ owner: "octo", name: "overflow" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubResponseTooLargeError);
    expect((error as Error).name).toBe("GitHubResponseTooLargeError");
    expect((error as Error).message).not.toContain("test-access-token");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  it("buffers a success body just under the cap and delivers it intact", async () => {
    const repository = {
      id: 42,
      name: "overflow",
      full_name: "octo/overflow",
      private: false,
      html_url: "https://github.com/octo/overflow",
      owner: { login: "octo" },
      permissions: { admin: true },
    };
    const skeleton = JSON.stringify({ ...repository, pad: "" });
    const body = JSON.stringify({ ...repository, pad: "p".repeat(cap - 1 - skeleton.length) });
    expect(body.length).toBe(cap - 1); // ASCII throughout, so code units are bytes
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async () => new Response(body),
    });

    await expect(gateway.getRepository({ owner: "octo", name: "overflow" })).resolves.toMatchObject({
      id: 42,
      name: "overflow",
    });
  });

  it("pins the success-body byte cap above the write-time fact limit", () => {
    expect(Number.isFinite(MAX_SUCCESS_BODY_BYTES)).toBe(true);
    expect(MAX_SUCCESS_BODY_BYTES).toBeGreaterThan(64 * 1024 * 1024);
  });
});
