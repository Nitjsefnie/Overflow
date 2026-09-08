import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runWebhookUpgradeCli, type WebhookUpgradeCliDependencies } from "../../scripts/upgrade-webhooks";

function fixture() {
  const lines: string[] = [];
  const dependencies: WebhookUpgradeCliDependencies = {
    store: {
      listActiveRepositoryIds: async () => ["repository-1", "repository-2"],
      findActiveRepositoryById: async (id) => ({ id, githubRepositoryId: 42, githubWebhookId: 81, ownerName: "octo/old", sponsorId: id, visibility: "PUBLIC" }),
      getGitHubAccessToken: async () => null,
      enqueueReconciliationJob: async () => { throw new Error("must not enqueue before verification"); },
    },
    createGateway: () => { throw new Error("must not access GitHub without credentials"); },
    webhookSecret: "existing-secret",
    write: (line) => { lines.push(line); },
  };
  return { lines, dependencies };
}

describe("webhook upgrade CLI", () => {
  it("returns nonzero after reporting every registration's failure safely", async () => {
    const f = fixture();
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(1);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([
      { repositoryId: "repository-1", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" },
      { repositoryId: "repository-2", subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED" },
      { succeeded: 0, failed: 2 },
    ]);
  });

  it("reports an empty active registration set as a successful no-op", async () => {
    const f = fixture(); f.dependencies.store.listActiveRepositoryIds = async () => [];
    expect(await runWebhookUpgradeCli([], f.dependencies)).toBe(0);
    expect(f.lines.map((line) => JSON.parse(line))).toEqual([{ succeeded: 0, failed: 0 }]);
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
      env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: "", GITHUB_WEBHOOK_SECRET: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.trim()).toBe(output);
    expect(result.stderr).not.toContain("secret-argument");
    expect(result.stderr).not.toContain("Error:");
  });
});
