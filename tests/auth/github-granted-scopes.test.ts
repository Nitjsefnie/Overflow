import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubScopeProbeError,
  GitHubWebhookScopeError,
  readGitHubGrantedScopes,
  requireWebhookAdministration,
} from "@/lib/auth/github-granted-scopes";

const GITHUB_USER_URL = "https://api.github.com/user";
const accessToken = "stored-oauth-token";

function userResponse(scopes: string | null, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (scopes !== null) {
    headers.set("x-oauth-scopes", scopes);
  }
  return new Response(JSON.stringify({ id: 4242, login: "octocat" }), { status, headers });
}

afterEach(() => {
  vi.useRealTimers();
});

// Issue 599: the scopes GitHub actually granted are read from an authenticated
// response's X-OAuth-Scopes header — never from the scope the sign-in asked
// for or the hint the JWT carries.
describe("readGitHubGrantedScopes", () => {
  it("asks /user with the bearer token and returns the header's scopes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse("admin:repo_hook, read:user"));

    await expect(readGitHubGrantedScopes(accessToken, fetchMock)).resolves.toEqual([
      "admin:repo_hook",
      "read:user",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(GITHUB_USER_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
  });

  it.each([
    { label: "an empty header", scopes: "" },
    { label: "no header at all", scopes: null },
  ])("reads $label as no scopes granted", async ({ scopes }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse(scopes));

    await expect(readGitHubGrantedScopes(accessToken, fetchMock)).resolves.toEqual([]);
  });

  it.each([401, 403, 500])("refuses a %i response with a typed error carrying the status", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse("admin:repo_hook", status));

    const failure = await readGitHubGrantedScopes(accessToken, fetchMock).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubScopeProbeError);
    expect((failure as GitHubScopeProbeError).status).toBe(status);
    expect((failure as Error).message).not.toContain(accessToken);
  });

  it("fails the probe when the transport never settles within the deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );

    const probe = readGitHubGrantedScopes(accessToken, fetchMock);
    const settled = probe.then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(9_999);
    // Still pending one millisecond short of the deadline.
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBe("rejected");
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});

describe("requireWebhookAdministration", () => {
  it.each([
    { label: "the registration grant", scopes: "admin:repo_hook" },
    { label: "the registration grant beside identity scopes", scopes: "read:user, admin:repo_hook" },
    { label: "full repository access", scopes: "repo" },
    { label: "public repository access", scopes: "public_repo" },
  ])("answers the granted scopes for $label", async ({ scopes }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse(scopes));

    await expect(requireWebhookAdministration(accessToken, fetchMock)).resolves.toEqual(
      scopes.split(", "),
    );
  });

  it.each([
    { label: "the contributor grant", scopes: "" },
    { label: "identity scopes only", scopes: "read:user, user:email" },
    { label: "hook write without delete", scopes: "write:repo_hook" },
  ])("refuses $label with the scope error naming the remedy", async ({ scopes }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse(scopes));

    const failure = await requireWebhookAdministration(accessToken, fetchMock).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubWebhookScopeError);
    expect((failure as GitHubWebhookScopeError).grantedScopes).toEqual(scopes === "" ? [] : scopes.split(", "));
    expect((failure as Error).message).toContain("admin:repo_hook");
    expect((failure as Error).message).toMatch(/sign in to register a repository/i);
    expect((failure as Error).message).not.toContain(accessToken);
  });

  it("lets a probe failure through unchanged", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => userResponse("admin:repo_hook", 401));

    await expect(requireWebhookAdministration(accessToken, fetchMock)).rejects.toBeInstanceOf(GitHubScopeProbeError);
  });
});
