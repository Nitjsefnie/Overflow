import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const mocks = vi.hoisted(() => {
  const signOut = vi.fn();
  return {
    signOut,
    nextAuth: vi.fn(() => ({
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut,
    })),
    github: vi.fn(() => ({ id: "github" })),
  };
});

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));

// Issue 700: every action now opens with the origin guard, so the request
// headers must name the trusted origin (APP_URL is stubbed by useTrustedOrigin).
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: trustedOrigin, host: "overflow.internal" }),
}));

useTrustedOrigin();

describe("sign-out server action", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("clears the session and sends the visitor to the landing page", async () => {
    const { signOutAction } = await import("@/lib/auth/sign-out-action");

    await signOutAction();

    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/" });
  });

  it("does not construct NextAuth merely by being imported", async () => {
    await import("@/lib/auth/sign-out-action");

    expect(mocks.nextAuth).not.toHaveBeenCalled();
  });
});
