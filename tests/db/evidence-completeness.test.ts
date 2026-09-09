import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 5_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

const whitespaceSpellings = ["\t", "\n"] as const;

describe("issue evidence completeness constraints", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "evidence_test",
      user: "evidence_test",
      password: "evidence_test",
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

  // The whitespace spellings the superseded constraints stripped past: the
  // one-argument trim() removes spaces and nothing else, so a tab or a newline
  // satisfied `length(trim(col)) > 0` while carrying no content.
  it.each(whitespaceSpellings)("refuses whitespace-only opening evidence on INSERT (%s)", async (whitespace) => {
    for (const column of ["owner_github_login", "opening_source_event_id", "opening_source_actor_login"] as const) {
      await expect(insertIssueWithOpeningEvidence({
        ownerLogin: column === "owner_github_login" ? whitespace : "sponsor-login",
        openingSourceEventId: column === "opening_source_event_id" ? whitespace : "opening-event-1",
        openingSourceActorLogin: column === "opening_source_actor_login" ? whitespace : "sponsor-login",
        openingSourceAt: "2026-09-01T09:00:00.000Z",
      })).rejects.toThrow(/issues_opening_source_complete_check/);
    }
  });

  it.each(whitespaceSpellings)("refuses whitespace-only opening evidence on UPDATE (%s)", async (whitespace) => {
    const issue = await insertIssue(sql);
    for (const column of ["owner_github_login", "opening_source_event_id", "opening_source_actor_login"] as const) {
      await expect(sql`
        update issues
        set owner_github_login = ${column === "owner_github_login" ? whitespace : "sponsor-login"},
            opening_source_event_id = ${column === "opening_source_event_id" ? whitespace : "opening-event-1"},
            opening_source_actor_login = ${column === "opening_source_actor_login" ? whitespace : "sponsor-login"},
            opening_source_at = ${"2026-09-01T09:00:00.000Z"}
        where id = ${issue.id}
      `).rejects.toThrow(/issues_opening_source_complete_check/);
    }
  });

  it.each(whitespaceSpellings)("refuses whitespace-only settled evidence on INSERT (%s)", async (whitespace) => {
    for (const column of [
      "settled_label",
      "settled_label_event_id",
      "settled_label_actor_login",
      "settled_rationale_comment_id",
      "settled_rationale_actor_login",
    ] as const) {
      const evidence = completeSettledEvidence();
      await expect(insertIssueWithSettledEvidence({
        settledLabel: column === "settled_label" ? whitespace : evidence.settledLabel,
        settledPoints: evidence.settledPoints,
        settledLabelEventId: column === "settled_label_event_id" ? whitespace : evidence.settledLabelEventId,
        settledLabelActorLogin: column === "settled_label_actor_login" ? whitespace : evidence.settledLabelActorLogin,
        settledLabelAppliedAt: evidence.settledLabelAppliedAt,
        settledRationaleCommentId: column === "settled_rationale_comment_id" ? whitespace : evidence.settledRationaleCommentId,
        settledRationaleActorLogin: column === "settled_rationale_actor_login" ? whitespace : evidence.settledRationaleActorLogin,
        settledRationaleCommentedAt: evidence.settledRationaleCommentedAt,
      })).rejects.toThrow(/issues_settled_evidence_complete_check/);
    }
  });

  it.each(whitespaceSpellings)("refuses whitespace-only settled evidence on UPDATE (%s)", async (whitespace) => {
    const issue = await insertIssue(sql);
    for (const column of [
      "settled_label",
      "settled_label_event_id",
      "settled_label_actor_login",
      "settled_rationale_comment_id",
      "settled_rationale_actor_login",
    ] as const) {
      await expect(sql`
        update issues
        set settled_label = ${column === "settled_label" ? whitespace : "delivered/6"},
            settled_points = 6,
            settled_label_event_id = ${column === "settled_label_event_id" ? whitespace : "settled-event-1"},
            settled_label_actor_login = ${column === "settled_label_actor_login" ? whitespace : "issue-owner"},
            settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
            settled_rationale_comment_id = ${column === "settled_rationale_comment_id" ? whitespace : "comment-1"},
            settled_rationale_actor_login = ${column === "settled_rationale_actor_login" ? whitespace : "issue-owner"},
            settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
        where id = ${issue.id}
      `).rejects.toThrow(/issues_settled_evidence_complete_check/);
    }
  });

  it("refuses opening evidence standing without its mandatory text on INSERT", async () => {
    // A SQL CHECK passes on NULL, so under the superseded constraints a row
    // whose evidence timestamp stood beside null mandatory text left the
    // completeness arm NULL rather than false, and NULL passes a CHECK.
    await expect(insertIssueWithOpeningEvidence({
      ownerLogin: null,
      openingSourceEventId: null,
      openingSourceActorLogin: null,
      openingSourceAt: "2026-09-01T09:00:00.000Z",
    })).rejects.toThrow(/issues_opening_source_complete_check/);
    await expect(insertIssueWithOpeningEvidence({
      ownerLogin: null,
      openingSourceEventId: "opening-event-1",
      openingSourceActorLogin: null,
      openingSourceAt: "2026-09-01T09:00:00.000Z",
    })).rejects.toThrow(/issues_opening_source_complete_check/);
  });

  it("refuses opening evidence standing without its mandatory text on UPDATE", async () => {
    const issue = await insertIssue(sql);
    await expect(sql`
      update issues set opening_source_at = ${"2026-09-01T09:00:00.000Z"} where id = ${issue.id}
    `).rejects.toThrow(/issues_opening_source_complete_check/);
  });

  it("refuses settled evidence standing without its mandatory text on INSERT", async () => {
    await expect(insertIssueWithSettledEvidence({
      ...completeSettledEvidence(),
      settledLabel: null,
      settledLabelEventId: null,
      settledLabelActorLogin: null,
      settledRationaleCommentId: null,
      settledRationaleActorLogin: null,
    })).rejects.toThrow(/issues_settled_evidence_complete_check/);
  });

  it("refuses settled evidence standing without its mandatory text on UPDATE", async () => {
    const issue = await insertIssue(sql);
    await expect(sql`
      update issues
      set settled_label = null,
          settled_points = 6,
          settled_label_event_id = null,
          settled_label_actor_login = null,
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = null,
          settled_rationale_actor_login = null,
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${issue.id}
    `).rejects.toThrow(/issues_settled_evidence_complete_check/);
  });

  it("allows an issue whose evidence columns are all absent", async () => {
    const issue = await insertIssue(sql);
    await expect(sql`
      select owner_github_login, opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at
      from issues where id = ${issue.id}
    `).resolves.toEqual([{
      owner_github_login: null,
      opening_source_event_id: null,
      opening_source_actor_login: null,
      opening_source_at: null,
      settled_label: null,
      settled_points: null,
      settled_label_event_id: null,
      settled_label_actor_login: null,
      settled_label_applied_at: null,
      settled_rationale_comment_id: null,
      settled_rationale_actor_login: null,
      settled_rationale_commented_at: null,
    }]);
  });

  it("allows a fully complete opening and settled evidence record", async () => {
    const issue = await insertIssue(sql);
    await sql`
      update issues
      set owner_github_login = ${"sponsor-login"},
          opening_source_event_id = ${"opening-event-1"},
          opening_source_actor_login = ${"sponsor-login"},
          opening_source_at = ${"2026-09-01T09:00:00.000Z"},
          settled_label = ${"delivered/6"},
          settled_points = 6,
          settled_label_event_id = ${"settled-event-1"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-1"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${issue.id}
    `;
    await expect(sql`
      select owner_github_login, opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_rationale_comment_id
      from issues where id = ${issue.id}
    `).resolves.toEqual([{
      owner_github_login: "sponsor-login",
      opening_source_event_id: "opening-event-1",
      opening_source_actor_login: "sponsor-login",
      opening_source_at: new Date("2026-09-01T09:00:00.000Z"),
      settled_label: "delivered/6",
      settled_points: 6,
      settled_rationale_comment_id: "comment-1",
    }]);
  });

  it("still refuses all-spaces opening evidence", async () => {
    await expect(insertIssueWithOpeningEvidence({
      ownerLogin: "   ",
      openingSourceEventId: "opening-event-1",
      openingSourceActorLogin: "sponsor-login",
      openingSourceAt: "2026-09-01T09:00:00.000Z",
    })).rejects.toThrow(/issues_opening_source_complete_check/);
  });

  it.each([0, 11])("still refuses a settled_points of %s with otherwise complete evidence", async (points) => {
    const issue = await insertIssue(sql);
    await expect(sql`
      update issues
      set settled_label = ${"delivered/6"},
          settled_points = ${points},
          settled_label_event_id = ${"settled-event-1"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-1"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${issue.id}
    `).rejects.toThrow(/issues_settled_evidence_complete_check/);
  });
});

