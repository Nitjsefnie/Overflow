import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { createGitLabWebhookPostHandler } from "@/app/api/gitlab/webhooks/route";
import { processWebhook } from "@/lib/webhooks/processor";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("GitLab stable message retries", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "gitlab_retry", user: "gitlab_retry", password: "gitlab_retry" });
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

  it.each(["Idempotency-Key", "webhook-id"])("deduplicates fresh execution UUIDs using %s without invalidating a running fold", async (header) => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const [repository] = await sql`update registered_repositories
      set provider = 'gitlab', instance_url = 'https://gitlab.example.com', forge_project_id = github_repository_id
      where id = ${repositoryId} returning forge_project_id`;
    const projectId = Number(repository.forge_project_id);
    const credentialId = "181a4fbb-64d1-44fd-82da-cd191613798c";
    const results: unknown[] = [];
    const route = createGitLabWebhookPostHandler({
      lookupCredential: async () => ({
        repositoryId, credentialId, provider: "gitlab", instanceUrl: "https://gitlab.example.com",
        projectId, secret: "test-secret", webhookId: 4242, configuredAt: null,
      }),
      processWebhook: async (delivery, scope) => {
        const result = await processWebhook({ store,
          enqueueReconciliation: (id, event) => store.enqueueWebhookReconciliation(id, event),
        }, delivery, scope);
        results.push(result);
        return result;
      },
    });
    const body = JSON.stringify({
      object_kind: "issue",
      project: { id: projectId, path_with_namespace: "group/project", web_url: "https://gitlab.example.com/group/project" },
      object_attributes: {
        id: fold.issues[0].githubIssueId, iid: 1, title: "Updated", description: "", state: "opened",
        updated_at: "2026-09-26T12:00:00Z", url: "https://gitlab.example.com/group/project/-/issues/1", action: "reopen",
      },
    });
    const send = (uuid: string) => route(new Request(`https://overflow.test/api/gitlab/webhooks?hook=${credentialId}`, {
      method: "POST", body,
      headers: { "x-gitlab-event": "Issue Hook", "x-gitlab-token": "test-secret",
        "x-gitlab-webhook-uuid": uuid, [header]: "stable-message" },
    }));

    expect((await send("execution-1")).status).toBe(202);
    expect(results).toEqual([{ status: "PROCESSED" }]);
    expect(await store.claimNextReconciliationJob()).toMatchObject({ repositoryId });
    const dirtyBefore = await store.getDirtyReconciliationSubjects(repositoryId);
    expect(dirtyBefore).toHaveLength(1);
    const jobsBefore = await sql`select id, state, follow_up_requested from repository_reconciliation_jobs where repository_id = ${repositoryId}`;
    expect(jobsBefore).toEqual([{ id: expect.any(String), state: "RUNNING", follow_up_requested: false }]);

    // The identical-execution control also stays a duplicate while the job runs.
    expect((await send("execution-1")).status).toBe(202);
    expect((await send("execution-2")).status).toBe(202);
    expect(results).toEqual([{ status: "PROCESSED" }, { status: "DUPLICATE" }, { status: "DUPLICATE" }]);
    expect(await store.getDirtyReconciliationSubjects(repositoryId)).toEqual(dirtyBefore);
    expect(await sql`select id, state, follow_up_requested from repository_reconciliation_jobs where repository_id = ${repositoryId}`)
      .toEqual(jobsBefore);
    expect(await sql`select provider, delivery_key, execution_id, attempt_count, processing_state
      from webhook_deliveries where registration_id = ${repositoryId}`)
      .toEqual([{ provider: "gitlab", delivery_key: "stable-message", execution_id: "execution-1", attempt_count: 1, processing_state: "PROCESSED" }]);
  });
});
