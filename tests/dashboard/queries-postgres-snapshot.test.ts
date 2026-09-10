import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { getDashboard, type DashboardSql } from "@/lib/dashboard/queries";

let container: StartedTestContainer | undefined;
let sql: Sql;
/** A second, independent session: the commit that lands mid-projection. */
let otherSession: Sql;
let externalId = 63_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

const seeded = {
  memberId: "",
  creditorId: "",
  settlementId: "",
};

/** The member's authoritative balance with the settlement present: 6 credits owed reads -6. */
const BALANCE_WITH_SETTLEMENT = -6;
const SETTLEMENT_CREDITS = 6;

type SavedSettlement = {
  id: string;
  pull_request_id: string;
  issue_id: string;
  creditor_id: string | null;
  creditor_github_login: string | null;
  debtor_id: string;
  opening_comparison_points: number;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  proof_sha256: string;
  status: string;
  created_at: Date;
};

describe("the dashboard projection reads one database snapshot", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "dashboard_snapshot_test",
      user: "dashboard_snapshot_test",
      password: "dashboard_snapshot_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    otherSession = postgres(started.databaseUrl, { max: 1 });
    await runMigrations();
    await seedSettlementWorld();
  });

  afterAll(async () => {
    await closeSql();
    await otherSession?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("keeps settledBalance and recentSettlements on one side of a commit landing mid-projection", async () => {
    // Issue 443's deterministic interleaving: the settlement is deleted before
    // the projection starts, and a second session commits its restoration after
    // the projection's first read. Autocommit reads tear here — the balance
    // query answers from before the commit and the settlement query from after
    // it — while one snapshot makes the whole projection agree.
    const [saved] = await sql<SavedSettlement[]>`
      select id, pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256,
        status::text as status, created_at
      from settlements
      where id = ${seeded.settlementId}
    `;
    await sql`delete from settlements where id = ${seeded.settlementId}`;
    try {
      let queryCount = 0;
      // The tagged-template target the wrapper delegates to. It starts as the
      // pool client — what an unfixed projection reads through — and inside a
      // transaction the wrapper's begin rebinds it to the transaction's sql.
      let target = sql as unknown as DashboardSql;
      const countingSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queryCount += 1;
        const result = await target(strings, ...values);
        if (queryCount === 1) {
          await otherSession`
            insert into settlements (
              id, pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
              opening_comparison_points, settled_points, review_rounds, credits, proof_sha256,
              status, created_at
            )
            values (
              ${saved.id}, ${saved.pull_request_id}, ${saved.issue_id}, ${saved.creditor_id},
              ${saved.creditor_github_login}, ${saved.debtor_id}, ${saved.opening_comparison_points},
              ${saved.settled_points}, ${saved.review_rounds}, ${saved.credits}, ${saved.proof_sha256},
              ${saved.status}, ${saved.created_at}
            )
          `;
        }
        return result;
      }) as DashboardSql;
      // The real client's begin, rebound so the reads inside the transaction go
      // through this wrapper — the production default scope path, observable.
      (countingSql as DashboardSql & {
        begin: (options: string, run: (sql: DashboardSql) => Promise<unknown>) => Promise<unknown>;
      }).begin = (options, run) =>
        (sql as unknown as {
          begin: (
            options: string,
            run: (txSql: Sql) => Promise<unknown>,
          ) => Promise<unknown>;
        }).begin(options, (txSql) => {
          target = txSql as unknown as DashboardSql;
          return run(countingSql);
        });

      const dashboard = await getDashboard(seeded.memberId, { sql: countingSql });

      // Every read of the projection went through the wrapper, so the second
      // session's commit really did land between the first and the second.
      expect(queryCount).toBe(6);

      // Single-instant consistency: both figures describe the settlement, or
      // neither does. The torn answer — a balance from before the commit beside
      // a settlement history from after it — is issue 443's defect.
      const balanceIncludesSettlement = dashboard.settledBalance === BALANCE_WITH_SETTLEMENT;
      const historyIncludesSettlement = dashboard.recentSettlements.some(
        (settlement) => settlement.credits === SETTLEMENT_CREDITS,
      );
      expect(balanceIncludesSettlement).toBe(historyIncludesSettlement);
      if (historyIncludesSettlement) {
        expect(dashboard.settledBalance).toBe(BALANCE_WITH_SETTLEMENT);
        expect(dashboard.recentSettlements.map((settlement) => settlement.credits)).toEqual([
          SETTLEMENT_CREDITS,
        ]);
      } else {
        expect(dashboard.settledBalance).toBe(0);
        expect(dashboard.recentSettlements).toEqual([]);
      }
    } finally {
      // Whatever the projection answered, leave the seeded world as it was.
      await restoreDeletedSettlement(sql, saved);
    }
  });
});

