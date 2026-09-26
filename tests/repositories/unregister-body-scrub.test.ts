import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import {
  CACHED_COMMENT_BODY_PLACEHOLDER,
  narrowCachedIssueBodies,
  RECONCILIATION_EVIDENCE_FORMAT,
} from "@/lib/fold/reconciliation-evidence";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresRepositoryStore;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 41).toString("base64url");
let externalId = 9_840_000;

const SCRUBBED_ISSUE_BODY = "Cached issue body the unregistration must scrub";
const SCRUBBED_PULL_REQUEST_BODY = "Cached pull request body the unregistration must scrub";
const SCRUBBED_COMMENT_BODY = "Cached comment body the unregistration must scrub";
// The cached reviews and raw diff are settlement evidence the unregistration
// must carry through untouched, so the fixture makes them distinctive.
const RAW_DIFF = "diff --git a/scrub b/scrub\n+bytes the unregistration must never touch\n";
const REVIEWS = [{
  id: 7_401,
  state: "APPROVED" as const,
  submittedAt: "2026-09-01T09:30:00.000Z",
  dismissal: null,
}];

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "unregister_scrub_test",
    user: "unregister_scrub_test",
    password: "unregister_scrub_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  store = new PostgresRepositoryStore(sql, tokenEncryptionKey);
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("scrubbing free text when a repository is unregistered", () => {
  it("nulls the materialized issue and pull request bodies while keeping every row", async () => {
    const repository = await registeredRepository();
    await materializedRows(repository.repositoryId);

    await expect(store.unregisterRepository(registrationOf(repository))).resolves.toMatchObject({
      kind: "UNREGISTERED",
    });
    expect(await issueBodies(repository.repositoryId)).toEqual([{ body: null }]);
    expect(await pullRequestBodies(repository.repositoryId)).toEqual([{ body: null }]);
    expect(await rowCount("issues", repository.repositoryId)).toBe(1);
    expect(await rowCount("pull_requests", repository.repositoryId)).toBe(1);
  });

  it("narrows the evidence cache in place: comment bodies become the placeholder, issue bodies vanish, the diff stays byte-identical", async () => {
    const repository = await registeredRepository();
    const before = await seedWideEvidenceCache(repository.repositoryId);

    await store.unregisterRepository(registrationOf(repository));

    const after = await evidenceCache(repository.repositoryId);
    const [cachedIssue] = after.issues;
    // The scrub leaves exactly the narrowing: every other cached field — ids,
    // logins, timestamps, history, the diff and reviews — passes through
    // unchanged.
    expect(after.issues).toEqual(narrowCachedIssueBodies(before.issues));
    // The issue's and its nested pull request's own bodies are gone outright,
    // while every nonblank comment body is the placeholder and the blank one
    // stays blank.
    expect(Object.hasOwn(cachedIssue!, "body")).toBe(false);
    expect(Object.hasOwn(cachedIssue!.closingPullRequests[0]!, "body")).toBe(false);
    expect(cachedIssue!.comments.map(({ body }) => body)).toEqual([
      CACHED_COMMENT_BODY_PLACEHOLDER, "",
    ]);
    // The cached reviews and raw diff pass through byte for byte.
    expect(after.pullRequestsRaw).toBe(before.pullRequestsRaw);
  });

  it.each(["PENDING", "RUNNING"] as const)(
    "leaves the evidence cache untouched while a %s job could still fold the repository",
    async (state) => {
      const repository = await registeredRepository();
      await materializedRows(repository.repositoryId);
      const before = await seedWideEvidenceCache(repository.repositoryId);
      await insertReconciliationJob(repository.repositoryId, state);

      await store.unregisterRepository(registrationOf(repository));

      const after = await evidenceCache(repository.repositoryId);
      expect(after.issuesRaw).toBe(before.issuesRaw);
      expect(after.pullRequestsRaw).toBe(before.pullRequestsRaw);
      // The body columns carry no reader, so they are scrubbed regardless.
      expect(await issueBodies(repository.repositoryId)).toEqual([{ body: null }]);
      expect(await pullRequestBodies(repository.repositoryId)).toEqual([{ body: null }]);
      // The job is neither cancelled nor deleted.
      expect(await rowCount("repository_reconciliation_jobs", repository.repositoryId)).toBe(1);
    },
  );

  it("leaves the evidence cache untouched while a fresh merge is inside the settlement evidence window", async () => {
    const repository = await registeredRepository();
    await materializedRows(repository.repositoryId, {
      mergedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const before = await seedWideEvidenceCache(repository.repositoryId);

    await store.unregisterRepository(registrationOf(repository));

    const after = await evidenceCache(repository.repositoryId);
    expect(after.issuesRaw).toBe(before.issuesRaw);
    expect(after.pullRequestsRaw).toBe(before.pullRequestsRaw);
  });

  it("scrubs the evidence cache once the fresh merge already carries its settlement", async () => {
    const repository = await registeredRepository();
    const { issueId, pullRequestId } = await materializedRows(repository.repositoryId, {
      mergedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await insertSettlement(repository.repositoryId, pullRequestId, issueId);
    const before = await seedWideEvidenceCache(repository.repositoryId);

    await store.unregisterRepository(registrationOf(repository));

    const after = await evidenceCache(repository.repositoryId);
    const [cachedIssue] = after.issues;
    expect(after.issues).toEqual(narrowCachedIssueBodies(before.issues));
    expect(Object.hasOwn(cachedIssue!, "body")).toBe(false);
    expect(cachedIssue!.comments.map(({ body }) => body)).toEqual([
      CACHED_COMMENT_BODY_PLACEHOLDER, "",
    ]);
  });
});

function registrationOf(repository: { ownerName: string; sponsorId: string }): {
  ownerName: string;
  sponsorId: string;
  provider: "github";
} {
  return { ownerName: repository.ownerName, sponsorId: repository.sponsorId, provider: "github" };
}

async function registeredRepository(): Promise<{ repositoryId: string; ownerName: string; sponsorId: string }> {
  const githubUserId = externalId++;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`scrub-sponsor-${githubUserId}`})
    returning id
  `;
  const githubRepositoryId = externalId++;
  const ownerName = `scrub/repo-${githubRepositoryId}`;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${ownerName}, ${user!.id}, ${"PUBLIC"}, ${externalId++},
      ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  return { repositoryId: repository!.id, ownerName, sponsorId: user!.id };
}

async function materializedRows(
  repositoryId: string,
  overrides: { mergedAt?: Date | null } = {},
): Promise<{ issueId: string; pullRequestId: string }> {
  const mergedAt = overrides.mergedAt === undefined ? "2026-09-01T12:00:00.000Z" : overrides.mergedAt;
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${externalId++}, ${repositoryId}, 1, 'Issue title',
      'Issue body text the unregistration must scrub',
      ${`https://github.com/scrub/issues/${externalId}`}, ${"CLOSED"}, ${"M"}, 5, 5
    )
    returning id
  `;
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      state, merged_at
    )
    values (
      ${externalId++}, ${repositoryId}, ${issue!.id}, 11,
      ${`https://github.com/scrub/pull/${externalId}`}, 'Pull request title',
      'Pull request body text the unregistration must scrub', ${"MERGED"}, ${mergedAt}
    )
    returning id
  `;
  return { issueId: issue!.id, pullRequestId: pullRequest!.id };
}

/** A legacy (pre-narrowing) evidence cache: wide bodies, a review and a raw diff. */
async function seedWideEvidenceCache(
  repositoryId: string,
): Promise<{
  issues: Array<{ body?: string; comments: Array<{ body: string }>; closingPullRequests: Array<Record<string, unknown>> }>;
  issuesRaw: string;
  pullRequestsRaw: string;
}> {
  const issues = [{
    id: externalId,
    number: 1,
    title: "Cached issue",
    body: SCRUBBED_ISSUE_BODY,
    url: `https://github.com/scrub/issues/${externalId}`,
    state: "CLOSED",
    stateReason: "COMPLETED",
    createdAt: "2026-08-30T09:00:00.000Z",
    closedAt: "2026-09-01T12:05:00.000Z",
    updatedAt: "2026-09-01T12:05:00.000Z",
    authorLogin: null,
    authorGitHubUserId: null,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
    claimAssigneeGitHubUserId: null,
    history: [],
    comments: [
      {
        id: `comment-${externalId}`,
        databaseId: externalId,
        authorLogin: null,
        authorGitHubUserId: null,
        body: SCRUBBED_COMMENT_BODY,
        createdAt: "2026-09-01T11:30:00.000Z",
        lastEditedAt: null,
      },
      {
        id: `comment-blank-${externalId}`,
        databaseId: externalId + 1,
        authorLogin: null,
        authorGitHubUserId: null,
        body: "   \n\t ",
        createdAt: "2026-09-01T11:40:00.000Z",
        lastEditedAt: null,
      },
    ],
    closingPullRequests: [{
      id: externalId + 2,
      number: 11,
      title: "Cached pull request",
      body: SCRUBBED_PULL_REQUEST_BODY,
      url: `https://github.com/scrub/pull/11`,
      state: "MERGED",
      mergedAt: "2026-09-01T12:00:00.000Z",
      mergeCommitOid: "c".repeat(40),
      finalCommitAt: "2026-09-01T10:00:00.000Z",
      authorLogin: null,
      authorGitHubUserId: null,
      repositoryGitHubId: externalId - 1,
      repositoryNameWithOwner: "scrub/example",
    }],
  }];
  const pullRequests = [{ id: externalId + 2, reviews: REVIEWS, rawDiff: RAW_DIFF }];
  await sql`
    insert into repository_reconciliation_evidence
      (repository_id, version, format_version, checkpoint, last_full_pass_at, issues, pull_requests)
    values (
      ${repositoryId}, 1, ${RECONCILIATION_EVIDENCE_FORMAT}, now(), now(),
      ${sql.json(issues)}::jsonb, ${sql.json(pullRequests)}::jsonb
    )
  `;
  // jsonb canonicalises key order, so byte-identity is judged on the stored
  // text read back from the database, not on the fixture's own JSON.
  const [stored] = await sql<{ issues_raw: string; pull_requests_raw: string }[]>`
    select issues::text as issues_raw, pull_requests::text as pull_requests_raw
    from repository_reconciliation_evidence
    where repository_id = ${repositoryId}
  `;
  return { issues, issuesRaw: stored!.issues_raw, pullRequestsRaw: stored!.pull_requests_raw };
}

