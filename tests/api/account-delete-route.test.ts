import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createAccountDeleteHandler, DELETE as productionDelete } from "@/app/api/account/route";
import type { AccountDeletionOutcome } from "@/lib/accounts/deletion";
import type { SqlClient } from "@/lib/db/types";
import { guardedRequests, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const {
  productionAuth,
  productionSignOut,
  productionGetSql,
  productionFindIdentity,
  productionDeleteAccount,
} = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionSignOut: vi.fn(),
  productionGetSql: vi.fn(),
  productionFindIdentity: vi.fn(),
  productionDeleteAccount: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth, signOut: productionSignOut }));
vi.mock("@/lib/db/client", () => ({ getSql: productionGetSql }));
vi.mock("@/lib/accounts/self-service", () => ({ findLiveAccountIdentity: productionFindIdentity }));
vi.mock("@/lib/accounts/deletion", () => ({ deleteAccount: productionDeleteAccount }));

useTrustedOrigin();
const requests = guardedRequests("/api/account");
const sql = {} as SqlClient;
const now = Date.parse("2026-09-26T12:00:00Z");
const deleted: AccountDeletionOutcome = { kind: "DELETED", githubUserId: 42, accountId: "internal-id", alreadyDeleted: false, deletedAt: "2026-09-26T12:00:00Z", removedApiTokens: 0, scrubbedForgeIdentities: 0 };

function dependencies() {
  return {
    getSession: vi.fn(async (): Promise<{ user: { id: string; authenticatedAt: number | null } } | null> => ({ user: { id: "internal-id", authenticatedAt: now / 1000 } })),
    getSql: vi.fn(() => sql),
    findIdentity: vi.fn(async (): Promise<{ githubUserId: number; githubLogin: string } | null> => ({ githubUserId: 42, githubLogin: "Alice" })),
    deleteAccount: vi.fn(async (): Promise<AccountDeletionOutcome> => deleted),
    endSession: vi.fn(async () => undefined),
    now: () => now,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // resetAllMocks, not clearAllMocks: a queued mockResolvedValueOnce survives
  // clearing, so once-values queued by an earlier refusal test that never
  // reaches signOut absorb the next test's call — its in-mock ordering
  // assertion then never runs. Resetting drops the queued once-values while
  // keeping each vi.fn(implementation) default.
  vi.resetAllMocks();
});
afterAll(() => vi.resetModules());

