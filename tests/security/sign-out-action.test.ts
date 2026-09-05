import { beforeEach, describe, expect, it, vi } from "vitest";

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
