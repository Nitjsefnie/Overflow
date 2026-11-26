import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresTeamStore } from "@/lib/teams/store";
import { startPostgresContainer } from "../support/postgres-container";
import { balancesOf, insertAccount, insertSettlement, type FixtureAccount } from "../support/team-fixtures";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresTeamStore;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
let teamNumber = 0;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "team_store", user: "team_store" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  store = new PostgresTeamStore(sql);
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

/** A team led by `lead`, its members added by login. */
async function team(lead: FixtureAccount, ...members: FixtureAccount[]): Promise<string> {
  const created = await store.createTeam(lead.id, `store team ${++teamNumber}`);
  if (created.kind !== "ok") throw new Error(`fixture team refused: ${created.kind}`);
  for (const member of members) expect(await store.addTeamMember(lead.id, member.login)).toMatchObject({ kind: "ok" });
  return created.value.id;
}

/** A team holding `credits` from one settlement its lead authored. */
async function fundedTeam(credits: number, ...members: FixtureAccount[]) {
  const [lead, sponsor] = [await insertAccount(sql), await insertAccount(sql)];
  const teamId = await team(lead, ...members);
  await insertSettlement(sql, { author: lead, debtor: sponsor, credits, teamId });
  return { lead, teamId };
}

async function membershipRows(userId: string) {
  return sql<{ team_id: string; left: boolean }[]>`
    select team_id, left_at is not null as left from team_memberships where user_id = ${userId} order by joined_at, left_at nulls last
  `;
}

describe("creating a team", () => {
  it("makes the creator its lead and first member, with an empty balance and no distributions", async () => {
    const lead = await insertAccount(sql);
    const created = await store.createTeam(lead.id, "  The Tide  ");
    expect(created).toMatchObject({ kind: "ok", value: { name: "The Tide", leadId: lead.id } });
    if (created.kind !== "ok") return;
    expect(await store.getTeamForAccount(lead.id)).toEqual({
      ...created.value,
      members: [{ userId: lead.id, githubLogin: lead.login, joinedAt: expect.any(String) }],
      balance: 0,
      distributions: [],
    });
  });

  it("refuses a blank name, a name taken in any case, and an unknown or deleted lead", async () => {
    const [first, second, deleted] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    expect(await store.createTeam(first.id, "")).toEqual({ kind: "invalid_name" });
    expect(await store.createTeam(first.id, " \t\n ")).toEqual({ kind: "invalid_name" });
    expect(await store.createTeam(first.id, "Breakwater")).toMatchObject({ kind: "ok" });
    expect(await store.createTeam(second.id, " BREAKWATER ")).toEqual({ kind: "name_taken" });
    expect(await store.getTeamForAccount(second.id)).toBeNull();
    await sql`update users set deleted_at = now(), github_login = '(deleted account)' where id = ${deleted.id}`;
    expect(await store.createTeam(deleted.id, "Ghosts")).toEqual({ kind: "not_found" });
    expect(await store.createTeam("00000000-0000-4000-8000-000000000000", "Nobody")).toEqual({ kind: "not_found" });
  });

  it("refuses an account already in a team, lead or member", async () => {
    const [lead, member] = [await insertAccount(sql), await insertAccount(sql)];
    await team(lead, member);
    expect(await store.createTeam(lead.id, "Second team")).toEqual({ kind: "already_in_team" });
    expect(await store.createTeam(member.id, "Breakaway")).toEqual({ kind: "already_in_team" });
  });
});

