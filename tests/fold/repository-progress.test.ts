import { afterAll, beforeAll, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { runMigrations } from "../../scripts/migrate";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let nextId = 80_000_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "repository_progress", user: "repository_progress" });
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

it("keeps the first and second listed issue milestones through removal and unregistration", async () => {
  const f = await fixture();
  const [initial] = await sql<{ first: string; second: boolean }[]>`
    select first_listed_issue_id as first, second_issue_listed as second
    from registered_repositories where id = ${f.source.repositoryId}
  `;
  expect(initial).toEqual({ first: String(f.source.fold.issues[0]!.githubIssueId), second: true });
  const first = { ...f.source.fold.issues[0]!, githubIssueId: nextId++, number: 1 };
  const second = { ...first, githubIssueId: nextId++, number: 2, openingSourceEventId: `opening-${nextId}` };
  const notBefore = new Date("2035-01-01T00:00:00.000Z");
  await f.source.store.withRepositoryReconciliation(f.repositoryId, () =>
    f.source.store.setReconciliationCooldown(f.repositoryId, notBefore));
  await f.publish({ ...f.empty, issues: [first] });
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: false, reviewed: false });
  expect(await f.source.store.getReconciliationCooldown(f.repositoryId)).toEqual(notBefore);
  await f.publish({ ...f.empty, issues: [first] });
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: false, reviewed: false });
  await f.publish(f.empty);
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: false, reviewed: false });
  await f.publish({ ...f.empty, issues: [second] });
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: true, reviewed: false });
  await f.publish(f.empty);
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: true, reviewed: false });
  await expect(new PostgresRepositoryStore(sql).unregisterRepository({
    ownerName: f.ownerName, sponsorId: f.sponsorId, provider: "github",
  })).resolves.toMatchObject({ kind: "UNREGISTERED" });
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: true, reviewed: false });
  await expect(new PostgresRepositoryStore(sql).createRepository({
    githubRepositoryId: f.githubId, ownerName: f.ownerName, sponsorId: f.sponsorId, visibility: "PUBLIC",
    githubWebhookId: f.webhookId, registrationMethod: "oauth_hook", webhookCredential: null,
    difficultyScheme: validDifficultyScheme(),
  })).resolves.toMatchObject({ id: f.repositoryId });
  expect(await f.markers()).toEqual({ first: String(first.githubIssueId), second: true, reviewed: false });
});

it("backstops contributor review rounds without counting sponsor or unlinked authors", async () => {
  const f = await fixture();
  const issue = { ...f.source.fold.issues[0]!, githubIssueId: nextId++, number: 1 };
  const contributor = f.source.fold.pullRequests[0]!;
  const sponsor = f.source.fold.pullRequests[1]!;
  const reviewRounds = [{ githubReviewId: nextId++, submittedAt: "2026-09-01T12:00:00.000Z" }];
  const base = { ...contributor, githubPullRequestId: nextId++, number: 1,
    githubIssueIds: [issue.githubIssueId], reviewRounds };
  const publish = (pr: typeof base) => f.publish({ ...f.empty, issues: [issue], pullRequests: [pr] });
  await publish({ ...base, authorId: sponsor.authorId, authorGitHubUserId: sponsor.authorGitHubUserId,
    authorGitHubLogin: sponsor.authorGitHubLogin });
  expect((await f.markers()).reviewed).toBe(false);
  await publish({ ...base, authorId: null, authorGitHubUserId: nextId++, authorGitHubLogin: "unlinked" });
  expect((await f.markers()).reviewed).toBe(false);
  await publish(base);
  expect((await f.markers()).reviewed).toBe(true);
  await f.publish(f.empty);
  expect((await f.markers()).reviewed).toBe(true);
});

async function fixture() {
  const source = await materializeRepositoryFixture(sql);
  const repoId = nextId++;
  const webhookId = nextId++;
  const ownerName = `progress/repository-${repoId}`;
  const [repository] = await sql<{ id: string; sponsor_id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility,
      github_webhook_id, difficulty_scheme)
    select ${repoId}, ${ownerName}, sponsor_id, visibility, ${webhookId}, difficulty_scheme
    from registered_repositories where id = ${source.repositoryId} returning id, sponsor_id
  `;
  const repositoryId = repository!.id;
  const empty: FoldResult = { ...source.fold, issues: [], pullRequests: [], settlements: [],
    selfWorkCalibrations: [], unwritableClosures: [], policyViolations: [], ledgerEntries: [] };
  return {
    source, empty, ownerName, repositoryId, githubId: repoId, webhookId, sponsorId: repository!.sponsor_id,
    publish: (fold: FoldResult) => source.store.withRepositoryReconciliation(repositoryId, async () =>
      source.store.materialize({ repositoryId, runId: await source.store.beginRun(repositoryId), fold })),
    markers: async () => {
      const [row] = await sql<{ first: string | null; second: boolean; reviewed: boolean }[]>`
        select first_listed_issue_id as first, second_issue_listed as second,
          contributor_review_received as reviewed from registered_repositories where id = ${repositoryId}
      `;
      return row;
    },
  };
}
