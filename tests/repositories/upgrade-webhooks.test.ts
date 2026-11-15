import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GitHubGateway } from "@/lib/github/client";
import { GitLabGateway } from "@/lib/gitlab/client";
import { upgradeRepositoryWebhooks, type WebhookUpgradeDependencies } from "@/lib/repositories/upgrade-webhooks";
import type { RegisteredRepository } from "@/lib/repositories/register";
import type { WebhookCredentialRecord } from "@/lib/webhooks/credentials";

const registration: RegisteredRepository = {
  registrationMethod: "oauth_hook",
  id: "registration-1", githubRepositoryId: 42, githubWebhookId: 81,
  ownerName: "old-owner/old-name", sponsorId: "sponsor-1", visibility: "PUBLIC",
};

const outcome = (subscription: string, queue: string, failure: string | null) => ({ repositoryId: "registration-1", subscription, queue, failure });

function fixture(options: { provider?: string; instanceUrl?: string | null; lookupStatus?: number; configuredAt?: Date | null } = {}) {
  const requests: Request[] = [];
  const queued: { repositoryId: string; reason: string }[] = [];
  const credentials: string[] = [];
  const forgeCredentials: string[] = [];
  const outcomes: unknown[] = [], causes: string[] = [], lost = { response: false, fired: 0 };
  const registrations = [registration];
  const credentialId = randomUUID();
  let pending: WebhookCredentialRecord | null = null, owed = false;
  const repository = { id: 42, name: "renamed", full_name: "new-owner/renamed", private: false,
    html_url: "https://github.com/new-owner/renamed", owner: { login: "new-owner" }, permissions: { admin: true } };
  const hook = {
    id: 81, active: true, name: "web", type: "Repository",
    events: ["issues", "pull_request", "pull_request_review"],
    config: { url: "https://overflow.example/api/github/webhooks", content_type: "json", insecure_ssl: "0", secret: "********" },
  };
  const gitlabHook = { id: 81, url: "https://overflow.example/api/gitlab/webhooks", push_events: false,
    issues_events: false, merge_requests_events: false };
  const dependencies: WebhookUpgradeDependencies = {
    store: {
      withWebhookUpgradeLock: async (_id, operation) => operation(),
      stageWebhookCredential: async (target) => pending ??= { ...target, credentialId, secret: "scoped-upgrade-secret", configuredAt: options.configuredAt ?? null },
      finalizeWebhookCredential: async (_credential, beforeCommit) => {
        await beforeCommit?.();
        if (pending !== null) pending = { ...pending, configuredAt: new Date("2026-01-01T00:00:00Z") };
        return true;
      },
      markWebhookRederivationOwed: async () => { const was = owed; owed = true; return was; }, clearWebhookRederivationOwed: async () => { owed = false; },
      listActiveRepositoryIds: async () => registrations.map((entry) => entry.id),
      findActiveRepositoryById: async (id) => registrations.find((entry) => entry.id === id) ?? null,
      findActiveRepositoryForgeById: async (id) => registrations.some((entry) => entry.id === id)
        ? { provider: options.provider ?? "github", instanceUrl: options.instanceUrl ?? null } : null,
      getGitHubAccessToken: async (sponsorId) => { credentials.push(sponsorId); return `token-${sponsorId}`; },
      getForgeToken: async (sponsorId, instanceUrl) => {
        forgeCredentials.push(`${sponsorId}@${instanceUrl}`); return { token: `glpat-${sponsorId}`, identityId: "identity-1" }; },
      requestRepositoryRederivation: async (repositoryId) => { queued.push({ repositoryId, reason: "REDERIVATION" }); },
    },
    webhookUrls: { github: "https://overflow.example/api/github/webhooks", gitlab: "https://overflow.example/api/gitlab/webhooks" },
    createGateway: (accessToken) => new GitHubGateway({ accessToken, fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith("/repositories/42")) {
        return options.lookupStatus === undefined ? Response.json(repository) : new Response(null, { status: options.lookupStatus });
      }
      if (request.method === "PATCH") {
        const update = await request.clone().json();
        hook.events.push(...update.add_events);
        hook.config = update.config;
        if (lost.response) { lost.fired++; throw new Error("synthetic lost response"); }
      }
      return Response.json(hook);
    } }),
    // Host-sensitive: a GitLab gateway built on any other instance cannot
    // satisfy the verification through this transport.
    createGitLabGateway: (instanceUrl, token) => new GitLabGateway({ instanceUrl, token, fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (new URL(request.url).origin !== "https://gitlab.example.com") {
        return new Response("wrong instance", { status: 404 });
      }
      if (request.url.endsWith("/projects/42") && options.lookupStatus !== undefined) {
        return new Response(null, { status: options.lookupStatus });
      }
      if (request.method === "PUT") Object.assign(gitlabHook, await request.clone().json());
      if (request.method === "PUT" && lost.response) { lost.fired++; throw new Error("synthetic lost response"); }
      if (request.url.includes("/hooks/")) {
        return Response.json(gitlabHook);
      }
      return Response.json({
        id: 42, name: "project", path: "project", path_with_namespace: "gl-group/project",
        visibility: "public", web_url: "https://gitlab.example.com/gl-group/project",
        namespace: { name: "gl-group", path: "gl-group", kind: "group" },
        permissions: { project_access: { access_level: 40 } },
      });
    } }),
    report: (outcome) => { outcomes.push(outcome); }, writeError: (line) => { causes.push(line); },
  };
  return { dependencies, requests, queued, credentials, forgeCredentials, outcomes, causes, lost, registrations, repository, hook, gitlabHook, credentialId };
}

