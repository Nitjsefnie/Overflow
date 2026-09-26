import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig, Profile } from "next-auth";
import { refreshSessionToken, type SessionAccountState } from "@/lib/auth/account-store";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const mocks = vi.hoisted(() => ({
  github: vi.fn(() => ({ id: "github" })),
  nextAuth: vi.fn<(config: NextAuthConfig) => unknown>(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
  })),
  sql: vi.fn(),
  claimGitHubIdentity: vi.fn(),
  findSessionAccountState: vi.fn<(id: string) => Promise<SessionAccountState>>(),
}));

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql }));
vi.mock("@/lib/fold/postgres-store", () => ({ claimGitHubIdentity: mocks.claimGitHubIdentity }));
// Only the lookup is replaced; the real refreshSessionToken runs, so the
// wiring proves a DELETED row is what turns the refreshed token into null.
vi.mock("@/lib/auth/account-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account-store")>();
  return { ...actual, findSessionAccountState: mocks.findSessionAccountState };
});

type Lookup = (id: string) => Promise<SessionAccountState>;

describe("refreshSessionToken", () => {
  it("returns the token and never looks up when the token carries no string userId", async () => {
    const lookup: Lookup = vi.fn().mockResolvedValue("DELETED");

    await expect(refreshSessionToken({}, lookup)).resolves.toEqual({});
    await expect(refreshSessionToken({ userId: 4242 }, lookup)).resolves.toEqual({ userId: 4242 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns null when the account is DELETED", async () => {
    const lookup: Lookup = vi.fn().mockResolvedValue("DELETED");

    await expect(
      refreshSessionToken({ userId: "u1", role: "MEMBER" }, lookup),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("keeps the token when the account is LIVE", async () => {
    const lookup: Lookup = vi.fn().mockResolvedValue("LIVE");
    const token = { userId: "u1", role: "MEMBER" };

    await expect(refreshSessionToken(token, lookup)).resolves.toBe(token);
  });

  it("keeps the token when the account is MISSING, preserving the stale-session route", async () => {
    const lookup: Lookup = vi.fn().mockResolvedValue("MISSING");
    const token = { userId: "u1", role: "MEMBER" };

    await expect(refreshSessionToken(token, lookup)).resolves.toBe(token);
  });

  it("fails open when the lookup throws", async () => {
    const lookup: Lookup = vi.fn().mockRejectedValue(new Error("database unreachable"));
    const token = { userId: "u1", role: "MEMBER" };

    await expect(refreshSessionToken(token, lookup)).resolves.toBe(token);
  });
});

describe("jwt callback wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function jwtCallback(): Promise<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>> {
    await import("@/auth");
    return mocks.nextAuth.mock.calls[0]![0].callbacks!.jwt!;
  }

  it("ends the session of a deleted account: the refreshed token is null", async () => {
    const jwt = await jwtCallback();
    mocks.findSessionAccountState.mockResolvedValue("DELETED");
    const token = { userId: "u1", role: "MEMBER" };

    await expect(jwt({ token } as never)).resolves.toBeNull();
    expect(mocks.findSessionAccountState).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("keeps the token of a live account on a refresh call", async () => {
    const jwt = await jwtCallback();
    mocks.findSessionAccountState.mockResolvedValue("LIVE");
    const token = { userId: "u1", role: "MEMBER" };

    await expect(jwt({ token } as never)).resolves.toBe(token);
  });

  it("does not consult the account state on the sign-in branch", async () => {
    const jwt = await jwtCallback();
    const token = { userId: "u1", role: "MEMBER" };

    // The sign-in branch resolves the account inline (sql re-read) and returns
    // the same token object; the refresh lookup has no business in it. Only
    // the lookup is pinned here — under this repo's reused, non-isolated
    // workers a cross-file module graph can leave the sql mock data path
    // foreign to this file's instance, and that population is not this test's
    // subject.
    await expect(jwt({
      token,
      account: { provider: "github", providerAccountId: "4242", type: "oauth" },
      profile: { id: 4242, login: "octocat" } as unknown as Profile,
    } as never)).resolves.toBe(token);
    expect(mocks.findSessionAccountState).not.toHaveBeenCalled();
  });
});
