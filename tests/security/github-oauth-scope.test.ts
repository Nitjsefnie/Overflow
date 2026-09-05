import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => { vi.resetModules(); });

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
