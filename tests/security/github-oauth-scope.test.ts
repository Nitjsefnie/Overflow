import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig, Profile } from "next-auth";

const mocks = vi.hoisted(() => ({
  github: vi.fn(() => ({ id: "github" })),
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

describe("GitHub OAuth scope", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    { name: "grants a configured account after a rename", id: 4242, login: "renamed-moderator", ids: "4242", legacy: "former-login", role: "MODERATOR" },
    { name: "rejects a different account holding the same login", id: 4243, login: "renamed-moderator", ids: "4242", legacy: "renamed-moderator", role: "MEMBER" },
    { name: "rejects a numeric login equal to a configured id", id: 4244, login: "4242", ids: "4242", legacy: undefined, role: "MEMBER" },
    { name: "ignores the legacy login variable alone", id: 9001, login: "recycled", ids: undefined, legacy: "recycled", role: "MEMBER" },
    { name: "grants nobody for an empty configuration", id: 4245, login: "ordinary", ids: "", legacy: undefined, role: "MEMBER" },
    { name: "grants nobody for an unset configuration", id: 4246, login: "ordinary", ids: undefined, legacy: undefined, role: "MEMBER" },
    { name: "grants nobody for a junk-only configuration", id: 4247, login: "octocat", ids: "octocat,0,-1", legacy: undefined, role: "MEMBER" },
    { name: "trims configured ids alongside junk entries", id: 42, login: "renamed", ids: " junk, 42 ,0", legacy: undefined, role: "MODERATOR" },
    { name: "rejects leading-zero ids", id: 42, login: "renamed", ids: "042", legacy: undefined, role: "MEMBER" },
    { name: "does not substitute the next account id", id: 4248, login: "neighbor", ids: "4249", legacy: undefined, role: "MEMBER" },
    { name: "grants the configured neighboring account", id: 4249, login: "configured-neighbor", ids: "4249", legacy: undefined, role: "MODERATOR" },
  ])("bootstrap $name", async ({ id, login, ids, legacy, role }) => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64url"));
    vi.stubEnv("MODERATOR_GITHUB_USER_IDS", ids);
    vi.stubEnv("MODERATOR_GITHUB_LOGINS", legacy);
    mocks.sql.mockResolvedValue([{ id: "claimant-uuid", role: "MEMBER" }]);
    await import("@/auth");
    const signIn = mocks.nextAuth.mock.calls[0]![0].callbacks!.signIn!;

    await expect(signIn({
      user: { id: String(id) },
      account: { provider: "github", providerAccountId: String(id), type: "oauth", access_token: "test-token" },
      profile: { id, login, avatar_url: null } as unknown as Profile,
    })).resolves.toBe(true);

    expect(mocks.sql).toHaveBeenCalledTimes(1);
    const [, ...bindings] = mocks.sql.mock.calls[0]!;
    expect(bindings.slice(0, 4)).toEqual([id, login, null, role]);
    expect(mocks.claimGitHubIdentity).toHaveBeenCalledExactlyOnceWith(mocks.sql, "claimant-uuid", id);
  });

  it.each(["renamed-contributor", "9001"])("claims the profile account id at sign-in with login %s", async (login) => {
    await import("@/auth");
    const config = mocks.nextAuth.mock.calls[0]![0];
    const signIn = config.callbacks!.signIn!;
    const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64url");
    mocks.sql.mockResolvedValue([{ id: "claimant-uuid", role: "MEMBER" }]);
    mocks.claimGitHubIdentity.mockReset();
    try {
      await expect(signIn({
        user: { id: "4242" },
        account: { provider: "github", providerAccountId: "4242", type: "oauth", access_token: "test-token" },
        // GitHub supplies a number; NextAuth's generic Profile declares a string id.
        profile: { id: 4242, login, avatar_url: null } as unknown as Profile,
      })).resolves.toBe(true);
      expect(mocks.claimGitHubIdentity).toHaveBeenCalledExactlyOnceWith(mocks.sql, "claimant-uuid", 4242);
    } finally {
      if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    }
  });

  it("asks the GitHub provider for exactly the public repository scope", async () => {
    const { githubOAuthScope } = await import("@/auth");

    expect(githubOAuthScope).toBe("public_repo");
    expect(mocks.github).toHaveBeenCalledWith({
      authorization: { params: { scope: "public_repo" } },
    });
  });

  it("never requests private profile, email, private repository, or hook administration access", async () => {
    const { githubOAuthScope } = await import("@/auth");

    const requestedScopes = githubOAuthScope.split(" ");
    expect(requestedScopes).not.toContain("read:user");
    expect(requestedScopes).not.toContain("user:email");
    expect(requestedScopes).not.toContain("repo");
    expect(requestedScopes).not.toContain("admin:repo_hook");
  });
});
