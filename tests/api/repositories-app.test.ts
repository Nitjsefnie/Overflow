import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTrustedOrigin } from "../support/trusted-origin";
import type { GitHubAppAuthConfig } from "@/lib/github/app-installation-auth";
import type { RegisteredRepository } from "@/lib/repositories/register";

const { readConfig, session } = vi.hoisted(() => ({ readConfig: vi.fn((): GitHubAppAuthConfig | null => null),
  session: vi.fn(async () => ({ user: { id: "sponsor-id", role: "MEMBER" } })) }));
vi.mock("@/auth", () => ({ auth: session }));
vi.mock("@/lib/github/app-installation-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/github/app-installation-auth")>(),
  readGitHubRegistrationAppAuthConfig: readConfig,
}));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: async () => "MEMBER" }));
useTrustedOrigin();

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const input = { repositoryUrl: "octo/overflow", registrationMethod: "app", openingName: "Scope", actualName: "Delivered",
  openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
  actualLabels: Array.from({ length: 10 }, (_, i) => ({ label: `done/${i + 1}`, points: i + 1 })) };
const repository: RegisteredRepository = { id: "repository-id", githubRepositoryId: 42, ownerName: "octo/overflow",
  sponsorId: "sponsor-id", visibility: "PUBLIC", registrationMethod: "app", githubWebhookId: null };

function request(body: unknown = input, method = "POST") {
  return new Request("https://overflow.example/api/repositories", { method,
    headers: { origin: "https://overflow.example", "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function wiring(configured = true) {
  vi.resetModules();
  readConfig.mockReset().mockReturnValue(configured ? { appId: "202", privateKey } : null);
  vi.stubEnv("GITHUB_REGISTRATION_APP_ID", "202");
  vi.stubEnv("GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH", "/synthetic/registration-key.pem");
  vi.stubEnv("OVERFLOW_GITHUB_WEBHOOK_URL", "");
  vi.stubEnv("OVERFLOW_DATABASE_URL", "postgres://overflow:overflow@127.0.0.1:1/overflow");
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method, authorization: new Headers(init?.headers).get("authorization") });
    if (path === "/user") return new Response("{}", { headers: { "x-oauth-scopes": "read:user,user:email" } });
    if (path === "/repos/octo/overflow/installation") return Response.json({ id: 321 });
    if (path === "/repos/octo/overflow/labels") return Response.json(
      [...input.openingLabels, ...input.actualLabels].map(({ label }) => ({ name: label })),
    );
    if (path === "/repos/octo/overflow/contents/.github/workflows") return Response.json([]);
    if (path === "/repos/octo/overflow") return Response.json({ id: 42, name: "overflow", full_name: "octo/overflow",
      private: false, html_url: "https://github.com/octo/overflow", owner: { login: "octo" }, permissions: { admin: true } });
    if (path === "/repos/Nitjsefnie-Actions/claim/git/matching-refs/tags/v") return Response.json([]);
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  });
  const route = await import("@/app/api/repositories/route");
  const { PostgresRepositoryStore } = await import("@/lib/repositories/postgres-store");
  const { PostgresFoldStore } = await import("@/lib/fold/postgres-store");
  const proto = PostgresRepositoryStore.prototype;
  vi.spyOn(proto, "getGitHubAccessToken").mockResolvedValue("synthetic-public-identity-token");
  vi.spyOn(proto, "getEnforcementState").mockResolvedValue("ACTIVE");
  vi.spyOn(proto, "findRepositoryRegistrationState").mockResolvedValue(null);
  vi.spyOn(proto, "findRepositoryProviderById").mockResolvedValue("github");
  vi.spyOn(proto, "listAbandonedWebhookCleanups").mockResolvedValue([]);
  const save = vi.spyOn(proto, "createRepository").mockResolvedValue(repository);
  vi.spyOn(PostgresFoldStore.prototype, "enqueueReconciliationJob").mockResolvedValue(undefined);
  return { ...route, calls, save, proto };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => { vi.resetModules(); });

