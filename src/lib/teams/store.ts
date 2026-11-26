import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";

export type Team = { id: string; name: string; leadId: string; createdAt: string };
export type TeamMember = { userId: string; githubLogin: string; joinedAt: string };
export type TeamDistribution = { id: string; teamId: string; memberId: string; points: number; createdAt: string };

/** A team as its members read it: its current members, its balance and its distributions, newest first. */
export type TeamView = Team & {
  members: TeamMember[];
  balance: number;
  distributions: (TeamDistribution & { memberLogin: string })[];
};

export type TeamRefusal =
  | { kind: "invalid_name" }
  | { kind: "name_taken" }
  | { kind: "already_in_team" }
  | { kind: "not_found" }
  | { kind: "not_lead" }
  | { kind: "not_member" }
  | { kind: "lead_cannot_leave" }
  | { kind: "invalid_points" }
  | { kind: "insufficient_balance" };

export type TeamStoreResult<T> = { kind: "ok"; value: T } | TeamRefusal;

type TeamRow = { id: string; name: string; lead_id: string; created_at: Date };

/**
 * Reads and writes teams, their membership history and their lead's distributions.
 *
 * Every authorization is a database read inside the writing transaction: the
 * team row, found by its lead, is locked `for no key update`, so a lead's
 * membership changes and distributions serialize and a distribution's balance
 * check cannot be raced by another distribution, while the foreign-key checks
 * of rows naming the team (settlements, memberships) do not wait on it. One-team-per-account is the open
 * membership partial unique index's (migration 097): two adds of one account
 * to two teams both pass their reads, and the index refuses the second. Its
 * violation, like a taken name's, is mapped OUTSIDE sql.begin, because
 * postgres.js re-throws a query error raised inside a transaction after the
 * rollback even when the callback caught it (the sanction contest store maps
 * its index the same way).
 */