describe("changing a team's membership", () => {
  it("adds by login in any case, removes, and re-adds as a new history row", async () => {
    const [lead, member] = [await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead);
    expect(await store.addTeamMember(lead.id, ` ${member.login.toUpperCase()} `)).toEqual({ kind: "ok", value: { userId: member.id } });
    expect((await store.getTeamForAccount(member.id))?.members.map((row) => row.userId)).toEqual([lead.id, member.id]);

    expect(await store.removeTeamMember(lead.id, member.id)).toEqual({ kind: "ok", value: { userId: member.id } });
    expect(await store.getTeamForAccount(member.id)).toBeNull();
    expect((await store.getTeamForAccount(lead.id))?.members.map((row) => row.userId)).toEqual([lead.id]);

    expect(await store.addTeamMember(lead.id, member.login)).toMatchObject({ kind: "ok" });
    expect([...await membershipRows(member.id)]).toEqual([{ team_id: teamId, left: true }, { team_id: teamId, left: false }]);
  });

  it("refuses a non-lead, an unknown or deleted login, and an account already in any team", async () => {
    const [lead, member, outsider, otherLead, deleted] = [
      await insertAccount(sql), await insertAccount(sql), await insertAccount(sql), await insertAccount(sql), await insertAccount(sql),
    ];
    await team(lead, member);
    await team(otherLead);
    expect(await store.addTeamMember(member.id, outsider.login)).toEqual({ kind: "not_lead" });
    expect(await store.addTeamMember(outsider.id, outsider.login)).toEqual({ kind: "not_lead" });
    expect(await store.addTeamMember(lead.id, "no-such-login")).toEqual({ kind: "not_found" });
    // Deleted but still carrying its login, the one state where only deleted_at tells it apart.
    await sql`update users set deleted_at = now() where id = ${deleted.id}`;
    expect(await store.addTeamMember(lead.id, deleted.login)).toEqual({ kind: "not_found" });
    expect(await store.addTeamMember(lead.id, member.login)).toEqual({ kind: "already_in_team" });
    expect(await store.addTeamMember(lead.id, otherLead.login)).toEqual({ kind: "already_in_team" });
    expect(await store.addTeamMember(otherLead.id, member.login)).toEqual({ kind: "already_in_team" });
  });

  it("refuses the second of two concurrent adds of one account to two teams", async () => {
    const [firstLead, secondLead, target] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const [firstTeam] = [await team(firstLead), await team(secondLead)];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // An uncommitted membership the second add cannot see, so only the open-membership index stops it.
    const holder = sql.begin(async (tx) => {
      await tx`insert into team_memberships (team_id, user_id) values (${firstTeam}, ${target.id})`;
      await held;
    });
    const second = store.addTeamMember(secondLead.id, target.login);
    for (;;) {
      const [blocked] = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%insert into team_memberships%'
      `;
      if (blocked.count > 0) break;
    }
    release();
    await holder;
    expect(await second).toEqual({ kind: "already_in_team" });
    expect([...await membershipRows(target.id)]).toEqual([{ team_id: firstTeam, left: false }]);
  });

  it("refuses a removal by a non-lead, of the lead, and of a non-member", async () => {
    const [lead, member, outsider] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    await team(lead, member);
    expect(await store.removeTeamMember(member.id, member.id)).toEqual({ kind: "not_lead" });
    expect(await store.removeTeamMember(lead.id, lead.id)).toEqual({ kind: "lead_cannot_leave" });
    expect(await store.removeTeamMember(lead.id, outsider.id)).toEqual({ kind: "not_member" });
    expect(await store.removeTeamMember(lead.id, member.id)).toMatchObject({ kind: "ok" });
    expect(await store.removeTeamMember(lead.id, member.id)).toEqual({ kind: "not_member" });
  });
});

describe("membership and distribution history", () => {
  it("refuses deleting a membership or changing anything but a still-open left_at", async () => {
    const [lead, member, other] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead, member);
    const otherTeamId = await team(other);
    const refusal = { message: "Team membership history is immutable" };
    await expect(sql`update team_memberships set team_id = ${otherTeamId} where user_id = ${member.id}`).rejects.toMatchObject(refusal);
    await expect(sql`update team_memberships set id = gen_random_uuid() where user_id = ${member.id}`).rejects.toMatchObject(refusal);
    await expect(sql`delete from team_memberships where user_id = ${member.id}`).rejects.toMatchObject(refusal);
    await expect(sql`update team_memberships set joined_at = joined_at - interval '1 day' where user_id = ${member.id}`)
      .rejects.toMatchObject(refusal);
    await expect(sql`update team_memberships set user_id = ${other.id} where user_id = ${member.id}`).rejects.toMatchObject(refusal);
    await expect(sql`update team_memberships set left_at = now(), team_id = ${teamId}, joined_at = joined_at + interval '1 second'
      where user_id = ${member.id}`).rejects.toMatchObject(refusal);
    await sql`update team_memberships set left_at = now() where user_id = ${member.id}`;
    await expect(sql`update team_memberships set left_at = now() + interval '1 day' where user_id = ${member.id}`)
      .rejects.toMatchObject(refusal);
    await expect(sql`update team_memberships set left_at = null where user_id = ${member.id}`).rejects.toMatchObject(refusal);
  });

  it("refuses changing or deleting a distribution", async () => {
    const member = await insertAccount(sql);
    const { lead } = await fundedTeam(5, member);
    expect(await store.distributeTeamPoints(lead.id, member.id, 2)).toMatchObject({ kind: "ok" });
    const refusal = { message: "Team distribution history is immutable" };
    await expect(sql`update team_distributions set points = 1 where member_id = ${member.id}`).rejects.toMatchObject(refusal);
    await expect(sql`delete from team_distributions where member_id = ${member.id}`).rejects.toMatchObject(refusal);
  });
});

describe("distributing a team's points", () => {
  it("lets the lead pay any current member, the lead included, and lists distributions newest first", async () => {
    const member = await insertAccount(sql);
    const { lead, teamId } = await fundedTeam(5, member);
    const first = await store.distributeTeamPoints(lead.id, member.id, 2);
    const second = await store.distributeTeamPoints(lead.id, lead.id, 1);
    expect(first).toMatchObject({ kind: "ok", value: { teamId, memberId: member.id, points: 2 } });
    expect(second).toMatchObject({ kind: "ok", value: { teamId, memberId: lead.id, points: 1 } });
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(await store.getTeamForAccount(member.id)).toMatchObject({
      balance: 2,
      distributions: [
        { ...second.value, memberLogin: lead.login },
        { ...first.value, memberLogin: member.login },
      ],
    });
    expect(await balancesOf(sql, teamId, member.id, lead.id)).toEqual([2, 2, 1]);
  });

  it("refuses a distribution that would take the balance below zero, at the boundary", async () => {
    const member = await insertAccount(sql);
    const { lead, teamId } = await fundedTeam(5, member);
    expect(await store.distributeTeamPoints(lead.id, member.id, 6)).toEqual({ kind: "insufficient_balance" });
    expect(await store.distributeTeamPoints(lead.id, member.id, 5)).toMatchObject({ kind: "ok" });
    expect(await store.distributeTeamPoints(lead.id, member.id, 1)).toEqual({ kind: "insufficient_balance" });
    expect(await balancesOf(sql, teamId, member.id)).toEqual([0, 5]);
  });

  it("refuses a distribution that a concurrent one, committed while it waited, left unaffordable", async () => {
    const member = await insertAccount(sql);
    const { lead, teamId } = await fundedTeam(5, member);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    // A second distributor in the store's own shape: team row locked, 3 points out, not yet committed.
    const holder = sql.begin(async (tx) => {
      await tx`select id from teams where id = ${teamId} for no key update`;
      await tx`insert into team_distributions (team_id, member_id, points) values (${teamId}, ${lead.id}, 3)`;
      locked();
      await held;
    });
    await holding;
    let settled = false;
    const pending = store.distributeTeamPoints(lead.id, member.id, 3).finally(() => { settled = true; });
    // An unlocked store never waits, so settling ends the wait as well as blocking does.
    for (;;) {
      const [blocked] = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()
      `;
      if (blocked.count > 0 || settled) break;
    }
    release();
    await holder;
    expect(await pending).toEqual({ kind: "insufficient_balance" });
    expect(await balancesOf(sql, teamId)).toEqual([2]);
  });

  it("refuses zero, negative and fractional points", async () => {
    const member = await insertAccount(sql);
    const { lead } = await fundedTeam(5, member);
    for (const points of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await store.distributeTeamPoints(lead.id, member.id, points)).toEqual({ kind: "invalid_points" });
    }
    await expect(sql`insert into team_distributions (team_id, member_id, points)
      select team_id, user_id, 0 from team_memberships where user_id = ${member.id}`)
      .rejects.toMatchObject({ constraint_name: "team_distributions_points_positive_check" });
  });

  it("refuses a non-lead, a non-member and a removed member", async () => {
    const [member, outsider] = [await insertAccount(sql), await insertAccount(sql)];
    const { lead } = await fundedTeam(5, member);
    expect(await store.distributeTeamPoints(member.id, member.id, 1)).toEqual({ kind: "not_lead" });
    expect(await store.distributeTeamPoints(outsider.id, member.id, 1)).toEqual({ kind: "not_lead" });
    expect(await store.distributeTeamPoints(lead.id, outsider.id, 1)).toEqual({ kind: "not_member" });
    await store.removeTeamMember(lead.id, member.id);
    expect(await store.distributeTeamPoints(lead.id, member.id, 1)).toEqual({ kind: "not_member" });
    expect(await balancesOf(sql, member.id, outsider.id)).toEqual([0, 0]);
  });
});
