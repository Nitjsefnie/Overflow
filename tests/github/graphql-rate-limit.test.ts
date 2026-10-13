import { describe, expect, it } from "vitest";
import { GitHubGraphqlRequestError, githubRateLimitNotBefore } from "@/lib/github/errors";
import { GitHubGraphqlClient } from "@/lib/github/graphql";

const query = "query { viewer { login } }";

describe("HTTP 200 GraphQL rate-limit classification", () => {
  // https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit
  it.each([undefined, "120"])("honours the primary reset captured from a real HTTP 200 structured limit, retry-after=%s", async (retryAfter) => {
    const resetAt = new Date("2030-01-02T03:09:05Z");
    const headers: Record<string, string> = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt.getTime() / 1000) };
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
    const client = new GitHubGraphqlClient({
      accessToken: "fixture-token",
      fetch: async () => Response.json({ errors: [{ type: "RATE_LIMITED" }] }, { status: 200, headers }),
    });
    const error: unknown = await client.query(query, {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect(githubRateLimitNotBefore(error as GitHubGraphqlRequestError, new Date("2030-01-02T03:04:05.678Z")))
      .toEqual(new Date("2030-01-02T03:09:05Z"));
    expect(error).toMatchObject({ headers });
  });

  it.each([
    { type: "RATE_LIMIT" },
    { type: "RATE_LIMITED" },
    { type: "graphql_rate_limit" },
    { code: "RATE_LIMIT" },
    { code: "RATE_LIMITED" },
    { code: "graphql_rate_limit" },
  ])("classifies the structured marker %j without changing diagnostics", async (marker) => {
    const client = new GitHubGraphqlClient({
      accessToken: "private-token",
      fetch: async () => Response.json({ errors: [{ ...marker, message: "Limit for private-token" }] }, {
        headers: { "retry-after": "120" },
      }),
    });

    await expect(client.query(query, {})).rejects.toMatchObject({
      message: `GitHub GraphQL request failed. ${"type" in marker ? marker.type : "UNKNOWN"}: Limit for [REDACTED]`,
      rateLimited: true,
      retryAfterSeconds: 120,
    });
  });

  it.each<{ headers: Record<string, string>; seconds: number | null }>([
    { headers: {}, seconds: null },
    { headers: { "retry-after": "0" }, seconds: 0 },
    { headers: { "retry-after": "soon" }, seconds: null },
    { headers: { "retry-after": "9007199254740992" }, seconds: null },
  ])("retains bounded retry guidance: $headers", async ({ headers, seconds }) => {
    const client = new GitHubGraphqlClient({
      accessToken: "private-token",
      fetch: async () => Response.json({ errors: [{ code: "graphql_rate_limit" }] }, { headers }),
    });

    await expect(client.query(query, {})).rejects.toMatchObject({ rateLimited: true, retryAfterSeconds: seconds });
  });

  it("classifies a later entry even beyond the diagnostic preview and alongside partial data", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "private-token",
      fetch: async () => Response.json({
        data: { viewer: null },
        errors: [
          ...Array.from({ length: 6 }, (_, index) => ({ type: "OTHER", message: `Failure ${index}` })),
          null,
          { type: "FORBIDDEN", code: "graphql_rate_limit" },
        ],
      }),
    });

    await expect(client.query(query, {})).rejects.toMatchObject({ rateLimited: true, retryAfterSeconds: null });
  });

  it.each([
    [{ type: "FORBIDDEN", message: "RATE_LIMIT secondary rate limit" }],
    [{ type: "UNAUTHORIZED" }],
    [{ type: "GRAPHQL_VALIDATION_FAILED" }],
    [{ code: "RATE_LIMIT_CONFIGURATION_INVALID" }],
    [{ type: "RATE_LIMIT_ERROR" }],
    [null, 1, "RATE_LIMIT", ["RATE_LIMIT"], { type: 429 }],
    { type: "RATE_LIMIT" },
    [],
    undefined,
  ].map((errors) => ({ errors })))("does not infer a cooldown from unclassified errors $errors or headers alone", async ({ errors }) => {
    const client = new GitHubGraphqlClient({
      accessToken: "private-token",
      fetch: async () => Response.json({ errors }, {
        headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
      }),
    });

    await expect(client.query(query, {})).rejects.toMatchObject({ rateLimited: false, retryAfterSeconds: 60 });
  });

  it("keeps a transport rejection outside the rate-limit contract even if it impersonates a limit", async () => {
    const client = new GitHubGraphqlClient({
      accessToken: "private-token",
      fetch: async () => { throw new Error("RATE_LIMIT secondary rate limit"); },
    });

    await expect(client.query(query, {})).rejects.toMatchObject({
      message: "GitHub GraphQL request failed. Error: RATE_LIMIT secondary rate limit", rateLimited: false, retryAfterSeconds: null,
    });
  });
});
