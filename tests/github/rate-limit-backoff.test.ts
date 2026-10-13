import { describe, expect, it } from "vitest";
import {
  classifyGitHubRateLimit, GitHubApiError, GitHubGraphqlRequestError,
  githubRateLimitNotBefore, findGitHubRateLimitError,
} from "@/lib/github/errors";

const now = new Date("2030-01-02T03:04:05.678Z");
const reset = String(new Date("2030-01-02T03:09:05Z").getTime() / 1000);

describe("GitHub retry deadlines", () => {
  it.each<{ name: string; seconds: number | null; headers: Record<string, string>; expected: string }>([
    { name: "retry-after seconds", seconds: 120, headers: { "retry-after": "120" }, expected: "2030-01-02T03:06:05.678Z" },
    { name: "exhausted primary reset", seconds: null, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, expected: "2030-01-02T03:09:05Z" },
    { name: "later primary reset alongside retry-after", seconds: 120, headers: { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, expected: "2030-01-02T03:09:05Z" },
    { name: "later retry-after alongside primary reset", seconds: 600, headers: { "retry-after": "600", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, expected: "2030-01-02T03:14:05.678Z" },
    { name: "zero retry-after floor", seconds: 0, headers: { "retry-after": "0" }, expected: "2030-01-02T03:05:05.678Z" },
    { name: "short retry-after floor", seconds: 30, headers: { "retry-after": "30" }, expected: "2030-01-02T03:05:05.678Z" },
    { name: "past reset floor", seconds: null, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }, expected: "2030-01-02T03:05:05.678Z" },
    { name: "out-of-range retry fallback", seconds: Number.MAX_SAFE_INTEGER, headers: {}, expected: "2030-01-02T04:04:05.678Z" },
    { name: "out-of-range reset fallback", seconds: null, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Number.MAX_SAFE_INTEGER) }, expected: "2030-01-02T04:04:05.678Z" },
    { name: "valid reset despite out-of-range retry", seconds: Number.MAX_SAFE_INTEGER, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, expected: "2030-01-02T03:09:05Z" },
    { name: "headerless fallback", seconds: null, headers: {}, expected: "2030-01-02T04:04:05.678Z" },
    { name: "unexhausted reset ignored", seconds: null, headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": reset }, expected: "2030-01-02T04:04:05.678Z" },
    { name: "malformed reset fallback", seconds: null, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" }, expected: "2030-01-02T04:04:05.678Z" },
  ])("honours $name", ({ seconds, headers, expected }) => {
    expect(githubRateLimitNotBefore(new GitHubApiError(403, true, seconds, null, headers), now))
      .toEqual(new Date(expected));
  });

  // https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit
  it("honours retry guidance on a structured GraphQL limit", () => {
    expect(githubRateLimitNotBefore(new GitHubGraphqlRequestError("Limit", true, 120), now))
      .toEqual(new Date("2030-01-02T03:06:05.678Z"));
  });
});

describe("documented GitHub rate-limit shapes", () => {
  // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits
  // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-primary-rate-limit
  it.each<{ name: string; status: number; headers: Record<string, string>; body: string | null; limited: boolean; seconds: number | null }>([
    { name: "secondary 403 with retry-after", status: 403, headers: { "retry-after": "120" }, body: null, limited: true, seconds: 120 },
    { name: "secondary 429 with documented body and no headers", status: 429, headers: {}, body: JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }), limited: true, seconds: null },
    { name: "primary 403 with remaining zero and reset", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, body: null, limited: true, seconds: null },
    { name: "plain integration-access 403", status: 403, headers: {}, body: JSON.stringify({ message: "Resource not accessible by integration" }), limited: false, seconds: null },
  ])("classifies $name", ({ status, headers, body, limited, seconds }) => {
    expect(classifyGitHubRateLimit(status, new Headers(headers), body))
      .toEqual({ rateLimited: limited, retryAfterSeconds: seconds });
  });
});

describe("bounded rate-limit cause detection", () => {
  it("stops a fresh-object cause getter before its fuse trips", () => {
    let reads = 0;
    const freshCause = (): Error => Object.defineProperty(new Error("Wrapper"), "cause", {
      get: () => {
        reads += 1;
        if (reads > 64) throw new Error("cause traversal fuse tripped");
        return freshCause();
      },
    });
    let result: ReturnType<typeof findGitHubRateLimitError> | undefined;
    expect(() => { result = findGitHubRateLimitError(freshCause()); }).not.toThrow();
    expect(result).toBeNull();
    expect(reads).toBeLessThanOrEqual(32);
  });
});