async function evidenceCache(
  repositoryId: string,
): Promise<{
  issues: Array<{ body?: string; comments: Array<{ body: string }>; closingPullRequests: Array<Record<string, unknown>> }>;
  pullRequests: Array<unknown>;
  issuesRaw: string;
  pullRequestsRaw: string;
}> {
  const [row] = await sql<{
    issues: Array<{ body?: string; comments: Array<{ body: string }>; closingPullRequests: Array<Record<string, unknown>> }>;
    pull_requests: Array<unknown>;
    issues_raw: string;
    pull_requests_raw: string;
  }[]>`
    select issues, pull_requests, issues::text as issues_raw, pull_requests::text as pull_requests_raw
    from repository_reconciliation_evidence
    where repository_id = ${repositoryId}
  `;
  if (row === undefined) {
    throw new Error("The evidence cache row did not survive the unregistration.");
  }
  return { issues: row.issues, pullRequests: row.pull_requests, issuesRaw: row.issues_raw, pullRequestsRaw: row.pull_requests_raw };
}

async function insertReconciliationJob(repositoryId: string, state: "PENDING" | "RUNNING"): Promise<void> {
  if (state === "RUNNING") {
    // An expired lease leaves the job in the state the runner reclaims and
    // executes, which is the pending shape this test pins.
    await sql`
      insert into repository_reconciliation_jobs
        (repository_id, reason, state, lease_token, lease_duration_ms, lease_expires_at)
      values (${repositoryId}, ${"WEBHOOK"}, ${"RUNNING"}, gen_random_uuid(), 20000, now() - interval '1 minute')
    `;
    return;
  }
  await sql`
    insert into repository_reconciliation_jobs (repository_id, reason)
    values (${repositoryId}, ${"WEBHOOK"})
  `;
}

