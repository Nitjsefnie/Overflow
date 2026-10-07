import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTrustedOrigin } from "../support/trusted-origin";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

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

// Issue 700: every action now opens with the origin guard, so the request
// headers must name the trusted origin (APP_URL is stubbed by useTrustedOrigin).
vi.mock("next/headers", async () => (await import("../support/trusted-origin")).trustedRequestHeaders());

useTrustedOrigin();

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

  // Minting an API token needs a recent sign-in, not a wider grant: this one
  // requests no scope. GitHub issues the new authorization with only the
  // scopes the sign-in requested, so an earlier webhook-administration grant
  // survives through the storage path's continuity ruling (src/auth.ts).
  it("re-confirms a member's sign-in for an API token with the empty scope and returns to repository registration", async () => {
    const { confirmSignInForApiToken } = await import("@/lib/auth/sign-in-actions");

    await confirmSignInForApiToken();

    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/repositories/new" }, { scope: "" });
  });

  it("does not construct NextAuth merely by being imported", async () => {
    await import("@/lib/auth/sign-in-actions");

    expect(mocks.nextAuth).not.toHaveBeenCalled();
  });
});
