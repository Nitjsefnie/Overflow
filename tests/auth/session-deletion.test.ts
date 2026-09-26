import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig, Profile } from "next-auth";
import { refreshSessionToken, type SessionAccountState } from "@/lib/auth/account-store";
import type { PersistedGitHubUser } from "@/lib/auth/sign-in-decision";

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
  upsertGitHubAccount: vi.fn<(...args: unknown[]) => Promise<PersistedGitHubUser>>(),
  findGitHubAccount: vi.fn<(githubUserId: number) => Promise<PersistedGitHubUser | null>>(),
  findSessionAccountState: vi.fn<(id: string) => Promise<SessionAccountState>>(),
}));

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql }));
vi.mock("@/lib/fold/postgres-store", () => ({ claimGitHubIdentity: mocks.claimGitHubIdentity }));
// Every DB-touching export is replaced. Spreading the actual module here is a
// cross-file leak under isolate: false — importOriginal would return the
// actual instance another file (e.g. a container suite) already loaded, with
// its exports bound to the real database client. Only the PURE
// refreshSessionToken is kept real: it takes the lookup as an argument and
// never reaches getSql, so the wiring still proves a DELETED row is what
// turns the refreshed token into null.
vi.mock("@/lib/auth/account-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account-store")>();
  return {
    refreshSessionToken: actual.refreshSessionToken,
    upsertGitHubAccount: mocks.upsertGitHubAccount,
    findGitHubAccount: mocks.findGitHubAccount,
    findSessionAccountState: mocks.findSessionAccountState,
  };
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

  it("resolves the account inline on the sign-in branch and never consults the session state", async () => {
    const jwt = await jwtCallback();
    mocks.findGitHubAccount.mockResolvedValue({ id: "user-uuid", role: "MEMBER" });
    const token = { userId: "u1", role: "MEMBER" };

    await expect(jwt({
      token,
      account: { provider: "github", providerAccountId: "4242", type: "oauth" },
      profile: { id: 4242, login: "octocat" } as unknown as Profile,
    } as never)).resolves.toEqual({ userId: "user-uuid", role: "MEMBER", canAdministerWebhooks: false });
    expect(mocks.findGitHubAccount).toHaveBeenCalledExactlyOnceWith(4242);
    // The jwt callback resolves the account read-only: persistence belongs to
    // the signIn callback, and the refresh lookup has no business here.
    expect(mocks.upsertGitHubAccount).not.toHaveBeenCalled();
    expect(mocks.findSessionAccountState).not.toHaveBeenCalled();
  });
});