describe("existing registration webhook upgrade", () => {
  it.each([
    ["github", "unchanged"], ["github", "events"], ["github", "URL"], ["github", "unfinalized"],
    ["gitlab", "unchanged"], ["gitlab", "events"], ["gitlab", "URL"], ["gitlab", "unfinalized"],
  ] as const)("queues only the needed %s repair for %s and does nothing on the next run", async (provider, change) => {
    const f = fixture({ provider, instanceUrl: provider === "gitlab" ? "https://gitlab.example.com" : null,
      configuredAt: change === "unfinalized" ? null : new Date("2026-01-01T00:00:00Z") });
    const callbackUrl = new URL(f.dependencies.webhookUrls[provider]);
    callbackUrl.searchParams.set("hook", f.credentialId);
    f.hook.events.push("issue_comment");
    f.hook.config.url = callbackUrl.toString();
    Object.assign(f.gitlabHook, { url: callbackUrl.toString(), issues_events: true, merge_requests_events: true });
    if (change === "events") {
      if (provider === "github") f.hook.events = f.hook.events.filter((event) => event !== "issue_comment");
      else f.gitlabHook.issues_events = false;
    }
    if (change === "URL") {
      if (provider === "github") f.hook.config.url = "https://old.test/hook";
      else f.gitlabHook.url = "https://old.test/hook";
    }
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
    expect(f.queued).toEqual(change === "unchanged" ? [] : [{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
    expect(f.outcomes).toEqual([outcome("VERIFIED", change === "unchanged" ? "NOT_NEEDED" : "QUEUED", null), outcome("VERIFIED", "NOT_NEEDED", null)]);
  });

  // A finalized hook's row that moved on before its debt is recorded is refused before the forge is asked.
  it.each([["github", "finalization"], ["gitlab", "finalization"], ["github", "owed marker"], ["gitlab", "owed marker"]] as const)("refuses a stale %s %s without queueing repair", async (provider, stale) => {
    const f = fixture({ provider, instanceUrl: provider === "gitlab" ? "https://gitlab.example.com" : null, configuredAt: stale === "owed marker" ? new Date("2026-01-01T00:00:00Z") : null });
    Object.assign(f.dependencies.store, stale === "finalization" ? { finalizeWebhookCredential: async () => false } : { markWebhookRederivationOwed: async () => null });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect([f.queued, f.requests.filter((request) => ["PATCH", "PUT"].includes(request.method)).length]).toEqual([[], stale === "owed marker" ? 0 : 1]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "SUBSCRIPTION_FAILED")]);
  });

  it.each(["github", "gitlab"] as const)("reports %s finalization failure after queue acceptance", async (provider) => {
    const f = fixture({ provider, instanceUrl: provider === "gitlab" ? "https://gitlab.example.com" : null });
    f.dependencies.store.finalizeWebhookCredential = async (_credential, beforeCommit) => { await beforeCommit?.(); throw new Error("synthetic finalization failure"); };
    expect.soft(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
    expect(f.outcomes).toEqual([outcome("FAILED", "QUEUED", "SUBSCRIPTION_FAILED")]);
  });

  it("reconfigures a legacy hook whose events are already complete", async () => {
    const f = fixture();
    f.hook.events.push("issue_comment");
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
    const updates = f.requests.filter((request) => request.method === "PATCH");
    expect(updates).toHaveLength(1);
    const config = (await updates[0].clone().json()).config;
    expect(new URL(config.url).searchParams.get("hook")).not.toBeNull();
    expect(config.secret).not.toBe("existing-secret");
  });

  it.each([".github", "-renamed", "_renamed"])("upgrades a registration renamed to %s using the same immutable IDs and the current path", async (name) => {
    const f = fixture();
    Object.assign(f.repository, { name, full_name: `new-owner/${name}` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /repositories/42", `GET /repos/new-owner/${name}/hooks/81`, `PATCH /repos/new-owner/${name}/hooks/81`,
    ]);
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
  });

  it.each([".", "..", "has/slash", "has\\backslash", "%2e%2e", "", "has space"])("refuses unsafe current repository name %j before touching a hook", async (name) => {
    const f = fixture();
    Object.assign(f.repository, { name, full_name: `new-owner/${name}` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
  });

  it.each([".github", "-owner", "has/slash", "has\\backslash"])("refuses unsafe current owner %j independently of repository-name validation", async (owner) => {
    const f = fixture();
    Object.assign(f.repository, { owner: { login: owner }, full_name: `${owner}/renamed` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
  });

  it("resolves immutable identity and the sponsor token, writes at the current path, and queues repair once", async () => {
    const f = fixture();
    await expect(upgradeRepositoryWebhooks(f.dependencies)).resolves.toEqual({ succeeded: 1, failed: 0, gone: 0 });
    await expect(upgradeRepositoryWebhooks(f.dependencies)).resolves.toEqual({ succeeded: 1, failed: 0, gone: 0 });
    expect(f.credentials).toEqual(["sponsor-1", "sponsor-1"]);
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /repositories/42", "GET /repos/new-owner/renamed/hooks/81", "PATCH /repos/new-owner/renamed/hooks/81",
      "GET /repositories/42", "GET /repos/new-owner/renamed/hooks/81", "PATCH /repos/new-owner/renamed/hooks/81",
    ]);
    expect(f.requests.map((request) => request.headers.get("authorization"))).toEqual(Array(6).fill("Bearer token-sponsor-1"));
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
    expect(f.outcomes).toEqual([outcome("VERIFIED", "QUEUED", null), outcome("VERIFIED", "NOT_NEEDED", null)]);
  });

  it.each([
    ["mismatched", { id: 43 }], ["private", { private: true }], ["visibility absent", { private: undefined }],
    ["admin denied", { permissions: { admin: false } }], ["invalid path", { name: "../wrong" }], ["inconsistent full name", { full_name: "another/project" }],
  ])("refuses a %s repository before touching its hook", async (_name, replacement) => {
    const f = fixture(); Object.assign(f.repository, replacement);
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "REPOSITORY_FAILED")]);
  });

  it.each(["github", "gitlab"] as const)("skips a gone %s repository without using its persisted owner/name", async (provider) => {
    const f = fixture({ provider, instanceUrl: "https://gitlab.example.com", lookupStatus: 404 });
    expect.soft(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 0, gone: 1 });
    expect(f.queued).toEqual([]);
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([provider === "github" ? "GET /repositories/42" : "GET /api/v4/projects/42"]);
    expect(f.outcomes).toEqual([outcome("SKIPPED", "NOT_ATTEMPTED", "REPOSITORY_GONE")]);
  });

  it.each([["github", 401], ["github", 500], ["gitlab", 401], ["gitlab", 500]] as const)("keeps a %s by-id lookup error %s as a repository failure", async (provider, lookupStatus) => {
    const f = fixture({ provider, instanceUrl: "https://gitlab.example.com", lookupStatus });
    expect.soft(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "REPOSITORY_FAILED")]);
  });

  it.each([null, "", new Error("private token-decryption diagnostic")])("reports unavailable sponsor credentials safely: %s", async (token) => {
    const f = fixture();
    f.dependencies.store.getGitHubAccessToken = async () => { if (token instanceof Error) throw token; return token; };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "CREDENTIALS_FAILED")]);
  });

  it("isolates a broken registration and continues with the next sponsor", async () => {
    const f = fixture();
    f.registrations.unshift({ ...registration, id: "broken", sponsorId: "broken-sponsor" });
    const find = f.dependencies.store.findActiveRepositoryById;
    f.dependencies.store.findActiveRepositoryById = async (id) => {
      if (id === "broken") throw new Error("private DB row contents");
      return find(id);
    };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 1, gone: 0 });
    expect(f.credentials).toEqual(["sponsor-1"]);
    expect(f.outcomes).toEqual([{ ...outcome("FAILED", "NOT_ATTEMPTED", "REGISTRATION_FAILED"), repositoryId: "broken" }, outcome("VERIFIED", "QUEUED", null)]);
    expect(f.causes).toEqual(['{"repositoryId":"broken","failure":"REGISTRATION_FAILED","cause":"Error: private DB row contents"}']);
  });

  it("reports a registration deactivated after enumeration without touching GitHub", async () => {
    const f = fixture(); f.dependencies.store.findActiveRepositoryById = async () => null;
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "REGISTRATION_FAILED")]);
  });

  // Run 1 loses the queue write, or the forge applies the update and its response is lost; the hook is unfinalized or finalized.
  it.each((["github", "gitlab"] as const).flatMap((provider) => [null, "2026-01-01T00:00:00Z"].flatMap((finalized) =>
    (["queue write", "forge response"] as const).map((lost) => ({ provider, finalized, lost })))))(
    "re-queues a $provider hook finalized at $finalized whose $lost was lost exactly once on the next run, then nothing", async ({ provider, finalized, lost }) => {
      const f = fixture({ provider, instanceUrl: provider === "gitlab" ? "https://gitlab.example.com" : null, configuredAt: finalized === null ? null : new Date(finalized) });
      const enqueue = f.dependencies.store.requestRepositoryRederivation;
      if (lost === "queue write") f.dependencies.store.requestRepositoryRederivation = async () => { throw new Error("private database password"); };
      f.lost.response = lost === "forge response";
      expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
      expect([f.queued, f.causes.length, f.lost.fired]).toEqual([[], 1, lost === "queue write" ? 0 : 1]);
      [f.dependencies.store.requestRepositoryRederivation, f.lost.response] = [enqueue, false];
      expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
      expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
      expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
      expect([f.requests.filter((request) => request.method === (provider === "github" ? "PATCH" : "PUT")).length, f.queued.length]).toEqual([3, 1]);
      expect(f.outcomes).toEqual([lost === "queue write" ? outcome("VERIFIED", "FAILED", "QUEUE_FAILED") : outcome("FAILED", "NOT_ATTEMPTED", "SUBSCRIPTION_FAILED"),
        outcome("VERIFIED", "QUEUED", null), outcome("VERIFIED", "NOT_NEEDED", null)]);
    });

  it("reports a finalized hook whose debt was not cleared as unpaid, so the next run queues it again", async () => {
    const f = fixture({ configuredAt: new Date("2026-01-01T00:00:00Z") }), { clearWebhookRederivationOwed: clear } = f.dependencies.store;
    f.dependencies.store.clearWebhookRederivationOwed = async () => { f.dependencies.store.clearWebhookRederivationOwed = clear; throw new Error("synthetic clear failure"); };
    expect([await upgradeRepositoryWebhooks(f.dependencies), await upgradeRepositoryWebhooks(f.dependencies)]).toEqual([{ succeeded: 0, failed: 1, gone: 0 }, { succeeded: 1, failed: 0, gone: 0 }]);
    expect([f.queued.length, f.outcomes]).toEqual([2, [outcome("VERIFIED", "FAILED", "QUEUE_FAILED"), outcome("VERIFIED", "QUEUED", null)]]);
  });

  it("does not queue repair when the hook update or verification fails", async () => {
    const f = fixture();
    const createGateway = f.dependencies.createGateway;
    f.dependencies.createGateway = (token, owner) => {
      const gateway = createGateway(token, owner);
      return { getRepositoryById: gateway.getRepositoryById.bind(gateway), configureWebhook: async () => { throw new Error("secret upstream body"); } };
    };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "SUBSCRIPTION_FAILED")]);
  });

  // The GitLab arm (issue 547): provider 'gitlab' + a webhook id verifies the
  // hook through the sponsor's forge-identity token for the registration's
  // own instance, then queues the same rederivation the GitHub arm queues.
  it("verifies a GitLab registration's hook through the forge identity and queues repair", async () => {
    const f = fixture({ provider: "gitlab", instanceUrl: "https://gitlab.example.com" });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0, gone: 0 });
    expect(f.forgeCredentials).toEqual(["sponsor-1@https://gitlab.example.com"]);
    expect(f.credentials).toEqual([]);
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /api/v4/projects/42", "GET /api/v4/projects/gl-group%2Fproject/hooks/81", "PUT /api/v4/projects/gl-group%2Fproject/hooks/81",
    ]);
    expect(f.outcomes).toEqual([outcome("VERIFIED", "QUEUED", null)]);
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
  });

  it("answers CREDENTIALS_FAILED for a GitLab registration whose sponsor has no identity linked on the instance", async () => {
    const f = fixture({ provider: "gitlab", instanceUrl: "https://gitlab.example.com" });
    f.dependencies.store.getForgeToken = async (sponsorId, instanceUrl) => { f.forgeCredentials.push(`${sponsorId}@${instanceUrl}`); return null; };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.forgeCredentials).toEqual(["sponsor-1@https://gitlab.example.com"]);
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "CREDENTIALS_FAILED")]);
  });

  it("answers REGISTRATION_FAILED for a GitLab registration whose forge columns vanished", async () => {
    const f = fixture({ provider: "gitlab", instanceUrl: "https://gitlab.example.com" });
    f.dependencies.store.findActiveRepositoryForgeById = async () => null;
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "REGISTRATION_FAILED")]);
  });

  it("answers REPOSITORY_FAILED for a GitLab project that went private or lost maintainer", async () => {
    for (const projectOverrides of [{ visibility: "private" }, { permissions: { project_access: { access_level: 30 } } }]) {
      const f = fixture({ provider: "gitlab", instanceUrl: "https://gitlab.example.com" });
      f.dependencies.createGitLabGateway = (instanceUrl, token) => {
        const gateway = new GitLabGateway({ instanceUrl, token, fetch: async () =>
          Response.json({
            id: 42, name: "project", path: "project", path_with_namespace: "gl-group/project",
            ...projectOverrides,
            web_url: "https://gitlab.example.com/gl-group/project",
            namespace: { name: "gl-group", path: "gl-group", kind: "group" },
          }),
        });
        return { getRepositoryById: gateway.getRepositoryById.bind(gateway),
          configureWebhook: async () => { throw new Error("the hook must not be read for a refused project"); } };
      };
      expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1, gone: 0 });
      expect([f.requests.filter((request) => request.method === "PUT"), f.queued]).toEqual([[], []]);
      expect(f.outcomes).toEqual([outcome("FAILED", "NOT_ATTEMPTED", "REPOSITORY_FAILED")]);
    }
  });
});
