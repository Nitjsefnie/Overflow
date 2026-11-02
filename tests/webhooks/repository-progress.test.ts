import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import { parseGitHubWebhookDeliveryDetailed, type GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { parseGitLabWebhookDeliveryDetailed } from "@/lib/gitlab/webhook-schema";
import { PostgresWebhookDeliveryStore } from "@/lib/webhooks/postgres-delivery-store";
import { processWebhook } from "@/lib/webhooks/processor";
import { runMigrations } from "../../scripts/migrate";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let nextId = 81_000_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "webhook_progress", user: "webhook_progress" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

it("records submitted GitHub reviews of contributor PRs, but not sponsor, unlinked or non-submitted reviews", async () => {
  const f = await fixture();
  for (const [action, author] of [["submitted", f.sponsorForgeId], ["submitted", nextId++], ["submitted", null],
    ["edited", f.contributorForgeId], ["dismissed", f.contributorForgeId]] as const) {
    await f.deliver(github(f.githubId, action, author));
    expect(await f.reviewed()).toBe(false);
  }
  for (const state of ["commented", "approved", "changes_requested"]) {
    const target = state === "commented" ? f : await fixture();
    await target.deliver(github(target.githubId, "submitted", target.contributorForgeId, state));
    expect(await target.reviewed()).toBe(true);
    await target.deliver(github(target.githubId, "dismissed", target.contributorForgeId));
    expect(await target.reviewed()).toBe(true);
  }
});

it("resolves a GitLab approval through the linked identity on the correct instance", async () => {
  const f = await fixture();
  await sql`update registered_repositories set provider = 'gitlab', instance_url = 'https://gitlab.example',
    forge_project_id = ${f.githubId} where id = ${f.repositoryId}`;
  const sponsorId = nextId++;
  await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
    values (${f.sponsorId}, 'gitlab', 'https://gitlab.example', ${sponsorId}, 'sponsor', ${Buffer.from("fixture")})`;
  await f.deliver(gitlab(f.githubId, sponsorId), "gitlab");
  expect(await f.reviewed()).toBe(false);
  const authorId = nextId++;
  await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
    values (${f.contributorId}, 'gitlab', 'https://other.example', ${authorId}, 'contributor', ${Buffer.from("fixture")})`;
  await f.deliver(gitlab(f.githubId, authorId), "gitlab");
  expect(await f.reviewed()).toBe(false);
  await sql`update user_forge_identities set instance_url = 'https://gitlab.example' where user_id = ${f.contributorId}`;
  await f.deliver(gitlab(f.githubId, authorId), "gitlab");
  expect(await f.reviewed()).toBe(true);
});

it("does not write a marker for an unregistered repository", async () => {
  const f = await fixture();
  await sql`update registered_repositories set active = false, unregistered_at = now() where id = ${f.repositoryId}`;
  await f.deliver(github(f.githubId, "submitted", f.contributorForgeId));
  expect(await f.reviewed()).toBe(false);
  expect(await sql`select id from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`).toHaveLength(0);
});

it("records a review for a registered repository even when reconciliation is vetoed", async () => {
  for (const veto of ["unavailable", "private"] as const) {
    const f = await fixture();
    if (veto === "unavailable") await sql`update registered_repositories
      set unavailable_reason = 'NOT_PUBLIC', unavailable_since = now() where id = ${f.repositoryId}`;
    const delivery = github(f.githubId, "submitted", f.contributorForgeId);
    if (veto === "private") delivery.repositoryPrivate = true;
    await expect(f.deliver(delivery)).resolves.toEqual({ status: "PROCESSED" });
    expect(await f.reviewed()).toBe(true);
    expect(await sql`select id from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`).toHaveLength(0);
  }
});

it("keeps the response and reconciliation when a marker write fails, without logging identifiers", async () => {
  const f = await fixture();
  const store = new PostgresWebhookDeliveryStore(sql);
  Object.assign(store, { markContributorReviewReceived: async () => { throw new Error(`sensitive ${f.githubId}`); } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(f.deliver(github(f.githubId, "submitted", f.contributorForgeId), "github", store))
      .resolves.toEqual({ status: "PROCESSED" });
    expect(await sql`select id from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`).toHaveLength(1);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(String(f.githubId));
  } finally {
    log.mockRestore();
  }
});

function github(repositoryId: number, action: string, authorId: number | null, state = "approved"): GitHubWebhookDelivery {
  const parsed = parseGitHubWebhookDeliveryDetailed("pull_request_review", `delivery-${nextId++}`, {
    action, repository: { id: repositoryId, full_name: "example/project" },
    pull_request: { id: nextId++, number: 1, user: authorId === null ? null : { id: authorId } }, review: { state },
  });
  if (parsed.status !== "ok") throw new Error("Expected a GitHub delivery");
  return parsed.delivery;
}

function gitlab(repositoryId: number, authorId: number): GitHubWebhookDelivery {
  const parsed = parseGitLabWebhookDeliveryDetailed("Merge Request Hook", `delivery-${nextId++}`, {
    object_kind: "merge_request", project: { id: repositoryId, path_with_namespace: "example/project",
      web_url: "https://gitlab.example/example/project" },
    object_attributes: { id: nextId++, iid: 1, action: "approval", author_id: authorId },
    user: { id: nextId++ },
  });
  if (parsed.status !== "ok") throw new Error("Expected a GitLab delivery");
  return parsed.delivery;
}

async function fixture() {
  const sponsorForgeId = nextId++;
  const contributorForgeId = nextId++;
  const [sponsor] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
    values (${sponsorForgeId}, ${`sponsor-${sponsorForgeId}`}) returning id`;
  const [contributor] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
    values (${contributorForgeId}, ${`contributor-${contributorForgeId}`}) returning id`;
  const githubId = nextId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility,
      github_webhook_id, difficulty_scheme)
    values (${githubId}, ${`example/repository-${githubId}`}, ${sponsor!.id}, 'PUBLIC', ${nextId++},
      ${sql.json(validDifficultyScheme())}) returning id
  `;
  const repositoryId = repository!.id;
  return {
    githubId, repositoryId, sponsorForgeId, contributorForgeId, sponsorId: sponsor!.id, contributorId: contributor!.id,
    reviewed: async () => (await sql<{ contributor_review_received: boolean }[]>`
      select contributor_review_received from registered_repositories where id = ${repositoryId}
    `)[0]!.contributor_review_received,
    deliver: (delivery: GitHubWebhookDelivery, provider: "github" | "gitlab" = "github",
      store = new PostgresWebhookDeliveryStore(sql)) => processWebhook({ store,
        enqueueReconciliation: (id, event) => store.enqueueWebhookReconciliation(id, event),
      }, delivery, { provider, registrationId: repositoryId }),
  };
}
