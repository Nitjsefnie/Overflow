import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { upgradeRepositoryWebhooks, type WebhookUpgradeDependencies } from "@/lib/repositories/upgrade-webhooks";
import type { RegisteredRepository } from "@/lib/repositories/register";

const registration: RegisteredRepository = {
  id: "registration-1", githubRepositoryId: 42, githubWebhookId: 81,
  ownerName: "old-owner/old-name", sponsorId: "sponsor-1", visibility: "PUBLIC",
};

function fixture() {
  const requests: Request[] = [];
  const queued: { repositoryId: string; reason: string }[] = [];
  const credentials: string[] = [];
  const outcomes: unknown[] = [];
  const registrations = [registration];
  const repository = {
    id: 42, name: "renamed", full_name: "new-owner/renamed", private: false,
    html_url: "https://github.com/new-owner/renamed", owner: { login: "new-owner" }, permissions: { admin: true },
  };
  const hook = {
    id: 81, active: true, name: "web", type: "Repository",
    events: ["issues", "pull_request", "pull_request_review"],
    config: { url: "https://overflow.example/api/github/webhooks", content_type: "json", insecure_ssl: "0", secret: "********" },
  };
  const dependencies: WebhookUpgradeDependencies = {
    store: {
      listActiveRepositoryIds: async () => registrations.map((entry) => entry.id),
      findActiveRepositoryById: async (id) => registrations.find((entry) => entry.id === id) ?? null,
      getGitHubAccessToken: async (sponsorId) => { credentials.push(sponsorId); return `token-${sponsorId}`; },
      requestRepositoryRederivation: async (repositoryId) => { queued.push({ repositoryId, reason: "REDERIVATION" }); },
    },
    webhookSecret: "existing-secret",
    createGateway: (accessToken) => new GitHubGateway({ accessToken, fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith("/repositories/42")) return Response.json(repository);
      if (request.method === "PATCH") {
        const update = await request.json();
        hook.events.push(...update.add_events);
      }
      return Response.json(hook);
    } }),
    report: (outcome) => { outcomes.push(outcome); },
  };
  return { dependencies, requests, queued, credentials, outcomes, registrations, repository };
}