describe("repository App route wiring", () => {
  it("uses public identity for repository reads, the registration App for lookup, and never probes hook scopes", async () => {
    const h = await wiring();
    const response = await h.POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ repository: { id: "repository-id", githubRepositoryId: 42,
      ownerName: "octo/overflow", sponsorId: "sponsor-id", visibility: "PUBLIC", githubWebhookId: null },
    initialImportScheduled: true, claimPath: "NO_EVIDENCE_FOUND", openingLabels: ["size/S"] });
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ registrationMethod: "app", githubWebhookId: null, webhookCredential: null }));
    expect(h.calls.map(({ path, method }) => `${method} ${path}`)).toEqual([
      "GET /repos/octo/overflow", "GET /repos/octo/overflow/labels", "GET /repos/octo/overflow/installation",
      "GET /repos/octo/overflow/contents/.github/workflows",
      "GET /repos/Nitjsefnie-Actions/claim/git/matching-refs/tags/v",
    ]);
    expect(h.calls[0]!.authorization).toBe("Bearer synthetic-public-identity-token");
    expect(h.calls[2]!.authorization).toMatch(/^Bearer ey/);
    await h.POST(request());
    expect(readConfig).toHaveBeenCalledExactlyOnceWith(process.env);
  });

  it("returns INVALID_INPUT when the instance has no registration App", async () => {
    const h = await wiring(false);
    const response = await h.POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_INPUT",
      message: "Registration through the App is not available on this instance." } });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.calls.some(({ path }) => path === "/user")).toBe(false);
  });

  it.each([undefined, "oauth_hook"])("retains the hook scope probe with method %s", async (registrationMethod) => {
    const h = await wiring();
    vi.stubEnv("OVERFLOW_GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    const response = await h.POST(request({ ...input, registrationMethod }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "GITHUB_WEBHOOK_SCOPE_REQUIRED" } });
    expect(h.calls.map(({ path }) => path)).toEqual(["/user"]);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("rejects GitLab plus App as INVALID_INPUT before attempting linked-identity setup", async () => {
    const h = await wiring();
    const response = await h.POST(request({ ...input, provider: "gitlab", instanceUrl: "https://gitlab.example", project: "group/project" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(h.calls).toEqual([]);
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each([
    { label: "App", registrationMethod: "app", githubWebhookId: null },
    { label: "App with a stale webhook id", registrationMethod: "app", githubWebhookId: 501 },
    { label: "OAuth hook", registrationMethod: "oauth_hook", githubWebhookId: 501 },
  ] as const)("unregisters an $label row with its method-specific HTTP answer", async ({ registrationMethod, githubWebhookId }) => {
    const h = await wiring();
    if (registrationMethod === "oauth_hook") vi.stubEnv("OVERFLOW_GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    const stored = { ...repository, registrationMethod, githubWebhookId };
    vi.spyOn(h.proto, "findRepositoryRegistrationStateByOwnerName").mockResolvedValue({ repository: stored, unregisteredAt: null });
    const deactivate = vi.spyOn(h.proto, "unregisterRepository").mockResolvedValue({ kind: "UNREGISTERED", repository: stored });
    const { GitHubGateway } = await import("@/lib/github/client");
    const deleteWebhook = vi.spyOn(GitHubGateway.prototype, "deleteWebhook").mockResolvedValue(undefined);
    const response = await h.DELETE(request({ repositoryUrl: "octo/overflow" }, "DELETE"));
    expect(response.status).toBe(200);
    if (registrationMethod === "app") expect(deleteWebhook).not.toHaveBeenCalled();
    else expect(deleteWebhook).toHaveBeenCalledExactlyOnceWith({ owner: "octo", name: "overflow" }, 501);
    expect(h.calls).toEqual([]);
    expect(await response.text()).toBe(JSON.stringify({ repository: { id: "repository-id", githubRepositoryId: 42,
      ownerName: "octo/overflow", sponsorId: "sponsor-id", visibility: "PUBLIC", githubWebhookId: stored.githubWebhookId },
    webhookDeleted: registrationMethod === "oauth_hook", alreadyUnregistered: false,
    ...(registrationMethod === "app" ? { appAccessRemains: {
      message: "The GitHub App still has access to this repository. Manage its access in your GitHub installation settings.",
      url: "https://github.com/settings/installations",
    } } : {}) }));
    expect(deactivate).toHaveBeenCalledExactlyOnceWith({ ownerName: "octo/overflow", sponsorId: "sponsor-id", provider: "github" });
  });
});
