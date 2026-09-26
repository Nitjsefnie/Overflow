import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountDeleteHandler } from "@/app/api/account/route";
import type { AccountDeletionOutcome } from "@/lib/accounts/deletion";
import type { SqlClient } from "@/lib/db/types";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

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

afterEach(() => vi.restoreAllMocks());

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
    expect((await response.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
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
    const deps = dependencies();
    deps.deleteAccount.mockResolvedValueOnce(kind === "UNKNOWN_ACCOUNT" ? { kind, githubUserId: 42 } : { kind, githubUserId: 42, accountId: "internal-id", alreadyDeleted: false, wouldRemoveApiToken: false, wouldScrubForgeIdentities: 0, wouldClear: ["github_login", "avatar_url", "encrypted_oauth_token"] });
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(kind === "UNKNOWN_ACCOUNT" ? 403 : 502);
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
    deps.endSession.mockRejectedValueOnce(new Error("secret"));
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true, sessionEnded: false });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toHaveLength(1);
    expect(consoleError.mock.calls[0]![0]).not.toContain("secret");
  });

  it.each(["session", "lookup", "delete"])('returns 502 when %s throws without ending session', async (failure) => {
    const deps = dependencies();
    if (failure === "session") deps.getSession.mockRejectedValueOnce(new Error("secret"));
    if (failure === "lookup") deps.findIdentity.mockRejectedValueOnce(new Error("secret"));
    if (failure === "delete") deps.deleteAccount.mockRejectedValueOnce(new Error("secret"));
    const response = await createAccountDeleteHandler(deps)(requests.json({ confirmLogin: "Alice" }, "DELETE"));
    expect(response.status).toBe(502);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("UPSTREAM_FAILURE");
    expect(deps.endSession).not.toHaveBeenCalled();
  });
});
