import { pathToFileURL } from "node:url";
import { closeSql, getSql } from "../src/lib/db/client.ts";
import { GitHubGateway } from "../src/lib/github/client.ts";
import { GitLabGateway } from "../src/lib/gitlab/client.ts";
import { PostgresFoldStore } from "../src/lib/fold/postgres-store.ts";
import { PostgresForgeIdentityStore } from "../src/lib/forge/postgres-identities-store.ts";
import { PostgresRepositoryStore } from "../src/lib/repositories/postgres-store.ts";
import { upgradeRepositoryWebhooks, type WebhookUpgradeDependencies } from "../src/lib/repositories/upgrade-webhooks.ts";

export type WebhookUpgradeCliDependencies = Omit<WebhookUpgradeDependencies, "report"> & {
  write(line: string): void;
};

export async function runWebhookUpgradeCli(
  argumentsList: readonly string[] = process.argv.slice(2),
  dependencies?: WebhookUpgradeCliDependencies,
): Promise<number> {
  const write = dependencies?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (argumentsList.length > 0) {
    write("Usage: pnpm webhooks:upgrade [--help]");
    return argumentsList.length === 1 && argumentsList[0] === "--help" ? 0 : 2;
  }
  try {
    dependencies ??= productionDependencies(write);
    const summary = await upgradeRepositoryWebhooks({
      ...dependencies,
      report: (outcome) => write(JSON.stringify(outcome)),
    });
    write(JSON.stringify(summary));
    return summary.failed === 0 ? 0 : 1;
  } catch {
    write(JSON.stringify({ failure: "UPGRADE_FAILED" }));
    return 1;
  }
}

function productionDependencies(write: (line: string) => void): WebhookUpgradeCliDependencies {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret.length === 0) {
    throw new Error("Existing webhook secret must be configured.");
  }
  const registrations = new PostgresRepositoryStore();
  const queue = new PostgresFoldStore();
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
    throw new Error("Token encryption key must be configured.");
  }
  const forgeIdentities = new PostgresForgeIdentityStore(getSql(), tokenEncryptionKey);
  return {
    store: {
      listActiveRepositoryIds: () => queue.listActiveRepositoryIds(),
      findActiveRepositoryById: (id) => registrations.findActiveRepositoryById(id),
      findActiveRepositoryForgeById: (id) => registrations.findActiveRepositoryForgeById(id),
      getGitHubAccessToken: (id) => registrations.getGitHubAccessToken(id),
      getForgeToken: (sponsorId, instanceUrl) => forgeIdentities.getForgeToken(sponsorId, instanceUrl),
      requestRepositoryRederivation: (id, at) => queue.requestRepositoryRederivation(id, at),
    },
    createGateway: (accessToken, owner) => new GitHubGateway({ accessToken, owner }),
    createGitLabGateway: (instanceUrl, token) => new GitLabGateway({ instanceUrl, token }),
    webhookSecret,
    write,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runWebhookUpgradeCli();
  } finally {
    try {
      await closeSql();
    } catch {
      process.stdout.write(`${JSON.stringify({ failure: "CLOSE_FAILED" })}\n`);
      process.exitCode = 1;
    }
  }
}
