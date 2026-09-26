import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createAccountExportPostHandler, POST as productionPost } from "@/app/api/account/export/route";
import { formatAccountExport, type AccountExport } from "@/lib/accounts/export";
import { expectNoDependencyCall, guardedRequests, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";
import type { SqlClient } from "@/lib/db/types";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const { productionAuth, productionGetSql, productionFindIdentity, productionExportAccount } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionGetSql: vi.fn(),
  productionFindIdentity: vi.fn(),
  productionExportAccount: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/db/client", () => ({ getSql: productionGetSql }));
vi.mock("@/lib/accounts/self-service", () => ({ findLiveAccountIdentity: productionFindIdentity }));
vi.mock("@/lib/accounts/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accounts/export")>()),
  exportAccount: productionExportAccount,
}));

useTrustedOrigin();
const requests = guardedRequests("/api/account/export");
const sql = {} as SqlClient;
const document = { formatVersion: 1, account: { githubLogin: "alice" } } as AccountExport;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => vi.resetModules());

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
    expectNoDependencyCall(deps);
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

  // The dashboard panel sends exactly this: a POST naming only the origin,
  // with no body and so no content type.
  it("accepts the panel's bodyless request that carries no content type", async () => {
    const deps = dependencies();
    const response = await createAccountExportPostHandler(deps)(new Request(requests.url, { method: "POST", headers: { origin: trustedOrigin } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(formatAccountExport(document));
  });

  it.each(["session", "sql", "lookup", "export"])('returns 502 and logs when the %s dependency throws', async (failure) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failureError = new Error("secret database detail");
    const deps = dependencies();
    if (failure === "session") deps.getSession.mockRejectedValueOnce(failureError);
    if (failure === "sql") deps.getSql.mockImplementationOnce(() => { throw failureError; });
    if (failure === "lookup") deps.findIdentity.mockRejectedValueOnce(failureError);
    if (failure === "export") deps.exportAccount.mockRejectedValueOnce(failureError);
    const response = await createAccountExportPostHandler(deps)(requests.json({}));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "UPSTREAM_FAILURE", message: "Unable to export account data." } });
    expect(body).not.toContain("secret database detail");
    const phase = failure === "sql" ? "lookup" : failure === "export" ? "operation" : failure;
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(`Account export ${phase} failed.`, failureError);
  });

  it.each(["lookup", "export"])('refuses when the %s has no live account', async (missing) => {
    const deps = dependencies();
    if (missing === "lookup") deps.findIdentity.mockResolvedValueOnce(null as never);
    if (missing === "export") deps.exportAccount.mockResolvedValueOnce(null);
    const response = await createAccountExportPostHandler(deps)(requests.json({}));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
  });
});

describe("production POST /api/account/export", () => {
  it("uses auth() to obtain the member's session before exporting", async () => {
    productionAuth.mockResolvedValueOnce({ user: { id: "internal-id", role: "MEMBER" } });
    productionGetSql.mockReturnValueOnce(sql);
    productionFindIdentity.mockResolvedValueOnce({ githubUserId: 42, githubLogin: "alice" });
    productionExportAccount.mockResolvedValueOnce(document);
    const response = await productionPost(requests.json({}));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(formatAccountExport(document));
    expect(productionAuth).toHaveBeenCalledTimes(1);
    expect(productionFindIdentity).toHaveBeenCalledWith(sql, "internal-id");
    expect(productionExportAccount).toHaveBeenCalledWith(sql, 42);
  });

  it("refuses export when auth() has no session", async () => {
    productionAuth.mockResolvedValueOnce(null);
    const response = await productionPost(requests.json({}));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    expect(productionAuth).toHaveBeenCalledTimes(1);
    expect(productionGetSql).not.toHaveBeenCalled();
  });
});
