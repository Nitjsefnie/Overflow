import { describe, expect, it, vi } from "vitest";
import { createAccountExportPostHandler } from "@/app/api/account/export/route";
import { formatAccountExport, type AccountExport } from "@/lib/accounts/export";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";
import type { SqlClient } from "@/lib/db/types";

useTrustedOrigin();
const requests = guardedRequests("/api/account/export");
const sql = {} as SqlClient;
const document = { formatVersion: 1, account: { githubLogin: "alice" } } as AccountExport;

function dependencies() {
  return {
    getSession: vi.fn(async (): Promise<{ user: { id: string } } | null> => ({ user: { id: "internal-id" } })),
    getSql: vi.fn(() => sql),
    findIdentity: vi.fn(async () => ({ githubUserId: 42, githubLogin: "alice" })),
    exportAccount: vi.fn(async (): Promise<AccountExport | null> => document),
  };
}

describe("POST /api/account/export", () => {
  it.each([
    ["foreign Origin", requests.foreignJson({})],
    ["missing Origin", new Request(requests.url, { method: "POST" })],
    ["foreign text", requests.foreignText({})],
  ])("refuses %s before any dependency", async (_label, request) => {
    const deps = dependencies();
    const response = await createAccountExportPostHandler(deps)(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "The request origin is not allowed." } });
    for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled();
  });

  it("requires a cookie session even with a bearer credential", async () => {
    const deps = dependencies();
    deps.getSession.mockResolvedValueOnce(null);
    const response = await createAccountExportPostHandler(deps)(requests.json({}, "POST", { authorization: "Bearer token" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    expect(deps.getSql).not.toHaveBeenCalled();
  });

  it("downloads the formatted document without requiring a recent sign-in", async () => {
    const deps = dependencies();
    const response = await createAccountExportPostHandler(deps)(requests.json({}));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(formatAccountExport(document));
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="overflow-account-export.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.findIdentity).toHaveBeenCalledWith(sql, "internal-id");
    expect(deps.exportAccount).toHaveBeenCalledWith(sql, 42);
  });

  it.each(["session", "lookup", "export"])('returns 502 when the %s dependency throws', async (failure) => {
    const deps = dependencies();
    if (failure === "session") deps.getSession.mockRejectedValueOnce(new Error("secret"));
    if (failure === "lookup") deps.findIdentity.mockRejectedValueOnce(new Error("secret"));
    if (failure === "export") deps.exportAccount.mockRejectedValueOnce(new Error("secret"));
    const response = await createAccountExportPostHandler(deps)(requests.json({}));
    expect(response.status).toBe(502);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("UPSTREAM_FAILURE");
  });

  it.each(["lookup", "export"])('refuses when the %s has no live account', async (missing) => {
    const deps = dependencies();
    if (missing === "lookup") deps.findIdentity.mockResolvedValueOnce(null as never);
    if (missing === "export") deps.exportAccount.mockResolvedValueOnce(null);
    const response = await createAccountExportPostHandler(deps)(requests.json({}));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});
