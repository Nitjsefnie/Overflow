import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepositoryDeleteHandler, createRepositoryPatchHandler, createRepositoryPostHandler,
} from "@/app/api/repositories/route";
import { GitHubScopeProbeError, GitHubWebhookScopeError } from "@/lib/auth/github-granted-scopes";
import { ForgeIdentityError } from "@/lib/forge/identities";
import {
  RepositoryRegistrationError, RepositoryWebhookIdConflictError,
  type RegisteredRepository, type RepositoryRegistrationDependencies,
} from "@/lib/repositories/register";
import { mintApiToken } from "@/lib/security/api-token";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

useTrustedOrigin();
afterEach(() => { vi.restoreAllMocks(); });
const { json } = guardedRequests("/api/repositories");

const input = {
  repositoryUrl: "https://github.com/octo/project", openingName: "Scope", actualName: "Delivered",
  openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
  actualLabels: Array.from({ length: 10 }, (_, i) => ({ label: `done/${i + 1}`, points: i + 1 })),
};
const gitlabInput = { ...input, provider: "gitlab", instanceUrl: "https://gitlab.example.com", project: "group/project" };
const labels = [...input.openingLabels, ...input.actualLabels].map(({ label }) => label);
const registered: RegisteredRepository = {
  id: "repo-id", githubRepositoryId: 42, ownerName: "octo/project", sponsorId: "member-id",
  visibility: "PUBLIC", githubWebhookId: 501, registrationMethod: "oauth_hook",
};

type Scenario = {
  forge?: "github" | "gitlab";
  visibility?: "PUBLIC" | "PRIVATE";
  admin?: boolean;
  labelsMissing?: boolean;
  existing?: boolean;
  otherProvider?: boolean;
  race?: boolean;
  collision?: boolean;
  app?: "absent" | "not-installed" | "installed";
};

function registrationDependencies(s: Scenario = {}): RepositoryRegistrationDependencies {
  const project = {
    id: 42, owner: "octo", name: "project", fullName: "octo/project", ownerType: "USER" as const,
    visibility: s.visibility ?? "PUBLIC", url: "https://github.com/octo/project", canAdminister: s.admin ?? true,
  };
  const github: RepositoryRegistrationDependencies["github"] = {
    async getRepository() { return project; },
    async getRepositoryById() { return project; },
    async listRepositoryLabels() { return new Set(s.labelsMissing ? [] : labels); },
    async createWebhook() { return { id: 501 }; },
    async deleteWebhook() {},
    async listWorkflowFiles() { return []; },
  };
  const store = {
    async findRepositoryRegistrationState() { return s.existing ? { repository: registered, unregisteredAt: null } : null; },
    async findRepositoryProviderById() { return s.otherProvider ? (s.forge === "gitlab" ? "github" : "gitlab") : null; },
    async createRepository() {
      if (s.collision) throw new RepositoryWebhookIdConflictError(501);
      return s.race ? null : registered;
    },
    async saveAbandonedWebhookCleanup() {}, async clearAbandonedWebhookCleanup() {},
    async listAbandonedWebhookCleanups() { return []; },
  } as unknown as RepositoryRegistrationDependencies["store"];
  const forgeFetch: typeof fetch = async (address, init) => {
    const path = new URL(String(address)).pathname;
    if (path.endsWith("/labels")) return Response.json((s.labelsMissing ? [] : labels).map((name) => ({ name })));
    if (path.endsWith("/hooks") && init?.method === "POST") return Response.json({ id: 501 });
    if (path.endsWith("/hooks/501") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/v4/projects/group%2Fproject") return Response.json({
      id: 42, name: "project", path: "project", path_with_namespace: "group/project",
      visibility: s.visibility === "PRIVATE" ? "private" : "public", web_url: "https://gitlab.example.com/group/project",
      namespace: { name: "group", path: "group", kind: "group" },
      permissions: { project_access: { access_level: s.admin === false ? 30 : 40 } },
    });
    throw new Error(`Unexpected GitLab request: ${path}`);
  };
  return {
    actor: { id: "member-id", role: "MEMBER" }, github, store,
    webhook: { callbackUrl: "https://overflow.example/api/github/webhooks" },
    forgeIdentity: { instanceUrl: "https://gitlab.example.com", token: "test" }, forgeFetch,
    registrationApp: s.app === "absent" ? null : { async lookupInstallation() {
      return s.app === "not-installed" ? null : { installationId: 9 };
    } },
  };
}

