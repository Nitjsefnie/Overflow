import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { parseGitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { processWebhook } from "@/lib/webhooks/processor";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("webhook issue materialization", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "webhook_test", user: "webhook_test", password: "webhook_test" });
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

  it.each(["issues", "issue_comment"])("applies %s raw fields before resolving without changing any derived field", async (event) => {
    const fixture = await materializeRepositoryFixture(sql);
    const before = await row(fixture);
    await deliver(fixture, { event });
    expect(await row(fixture)).toEqual({ ...before, state: "OPEN", title: "Webhook title", body: "Webhook body",
      url: "https://github.com/octo/example/issues/1", github_updated_at: new Date("2026-09-08T10:00:00Z") });
    expect(await sql`select state from repository_reconciliation_jobs where repository_id = ${fixture.repositoryId}`)
      .toEqual([{ state: "PENDING" }]);
  });

  it("rejects older replayed and retried views using GitHub time, while equal views may reapply", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const retryId = randomUUID();
    await expect(deliver(fixture, { deliveryId: retryId, updatedAt: "2026-09-08T09:00:00Z", failEnqueue: true }))
      .rejects.toThrow("Webhook processing failed.");
    await deliver(fixture, { state: "closed" });
    const newer = await row(fixture);
    await deliver(fixture, { deliveryId: retryId, updatedAt: "2026-09-08T09:00:00Z" });
    expect(await row(fixture)).toEqual(newer);
    await deliver(fixture, { updatedAt: "2026-09-08T09:59:59Z" });
    expect(await row(fixture)).toEqual(newer);
    await deliver(fixture); // Equal timestamp is allowed to reapply.
    expect(await row(fixture)).toEqual({ ...newer, state: "OPEN" });
  });

  it("does not regress raw fields when an older fold lands after the webhook; derived fields still update", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    await deliver(fixture);
    const newer = await row(fixture);
    fixture.fold.issues[0] = { ...fixture.fold.issues[0], updatedAt: "2026-09-08T09:00:00Z",
      claimAssigneeGitHubLogin: "fold-assignee" };
    await materialize(fixture);
    const after = await row(fixture);
    expect(after).toEqual({ ...newer, claim_assignee_github_login: "fold-assignee", updated_at: after.updated_at });
  });

  it("protects a GitHub-confirmed fold closure from an older webhook but accepts a later reopen", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    await deliver(fixture);
    fixture.fold.issues[0] = { ...fixture.fold.issues[0], updatedAt: "2026-09-08T11:00:00Z" };
    await materialize(fixture);
    const closed = await row(fixture);
    expect(closed.state).toBe("CLOSED");
    expect(closed.github_updated_at).toEqual(new Date("2026-09-08T11:00:00Z"));
    await deliver(fixture);
    expect(await row(fixture)).toEqual(closed);
    await deliver(fixture, { updatedAt: "2026-09-08T12:00:00Z" });
    expect(await row(fixture)).toMatchObject({ state: "OPEN", github_updated_at: new Date("2026-09-08T12:00:00Z") });
  });

  it("initializes unknown provenance without treating local write time as GitHub time", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    await sql`update issues set github_updated_at = null, updated_at = '2099-01-01' where repository_id = ${fixture.repositoryId}`;
    await deliver(fixture);
    expect(await row(fixture)).toMatchObject({ state: "OPEN", github_updated_at: new Date("2026-09-08T10:00:00Z"),
      updated_at: new Date("2099-01-01") });
  });

  it.each(["unknown issue", "unknown repository", "inactive repository", "wrong repository", "PR comment"])(
    "preserves rows at the %s boundary", async (boundary) => {
      const fixture = await materializeRepositoryFixture(sql);
      const options: Parameters<typeof deliver>[1] = {};
      if (boundary === "unknown issue") options.issueId = 9_999_999;
      if (boundary === "unknown repository") options.repositoryGitHubId = 9_999_999;
      if (boundary === "inactive repository") {
        await sql`update registered_repositories set active = false where id = ${fixture.repositoryId}`;
      }
      if (boundary === "wrong repository") {
        const other = await materializeRepositoryFixture(sql);
        const [repository] = await sql`select github_repository_id from registered_repositories where id = ${other.repositoryId}`;
        options.repositoryGitHubId = Number(repository.github_repository_id);
      }
      const issues = await sql`select * from issues order by id`;
      const prs = await sql`select * from pull_requests order by id`;
      if (boundary === "PR comment") {
        // A PR-carrying envelope parses to no delivery at all: nothing is
        // claimed, viewed or enqueued, so the rows and queue below stay
        // untouched.
        const [repository] = await sql`select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;
        expect(parseGitHubWebhookDelivery("issue_comment", randomUUID(), {
          action: "created",
          repository: { id: Number(repository.github_repository_id), full_name: "octo/example" },
          issue: { id: fixture.fold.issues[0].githubIssueId, number: 1, state: "open",
            updated_at: "2026-09-08T10:00:00Z", title: "Webhook title", body: "Webhook body",
            html_url: "https://github.com/octo/example/issues/1", pull_request: {} },
        })).toBeNull();
      } else {
        await deliver(fixture, options);
      }
      expect(await sql`select * from issues order by id`).toEqual(issues);
      expect(await sql`select * from pull_requests order by id`).toEqual(prs);
      const queued = !["unknown repository", "inactive repository", "wrong repository", "PR comment"].includes(boundary);
      expect(await sql`select count(*)::int as count from repository_reconciliation_jobs where repository_id = ${fixture.repositoryId}`)
        .toEqual([{ count: queued ? 1 : 0 }]);
    },
  );
});

type Fixture = Awaited<ReturnType<typeof materializeRepositoryFixture>>;

async function row(fixture: Fixture) {
  const [result] = await sql`select * from issues where github_issue_id = ${fixture.fold.issues[0].githubIssueId}`;
  return result;
}

async function deliver(fixture: Fixture, options: {
  event?: string; state?: string; updatedAt?: string; deliveryId?: string;
  issueId?: number; repositoryGitHubId?: number;
  failEnqueue?: boolean;
} = {}) {
  const [repository] = await sql`select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;
  const event = options.event ?? "issues";
  const delivery = parseGitHubWebhookDelivery(event, options.deliveryId ?? randomUUID(), {
    action: event === "issues" ? "reopened" : "created",
    repository: { id: options.repositoryGitHubId ?? Number(repository.github_repository_id), full_name: "octo/example" },
    issue: { id: options.issueId ?? fixture.fold.issues[0].githubIssueId, number: 1,
      state: options.state ?? "open", updated_at: options.updatedAt ?? "2026-09-08T10:00:00Z",
      title: "Webhook title", body: "Webhook body", html_url: "https://github.com/octo/example/issues/1" },
  });
  if (delivery === null) throw new Error("Invalid test delivery");
  return processWebhook({ store: fixture.store,
    enqueueReconciliation: (repositoryId, incoming) => {
      if (options.failEnqueue) throw new Error("Injected queue failure");
      return fixture.store.enqueueWebhookReconciliation(repositoryId, incoming);
    },
  }, delivery);
}

async function materialize(fixture: Fixture) {
  return fixture.store.withRepositoryReconciliation(fixture.repositoryId, async () => fixture.store.materialize({
    repositoryId: fixture.repositoryId, runId: await fixture.store.beginRun(fixture.repositoryId), fold: fixture.fold,
  }));
}
