import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import * as labelsRoute from "@/app/api/repositories/labels/route";

const { readSession } = vi.hoisted(() => ({ readSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));

beforeEach(() => {
  readSession.mockReset().mockResolvedValue(null);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(() => {
  try {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      expect(console[method]).not.toHaveBeenCalled();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const storedToken = "stored-github-oauth-token";

function labelsRequest(query = "?owner=octo&name=overflow"): Request {
  return new Request(`https://overflow.internal/api/repositories/labels${query}`);
}

describe("GET /api/repositories/labels", () => {
  it("exposes GET only, so other verbs never reach a handler", async () => {
    const verbs = labelsRoute as unknown as Record<string, unknown>;
    expect(verbs.GET).toBeTypeOf("function");
    for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(verbs[verb], `${verb} must not be exported from the labels route`).toBeUndefined();
    }
  });

  it("returns a structured 401 without a session", async () => {
    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("returns a structured 401 when the session user has no eligible role", async () => {
    readSession.mockResolvedValue({ user: { id: "sponsor-id" } });

    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it.each([
    ["a dot segment for the owner", "?owner=..&name=overflow"],
    ["a dot segment for the name", "?owner=octo&name=.."],
    ["a slash inside the owner", "?owner=octo/overflow&name=overflow"],
    ["a URL-encoded slash inside the owner", "?owner=octo%2Foverflow&name=overflow"],
    ["a URL-encoded slash inside the name", "?owner=octo&name=over%2Fflow"],
    ["an empty owner", "?owner=&name=overflow"],
    ["an empty name", "?owner=octo&name="],
    ["a missing owner", "?name=overflow"],
    ["a missing name", "?owner=octo"],
    ["an empty query", ""],
    ["a duplicated owner parameter", "?owner=octo&owner=other&name=overflow"],
    ["an unexpected parameter", "?owner=octo&name=overflow&per_page=1"],
  ])("returns a structured 400 for %s", async (_what, query) => {
    readSession.mockResolvedValue(memberSession());

    const response = await labelsRoute.GET(labelsRequest(query));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid repository labels request." },
    });
  });

  it("returns a structured 502 when the account has no stored GitHub token", async () => {
    readSession.mockResolvedValue(memberSession());
    vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue(null);

    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to read the repository labels on GitHub." },
    });
  });

  it("returns a structured 502 and hides the stored token when the token read fails", async () => {
    readSession.mockResolvedValue(memberSession());
    vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken")
      .mockRejectedValue(new Error(`read failed with ${storedToken}`));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to read the repository labels on GitHub." },
    });
    expect(JSON.stringify(body)).not.toContain(storedToken);
  });

  it("passes a GitHub rate limit through as a 429 through the real gateway", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    const fetchGitHub = vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 403,
        headers: { "retry-after": "60", "x-private": "private-header" },
      }));
    vi.stubGlobal("fetch", fetchGitHub);

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("GITHUB_RATE_LIMITED");
    expect(body.error.message).toContain("GitHub rate-limited the request to read the repository labels (HTTP 403).");
    expect(body.error.message).toContain("Retry after 60 seconds.");
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it.each([
    ["1", "Retry after 1 second."],
    ["2", "Retry after 2 seconds."],
  ])("passes a GitHub rate limit retry-after of %s seconds through with the plural matching it", async (retryAfter, delay) => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 403,
        headers: { "retry-after": retryAfter, "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("GITHUB_RATE_LIMITED");
    expect(body.error.message).toContain("GitHub rate-limited the request to read the repository labels (HTTP 403).");
    expect(body.error.message).toContain(delay);
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("answers a 502 for another GitHub API failure through the real gateway", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 500,
        headers: { "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to read the repository labels on GitHub." },
    });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("answers a GitHub credential rejection with an actionable 401 through the real gateway", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 401,
        headers: { "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "GITHUB_CREDENTIALS",
        message: "GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to read the repository labels. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry.",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("answers a GitHub credential rejection with 401 even when it carries rate-limit headers", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 401,
        headers: { "retry-after": "60", "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "GITHUB_CREDENTIALS",
        message: "GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to read the repository labels. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry.",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("answers a non-rate-limited GitHub 403 with the GITHUB_ACCESS guidance through the real gateway", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 403,
        headers: { "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "GITHUB_ACCESS",
        message: "GitHub refused to read the repository labels (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry before changing anything. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("answers a GitHub 404 with the GITHUB_ACCESS guidance through the real gateway", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response("private-body access-token-should-not-leak", {
        status: 404,
        headers: { "x-private": "private-header" },
      })));

    const response = await labelsRoute.GET(labelsRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "GITHUB_ACCESS",
        message: "GitHub answered 404 for the request to read the repository labels. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
  });

  it("reads the repository's labels with the account's stored token", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    const fetchGitHub = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/repos/octo/overflow/labels");
      return Response.json([{ name: "size/S" }, { name: "size/M" }]);
    });
    vi.stubGlobal("fetch", fetchGitHub);

    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ labels: ["size/S", "size/M"] });
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
    const [, init] = fetchGitHub.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${storedToken}`);
  });

  it("reads every label page before answering", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    const pages: string[][] = [["size/S", "size/M"], ["size/L"]];
    const fetchGitHub = vi.fn<typeof fetch>(async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      const index = Number(page) - 1;
      const labels = pages[index] ?? [];
      return new Response(JSON.stringify(labels.map((name) => ({ name }))), {
        status: 200,
        headers: index + 1 < pages.length ? { link: `<https://api.github.com/repos/octo/overflow/labels?per_page=100&page=${index + 2}>; rel="next"` } : {},
      });
    });
    vi.stubGlobal("fetch", fetchGitHub);

    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ labels: ["size/S", "size/M", "size/L"] });
    expect(fetchGitHub).toHaveBeenCalledTimes(2);
  });

  it("strips a .git suffix from the name before reading the labels", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    const fetchGitHub = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).pathname).toBe("/repos/octo/overflow/labels");
      return Response.json([{ name: "size/S" }]);
    });
    vi.stubGlobal("fetch", fetchGitHub);

    const response = await labelsRoute.GET(labelsRequest("?owner=octo&name=overflow.git"));

    expect(response.status).toBe(200);
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });

  // rejectUntrustedRequest refuses a request carrying no Origin header, but a
  // same-origin browser fetch() GET sends none, so guarding this verb would
  // refuse the read the registration form makes. The session gate is what
  // limits this route; see the moderation GET routes for the standing pattern.
  it("answers a browser-shaped request that carries no Origin header", async () => {
    readSession.mockResolvedValue(memberSession());
    stubStoredToken();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json([{ name: "size/S" }])));

    const response = await labelsRoute.GET(labelsRequest());

    expect(response.status).toBe(200);
  });
});

function memberSession() {
  return { user: { id: "sponsor-id", role: "MEMBER" as const } };
}

function stubStoredToken() {
  vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue(storedToken);
}
