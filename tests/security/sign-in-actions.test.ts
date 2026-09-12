import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const signIn = vi.fn();
  return {
    signIn,
    nextAuth: vi.fn(() => ({
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn,
      signOut: vi.fn(),
    })),
    github: vi.fn(() => ({ id: "github" })),
  };
});

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));

// Issue 599: the two sign-in actions are the only places a scope is chosen.
// Each passes its scope per call, which overrides the provider default
// (@auth/core 0.41.3, lib/actions/signin/authorization-url.js merges the
// request query over provider.authorization.params).
describe("sign-in server actions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("signs a contributor in with the explicit empty scope and returns to the dashboard", async () => {
    const { signInAsContributor } = await import("@/lib/auth/sign-in-actions");

    await signInAsContributor();

    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/dashboard" }, { scope: "" });
  });

  it("signs a sponsor in with webhook administration and returns to repository registration", async () => {
    const { signInForRepositoryRegistration } = await import("@/lib/auth/sign-in-actions");

    await signInForRepositoryRegistration();

    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith(
      "github",
      { redirectTo: "/repositories/new" },
      { scope: "admin:repo_hook" },
    );
  });

  it("does not construct NextAuth merely by being imported", async () => {
    await import("@/lib/auth/sign-in-actions");

    expect(mocks.nextAuth).not.toHaveBeenCalled();
  });
});