/** Reinserts the settlement if a projection left it deleted, so the suite stays idempotent. */
async function restoreDeletedSettlement(client: Sql, saved: SavedSettlement): Promise<void> {
  const [row] = await client<{ total: string }[]>`
    select count(*) as total from settlements where id = ${saved.id}
  `;
  if (Number(row.total) === 0) {
    await insertSavedSettlement(client, saved);
  }
}

async function insertSavedSettlement(client: Sql, saved: SavedSettlement): Promise<void> {
  await client`
    insert into settlements (
      id, pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256,
      status, created_at
    )
    values (
      ${saved.id}, ${saved.pull_request_id}, ${saved.issue_id}, ${saved.creditor_id},
      ${saved.creditor_github_login}, ${saved.debtor_id}, ${saved.opening_comparison_points},
      ${saved.settled_points}, ${saved.review_rounds}, ${saved.credits}, ${saved.proof_sha256},
      ${saved.status}, ${saved.created_at}
    )
  `;
}

/**
 * One settled settlement owed by the member: the `balances` view derives the
 * authoritative -6 from it, so the settlement row is the only thing both sides
 * of the interleaving read.
 */
async function seedSettlementWorld(): Promise<void> {
  seeded.memberId = await insertUser("member");
  seeded.creditorId = await insertUser("creditor");
  const repositoryId = await insertRepository({
    ownerName: "example/snapshot",
    sponsorId: seeded.creditorId,
    active: true,
  });
  const { issueId, pullRequestId } = await insertMergedWork({
    repositoryId,
    authorId: seeded.memberId,
  });
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
    )
    values (
      ${pullRequestId}, ${issueId}, ${seeded.creditorId}, ${seeded.memberId},
      4, 7, 1, ${SETTLEMENT_CREDITS}, ${proofFor(nextExternalId())}, ${"SETTLED"}, ${"2026-09-01T00:00:00.000Z"}
    )
    returning id
  `;
  seeded.settlementId = settlement.id;

  const [balance] = await sql<{ balance: number }[]>`
    select balance from balances where account_id = ${seeded.memberId}
  `;
  if (balance?.balance !== BALANCE_WITH_SETTLEMENT) {
    throw new Error(`Fixture invariant broken: expected balance ${BALANCE_WITH_SETTLEMENT}, got ${balance?.balance}`);
  }
}

async function insertUser(githubLogin: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${nextExternalId()}, ${githubLogin})
    returning id
  `;
  return user.id;
}

async function insertRepository(input: {
  ownerName: string;
  sponsorId: string;
  active: boolean;
}): Promise<string> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, active, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${input.ownerName}, ${input.sponsorId}, ${"PUBLIC"}, ${nextExternalId()},
      ${input.active}, ${sql.json(difficultyScheme())}
    )
    returning id
  `;
  return repository.id;
}

async function insertMergedWork(input: {
  repositoryId: string;
  authorId: string;
}): Promise<{ issueId: string; pullRequestId: string }> {
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"A settled calibration issue"},
      ${"Issue evidence"}, ${`https://github.com/example/snapshot/issues/${githubIssueId}`}, ${"CLOSED"},
      ${"size/M"}, 4, 4
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/snapshot/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${input.authorId}, ${"MERGED"}, now(),
      ${proofFor(githubPullRequestId)}
    )
    returning id
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
  `;
  return { issueId: issue.id, pullRequestId: pullRequest.id };
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function proofFor(identifier: number): string {
  return identifier.toString(16).padStart(64, "0");
}

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}
