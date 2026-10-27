import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitLabGateway } from "@/lib/gitlab/client";
import { runWebhookUpgradeCli, type WebhookUpgradeCliDependencies } from "../../scripts/upgrade-webhooks";

function fixture() {
  const lines: string[] = [];
  const dependencies: WebhookUpgradeCliDependencies = {
    store: {
      withWebhookUpgradeLock: async (_id, operation) => operation(),
      stageWebhookCredential: async () => { throw new Error("must not stage without sponsor credentials"); },
      finalizeWebhookCredential: async () => false,
      listActiveRepositoryIds: async () => ["repository-1", "repository-2"],
      findActiveRepositoryById: async (id) => ({ id, githubRepositoryId: 42, githubWebhookId: 81, registrationMethod: "oauth_hook", ownerName: "octo/old", sponsorId: id, visibility: "PUBLIC" }),
      findActiveRepositoryForgeById: async () => ({ provider: "github", instanceUrl: null }),
      getGitHubAccessToken: async () => null,
      getForgeToken: async () => { throw new Error("must not read a forge identity for a GitHub registration"); },
      requestRepositoryRederivation: async () => { throw new Error("must not enqueue before verification"); },
    },
    createGateway: () => { throw new Error("must not access GitHub without credentials"); },
    createGitLabGateway: () => { throw new Error("must not build a GitLab gateway for a GitHub registration"); },
    webhookUrls: { github: "https://overflow.example/api/github/webhooks", gitlab: "https://overflow.example/api/gitlab/webhooks" },
    write: (line) => { lines.push(line); },
  };
  return { lines, dependencies };
}

function lookupFixture(provider: "github" | "gitlab", status: number) {
  const f = fixture();
  f.dependencies.store.listActiveRepositoryIds = async () => ["repository-1"];
  f.dependencies.store.getGitHubAccessToken = async () => "synthetic-sponsor-token";
  f.dependencies.store.getForgeToken = async () => ({ token: "synthetic-forge-token", identityId: "identity-1" });
  f.dependencies.store.findActiveRepositoryForgeById = async () => ({ provider, instanceUrl: "https://gitlab.example.com" });
  f.dependencies.createGateway = (accessToken) => new GitHubGateway({ accessToken, fetch: async () => new Response(null, { status }) });
  f.dependencies.createGitLabGateway = (instanceUrl, token) => new GitLabGateway({ instanceUrl, token, fetch: async () => new Response(null, { status }) });
  return f;
}

describe("webhook upgrade CLI", () => {
  it.each(["github", "gitlab"] as const)("exits zero and names a gone %s repository beside a verified upgrade", async (provider) => {
    const f = lookupFixture(provider, 404);
    f.dependencies.store.listActiveRepositoryIds = async () => ["repository-1", "repository-2"];
    const find = f.dependencies.store.findActiveRepositoryById;
    f.dependencies.store.findActiveRepositoryById = async (id) => ({ ...(await find(id))!, githubRepositoryId: id === "repository-1" ? 42 : 43 });
    f.dependencies.store.stageWebhookCredential = async (target) => ({ ...target, credentialId: "credential-2", secret: "synthetic-secret", configuredAt: null });
    f.dependencies.store.finalizeWebhookCredential = async () => true;
    f.dependencies.store.requestRepositoryRederivation = async () => {};
    const createGateway = provider === "github" ? f.dependencies.createGateway : (token: string) => f.dependencies.createGitLabGateway("https://gitlab.example.com", token);
    const gateway = createGateway("synthetic-token", "sponsor-1");
    const getRepositoryById = gateway.getRepositoryById.bind(gateway);
    const upgraded: number[] = [];
    const create = () => ({
      getRepositoryById: async (id: number) => id === 42 ? getRepositoryById(id) : {
        id, owner: "current", ownerType: "USER" as const, name: "project", fullName: "current/project", visibility: "PUBLIC" as const,
        canAdminister: true, url: "https://forge.example/current/project",
      },
      configureWebhook: async () => { upgraded.push(43); },
    });
    f.dependencies.createGateway = create;
    f.dependencies.createGitLabGateway = create;
    expect.soft(await runWebhookUpgradeCli([], f.dependencies)).toBe(0);
    expect(upgraded).toEqual([43]);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([
      { repositoryId: "repository-1", subscription: "SKIPPED", queue: "NOT_ATTEMPTED", failure: "REPOSITORY_GONE" },
      { repositoryId: "repository-2", subscription: "VERIFIED", queue: "QUEUED", failure: null },
      { succeeded: 1, failed: 0, gone: 1 },
    ]);
  });

  it.each([
    ["github", 401], ["github", 500], ["gitlab", 401], ["gitlab", 500],
  ] as const)("exits nonzero for a %s by-id lookup error %s", async (provider, status) => {
    const f = lookupFixture(provider, status);
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(1);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([
      { repositoryId: "repository-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REPOSITORY_FAILED" },
      { succeeded: 0, failed: 1, gone: 0 },
    ]);
  });

  it("exits nonzero when a gone repository accompanies a credentials failure", async () => {
    const f = lookupFixture("github", 404);
    f.dependencies.store.listActiveRepositoryIds = async () => ["repository-1", "repository-2"];
    f.dependencies.store.getGitHubAccessToken = async (id) => id === "repository-1" ? "synthetic-token" : null;
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(1);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([
      { repositoryId: "repository-1", subscription: "SKIPPED", queue: "NOT_ATTEMPTED", failure: "REPOSITORY_GONE" },
      { repositoryId: "repository-2", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" },
      { succeeded: 0, failed: 1, gone: 1 },
    ]);
  });

  it("returns nonzero after reporting every registration's failure safely", async () => {
    const f = fixture();
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(1);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([
      { repositoryId: "repository-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" },
      { repositoryId: "repository-2", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" },
      { succeeded: 0, failed: 2, gone: 0 },
    ]);
  });

  it("reports an empty active registration set as a successful no-op", async () => {
    const f = fixture(); f.dependencies.store.listActiveRepositoryIds = async () => [];
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(0);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([{ succeeded: 0, failed: 0, gone: 0 }]);
  });

  it("sanitizes enumeration failures instead of printing the database connection string", async () => {
    const f = fixture(); f.dependencies.store.listActiveRepositoryIds = async () => { throw new Error("postgres://private:password@database"); };
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(1);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([{ failure: "UPGRADE_FAILED" }]);
  });

  it.each([["--repository"], ["--unknown", "secret-token"], ["--help", "extra"]])("rejects invalid arguments without database or GitHub work: %j", async (...args) => {
    const f = fixture();
    f.dependencies.store.listActiveRepositoryIds = async () => { throw new Error("must not enumerate"); };
    expect(await runWebhookUpgradeCli(args, f.dependencies)).toBe(2);
    expect(f.lines).toEqual(["Usage: pnpm webhooks:upgrade [--help]"]);
  });

  it.each([
    { args: ["--help"], status: 0, output: "Usage: pnpm webhooks:upgrade [--help]" },
    { args: ["--bad", "secret-argument"], status: 2, output: "Usage: pnpm webhooks:upgrade [--help]" },
    { args: [], status: 1, output: '{"failure":"UPGRADE_FAILED"}' },
  ])("reaches the actual package command with args $args and preserves exit $status", ({ args, status, output }) => {
    const result = spawnSync("pnpm", ["--silent", "webhooks:upgrade", ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: "", OVERFLOW_DATABASE_URL: "", GITHUB_WEBHOOK_SECRET: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.trim()).toBe(output);
    expect(result.stderr).not.toContain("secret-argument");
    expect(result.stderr).not.toContain("Error:");
  });
});
