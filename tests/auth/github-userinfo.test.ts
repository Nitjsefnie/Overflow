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
    vi.restoreAllMocks();
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

  it("rejects a 403 JSON body with a typed status error and logs the upstream reason code, never the rate-limit object as a profile", async () => {
    const rateLimitBody = {
      message: "API rate limit exceeded for 169.58.58.201.",
      documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rateLimitBody), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } }).then(
      () => expect.fail("expected requestGitHubPublicIdentity to reject on a 403 /user response"),
      (rejection: unknown) => rejection,
    );

    // The typed error carries the numeric status; the rate-limit body never
    // resolves as the profile (the request rejects instead) and its
    // documentation_url never leaks into the error or the diagnostic.
    expect(error).toMatchObject({
      name: "GitHubUserinfoStatusError",
      status: 403,
      message: expect.stringContaining("API rate limit exceeded for 169.58.58.201."),
    });
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(String((error as Error).message)).not.toContain("documentation_url");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("SIGNIN_UPSTREAM_UNAVAILABLE");
    expect(logged).toContain("403");
    expect(logged).toContain("API rate limit exceeded for 169.58.58.201.");
    expect(logged).not.toContain("documentation_url");
  });

  it("rejects a 502 HTML body with a typed status error, never a raw SyntaxError, keeping the diagnostic bounded", async () => {
    const htmlBody =
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center>" +
      "<hr><p>nginx/1.24.0 repeats the upstream failure page over and over to bulk this body past any reasonable log bound.</p>".repeat(6) +
      "<p>END_OF_LONG_BODY_MARKER</p></body></html>";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(htmlBody, {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } }).then(
      () => expect.fail("expected requestGitHubPublicIdentity to reject on a 502 /user response"),
      (rejection: unknown) => rejection,
    );

    expect(error).toMatchObject({ name: "GitHubUserinfoStatusError", status: 502 });
    expect(error).not.toBeInstanceOf(SyntaxError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("SIGNIN_UPSTREAM_UNAVAILABLE");
    expect(logged).toContain("502");
    // The non-JSON fallback still yields a bounded snippet: the collapsed
    // body head survives the 200-char truncation even though the whole body
    // does not reach the log.
    expect(logged).toContain("<!DOCTYPE html>");
    expect(logged).not.toContain(htmlBody);
    expect(logged).not.toContain("END_OF_LONG_BODY_MARKER");
  });

  it("reports a non-2xx response with an empty body as the bare typed error, with no message segment in the diagnostic", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } }).then(
      () => expect.fail("expected requestGitHubPublicIdentity to reject on a 503 /user response"),
      (rejection: unknown) => rejection,
    );

    // Bare message form: an empty upstream snippet adds no colon or space.
    expect(error).toMatchObject({
      name: "GitHubUserinfoStatusError",
      status: 503,
      message: "GitHub /user responded 503",
    });
    expect(error).not.toBeInstanceOf(SyntaxError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("SIGNIN_UPSTREAM_UNAVAILABLE");
    expect(logged).toContain("503");
    expect(logged).not.toContain("message=");
  });

  it("aborts a never-settling /user transport at the 10-second deadline and fails through the upstream-unavailable diagnostic", async () => {
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let suppliedSignal: AbortSignal | undefined;
      // An abort-ignoring transport: it records the signal the request
      // supplied and never settles, so only an application-owned deadline
      // can end the call.
      vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit): Promise<Response> => {
        suppliedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }));

      const settled = requestGitHubPublicIdentity({ tokens: { access_token: secretAccessToken } }).then(
        () => "resolved" as const,
        (rejection: unknown) => ({ rejected: rejection }),
      );

      // The deadline is the same 10 seconds the other GitHub clients use:
      // nothing may reject the call before it.
      await vi.advanceTimersByTimeAsync(9_999);
      const beforeDeadline = await Promise.race([settled, Promise.resolve("still-pending" as const)]);
      expect(beforeDeadline).toBe("still-pending");

      // At the deadline the call rejects — it never stays pending against a
      // transport that ignores the abort signal.
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await Promise.race([settled, Promise.resolve("still-pending" as const)]);
      expect(outcome).not.toBe("still-pending");

      const rejection = (outcome as { rejected: unknown }).rejected;
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("timed out");
      expect(suppliedSignal).toBeDefined();
      expect(suppliedSignal?.aborted).toBe(true);

      // The timeout failure routes through the existing upstream-unavailable
      // diagnostic, exactly once.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("SIGNIN_UPSTREAM_UNAVAILABLE");
    } finally {
      vi.useRealTimers();
    }
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