function route(s: Scenario = {}, setupError?: unknown) {
  const counts: string[] = [];
  const dependencies = {
    getSession: async () => ({ user: { id: "member-id", role: "MEMBER" as const } }),
    getCurrentRole: async () => "MEMBER" as const,
    findAccountByTokenHash: async () => ({ id: "member-id", tokenId: "token-id", role: "MEMBER" as const, enforcementState: "ACTIVE" as const }),
    createRegistrationDependencies: async () => {
      if (setupError !== undefined) throw setupError;
      return registrationDependencies(s);
    },
    incrementRegistrationAttempt: async (kind: string) => { counts.push(kind); },
  };
  return { dependencies, counts, handler: createRepositoryPostHandler(dependencies) };
}

describe("registration refusal counts", () => {
  it.each([
    ["GitHub URL", { ...input, repositoryUrl: "not-a-repository" }, input],
    ["GitHub opening catalog", { ...input, openingLabels: [] }, input],
    ["GitHub display name", { ...input, openingName: "  " }, input],
    ["App URL", { ...input, registrationMethod: "app", repositoryUrl: "not-a-repository" }, { ...input, registrationMethod: "app" }],
    ["App catalog", { ...input, registrationMethod: "app", actualLabels: [] }, { ...input, registrationMethod: "app" }],
    ["GitLab instance missing", { ...gitlabInput, instanceUrl: "" }, gitlabInput],
    ["GitLab instance invalid", { ...gitlabInput, instanceUrl: "http://gitlab.example.com" }, gitlabInput],
    ["GitLab project missing", { ...gitlabInput, project: "" }, gitlabInput],
    ["GitLab project path", { ...gitlabInput, project: "project" }, gitlabInput],
    ["GitLab project zero", { ...gitlabInput, project: "0" }, gitlabInput],
    ["GitLab project overflow", { ...gitlabInput, project: "9007199254740992" }, gitlabInput],
    ["GitLab App method", { ...gitlabInput, registrationMethod: "app" }, gitlabInput],
  ])("does not count malformed %s when account eligibility refuses first", async (_name, malformed, valid) => {
    const fixture = route();
    const handler = createRepositoryPostHandler({ ...fixture.dependencies,
      createRegistrationDependencies: async () => ({ ...registrationDependencies(),
        actor: { id: "member-id", role: "MEMBER", enforcementState: "BANNED" } }),
    });
    const baseline = await handler(json(valid));
    expect(baseline.status).toBe(403);
    expect(fixture.counts).toEqual(["OTHER"]);

    const response = await handler(json(malformed));
    expect(response.status).toBe(baseline.status);
    expect(await response.json()).toEqual(await baseline.json());
    expect(fixture.counts).toEqual(["OTHER"]);
  });

  it("counts an eligible GitLab refusal without interpreting its ignored repository URL as GitHub", async () => {
    const fixture = route({}, new RepositoryRegistrationError("FORBIDDEN", "refusal"));
    const response = await fixture.handler(json({ ...gitlabInput, repositoryUrl: "not-a-github-repository" }));
    expect(response.status).toBe(403);
    expect(fixture.counts).toEqual(["OTHER"]);
  });

  it.each([
    ["scope", new GitHubWebhookScopeError([]), "WEBHOOK_SCOPE_MISSING"],
    ["labels", new RepositoryRegistrationError("INVALID_INPUT", "refusal", undefined, "MISSING_CATALOG_LABELS"), "MISSING_CATALOG_LABELS"],
    ["administrator", new RepositoryRegistrationError("FORBIDDEN", "refusal", undefined, "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED"), "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED"],
    ["visibility", new RepositoryRegistrationError("FORBIDDEN", "refusal", undefined, "NOT_PUBLIC"), "NOT_PUBLIC"],
    ["already registered", new RepositoryRegistrationError("CONFLICT", "refusal", undefined, "ALREADY_REGISTERED"), "ALREADY_REGISTERED"],
    ["other", new RepositoryRegistrationError("FORBIDDEN", "refusal"), "OTHER"],
  ])("does not count a malformed request for the %s refusal", async (_name, error, kind) => {
    const fixture = route({}, error);
    const baseline = await fixture.handler(json(input));
    expect(fixture.counts).toEqual([kind]);

    const response = await fixture.handler(json({ ...input, repositoryUrl: "not-a-repository" }));
    expect(response.status).toBe(baseline.status);
    expect(await response.json()).toEqual(await baseline.json());
    expect(fixture.counts).toEqual([kind]);
  });

  it.each([
    ["GitHub missing labels", { labelsMissing: true }, "MISSING_CATALOG_LABELS", 400],
    ["GitLab missing labels", { forge: "gitlab", labelsMissing: true }, "MISSING_CATALOG_LABELS", 400],
    ["GitHub private", { visibility: "PRIVATE" }, "NOT_PUBLIC", 403],
    ["GitLab private", { forge: "gitlab", visibility: "PRIVATE" }, "NOT_PUBLIC", 403],
    ["GitHub non-admin", { admin: false }, "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED", 403],
    ["GitHub App non-admin", { admin: false, app: "installed" }, "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED", 403],
    ["GitLab non-maintainer", { forge: "gitlab", admin: false }, "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED", 403],
    ["App not installed", { app: "not-installed" }, "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED", 400],
    ["GitHub existing", { existing: true }, "ALREADY_REGISTERED", 409],
    ["GitLab existing", { forge: "gitlab", existing: true }, "ALREADY_REGISTERED", 409],
    ["GitHub race", { race: true }, "ALREADY_REGISTERED", 409],
    ["GitHub App race", { app: "installed", race: true }, "ALREADY_REGISTERED", 409],
    ["GitLab race", { forge: "gitlab", race: true }, "ALREADY_REGISTERED", 409],
    ["GitHub cross-forge collision", { otherProvider: true }, "ALREADY_REGISTERED", 409],
    ["GitLab cross-forge collision", { forge: "gitlab", otherProvider: true }, "ALREADY_REGISTERED", 409],
  ] as const)("counts %s once", async (_name, scenario, kind, status) => {
    const settings: Scenario = scenario;
    const fixture = route(settings);
    const body = { ...(settings.forge === "gitlab" ? gitlabInput : input),
      ...(settings.app === undefined ? {} : { registrationMethod: "app" }) };

    const response = await fixture.handler(json(body));

    expect(response.status).toBe(status);
    expect(fixture.counts).toEqual([kind]);
  });

  it("counts a webhook-scope refusal for a bearer-authenticated member", async () => {
    const fixture = route({}, new GitHubWebhookScopeError([]));
    const credential = mintApiToken().token;
    const response = await fixture.handler(json(input, "POST", { authorization: `Bearer ${credential}` }));
    expect(response.status).toBe(403);
    expect(fixture.counts).toEqual(["WEBHOOK_SCOPE_MISSING"]);
  });

  it.each([["FORBIDDEN", 403], ["CONFLICT", 409], ["NOT_FOUND", 404], ["GITHUB_ACCESS", 403]] as const)(
    "counts an untagged %s refusal as OTHER", async (code, status) => {
      const fixture = route({}, new RepositoryRegistrationError(code, "refusal"));
      const response = await fixture.handler(json(input));
      expect(response.status).toBe(status);
      expect(fixture.counts).toEqual(["OTHER"]);
    },
  );

  it.each([
    ["invalid input", new RepositoryRegistrationError("INVALID_INPUT", "invalid"), 400],
    ["forge identity", new ForgeIdentityError("FORBIDDEN", "unverified"), 403],
    ["credentials", new RepositoryRegistrationError("GITHUB_CREDENTIALS", "credentials"), 401],
    ["tagged credentials", new RepositoryRegistrationError("GITHUB_CREDENTIALS", "credentials", undefined, "NOT_PUBLIC"), 401],
    ["scope-probe credentials", new GitHubScopeProbeError(401), 401],
    ["gateway rate limit", new RepositoryRegistrationError("GITHUB_RATE_LIMITED", "rate limit"), 429],
    ["tagged gateway rate limit", new RepositoryRegistrationError("GITHUB_RATE_LIMITED", "rate limit", undefined, "NOT_PUBLIC"), 429],
    ["rate limit", new GitHubScopeProbeError(429), 429],
    ["upstream", new RepositoryRegistrationError("UPSTREAM_FAILURE", "upstream"), 502],
    ["tagged upstream", new RepositoryRegistrationError("UPSTREAM_FAILURE", "upstream", undefined, "NOT_PUBLIC"), 502],
    ["rollback", new RepositoryRegistrationError("ROLLBACK_INCOMPLETE", "rollback"), 503],
    ["tagged rollback", new RepositoryRegistrationError("ROLLBACK_INCOMPLETE", "rollback", undefined, "NOT_PUBLIC"), 503],
    ["unexpected upstream", new GitHubScopeProbeError(502), 502],
    ["internal setup", new Error("setup unavailable"), 500],
  ])("does not count %s", async (_name, error, status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = route({}, error);
    const response = await fixture.handler(json(input));
    expect(response.status).toBe(status);
    expect(fixture.counts).toEqual([]);
  });

  it.each(["github", "gitlab"] as const)("does not count the %s webhook-id collision", async (forge) => {
    const fixture = route({ forge, collision: true });
    const response = await fixture.handler(json(forge === "gitlab" ? gitlabInput : input));
    expect(response.status).toBe(409);
    expect(fixture.counts).toEqual([]);
  });

  it("does not count an unconfigured App, a success, or a malformed body", async () => {
    const app = route({ app: "absent" });
    expect((await app.handler(json({ ...input, registrationMethod: "app" }))).status).toBe(400);
    expect(app.counts).toEqual([]);
    const success = route();
    expect((await success.handler(json(input))).status).toBe(201);
    expect(success.counts).toEqual([]);
    const malformed = route();
    expect((await malformed.handler(json({ invalid: true }))).status).toBe(400);
    expect(malformed.counts).toEqual([]);
  });

  it("does not count pre-registration authorization and rate-gate refusals", async () => {
    const fixture = route({}, new GitHubWebhookScopeError([]));
    const unauthenticated = createRepositoryPostHandler({ ...fixture.dependencies, getSession: async () => null });
    expect((await unauthenticated(json(input))).status).toBe(401);
    const noMember = createRepositoryPostHandler({ ...fixture.dependencies, getCurrentRole: async () => null });
    expect((await noMember(json(input))).status).toBe(403);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failedRole = createRepositoryPostHandler({ ...fixture.dependencies, getCurrentRole: async () => { throw new Error("unavailable"); } });
    expect((await failedRole(json(input))).status).toBe(500);
    const rateLimited = createRepositoryPostHandler({ ...fixture.dependencies, rateGate: () => new Response(null, { status: 429 }) });
    expect((await rateLimited(json(input))).status).toBe(429);
    const unsupported = json(input, "POST", { "content-type": "text/plain" });
    expect((await fixture.handler(unsupported)).status).toBe(415);
    expect(fixture.counts).toEqual([]);
  });

  it("does not count PATCH or DELETE refusals", async () => {
    const fixture = route({}, new RepositoryRegistrationError("FORBIDDEN", "refusal"));
    expect((await createRepositoryPatchHandler(fixture.dependencies)(json(input, "PATCH"))).status).toBe(403);
    expect((await createRepositoryDeleteHandler(fixture.dependencies)(json({ repositoryUrl: input.repositoryUrl }, "DELETE"))).status).toBe(403);
    expect(fixture.counts).toEqual([]);
  });

  it("keeps the refusal response identical when a counter write fails", async () => {
    const fixture = route({ visibility: "PRIVATE" });
    const expected = await fixture.handler(json(input));
    expect(fixture.counts).toEqual(["NOT_PUBLIC"]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingWrite = vi.fn(async () => { throw new Error("private database detail"); });
    const failing = createRepositoryPostHandler({ ...fixture.dependencies, incrementRegistrationAttempt: failingWrite });
    const actual = await failing(json(input));
    expect(actual.status).toBe(expected.status);
    expect([...actual.headers]).toEqual([...expected.headers]);
    expect(await actual.json()).toEqual(await expected.json());
    expect(failingWrite).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private database detail");
  });
});