function completeSettledEvidence(): SettledEvidence {
  return {
    settledLabel: "delivered/6",
    settledPoints: 6,
    settledLabelEventId: "settled-event-1",
    settledLabelActorLogin: "issue-owner",
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: "comment-1",
    settledRationaleActorLogin: "issue-owner",
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
  };
}

type OpeningEvidence = {
  ownerLogin: string | null;
  openingSourceEventId: string | null;
  openingSourceActorLogin: string | null;
  openingSourceAt: string | null;
};

async function insertIssueWithOpeningEvidence(evidence: OpeningEvidence): Promise<string> {
  const sponsorId = await insertUser(sql);
  const repositoryId = await insertRepository(sql, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points,
      owner_github_login,
      opening_source_event_id,
      opening_source_actor_login,
      opening_source_at
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      5,
      5,
      ${evidence.ownerLogin},
      ${evidence.openingSourceEventId},
      ${evidence.openingSourceActorLogin},
      ${evidence.openingSourceAt}
    )
    returning id
  `;
  return issue.id;
}

type SettledEvidence = {
  settledLabel: string | null;
  settledPoints: number | null;
  settledLabelEventId: string | null;
  settledLabelActorLogin: string | null;
  settledLabelAppliedAt: string | null;
  settledRationaleCommentId: string | null;
  settledRationaleActorLogin: string | null;
  settledRationaleCommentedAt: string | null;
};

async function insertIssueWithSettledEvidence(evidence: SettledEvidence): Promise<string> {
  const sponsorId = await insertUser(sql);
  const repositoryId = await insertRepository(sql, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points,
      owner_github_login,
      opening_source_event_id,
      opening_source_actor_login,
      opening_source_at,
      settled_label,
      settled_points,
      settled_label_event_id,
      settled_label_actor_login,
      settled_label_applied_at,
      settled_rationale_comment_id,
      settled_rationale_actor_login,
      settled_rationale_commented_at
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      5,
      5,
      ${"sponsor-login"},
      ${"opening-event-1"},
      ${"sponsor-login"},
      ${"2026-09-01T09:00:00.000Z"},
      ${evidence.settledLabel},
      ${evidence.settledPoints},
      ${evidence.settledLabelEventId},
      ${evidence.settledLabelActorLogin},
      ${evidence.settledLabelAppliedAt},
      ${evidence.settledRationaleCommentId},
      ${evidence.settledRationaleActorLogin},
      ${evidence.settledRationaleCommentedAt}
    )
    returning id
  `;
  return issue.id;
}

async function insertIssue(client: Sql): Promise<{ id: string }> {
  const sponsorId = await insertUser(client);
  const repositoryId = await insertRepository(client, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      5,
      5
    )
    returning id
  `;
  return { id: issue.id };
}

async function insertRepository(client: Sql, sponsorId: string): Promise<string> {
  const githubRepositoryId = nextExternalId();
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id,
      owner_name,
      sponsor_id,
      visibility,
      github_webhook_id,
      difficulty_scheme
    )
    values (
      ${githubRepositoryId},
      ${`owner-${githubRepositoryId}/repository-${githubRepositoryId}`},
      ${sponsorId},
      ${"PUBLIC"},
      ${nextExternalId()},
      ${client.json(validDifficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
}

async function insertUser(client: Sql): Promise<string> {
  const githubUserId = nextExternalId();
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  return user.id;
}