describe("existing registration webhook upgrade", () => {
  it.each([".github", "-renamed", "_renamed"])("upgrades a registration renamed to %s using the same immutable IDs and the current path", async (name) => {
    const f = fixture();
    Object.assign(f.repository, { name, full_name: `new-owner/${name}` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0 });
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /repositories/42", `GET /repos/new-owner/${name}/hooks/81`, `PATCH /repos/new-owner/${name}/hooks/81`,
    ]);
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
  });

  it.each([".", "..", "has/slash", "has\\backslash", "%2e%2e", "", "has space"])("refuses unsafe current repository name %j before touching a hook", async (name) => {
    const f = fixture();
    Object.assign(f.repository, { name, full_name: `new-owner/${name}` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
  });

  it.each([".github", "-owner", "has/slash", "has\\backslash"])("refuses unsafe current owner %j independently of repository-name validation", async (owner) => {
    const f = fixture();
    Object.assign(f.repository, { owner: { login: owner }, full_name: `${owner}/renamed` });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
  });

  it("resolves immutable identity and the sponsor token, writes at the current path, and queues repair on every verified run", async () => {
    const f = fixture();
    await expect(upgradeRepositoryWebhooks(f.dependencies)).resolves.toEqual({ succeeded: 1, failed: 0 });
    await expect(upgradeRepositoryWebhooks(f.dependencies)).resolves.toEqual({ succeeded: 1, failed: 0 });
    expect(f.credentials).toEqual(["sponsor-1", "sponsor-1"]);
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /repositories/42", "GET /repos/new-owner/renamed/hooks/81", "PATCH /repos/new-owner/renamed/hooks/81",
      "GET /repositories/42", "GET /repos/new-owner/renamed/hooks/81",
    ]);
    expect(f.requests.map((request) => request.headers.get("authorization"))).toEqual(Array(5).fill("Bearer token-sponsor-1"));
    expect(f.queued).toEqual([
      { repositoryId: "registration-1", reason: "REDERIVATION" }, { repositoryId: "registration-1", reason: "REDERIVATION" },
    ]);
    expect(f.outcomes).toEqual(Array(2).fill({ repositoryId: "registration-1", subscription: "VERIFIED", queue: "QUEUED", failure: null }));
  });

  it.each([
    ["mismatched", { id: 43 }], ["private", { private: true }],
    ["visibility absent", { private: undefined }], ["admin denied", { permissions: { admin: false } }],
    ["invalid path", { name: "../wrong" }], ["inconsistent full name", { full_name: "another/project" }],
  ])("refuses a %s repository before touching its hook", async (_name, replacement) => {
    const f = fixture(); Object.assign(f.repository, replacement);
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/repositories/42"]);
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([{ repositoryId: "registration-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REPOSITORY_FAILED" }]);
  });

  it("refuses a missing repository instead of using the persisted owner/name", async () => {
    const f = fixture();
    f.dependencies.createGateway = () => new GitHubGateway({ accessToken: "token", fetch: async () => new Response(null, { status: 404 }) });
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([{ repositoryId: "registration-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REPOSITORY_FAILED" }]);
  });

  it.each([null, "", new Error("private token-decryption diagnostic")])("reports unavailable sponsor credentials safely: %s", async (token) => {
    const f = fixture();
    f.dependencies.store.getGitHubAccessToken = async () => { if (token instanceof Error) throw token; return token; };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([{ repositoryId: "registration-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" }]);
  });

  it("isolates a broken registration and continues with the next sponsor", async () => {
    const f = fixture();
    f.registrations.unshift({ ...registration, id: "broken", sponsorId: "broken-sponsor" });
    const find = f.dependencies.store.findActiveRepositoryById;
    f.dependencies.store.findActiveRepositoryById = async (id) => {
      if (id === "broken") throw new Error("private DB row contents");
      return find(id);
    };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 1 });
    expect(f.credentials).toEqual(["sponsor-1"]);
    expect(f.outcomes).toEqual([
      { repositoryId: "broken", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REGISTRATION_FAILED" },
      { repositoryId: "registration-1", subscription: "VERIFIED", queue: "QUEUED", failure: null },
    ]);
  });

  it("reports a registration deactivated after enumeration without touching GitHub", async () => {
    const f = fixture(); f.dependencies.store.findActiveRepositoryById = async () => null;
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.requests).toEqual([]);
    expect(f.outcomes).toEqual([{ repositoryId: "registration-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REGISTRATION_FAILED" }]);
  });

  it("keeps subscription and queue outcomes separate so reruns repair failed queueing", async () => {
    const f = fixture(); const enqueue = f.dependencies.store.requestRepositoryRederivation;
    f.dependencies.store.requestRepositoryRederivation = async () => { throw new Error("private database password"); };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    f.dependencies.store.requestRepositoryRederivation = enqueue;
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 1, failed: 0 });
    expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(f.outcomes).toEqual([
      { repositoryId: "registration-1", subscription: "VERIFIED", queue: "FAILED", failure: "QUEUE_FAILED" },
      { repositoryId: "registration-1", subscription: "VERIFIED", queue: "QUEUED", failure: null },
    ]);
    expect(f.queued).toEqual([{ repositoryId: "registration-1", reason: "REDERIVATION" }]);
  });

  it("does not queue repair when the hook update or verification fails", async () => {
    const f = fixture();
    const createGateway = f.dependencies.createGateway;
    f.dependencies.createGateway = (token, owner) => {
      const gateway = createGateway(token, owner);
      return { getRepositoryById: gateway.getRepositoryById.bind(gateway), ensureWebhookEvents: async () => { throw new Error("secret upstream body"); } };
    };
    expect(await upgradeRepositoryWebhooks(f.dependencies)).toEqual({ succeeded: 0, failed: 1 });
    expect(f.queued).toEqual([]);
    expect(f.outcomes).toEqual([{ repositoryId: "registration-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "SUBSCRIPTION_FAILED" }]);
  });
});
