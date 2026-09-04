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