async function insertSettlement(
  repositoryId: string,
  pullRequestId: string,
  issueId: string,
): Promise<void> {
  const [creditor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${externalId++}, ${`scrub-creditor-${externalId}`})
    returning id
  `;
  const [debtor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${externalId++}, ${`scrub-debtor-${externalId}`})
    returning id
  `;
  // Migration 003 routes the settlement's issue link through pull_request_issues,
  // and migration 005 gives that link the repository id, so the settlement's
  // composite foreign key reads the link table, not the issue column on the
  // pull request.
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequestId}, ${issueId}, ${repositoryId})
  `;
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequestId}, ${issueId}, ${creditor!.id}, ${debtor!.id}, 5, 6, 1, 5,
      ${createHash("sha256").update(String(externalId)).digest("hex")}, ${"SETTLED"}
    )
  `;
}

async function issueBodies(repositoryId: string): Promise<Array<{ body: string | null }>> {
  return await sql<{ body: string | null }[]>`
    select body from issues where repository_id = ${repositoryId} order by issue_number
  `;
}

async function pullRequestBodies(repositoryId: string): Promise<Array<{ body: string | null }>> {
  return await sql<{ body: string | null }[]>`
    select body from pull_requests where repository_id = ${repositoryId} order by pull_request_number
  `;
}

async function rowCount(table: string, repositoryId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(table)} where repository_id = ${repositoryId}
  `;
  return row!.count;
}

function difficultyScheme() {
  return {
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}
