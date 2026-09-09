import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NextAuthConfig, Profile } from "next-auth";
import {
  SIGN_IN_REFUSAL_REASONS,
  decideGitHubSignIn,
  readGitHubIdentity,
  type PersistGitHubIdentity,
} from "@/lib/auth/sign-in-decision";

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

const validProfile = {
  id: 4242,
  login: "octocat",
  avatar_url: "https://avatars.example/octocat.png",
} as unknown as Profile;

const secretAccessToken = "secret-access-token";

function persistSucceeding(): Mock<PersistGitHubIdentity> {
  return vi.fn<PersistGitHubIdentity>().mockResolvedValue({ id: "user-uuid", role: "MEMBER" });
}

function loggedArgs(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls.flat();
}

describe("SIGN_IN_REFUSAL_REASONS", () => {
  // The values are the operator-facing contract — saved log queries grep for
  // them — so they are pinned as literals. Asserting through the constant
  // itself (as the classification tests do) passes any rename.
  it("keeps the published reason-code literals", () => {
    expect(SIGN_IN_REFUSAL_REASONS).toEqual({
      identity: "SIGNIN_IDENTITY_INVALID",
      accessToken: "SIGNIN_ACCESS_TOKEN_MISSING",
      persistence: "SIGNIN_PERSIST_FAILED",
    });
  });
});

describe("readGitHubIdentity", () => {
  it("parses a numeric GitHub id, login, and avatar url", () => {
    expect(
      readGitHubIdentity({
        id: 4242,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat.png",
      } as unknown as Profile),
    ).toEqual({
      githubUserId: 4242,
      login: "octocat",
      avatarUrl: "https://avatars.example/octocat.png",
    });
  });

  it("parses a numeric-string GitHub id", () => {
    expect(
      readGitHubIdentity({ id: "4242", login: "octocat" } as unknown as Profile),
    ).toEqual({ githubUserId: 4242, login: "octocat", avatarUrl: null });
  });

  it("refuses a whitespace-only login", () => {
    expect(readGitHubIdentity({ id: 4242, login: "   " } as unknown as Profile)).toBeNull();
  });

  it("refuses an undefined profile", () => {
    expect(readGitHubIdentity(undefined)).toBeNull();
  });
});

describe("decideGitHubSignIn", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("allows a sign-in whose identity validates, token is present, and persistence succeeds", async () => {
    const persist = persistSucceeding();

    await expect(
      decideGitHubSignIn({ profile: validProfile, accessToken: secretAccessToken, persist }),
    ).resolves.toBe(true);

    expect(persist).toHaveBeenCalledExactlyOnceWith(
      { githubUserId: 4242, login: "octocat", avatarUrl: "https://avatars.example/octocat.png" },
      secretAccessToken,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("refuses with SIGNIN_IDENTITY_INVALID when the profile fails identity validation", async () => {
    const persist = persistSucceeding();

    await expect(
      decideGitHubSignIn({ profile: undefined, accessToken: secretAccessToken, persist }),
    ).resolves.toBe(false);

    expect(persist).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(SIGN_IN_REFUSAL_REASONS.identity);
  });

  it.each([
    { label: "an undefined profile", profile: undefined },
    { label: "a profile without a login", profile: { id: 4242 } },
    { label: "a profile with a non-numeric id", profile: { login: "octocat", id: "octocat" } },
    { label: "a profile with a non-positive id", profile: { id: 0, login: "octocat" } },
    {
      label: "a profile with a non-string avatar url",
      profile: { id: 4242, login: "octocat", avatar_url: 7 },
    },
  ])("classifies $label as SIGNIN_IDENTITY_INVALID", async ({ profile }) => {
    const persist = persistSucceeding();

    await expect(
      decideGitHubSignIn({ profile: profile as unknown as Profile, accessToken: secretAccessToken, persist }),
    ).resolves.toBe(false);

    expect(persist).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(SIGN_IN_REFUSAL_REASONS.identity);
  });

  it("classifies an undefined access token as SIGNIN_ACCESS_TOKEN_MISSING", async () => {
    const persist = persistSucceeding();

    await expect(
      decideGitHubSignIn({ profile: validProfile, accessToken: undefined, persist }),
    ).resolves.toBe(false);

    expect(persist).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(SIGN_IN_REFUSAL_REASONS.accessToken);
  });

  it("classifies an empty-string access token as SIGNIN_ACCESS_TOKEN_MISSING", async () => {
    const persist = persistSucceeding();

    await expect(
      decideGitHubSignIn({ profile: validProfile, accessToken: "", persist }),
    ).resolves.toBe(false);

    expect(persist).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(SIGN_IN_REFUSAL_REASONS.accessToken);
  });

  it("refuses with SIGNIN_PERSIST_FAILED and logs the error when persistence throws", async () => {
    const persistError = new Error("connection refused");
    const persist = vi.fn<PersistGitHubIdentity>().mockRejectedValue(persistError);

    await expect(
      decideGitHubSignIn({ profile: validProfile, accessToken: secretAccessToken, persist }),
    ).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(SIGN_IN_REFUSAL_REASONS.persistence);
    expect(loggedArgs(errorSpy)).toContain(persistError);
  });

  it("never logs the access token or any profile field", async () => {
    const persist = vi.fn<PersistGitHubIdentity>().mockRejectedValue(new Error("database unreachable"));

    await expect(
      decideGitHubSignIn({ profile: validProfile, accessToken: secretAccessToken, persist }),
    ).resolves.toBe(false);

    const allLogs = loggedArgs(errorSpy).map(String).join("\n");
    expect(allLogs).not.toContain(secretAccessToken);
    expect(allLogs).not.toContain("octocat");
    expect(allLogs).not.toContain("4242");
  });
});

describe("signIn callback wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function signInCallback(): Promise<(params: unknown) => Promise<boolean>> {
    await import("@/auth");
    return mocks.nextAuth.mock.calls[0]![0].callbacks!.signIn! as (
      params: unknown,
    ) => Promise<boolean>;
  }

  it("delegates the identity refusal to the decision and logs its reason code", async () => {
    const signIn = await signInCallback();

    await expect(
      signIn({
        user: { id: "4242" },
        account: { provider: "github", providerAccountId: "4242", type: "oauth", access_token: secretAccessToken },
        profile: undefined,
      }),
    ).resolves.toBe(false);

    // The reason code in the log is what distinguishes a delegated decision
    // from a bare `return false`: the refusal verdict alone cannot.
    expect(vi.mocked(console.error).mock.calls.length).toBeGreaterThan(0);
    const codes = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .join("\n");
    expect(codes).toContain(SIGN_IN_REFUSAL_REASONS.identity);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("delegates the access-token refusal to the decision and logs its reason code", async () => {
    const signIn = await signInCallback();

    await expect(
      signIn({
        user: { id: "4242" },
        account: undefined,
        profile: validProfile,
      }),
    ).resolves.toBe(false);

    expect(vi.mocked(console.error).mock.calls.length).toBeGreaterThan(0);
    const codes = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .join("\n");
    expect(codes).toContain(SIGN_IN_REFUSAL_REASONS.accessToken);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