describe("DELETE /api/account", () => {
  it.each([
    ["foreign Origin", requests.foreignJson({ confirmLogin: "Alice" }, "DELETE")],
    ["missing Origin", new Request(requests.url, { method: "DELETE" })],
    ["foreign text", requests.foreignText({ confirmLogin: "Alice" }, "DELETE")],
  ])("refuses %s before dependencies", async (_label, request) => {
    const deps = dependencies();
    const response = await createAccountDeleteHandler(deps)(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "The request origin is not allowed." } });
    // `now` is a plain clock function, not an injected dependency spy.
    for (const [name, dep] of Object.entries(deps)) if (name !== "now") expect(dep).not.toHaveBeenCalled();
  });

  it("requires a session even when Authorization carries a bearer token", async () => {
    const deps = dependencies();
    deps.getSession.mockResolvedValueOnce(null);
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE", { authorization: "Bearer token" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    expect(deps.getSql).not.toHaveBeenCalled();
  });

  it.each([null, now / 1000 - 601, now / 1000 + 61])("requires recent GitHub sign-in: %s", async (authenticatedAt) => {
    const deps = dependencies();
    deps.getSession.mockResolvedValueOnce({ user: { id: "internal-id", authenticatedAt } });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "REAUTHENTICATION_REQUIRED", message: "Confirm your GitHub sign-in to delete your account." } });
    expect(deps.getSql).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { confirmLogin: 42 }, { confirmLogin: null }])("rejects malformed body %j", async (body) => {
    const deps = dependencies();
    const response = await createAccountDeleteHandler(deps)(requests.json(body, "DELETE"));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
    expect(deps.getSql).not.toHaveBeenCalled();
  });

  it("rejects unparseable JSON with INVALID_REQUEST", async () => {
    const deps = dependencies();
    const request = new Request(requests.url, {
      method: "DELETE",
      headers: { origin: trustedOrigin, "content-type": "application/json" },
      body: "{",
    });
    const response = await createAccountDeleteHandler(deps)(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "A confirmation login is required." },
    });
    expect(deps.getSql).not.toHaveBeenCalled();
  });

  it("requires a live account and case-insensitive trimmed login confirmation", async () => {
    const deps = dependencies();
    const mismatch = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "bob" }, "DELETE"));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json() as { error: { code: string } }).error.code).toBe("CONFIRMATION_MISMATCH");
    expect(deps.deleteAccount).not.toHaveBeenCalled();
    const success = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "  aLiCe  " }, "DELETE"));
    expect(success.status).toBe(200);
    expect(deps.deleteAccount).toHaveBeenCalledWith(sql, 42, { confirm: true });
  });

  it("trims the stored login as well as the submitted confirmation", async () => {
    const deps = dependencies();
    deps.findIdentity.mockResolvedValueOnce({ githubUserId: 42, githubLogin: " Alice " });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "alice" }, "DELETE"));
    expect(response.status).toBe(200);
    expect(deps.deleteAccount).toHaveBeenCalledWith(sql, 42, { confirm: true });
  });

  it("refuses a missing live identity", async () => {
    const deps = dependencies();
    deps.findIdentity.mockResolvedValueOnce(null);
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });

  it("reports sponsor blockers with the exact repository list and retains the session", async () => {
    const deps = dependencies();
    const repositories = [{ ownerName: "owner/repo", provider: "github", instanceUrl: null }];
    deps.deleteAccount.mockResolvedValueOnce({ kind: "SPONSOR_BLOCKED", githubUserId: 42, repositories });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "SPONSOR_BLOCKED", message: expect.any(String), repositories } });
    expect(deps.endSession).not.toHaveBeenCalled();
  });

  it.each(["UNKNOWN_ACCOUNT", "PLANNED"] as const)("handles unexpected %s outcome without ending the session", async (kind) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies();
    deps.deleteAccount.mockResolvedValueOnce(kind === "UNKNOWN_ACCOUNT" ? { kind, githubUserId: 42 } : { kind, githubUserId: 42, accountId: "internal-id", alreadyDeleted: false, wouldRemoveApiToken: false, wouldScrubForgeIdentities: 0, wouldClear: ["github_login", "avatar_url", "encrypted_oauth_token"] });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(kind === "UNKNOWN_ACCOUNT" ? 403 : 502);
    if (kind === "UNKNOWN_ACCOUNT") {
      await expect(response.json()).resolves.toEqual({
        error: { code: "FORBIDDEN", message: "A member account is required." },
      });
      expect(consoleError).not.toHaveBeenCalled();
    } else {
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: { code: "UPSTREAM_FAILURE", message: "Unable to delete account." },
      });
      expect(body).not.toContain("Unexpected planned account deletion outcome.");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]![0]).toBe("Account delete outcome failed.");
      expect(consoleError.mock.calls[0]![1]).toBeInstanceOf(Error);
    }
    expect(deps.endSession).not.toHaveBeenCalled();
  });

  it("ends the session exactly once after deletion succeeds", async () => {
    const deps = dependencies();
    deps.endSession.mockImplementationOnce(async () => { expect(deps.deleteAccount).toHaveBeenCalledTimes(1); });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(deps.endSession).toHaveBeenCalledTimes(1);
  });

  it("reports successful deletion even when ending the browser session fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies();
    const sessionError = new Error("secret session detail");
    deps.endSession.mockRejectedValueOnce(sessionError);
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ deleted: true, sessionEnded: false });
    expect(body).not.toContain("secret session detail");
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("Account deleted, but ending the browser session failed.", sessionError);
  });

  it.each(["session", "sql", "lookup", "delete"])('returns 502 and logs when %s throws without ending session', async (failure) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failureError = new Error("secret database detail");
    const deps = dependencies();
    if (failure === "session") deps.getSession.mockRejectedValueOnce(failureError);
    if (failure === "sql") deps.getSql.mockImplementationOnce(() => { throw failureError; });
    if (failure === "lookup") deps.findIdentity.mockRejectedValueOnce(failureError);
    if (failure === "delete") deps.deleteAccount.mockRejectedValueOnce(failureError);
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "UPSTREAM_FAILURE", message: "Unable to delete account." } });
    expect(body).not.toContain("secret database detail");
    const phase = failure === "sql" ? "lookup" : failure === "delete" ? "operation" : failure;
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(`Account delete ${phase} failed.`, failureError);
    expect(deps.endSession).not.toHaveBeenCalled();
  });
});

describe("production DELETE /api/account", () => {
  it.each([
    ["stale", 1],
    ["missing", undefined],
    ["non-numeric", "yesterday"],
  ])("uses the %s GitHub sign-in instant from auth()", async (_label, authenticatedAt) => {
    productionAuth.mockResolvedValueOnce({
      user: { id: "internal-id", role: "MEMBER", ...(authenticatedAt === undefined ? {} : { authenticatedAt }) },
    });
    productionGetSql.mockReturnValueOnce(sql);
    productionFindIdentity.mockResolvedValueOnce({ githubUserId: 42, githubLogin: "Alice" });
    productionDeleteAccount.mockResolvedValueOnce(deleted);
    productionSignOut.mockResolvedValueOnce(undefined);
    const response = await productionDelete(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "REAUTHENTICATION_REQUIRED", message: "Confirm your GitHub sign-in to delete your account." },
    });
    expect(productionAuth).toHaveBeenCalledTimes(1);
    expect(productionGetSql).not.toHaveBeenCalled();
    expect(productionSignOut).not.toHaveBeenCalled();
  });

  it("calls signOut once without redirect only after a successful production deletion", async () => {
    productionAuth.mockResolvedValueOnce({ user: { id: "internal-id", role: "MEMBER", authenticatedAt: Math.floor(Date.now() / 1000) } });
    productionGetSql.mockReturnValueOnce(sql);
    productionFindIdentity.mockResolvedValueOnce({ githubUserId: 42, githubLogin: "Alice" });
    productionDeleteAccount.mockResolvedValueOnce(deleted);
    productionSignOut.mockImplementationOnce(async () => {
      expect(productionDeleteAccount).toHaveBeenCalledTimes(1);
    });
    const response = await productionDelete(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(productionFindIdentity).toHaveBeenCalledWith(sql, "internal-id");
    expect(productionDeleteAccount).toHaveBeenCalledWith(sql, 42, { confirm: true });
    expect(productionSignOut).toHaveBeenCalledExactlyOnceWith({ redirect: false });
  });
});
