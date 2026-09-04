import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  github: vi.fn(() => ({ id: "github" })),
  nextAuth: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
  })),
}));

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));

describe("GitHub OAuth scope", () => {
  it("asks the GitHub provider for exactly the least-privilege read and public repository scopes", async () => {
    const { githubOAuthScope } = await import("@/auth");

    expect(githubOAuthScope).toBe("read:user public_repo");
    expect(mocks.github).toHaveBeenCalledWith({
      authorization: { params: { scope: "read:user public_repo" } },
    });
  });

  it("never requests private repository, hook administration, or email access", async () => {
    const { githubOAuthScope } = await import("@/auth");

    const requestedScopes = githubOAuthScope.split(" ");
    expect(requestedScopes).not.toContain("repo");
    expect(requestedScopes).not.toContain("admin:repo_hook");
    expect(requestedScopes).not.toContain("user:email");
  });
});
