import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";

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
}));

vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql }));
vi.mock("@/lib/fold/postgres-store", () => ({ claimGitHubIdentity: vi.fn() }));

/**
 * Minting an API token requires a recent GitHub sign-in, so the JWT records
 * when its holder last completed one. Only the OAuth callback — the one jwt
 * invocation that carries an `account` — may write that instant; every later
 * invocation (a session read, an update) must carry it forward untouched, or
 * holding the cookie alone would keep it fresh.
 */
describe("session authentication time", () => {
  const signedInAt = new Date("2026-09-26T12:00:00.750Z");
  const signedInAtSeconds = Math.floor(signedInAt.getTime() / 1000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"], now: signedInAt });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function callbacks() {
    await import("@/auth");
    return mocks.nextAuth.mock.calls[0]![0].callbacks!;
  }

  const githubAccount = {
    provider: "github",
    providerAccountId: "4242",
    type: "oauth" as const,
    access_token: "test-token",
    scope: "",
  };

  it("records the sign-in instant in whole epoch seconds on the OAuth callback", async () => {
    const { jwt } = await callbacks();

    const token = await jwt!({ token: {}, user: { id: "4242" }, account: githubAccount, trigger: "signIn" });

    expect(token?.authenticatedAt).toBe(signedInAtSeconds);
  });

  it("replaces an older instant when the holder signs in with GitHub again", async () => {
    const { jwt } = await callbacks();

    const token = await jwt!({
      token: { authenticatedAt: signedInAtSeconds - 3600 },
      user: { id: "4242" },
      account: githubAccount,
      trigger: "signIn",
    });

    expect(token?.authenticatedAt).toBe(signedInAtSeconds);
  });

  it.each([
    { label: "a session read", trigger: undefined },
    // An update carries whatever the caller put in `session`, so a fresh
    // instant offered there must not be taken as a sign-in.
    { label: "a session update offering a fresh instant", trigger: "update" as const },
  ])("carries the recorded instant through $label without refreshing it", async ({ trigger }) => {
    const { jwt } = await callbacks();
    const recorded = signedInAtSeconds - 3600;

    const token = await jwt!({
      token: { authenticatedAt: recorded },
      user: { id: "4242" },
      ...(trigger === undefined
        ? {}
        : { trigger, session: { user: { authenticatedAt: signedInAtSeconds } } }),
    } as never);

    expect(token?.authenticatedAt).toBe(recorded);
  });

  it("ends a JWT that predates the claim at its next read (fail-closed on the missing instant)", async () => {
    // The absolute lifetime (issue 1043): the refresh path refuses a token
    // whose sign-in instant is missing — a pre-claim JWT is exactly the
    // unbounded cookie the issue is about, so it no longer passes through.
    const { jwt } = await callbacks();

    await expect(
      jwt!({ token: { userId: "user-uuid", role: "MEMBER" }, user: { id: "4242" } } as never),
    ).resolves.toBeNull();
  });

  it("exposes the instant on the session user only when the JWT holds a finite number", async () => {
    const { session: sessionCallback } = await callbacks();
    const read = async (token: Record<string, unknown>) => {
      const session = await sessionCallback!({
        session: {
          expires: "2099-01-01T00:00:00.000Z",
          user: { id: "", name: "Ada", email: null as unknown as string, emailVerified: null },
        },
        token: { userId: "user-uuid", role: "MEMBER", ...token },
      } as never);
      const user = session.user as Record<string, unknown>;
      return { present: "authenticatedAt" in user, value: user.authenticatedAt };
    };

    await expect(read({ authenticatedAt: signedInAtSeconds })).resolves.toEqual({
      present: true,
      value: signedInAtSeconds,
    });
    for (const unusable of [undefined, String(signedInAtSeconds), Number.NaN, Number.POSITIVE_INFINITY, null]) {
      await expect(read({ authenticatedAt: unusable })).resolves.toEqual({ present: false, value: undefined });
    }
  });
});
