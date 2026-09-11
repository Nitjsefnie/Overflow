import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { parseGitLabWebhookDelivery } from "@/lib/gitlab/webhook-schema";
import { processWebhook } from "@/lib/webhooks/processor";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

let externalId = 5_400_000;

async function insertGitLabRepository(options: { instanceUrl: string; projectId: number }) {
  const sponsorGitHubId = externalId++;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${sponsorGitHubId}, ${`gitlab-sponsor-${sponsorGitHubId}`}) returning id
  `;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
      difficulty_scheme, provider, instance_url, forge_project_id
    ) values (
      ${options.projectId}, ${`gl-group/project-${options.projectId}`}, ${sponsor!.id}, 'PUBLIC', ${externalId++},
      ${sql.json(validDifficultyScheme())}, 'gitlab', ${options.instanceUrl}, ${options.projectId}
    ) returning id
  `;
  return repository!.id;
}

async function insertIssue(repositoryId: string, githubIssueId: number) {
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${repositoryId}, 23, 'Old title', '',
      'https://gitlab.example.com/gl-group/p/-/issues/23', 'OPEN', 'size/M', 5, 5
    )
  `;
}

function issueDelivery(options: { projectId: number; instanceUrl: string; uuid: string; issueId: number }) {
  return parseGitLabWebhookDelivery("Issue Hook", options.uuid, {
    object_kind: "issue",
    event_type: "issue",
    project: {
      id: options.projectId,
      name: "p",
      path_with_namespace: `gl-group/project-${options.projectId}`,
      web_url: `${options.instanceUrl}/gl-group/project-${options.projectId}`,
    },
    object_attributes: {
      id: options.issueId,
      iid: 23,
      title: "Webhook title",
      description: "Webhook body",
      state: "closed",
      updated_at: "2026-09-08T10:00:00.000Z",
      url: `${options.instanceUrl}/gl-group/p/-/issues/23`,
      action: "close",
    },
  })!;
}

async function deliver(delivery: ReturnType<typeof issueDelivery>) {
  const store = new PostgresFoldStore();
  return processWebhook({
    store,
    enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
  }, delivery);
}

async function issueRow(repositoryId: string) {
  const [row] = await sql<{ title: string; state: string; github_updated_at: Date }[]>`
    select title, state::text as state, github_updated_at from issues where repository_id = ${repositoryId}
  `;
  return row!;
}

describe("GitLab webhook delivery materialization", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "gitlab_webhook_test",
      user: "gitlab_webhook_test",
      password: "gitlab_webhook_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("resolves the registration by forge identity, applies the issue view, and queues the fold", async () => {
    const projectId = externalId++;
    const instanceUrl = "https://gitlab.example.com";
    const issueId = externalId++;
    const repositoryId = await insertGitLabRepository({ instanceUrl, projectId });
    await insertIssue(repositoryId, issueId);

    await expect(deliver(issueDelivery({ projectId, instanceUrl, uuid: "db-uuid-1", issueId }))).resolves.toEqual({
      status: "PROCESSED",
    });

    expect(await issueRow(repositoryId)).toEqual({
      title: "Webhook title",
      state: "CLOSED",
      github_updated_at: new Date("2026-09-08T10:00:00.000Z"),
    });
    expect(await sql`select state::text as state from repository_reconciliation_jobs where repository_id = ${repositoryId}`)
      .toEqual([{ state: "PENDING" }]);
    expect(await sql`
      select kind::text as kind, github_subject_id::text as github_subject_id, subject_number
      from repository_reconciliation_dirty_subjects where repository_id = ${repositoryId}
    `).toEqual([{ kind: "ISSUE", github_subject_id: String(issueId), subject_number: 23 }]);
    // The dedup key is namespaced: it can never collide with a GitHub guid.
    expect(await sql`select github_delivery_id, processing_state::text as processing_state from webhook_deliveries where github_delivery_id = 'gitlab:db-uuid-1'`)
      .toEqual([{ github_delivery_id: "gitlab:db-uuid-1", processing_state: "PROCESSED" }]);
  });

  it("replays the same webhook uuid as a duplicate without re-enqueueing the fold", async () => {
    const projectId = externalId++;
    const instanceUrl = "https://gitlab.example.com";
    const issueId = externalId++;
    const repositoryId = await insertGitLabRepository({ instanceUrl, projectId });
    await insertIssue(repositoryId, issueId);

    await deliver(issueDelivery({ projectId, instanceUrl, uuid: "db-uuid-2", issueId }));
    const [before] = await sql`
      select generation::text as generation from repository_reconciliation_dirty_subjects
      where repository_id = ${repositoryId}
    `;
    await expect(deliver(issueDelivery({ projectId, instanceUrl, uuid: "db-uuid-2", issueId }))).resolves.toEqual({
      status: "DUPLICATE",
    });

    // The replay left the dirty subject exactly as the first delivery left it:
    // the namespaced uuid's unique claim, not the subject row, is what dedups.
    expect(await sql`
      select generation::text as generation from repository_reconciliation_dirty_subjects
      where repository_id = ${repositoryId}
    `).toEqual([{ generation: before!.generation }]);
  });

  it("preserves rows when the delivery's forge identity matches no registration", async () => {
    const projectId = externalId++;
    const issueId = externalId++;
    const repositoryId = await insertGitLabRepository({ instanceUrl: "https://gitlab.example.com", projectId });
    await insertIssue(repositoryId, issueId);

    // Same project id, another instance: the triple resolves to nothing, so
    // no fold is queued and no row moves.
    await expect(deliver(issueDelivery({
      projectId, instanceUrl: "https://other.example.com", uuid: "db-uuid-3", issueId,
    }))).resolves.toEqual({ status: "PROCESSED" });

    expect(await issueRow(repositoryId)).toMatchObject({ title: "Old title", state: "OPEN" });
    expect(await sql`select id from repository_reconciliation_jobs where repository_id = ${repositoryId}`).toEqual([]);
    expect(await sql`select github_subject_id from repository_reconciliation_dirty_subjects where repository_id = ${repositoryId}`).toEqual([]);
  });
});
