import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { getDashboard, listEligibleIssues } from "@/lib/dashboard/queries";

/**
 * Reservations are decided by the immutable GitHub account ids, not the mutable
 * logins: a sponsor who renames must stop being counted as reserving against
 * themselves, and an outsider who takes the sponsor's freed login must keep
 * reserving. `users.github_login` is display text that only refreshes on
 * sign-in, while GitHub reports the assignee's CURRENT login on every issue it
 * serves, so a login comparison answers the wrong question after a rename.
 * db/migrations/013_immutable_github_identity.sql is the same decision for
 * settlement credit.
 */
const SPONSOR_GITHUB_USER_ID = 101;
const SPONSOR_STORED_LOGIN = "sponsor-old";
const OUTSIDER_GITHUB_USER_ID = 202;

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("sponsor reservations against PostgreSQL", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "sponsor_reservation_identity_test",
      user: "sponsor_reservation_identity_test",
      password: "sponsor_reservation_identity_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    await seedReservationWorld();
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

  /**
   * One open five-reserve-point issue, claimed or not, observed through both
   * query paths against a zero settled balance.
   */
  async function reservedPointsFor(assignee: { id: number | null; login: string | null }): Promise<{
    dashboardReserved: number;
    eligibleHeadroom: number;
  }> {
    await sql`
      update issues
      set claim_assignee_github_login = ${assignee.login}, claim_assignee_github_user_id = ${assignee.id}
      where repository_id = ${seeded.repositoryId}
    `;
    const dashboard = await getDashboard(seeded.sponsorId);
    const eligible = await listEligibleIssues(seeded.viewerId, { claimState: "ALL" });
    expect(eligible).toHaveLength(1);
    expect(dashboard.settledBalance).toBe(0);
    // The rule under test: only a CLAIMED issue reserves, and a claimed issue
    // whose id is absent or is not the sponsor's account reserves in full.
    const claimed = assignee.login !== null;
    const reservedByIdentity = claimed && (assignee.id === null || assignee.id !== SPONSOR_GITHUB_USER_ID);
    const expected = reservedByIdentity ? 5 : 0;
    expect(dashboard.reservedPoints).toBe(expected);
    // The same reservation prices the eligible list's headroom: what a new claim can still spend.
    return {
      dashboardReserved: dashboard.reservedPoints,
      eligibleHeadroom: eligible[0]!.availableHeadroom!,
    };
  }

  it.each([
    { name: "an unclaimed issue reserves nothing", id: null, login: null, expected: 0 },
    { name: "the sponsor under their stored login reserves nothing", id: SPONSOR_GITHUB_USER_ID, login: SPONSOR_STORED_LOGIN, expected: 0 },
    { name: "the sponsor under a case-different login reserves nothing", id: SPONSOR_GITHUB_USER_ID, login: "SPONSOR-OLD", expected: 0 },
    { name: "an ordinary outsider reserves in full", id: OUTSIDER_GITHUB_USER_ID, login: "outsider", expected: 5 },
    { name: "the renamed sponsor under their new login reserves nothing", id: SPONSOR_GITHUB_USER_ID, login: "sponsor-new", expected: 0 },
    { name: "an outsider holding the sponsor's old login reserves in full", id: OUTSIDER_GITHUB_USER_ID, login: SPONSOR_STORED_LOGIN, expected: 5 },
    { name: "a legacy claimed issue with a null id still reserves in full", id: null, login: "sponsor-new", expected: 5 },
  ])("$name", async ({ id, login, expected }) => {
    const reservation = await reservedPointsFor({ id, login });

    expect(reservation.dashboardReserved).toBe(expected);
    // Both query paths price the same reservation, so headroom is its negation against a zero balance.
    expect(reservation.eligibleHeadroom).toBe(0 - expected);
  });

  it("keeps pricing by identity after only the stored sponsor login is refreshed", async () => {
    await sql`update users set github_login = ${"sponsor-new"} where id = ${seeded.sponsorId}`;
    try {
      const renamedSelf = await reservedPointsFor({ id: SPONSOR_GITHUB_USER_ID, login: "sponsor-new" });
      expect(renamedSelf.dashboardReserved).toBe(0);
      expect(renamedSelf.eligibleHeadroom).toBe(0);

      const outsiderOnOldLogin = await reservedPointsFor({ id: OUTSIDER_GITHUB_USER_ID, login: SPONSOR_STORED_LOGIN });
      expect(outsiderOnOldLogin.dashboardReserved).toBe(5);
      expect(outsiderOnOldLogin.eligibleHeadroom).toBe(-5);
    } finally {
      await sql`update users set github_login = ${SPONSOR_STORED_LOGIN} where id = ${seeded.sponsorId}`;
    }
  });

  it("rejects a nonpositive assignee id", async () => {
    await expect(sql`
      update issues set claim_assignee_github_user_id = 0 where repository_id = ${seeded.repositoryId}
    `).rejects.toThrow(/issues_claim_assignee_github_user_id_check/);
  });
});

const seeded = {
  sponsorId: "",
  viewerId: "",
  repositoryId: "",
};

async function seedReservationWorld(): Promise<void> {
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${SPONSOR_GITHUB_USER_ID}, ${SPONSOR_STORED_LOGIN})
    returning id
  `;
  const [viewer] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${nextExternalId()}, ${"viewer"})
    returning id
  `;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${"fixture/reserves"}, ${sponsor.id}, ${"PUBLIC"}, ${nextExternalId()},
      ${sql.json(difficultyScheme())}
    )
    returning id
  `;
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${nextExternalId()}, ${repository.id}, 1, ${"Five-point open issue"}, ${""},
      ${"https://github.com/fixture/reserves/issues/1"}, ${"OPEN"}, ${"M"}, 5, 5
    )
  `;
  seeded.sponsorId = sponsor.id;
  seeded.viewerId = viewer.id;
  seeded.repositoryId = repository.id;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

let externalId = 70_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}
