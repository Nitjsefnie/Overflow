import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST,
  createRepositoryDeleteHandler,
  createRepositoryPatchHandler,
  createRepositoryPostHandler,
} from "@/app/api/repositories/route";
import { GitHubScopeProbeError } from "@/lib/auth/github-granted-scopes";
import { getSql } from "@/lib/db/client";
import { GitHubGateway } from "@/lib/github/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import type { RegisteredRepository, RepositoryRegistrationDependencies } from "@/lib/repositories/register";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });
const { readSession, sqlStub } = vi.hoisted(() => ({
  readSession: vi.fn(), sqlStub: vi.fn(async () => [{ role: "MEMBER" }]),
}));
vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db/client")>(),
  getSql: vi.fn(() => sqlStub),
}));
useTrustedOrigin();
const { json: jsonRequest } = guardedRequests("/api/repositories");

beforeEach(() => {
  readSession.mockReset();
  vi.mocked(getSql).mockReset().mockReturnValue(sqlStub as unknown as ReturnType<typeof getSql>);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const apiToken = `ovf_${"recognisable-api-credential".padEnd(43, "_")}`;
const tokenAccount = {
  id: "token-account-id", tokenId: "role-error-token", role: "MEMBER", enforcementState: "ACTIVE",
} as const;
const repository: RegisteredRepository = {
  id: "repository-id", githubRepositoryId: 42, ownerName: "octo/overflow", sponsorId: "moderator-id",
  visibility: "PUBLIC", githubWebhookId: 501, registrationMethod: "oauth_hook",
};

function validInput() {
  return {
    repositoryUrl: "https://github.com/octo/overflow.git", openingName: "Scope", actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
}
function validUnregisterInput() { return { repositoryUrl: "https://github.com/octo/overflow.git" }; }
function authorizedRequest(body: unknown) {
  return new Request("https://overflow.example/api/repositories", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
    body: JSON.stringify(body),
  });
}

describe("repository route internal failures", () => {
  it.each([
    { causeId: "webhook-configuration", message: "GitHub webhook configuration must be set.", secret: false },
    { causeId: "repository-store", message: "Repository store setup failed.", secret: true },
  ])("logs the current DELETE wiring cause $causeId and redacts credentials", async ({ causeId, message, secret }) => {
    const githubToken = `ghp_${"delete-wiring-credential".replaceAll("-", "")}`;
    const connectionUrl = `postgres://member:${"database-password"}@localhost/overflow`;
    const credentials = secret ? ` ${apiToken} ${githubToken} ${connectionUrl}` : "";
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => { throw new Error(`${message} cause=${causeId}${credentials}`); },
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unable to unregister the repository." },
    });
    const redacted = secret ? " ovf_*** ghp_*** postgres://***@localhost/overflow" : "";
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      `Repository unregistration failed: Error: ${message} cause=${causeId}${redacted}`,
    );
    const output = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(output).toContain(causeId);
    for (const credential of [apiToken, githubToken, connectionUrl, "database-password"]) {
      expect(output).not.toContain(credential);
    }
  });

  it("keeps an exported POST scope-probe transport rejection upstream and logs the original error", async () => {
    readSession.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
    vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue("synthetic-identity-token");
    vi.spyOn(PostgresRepositoryStore.prototype, "getEnforcementState").mockResolvedValue("ACTIVE");
    vi.stubEnv("OVERFLOW_GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    const error = new TypeError("fetch failed");
    const fetchGitHub = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchGitHub);

    const response = await POST(jsonRequest(validInput()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to initialize repository registration.",
    } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Repository registration failed.", error);
    expect(fetchGitHub).toHaveBeenCalledExactlyOnceWith("https://api.github.com/user", expect.any(Object));
  });

  it("keeps the exported POST real scope-probe deadline upstream and logs its whole error", async () => {
    vi.useFakeTimers();
    readSession.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
    vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue("synthetic-identity-token");
    vi.spyOn(PostgresRepositoryStore.prototype, "getEnforcementState").mockResolvedValue("ACTIVE");
    vi.stubEnv("OVERFLOW_GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    const fetchGitHub = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchGitHub);

    const pending = POST(jsonRequest(validInput()));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to initialize repository registration.",
    } });
    expect(fetchGitHub).toHaveBeenCalledExactlyOnceWith("https://api.github.com/user", expect.any(Object));
    const signal = fetchGitHub.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect(signal.reason.message).toBe("GitHub /user granted-scope probe timed out.");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Repository registration failed.", signal.reason);
  });

  it("logs the real POST wiring failure when OVERFLOW_DATABASE_URL is unset", async () => {
    vi.stubEnv("OVERFLOW_DATABASE_URL", undefined);
    readSession.mockResolvedValue({ user: { id: "member-id", role: "MEMBER" } });
    const database = await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
    await database.closeSql();
    // Keep the live-role fixture, then let the real repository-store
    // construction resolve the database configuration itself.
    vi.mocked(getSql)
      .mockReturnValueOnce(sqlStub as unknown as ReturnType<typeof getSql>)
      .mockImplementationOnce(database.getSql);

    const response = await POST(jsonRequest(validInput()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "INTERNAL_ERROR", message: "Unable to initialize repository registration.",
    } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "Repository registration failed: Error: OVERFLOW_DATABASE_URL must be configured before using the database.",
    );
  });

  it.each([
    { method: "POST", createHandler: createRepositoryPostHandler },
    { method: "PATCH", createHandler: createRepositoryPatchHandler },
  ])("logs a $method wiring failure and answers a fixed internal error", async ({ method, createHandler }) => {
    const handler = createHandler({
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      getSession: async () => ({ user: { id: "member-id", role: "MEMBER" } }),
      createRegistrationDependencies: async () => {
        throw new Error("GitHub webhook configuration must be set.");
      },
    });

    const response = await handler(jsonRequest(validInput(), method));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "INTERNAL_ERROR", message: "Unable to initialize repository registration.",
    } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "Repository registration failed: Error: GitHub webhook configuration must be set.",
    );
  });

  it.each([
    { method: "PATCH", createHandler: createRepositoryPatchHandler, operation: "catalog change", message: "Unable to initialize repository registration." },
    { method: "DELETE", createHandler: createRepositoryDeleteHandler, operation: "unregistration", message: "Unable to unregister the repository." },
  ])("logs an unclassified $method flow failure whole and keeps the upstream answer", async ({ method, createHandler, operation, message }) => {
    const error = new Error("Repository provider lookup failed.");
    const store = new PostgresRepositoryStore();
    vi.spyOn(store, "findRepositoryByGitHubId").mockResolvedValue(repository);
    vi.spyOn(store, "findRepositoryRegistrationStateByOwnerName")
      .mockResolvedValue({ repository, unregisteredAt: null });
    vi.spyOn(store, "findRepositoryProviderById").mockRejectedValue(error);
    const github = new GitHubGateway({ accessToken: "synthetic-identity-token" });
    vi.spyOn(github, "getRepository").mockResolvedValue({
      id: 42, owner: "octo", ownerType: "USER", name: "overflow", fullName: "octo/overflow",
      visibility: "PUBLIC", url: "https://github.com/octo/overflow", canAdminister: true,
    });
    const dependencies: RepositoryRegistrationDependencies = {
      actor: { id: "moderator-id", role: "MODERATOR" }, github, store,
    };
    const handler = createHandler({
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(method === "DELETE" ? validUnregisterInput() : validInput(), method));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: { code: "UPSTREAM_FAILURE", message } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`Repository ${operation} failed.`, error);
  });

  it("logs the whole unclassified forge error and keeps the upstream answer", async () => {
    const error = new GitHubScopeProbeError(500);
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      getSession: async () => ({ user: { id: "member-id", role: "MEMBER" } }),
      createRegistrationDependencies: async () => { throw error; },
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to initialize repository registration.",
    } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Repository registration failed.", error);
  });
  it.each([false, true])("answers an internal error and logs a redacted role-read cause for bearer=%s", async (bearer) => {
    const causeId = bearer ? "bearer-role-lookup" : "cookie-role-lookup";
    const githubToken = `ghp_${"role-lookup-credential".replaceAll("-", "")}`;
    const connectionUrl = `postgres://member:${"database-password"}@localhost/overflow`;
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => (bearer ? tokenAccount : null),
      getSession: async () => (bearer ? null : { user: { id: "member-id", role: "MEMBER" } }),
      getCurrentRole: async () => {
        throw new Error(`role lookup unavailable (${causeId}): ${apiToken} ${githubToken} ${connectionUrl}`);
      },
      createRegistrationDependencies: async () => { throw new Error("Unexpected registration setup."); },
    });

    const response = await handler(bearer ? authorizedRequest(validInput()) : jsonRequest(validInput()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "INTERNAL_ERROR", message: "Unable to initialize repository registration.",
    } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      `Repository authorization failed: Error: role lookup unavailable (${causeId}): ovf_*** ghp_*** postgres://***@localhost/overflow`,
    );
    const output = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(output).toContain(causeId);
    for (const credential of [apiToken, githubToken, connectionUrl, "database-password"]) {
      expect(output).not.toContain(credential);
    }
  });
});
