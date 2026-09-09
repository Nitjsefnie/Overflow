import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";
import { requestGitHubPublicIdentity } from "@/lib/auth/github-userinfo";

const mocks = vi.hoisted(() => ({
  github: vi.fn<(config: unknown) => { id: string }>(() => ({ id: "github" })),
  nextAuth: vi.fn<(config: NextAuthConfig) => unknown>(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
  })),
  sql: vi.fn(),
  claimGitHubIdentity: vi.fn(),
}));

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql }));
vi.mock("@/lib/fold/postgres-store", () => ({ claimGitHubIdentity: mocks.claimGitHubIdentity }));

const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails";
const secretAccessToken = "secret-access-token";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchMockReturning(profile: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(jsonResponse(profile));
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("requestGitHubPublicIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches only /user and tolerates a profile with no email, never touching /user/emails", async () => {
    const profileWithoutEmail = {
      login: "octocat",
      id: 4242,
      avatar_url: "https://avatars.example/octocat.png",
      name: null,
    };
    const fetchMock = fetchMockReturning(profileWithoutEmail);
    vi.stubGlobal("fetch", fetchMock);

    const profile = await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } });

    expect(profile).toEqual(profileWithoutEmail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetchMock)).toEqual([GITHUB_USER_URL]);
    expect(requestedUrls(fetchMock).some((url) => url.startsWith(GITHUB_USER_EMAILS_URL))).toBe(false);
  });

  it("sends the bearer token and a user agent on the /user request", async () => {
    const fetchMock = fetchMockReturning({ login: "octocat", id: 4242 });
    vi.stubGlobal("fetch", fetchMock);

    await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${secretAccessToken}`);
    expect(headers.get("user-agent")).toBe("authjs");
  });

  it("passes an email through unchanged without querying the email endpoint when one exists", async () => {
    const profileWithEmail = {
      login: "octocat",
      id: 4242,
      avatar_url: "https://avatars.example/octocat.png",
      email: "octocat@example.com",
    };
    const fetchMock = fetchMockReturning(profileWithEmail);
    vi.stubGlobal("fetch", fetchMock);

    const profile = await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } });

    expect(profile).toEqual(profileWithEmail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetchMock)).toEqual([GITHUB_USER_URL]);
    expect(requestedUrls(fetchMock).some((url) => url.startsWith(GITHUB_USER_EMAILS_URL))).toBe(false);
  });

  it("reads the access token from the tokens the provider passes in", async () => {
    const fetchMock = fetchMockReturning({ login: "octocat", id: 4242 });
    vi.stubGlobal("fetch", fetchMock);

    await requestGitHubPublicIdentity({
      tokens: { access_token: secretAccessToken, refresh_token: "irrelevant" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${secretAccessToken}`);
  });
});

describe("GitHub provider wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("overrides the provider userinfo request with the public-identity request", async () => {
    await import("@/auth");
    // Imported after resetModules so this reference is the same module
    // instance the auth config captured.
    const { requestGitHubPublicIdentity } = await import("@/lib/auth/github-userinfo");

    expect(mocks.github).toHaveBeenCalledTimes(1);
    const config = mocks.github.mock.calls[0]![0] as {
      userinfo?: { url?: string; request?: unknown };
    };
    expect(config.userinfo?.url).toBe(GITHUB_USER_URL);
    expect(config.userinfo?.request).toBe(requestGitHubPublicIdentity);
  });
});