export class PostgresTeamStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async createTeam(leadId: string, name: string): Promise<TeamStoreResult<Team>> {
    const trimmed = name.trim();
    if (trimmed === "") return { kind: "invalid_name" };
    return this.mapUniqueViolation(this.sql.begin(async (tx): Promise<TeamStoreResult<Team>> => {
      const [lead] = await tx<{ id: string }[]>`
        select id from users where id = ${leadId} and deleted_at is null for update
      `;
      if (lead === undefined) return { kind: "not_found" };
      if (await hasOpenMembership(tx, leadId)) return { kind: "already_in_team" };
      const [row] = await tx<TeamRow[]>`
        insert into teams (lead_id, name) values (${leadId}, ${trimmed}) returning id, name, lead_id, created_at
      `;
      await tx`insert into team_memberships (team_id, user_id, joined_at) values (${row!.id}, ${leadId}, ${row!.created_at})`;
      return { kind: "ok", value: toTeam(row!) };
    }));
  }

  /** Adds the live account whose login matches, case-insensitively, exactly one live account. */
  public async addTeamMember(leadId: string, githubLogin: string): Promise<TeamStoreResult<{ userId: string }>> {
    return this.mapUniqueViolation(this.sql.begin(async (tx): Promise<TeamStoreResult<{ userId: string }>> => {
      const team = await lockLeadTeam(tx, leadId);
      if (team === undefined) return { kind: "not_lead" };
      // Login uniqueness was dropped (migration 013), so a stale second row is
      // possible: anything but one live match is refused rather than guessed.
      const accounts = await tx<{ id: string }[]>`
        select id from users where lower(github_login) = lower(${githubLogin.trim()}) and deleted_at is null limit 2
      `;
      if (accounts.length !== 1) return { kind: "not_found" };
      const userId = accounts[0]!.id;
      if (await hasOpenMembership(tx, userId)) return { kind: "already_in_team" };
      await tx`insert into team_memberships (team_id, user_id) values (${team.id}, ${userId})`;
      return { kind: "ok", value: { userId } };
    }));
  }

  public async removeTeamMember(leadId: string, memberId: string): Promise<TeamStoreResult<{ userId: string }>> {
    return this.sql.begin(async (tx): Promise<TeamStoreResult<{ userId: string }>> => {
      const team = await lockLeadTeam(tx, leadId);
      if (team === undefined) return { kind: "not_lead" };
      if (memberId === leadId) return { kind: "lead_cannot_leave" };
      const removed = await tx`
        update team_memberships set left_at = now()
        where team_id = ${team.id} and user_id = ${memberId} and left_at is null
        returning id
      `;
      return removed.length === 0 ? { kind: "not_member" } : { kind: "ok", value: { userId: memberId } };
    });
  }

  public async distributeTeamPoints(leadId: string, memberId: string, points: number): Promise<TeamStoreResult<TeamDistribution>> {
    if (!Number.isSafeInteger(points) || points < 1) return { kind: "invalid_points" };
    return this.sql.begin(async (tx): Promise<TeamStoreResult<TeamDistribution>> => {
      const team = await lockLeadTeam(tx, leadId);
      if (team === undefined) return { kind: "not_lead" };
      const [member] = await tx`
        select 1 from team_memberships where team_id = ${team.id} and user_id = ${memberId} and left_at is null
      `;
      if (member === undefined) return { kind: "not_member" };
      if ((await teamBalance(tx, team.id)) - points < 0) return { kind: "insufficient_balance" };
      const [row] = await tx<{ id: string; team_id: string; member_id: string; points: number; created_at: Date }[]>`
        insert into team_distributions (team_id, member_id, points) values (${team.id}, ${memberId}, ${points})
        returning id, team_id, member_id, points, created_at
      `;
      return {
        kind: "ok",
        value: { id: row!.id, teamId: row!.team_id, memberId: row!.member_id, points: row!.points, createdAt: row!.created_at.toISOString() },
      };
    });
  }

  /** The team the account is a current member of, or null. */
  public async getTeamForAccount(userId: string): Promise<TeamView | null> {
    return this.sql.begin("isolation level repeatable read read only", async (tx): Promise<TeamView | null> => {
      const [row] = await tx<TeamRow[]>`
        select teams.id, teams.name, teams.lead_id, teams.created_at
        from team_memberships join teams on teams.id = team_memberships.team_id
        where team_memberships.user_id = ${userId} and team_memberships.left_at is null
      `;
      if (row === undefined) return null;
      const members = await tx<{ user_id: string; github_login: string; joined_at: Date }[]>`
        select team_memberships.user_id, users.github_login, team_memberships.joined_at
        from team_memberships join users on users.id = team_memberships.user_id
        where team_memberships.team_id = ${row.id} and team_memberships.left_at is null
        order by team_memberships.joined_at, team_memberships.user_id
      `;
      const distributions = await tx<{ id: string; member_id: string; github_login: string; points: number; created_at: Date }[]>`
        select team_distributions.id, team_distributions.member_id, users.github_login, team_distributions.points,
          team_distributions.created_at
        from team_distributions join users on users.id = team_distributions.member_id
        where team_distributions.team_id = ${row.id}
        order by team_distributions.created_at desc, team_distributions.id desc
      `;
      return {
        ...toTeam(row),
        members: members.map((member) => ({
          userId: member.user_id, githubLogin: member.github_login, joinedAt: member.joined_at.toISOString(),
        })),
        balance: await teamBalance(tx, row.id),
        distributions: distributions.map((distribution) => ({
          id: distribution.id, teamId: row.id, memberId: distribution.member_id, memberLogin: distribution.github_login,
          points: distribution.points, createdAt: distribution.created_at.toISOString(),
        })),
      };
    });
  }

  private async mapUniqueViolation<T>(write: Promise<TeamStoreResult<T>>): Promise<TeamStoreResult<T>> {
    return write.catch((error: unknown) => {
      const constraint = typeof error === "object" && error !== null && "code" in error && error.code === "23505" &&
        "constraint_name" in error ? error.constraint_name : undefined;
      if (constraint === "teams_name_key") return { kind: "name_taken" };
      if (constraint === "teams_lead_id_key" || constraint === "team_memberships_one_open_per_account") {
        return { kind: "already_in_team" };
      }
      throw error;
    }) as Promise<TeamStoreResult<T>>;
  }
}

function toTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name, leadId: row.lead_id, createdAt: row.created_at.toISOString() };
}

async function lockLeadTeam(tx: TransactionClient, leadId: string): Promise<{ id: string } | undefined> {
  const [team] = await tx<{ id: string }[]>`select id from teams where lead_id = ${leadId} for no key update`;
  return team;
}

async function hasOpenMembership(tx: TransactionClient, userId: string): Promise<boolean> {
  const rows = await tx`select 1 from team_memberships where user_id = ${userId} and left_at is null`;
  return rows.length > 0;
}

async function teamBalance(tx: TransactionClient, teamId: string): Promise<number> {
  const [row] = await tx<{ balance: number }[]>`select coalesce(sum(amount), 0)::integer as balance from ledger_entries where account_id = ${teamId}`;
  return row!.balance;
}
