import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foreignOrigin, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

const state = vi.hoisted(() => ({
  sql: vi.fn(async (..._args: unknown[]) => []),
  signIn: vi.fn(async (..._args: unknown[]) => undefined),
  origin: "https://overflow.example",
}));

vi.hoisted(() => { vi.resetModules(); });
vi.mock("@/lib/db/client", () => ({ getSql: () => state.sql }));
vi.mock("@/auth", () => ({ signIn: state.signIn }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: state.origin }) }));

useTrustedOrigin();

beforeEach(() => {
  state.origin = trustedOrigin;
  state.sql.mockReset().mockResolvedValue([]);
  state.signIn.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("@/auth");
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("repository-registration sign-in counting", () => {
  it("records one registration start before the redirecting sign-in", async () => {
    const redirect = new Error("redirect");
    state.signIn.mockRejectedValueOnce(redirect);
    const { signInForRepositoryRegistration } = await import("@/lib/auth/sign-in-actions");

    await expect(signInForRepositoryRegistration()).rejects.toBe(redirect);

    expect(state.sql).toHaveBeenCalledTimes(1);
    expect(state.sql.mock.calls[0]).toContain("REGISTRATION_START");
    expect(state.sql.mock.invocationCallOrder[0]!).toBeLessThan(state.signIn.mock.invocationCallOrder[0]!);
    expect(state.signIn).toHaveBeenCalledOnce();
  });

  it("does not count contributor sign-in or API-token confirmation", async () => {
    const { signInAsContributor, confirmSignInForApiToken } = await import("@/lib/auth/sign-in-actions");

    await signInAsContributor();
    await confirmSignInForApiToken();

    expect(state.signIn).toHaveBeenCalledTimes(2);
    expect(state.sql).not.toHaveBeenCalled();
  });

  it("waits for the counter to settle before starting sign-in", async () => {
    let started!: () => void;
    let release!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    state.sql.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    });
    const { signInForRepositoryRegistration } = await import("@/lib/auth/sign-in-actions");
    await import("@/auth");

    const pending = signInForRepositoryRegistration();
    await writeStarted;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state.signIn).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await pending;
    expect(state.signIn).toHaveBeenCalledOnce();
  });

  it("continues sign-in when the counter fails without logging the error's contents", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.sql.mockRejectedValueOnce(new Error("private database detail"));
    const { signInForRepositoryRegistration } = await import("@/lib/auth/sign-in-actions");

    await signInForRepositoryRegistration();

    expect(state.sql).toHaveBeenCalledTimes(1);
    expect(state.signIn).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private database detail");
  });

  it("does not count an untrusted origin", async () => {
    state.origin = foreignOrigin;
    const { signInForRepositoryRegistration } = await import("@/lib/auth/sign-in-actions");

    await expect(signInForRepositoryRegistration()).rejects.toThrow();
    expect(state.signIn).not.toHaveBeenCalled();
    expect(state.sql).not.toHaveBeenCalled();
  });
});
