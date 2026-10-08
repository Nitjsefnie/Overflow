import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore, repositoryLockNamespace } from "@/lib/fold/postgres-store";
import { DATA_SUBJECT_TOMBSTONE_LOGIN, exportForgePerson, removeForgePerson } from "@/lib/accounts/forge-person";
import type { GitHubIssue, GitHubIssueReference, GitHubPullRequest, GitHubPullRequestReview } from "@/lib/github/types";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { scrubFoldResultForPerson, scrubIssueIdentity, scrubSuppressedForgeData } from "@/lib/fold/data-subject-suppression";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
let databaseUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;

// 32 raw bytes, base64url: a real key so the sponsor credential round-trips.
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
const start = new Date("2026-09-08T10:00:00Z");

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "data_subject_requests",
    user: "data_subject_requests",
    password: "data_subject_requests",
  });
  container = started.container;
  databaseUrl = started.databaseUrl;
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

// ---------------------------------------------------------------------------
// Seeding. One counter per file database keeps every case's external ids and
// login strings unique, exactly as the account-deletion suite does.
// ---------------------------------------------------------------------------

let seedCounter = 0;

function nextSeedNumber(): number {
  seedCounter += 1;
  return seedCounter;
}

function proofSha(seed: number): string {
  return createHash("sha256").update(`data-subject-proof-${seed}`).digest("hex");
}

type HandSeeded = {
  repositoryId: string;
  sponsor: { id: string; githubUserId: number };
  member: { id: string; githubUserId: number };
  person: { forgeId: number; login: string };
  /** The issue the person opened; its body is legacy text naming them. */
  personIssue: { id: string; githubIssueId: string; body: string };
  /** The sponsor-authored issue the person claimed as assignee. */
  claimedIssue: { id: string; githubIssueId: string };
  actorIssue: { id: string; githubIssueId: string };
  memberIssue: { id: string; githubIssueId: string; body: string };
  personPullRequest: { id: string; githubPullRequestId: string; body: string };
  memberPullRequest: { id: string };
  /** The unlinked settlement crediting the person. */
  personSettlement: { id: string };
  /** The member's settled settlement, which removal must not touch. */
  memberSettlement: { id: string };
  moderationEvent: { id: string; reason: string };
  changeRecord: { id: string };
  evidenceFact: { subjectKey: string };
};

/**
 * The exact scenario issue 1071 reproduced: a person who never signed in
 * (forge id + login, no users row) across issues, pull requests, settlements,
 * the evidence cache, the change log and a moderation note, in a repository
 * that also holds a member's own issue body.
 */
async function seedHandScenario(): Promise<HandSeeded> {
  const seed = nextSeedNumber();
  const forgeId = 9_100_000 + seed;
  const login = `outsider-${seed}`;
  const [sponsor] = await sql<{ id: string; github_user_id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${9_200_000 + seed}, ${`sponsor-${seed}`},
            ${Buffer.from(encryptToken("sponsor-token", TEST_ENCRYPTION_KEY,
              credentialBinding.userOAuthToken(9_200_000 + seed)), "utf8")})
    returning id, github_user_id
  `;
  const [member] = await sql<{ id: string; github_user_id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${9_300_000 + seed}, ${`member-${seed}`}) returning id, github_user_id
  `;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${9_400_000 + seed}, ${`ds-owner/repo-${seed}`}, ${sponsor!.id}, 'PUBLIC',
      ${9_400_100 + seed}, ${sql.json(validDifficultyScheme())}
    ) returning id
  `;
  const repositoryId = repository!.id;
  const personIssueBody = `Reported by ${login} (${forgeId}): the picker loses state.`;
  const [personIssue] = await sql<{ id: string; github_issue_id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
                        opening_source_event_id, opening_source_actor_login, opening_source_at)
    values (${9_500_000 + seed}, ${repositoryId}, 1, 'Picker loses state', ${personIssueBody},
            ${`https://example.test/issues/${9_500_000 + seed}`}, 'CLOSED',
            ${login}, 'M', 5, 5,
            ${`opening-${seed}`}, ${`sponsor-${seed}`}, '2026-09-01T08:00:00Z')
    returning id, github_issue_id
  `;
  const memberIssueBody = `Member ${seed}'s own write-up of their own work.`;
  const [memberIssue] = await sql<{ id: string; github_issue_id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
                        opening_source_event_id, opening_source_actor_login, opening_source_at)
    values (${9_500_100 + seed}, ${repositoryId}, 2, 'Member work item', ${memberIssueBody},
            ${`https://example.test/issues/${9_500_100 + seed}`}, 'CLOSED',
            ${`member-${seed}`}, 'M', 5, 5,
            ${`opening-${seed}-m`}, ${`sponsor-${seed}`}, '2026-09-01T08:00:00Z')
    returning id, github_issue_id
  `;
  const [actorIssue] = await sql<{ id: string; github_issue_id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
                        opening_source_event_id, opening_source_actor_login, opening_source_at)
    values (${9_500_300 + seed}, ${repositoryId}, 4, 'Sponsor-acted work item', null,
            ${`https://example.test/issues/${9_500_300 + seed}`}, 'CLOSED',
            ${`sponsor-${seed}`}, 'M', 5, 5,
            ${`opening-${seed}-a`}, ${login}, '2026-09-01T08:00:00Z')
    returning id, github_issue_id
  `;
  const [claimedIssue] = await sql<{ id: string; github_issue_id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
                        opening_source_event_id, opening_source_actor_login, opening_source_at,
                        claim_assignee_github_login, claim_assignee_github_user_id)
    values (${9_500_200 + seed}, ${repositoryId}, 3, 'Claimed work item', null,
            ${`https://example.test/issues/${9_500_200 + seed}`}, 'CLOSED',
            ${`sponsor-${seed}`}, 'M', 5, 5,
            ${`opening-${seed}-c`}, ${`sponsor-${seed}`}, '2026-09-01T08:00:00Z',
            ${login}, ${forgeId})
    returning id, github_issue_id
  `;
  const personPullRequestBody = `Patch by ${login}; fixes the picker state.`;
  const [personPullRequest] = await sql<{ id: string; github_pull_request_id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_github_login, author_github_user_id, state, merged_at, merge_commit_oid, final_commit_at,
      proof_sha256
    ) values (
      ${9_600_000 + seed}, ${repositoryId}, ${personIssue!.id}, 11,
      ${`https://example.test/pull/${9_600_000 + seed}`}, 'Fix the picker', ${personPullRequestBody},
      ${login}, ${forgeId}, 'MERGED', '2026-09-01T12:00:00Z', ${"a".repeat(40)},
      '2026-09-01T10:00:00Z', ${proofSha(seed)}
    ) returning id, github_pull_request_id
  `;
  const [memberPullRequest] = await sql<{ id: string; github_pull_request_id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, author_github_login, author_github_user_id, state, merged_at, merge_commit_oid,
      final_commit_at, proof_sha256
    ) values (
      ${9_600_100 + seed}, ${repositoryId}, ${memberIssue!.id}, 12,
      ${`https://example.test/pull/${9_600_100 + seed}`}, 'Member fix', null,
      ${member!.id}, ${`member-${seed}`}, ${9_300_000 + seed}, 'MERGED', '2026-09-01T12:00:00Z',
      ${"b".repeat(40)}, '2026-09-01T10:00:00Z', ${proofSha(1_000_000 + seed)}
    ) returning id, github_pull_request_id
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${personPullRequest!.id}, ${personIssue!.id}, ${repositoryId}),
           (${memberPullRequest!.id}, ${memberIssue!.id}, ${repositoryId})
  `;
  const [personSettlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    ) values (
      ${personPullRequest!.id}, ${personIssue!.id}, null, ${login}, ${forgeId}, ${sponsor!.id},
      5, 6, 0, 6, ${proofSha(seed)}, 'UNCLAIMED'
    ) returning id
  `;
  const [memberSettlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    ) values (
      ${memberPullRequest!.id}, ${memberIssue!.id}, ${member!.id}, ${sponsor!.id},
      5, 6, 0, 6, ${proofSha(2_000_000 + seed)}, 'SETTLED'
    ) returning id
  `;
  await sql`
    insert into repository_reconciliation_evidence (
      repository_id, version, format_version, checkpoint, last_full_pass_at, omitted_oversized_facts
    ) values (
      ${repositoryId}, 1, 4, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z', 0
    )
  `;
  const evidenceFactPayload = {
    id: Number(personIssue!.github_issue_id), number: 1, title: "Picker loses state",
    url: `https://example.test/issues/${9_500_000 + seed}`, state: "CLOSED", stateReason: "COMPLETED",
    createdAt: "2026-09-01T07:00:00Z", updatedAt: "2026-09-01T12:00:00Z", closedAt: "2026-09-01T12:00:00Z",
    authorLogin: login, authorGitHubUserId: forgeId, labels: ["M"],
    claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
    history: [{ kind: "LABELED", id: `opening-${seed}`, actorLogin: `sponsor-${seed}`,
      actorGitHubUserId: 9_200_000 + seed, label: "M", createdAt: "2026-09-01T08:00:00Z" }],
    comments: [
      { id: `comment-${seed}`, databaseId: 900_000 + seed, authorLogin: login, authorGitHubUserId: forgeId,
        body: "Comment body placeholder", createdAt: "2026-09-01T09:00:00Z", lastEditedAt: null },
      { id: `comment-${seed}-s`, databaseId: 900_100 + seed, authorLogin: `sponsor-${seed}`,
        authorGitHubUserId: 9_200_000 + seed, body: "Sponsor text", createdAt: "2026-09-01T11:30:00Z",
        lastEditedAt: null },
    ],
    closingPullRequests: [{
      id: 9_600_000 + seed, number: 11, title: "Fix the picker", state: "MERGED",
      mergedAt: "2026-09-01T12:00:00Z", mergeCommitOid: "a".repeat(40), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: login, authorGitHubUserId: forgeId,
      repositoryGitHubId: 9_400_000 + seed, repositoryNameWithOwner: `ds-owner/repo-${seed}`,
    }],
  };
  await sql`
    insert into repository_reconciliation_evidence_facts (repository_id, kind, subject_key, payload)
    values (${repositoryId}, 'issue', ${String(9_500_000 + seed)}, ${sql.json(evidenceFactPayload)})
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into reconciliation_runs (repository_id, status, started_at, completed_at)
    values (${repositoryId}, 'COMPLETED', '2026-09-01T12:00:00Z', '2026-09-01T12:01:00Z')
    returning id
  `;
  const changeAfterState = {
    githubIssueId: Number(personIssue!.github_issue_id), githubPullRequestId: 9_600_000 + seed,
    creditorGitHubLogin: login, creditorGitHubUserId: forgeId, status: "UNCLAIMED",
  };
  const [changeRecord] = await sql<{ id: string }[]>`
    insert into reconciliation_changes (
      reconciliation_run_id, pull_request_id, entity_kind, change_kind, before_state, after_state
    ) values (
      ${run!.id}, ${personPullRequest!.id}, 'SETTLEMENT', 'ADD', null, ${sql.json(changeAfterState)}
    ) returning id
  `;
  const moderationReason = `Audit opened about ${login} (forge id ${forgeId}) by hand.`;
  const [moderationEvent] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${member!.id}, ${sponsor!.id}, 'ACTIVE', 'UNDER_AUDIT', ${moderationReason})
    returning id
  `;
  return {
    repositoryId,
    sponsor: { id: sponsor!.id, githubUserId: Number(sponsor!.github_user_id) },
    member: { id: member!.id, githubUserId: Number(member!.github_user_id) },
    person: { forgeId, login },
    personIssue: { id: personIssue!.id, githubIssueId: personIssue!.github_issue_id, body: personIssueBody },
    claimedIssue: { id: claimedIssue!.id, githubIssueId: claimedIssue!.github_issue_id },
    actorIssue: { id: actorIssue!.id, githubIssueId: actorIssue!.github_issue_id },
    memberIssue: { id: memberIssue!.id, githubIssueId: memberIssue!.github_issue_id, body: memberIssueBody },
    personPullRequest: {
      id: personPullRequest!.id,
      githubPullRequestId: personPullRequest!.github_pull_request_id,
      body: personPullRequestBody,
    },
    memberPullRequest: { id: memberPullRequest!.id },
    personSettlement: { id: personSettlement!.id },
    memberSettlement: { id: memberSettlement!.id },
    moderationEvent: { id: moderationEvent!.id, reason: moderationReason },
    changeRecord: { id: changeRecord!.id },
    evidenceFact: { subjectKey: String(9_500_000 + seed) },
  };
}

/** One whole table row as jsonb, by primary key. */
async function rowJson(table: string, id: string): Promise<Record<string, unknown>> {
  const [row] = await sql.unsafe<Record<string, unknown>[]>(
    `select to_jsonb(t) as row from ${table} as t where t.id = $1`,
    [id],
  );
  return row!.row as Record<string, unknown>;
}

function storeOf(document: { stores: Array<{ table: string; count: number; rows: unknown[] }> }, table: string) {
  const section = document.stores.find((entry) => entry.table === table);
  expect(section, `export section for ${table}`).toBeDefined();
  return section!;
}

describe("data-subject export", () => {
  it("case 1: covers every row naming the person and none of the member's rows", async () => {
    const seed = await seedHandScenario();
    const document = await exportForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    });

    expect(document.formatVersion).toBe(1);
    expect(document.requested).toEqual({ provider: "github", instanceUrl: "https://github.com", forgeId: seed.person.forgeId, login: null });
    expect(document.logins).toEqual([seed.person.login]);

    expect(storeOf(document, "users")).toMatchObject({ count: 0, rows: [] });
    expect(storeOf(document, "user_forge_identities")).toMatchObject({ count: 0, rows: [] });
    expect(storeOf(document, "issues")).toMatchObject({ count: 3, rows: [
      await rowJson("issues", seed.personIssue.id),
      await rowJson("issues", seed.claimedIssue.id),
      await rowJson("issues", seed.actorIssue.id),
    ] });
    expect(storeOf(document, "pull_requests")).toMatchObject({ count: 1, rows: [
      await rowJson("pull_requests", seed.personPullRequest.id),
    ] });
    expect(storeOf(document, "settlements")).toMatchObject({ count: 1, rows: [
      await rowJson("settlements", seed.personSettlement.id),
    ] });
    expect(storeOf(document, "repository_reconciliation_evidence_facts")).toMatchObject({
      count: 1,
      rows: [{ kind: "issue", subject_key: seed.evidenceFact.subjectKey }],
    });
    expect(storeOf(document, "reconciliation_changes")).toMatchObject({ count: 1, rows: [
      await rowJson("reconciliation_changes", seed.changeRecord.id),
    ] });
    expect(storeOf(document, "moderation_events")).toMatchObject({ count: 1, rows: [
      await rowJson("moderation_events", seed.moderationEvent.id),
    ] });

    // None of the member's rows anywhere: their issue, pull request and
    // settlement name only them. The moderation note is the one section that
    // legitimately carries a member id — the note targets the member while
    // naming the person in its reason text — so it is pinned separately above.
    for (const section of document.stores) {
      if (section.table === "moderation_events") continue;
      const serialized = JSON.stringify(section.rows);
      expect(serialized, `section ${section.table} carries no member row`).not.toContain(seed.member.id);
      expect(serialized, `section ${section.table} carries no member issue`).not.toContain(seed.memberIssue.id);
      expect(serialized, `section ${section.table} carries no member pull request`)
        .not.toContain(seed.memberPullRequest.id);
      expect(serialized, `section ${section.table} carries no member settlement`)
        .not.toContain(seed.memberSettlement.id);
    }
  });

  it("case 2: exports empty stores for a person with no rows", async () => {
    const forgeId = 9_100_000 + nextSeedNumber();
    const document = await exportForgePerson(sql, { provider: "github", forgeId });
    expect(document.logins).toEqual([]);
    for (const section of document.stores) {
      expect(section, `section ${section.table}`).toMatchObject({ count: 0, rows: [] });
    }
  });
});

describe("data-subject removal", () => {
  it("case 3: applies the decision table, leaves the member untouched, records the suppression", async () => {
    const seed = await seedHandScenario();
    // Captured before the removal: the journal row must still equal it after.
    const changeBefore = await rowJson("reconciliation_changes", seed.changeRecord.id);
    const outcome = await removeForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    }, { confirm: true });
    expect(outcome).toMatchObject({
      kind: "REMOVED",
      provider: "github",
      forgeId: seed.person.forgeId,
      login: seed.person.login,
    });
    if (outcome.kind !== "REMOVED") return;

    // users: the person never signed in, so there is no row to pseudonymise.
    expect(outcome.perStore).toEqual({
      users: 0,
      apiTokens: 0,
      forgeIdentities: 0,
      issues: 3,
      pullRequests: 1,
      settlements: 1,
      evidenceFacts: 1,
    });

    // issues: the person-authored row loses its legacy body and its owner
    // login; the claim-assignee copy on the sponsor's issue is tombstoned and
    // the numeric id dropped.
    const personIssueAfter = await rowJson("issues", seed.personIssue.id);
    expect(personIssueAfter.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(personIssueAfter.body).toBeNull();
    const claimedIssueAfter = await rowJson("issues", seed.claimedIssue.id);
    expect(claimedIssueAfter.claim_assignee_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(claimedIssueAfter.claim_assignee_github_user_id).toBeNull();
    expect(claimedIssueAfter.body).toBeNull();
    // The actor-only row: the removal scrubs the sponsor-actor copy that
    // names the person and nothing else about the row.
    const actorIssueAfter = await rowJson("issues", seed.actorIssue.id);
    expect(actorIssueAfter.opening_source_actor_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(actorIssueAfter.owner_github_login).toBe(`sponsor-${seedCounter}`);

    // pull_requests: author copies scrubbed, the attribution key untouched.
    const personPrAfter = await rowJson("pull_requests", seed.personPullRequest.id);
    expect(personPrAfter.author_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(personPrAfter.author_github_user_id).toBeNull();
    expect(personPrAfter.author_id).toBeNull();
    expect(personPrAfter.body).toBeNull();

    // settlements: creditor copies scrubbed, creditor_id untouched.
    const settlementAfter = await rowJson("settlements", seed.personSettlement.id);
    expect(settlementAfter.creditor_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(settlementAfter.creditor_github_user_id).toBeNull();
    expect(settlementAfter.creditor_id).toBeNull();
    expect(settlementAfter.status).toBe("UNCLAIMED");

    // evidence facts: the payload identity fields are tombstoned in place;
    // the fact row itself and its content fields are kept.
    const [factAfter] = await sql<{ payload: {
      authorLogin: string; authorGitHubUserId: number | null;
      comments: Array<{ authorLogin: string; authorGitHubUserId: number | null }>;
      closingPullRequests: Array<{ authorLogin: string; authorGitHubUserId: number | null }>;
    } }[]>`
      select payload from repository_reconciliation_evidence_facts
      where repository_id = ${seed.repositoryId} and kind = 'issue'
        and subject_key = ${seed.evidenceFact.subjectKey}
    `;
    expect(factAfter).toBeDefined();
    expect(factAfter!.payload.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(factAfter!.payload.authorGitHubUserId).toBeNull();
    expect(factAfter!.payload.comments).toHaveLength(2);
    expect(factAfter!.payload.comments[0]!.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(factAfter!.payload.comments[0]!.authorGitHubUserId).toBeNull();
    expect(factAfter!.payload.comments[1]!.authorLogin).toBe(`sponsor-${seedCounter}`);
    expect(factAfter!.payload.closingPullRequests[0]!.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(factAfter!.payload.closingPullRequests[0]!.authorGitHubUserId).toBeNull();

    // moderation: the audit trail is immutable by trigger, so the note is
    // kept exactly as written — states and reason text unchanged — and the
    // export is the access copy the operator answers the request from.
    const moderationAfter = await rowJson("moderation_events", seed.moderationEvent.id);
    expect(moderationAfter.target_user_id).toBe(seed.member.id);
    expect(moderationAfter.actor_id).toBe(seed.sponsor.id);
    expect(moderationAfter.prior_state).toBe("ACTIVE");
    expect(moderationAfter.new_state).toBe("UNDER_AUDIT");
    expect(moderationAfter.reason).toBe(seed.moderationEvent.reason);

    // The member's rows are byte-identical to before the removal.
    const memberIssueBefore = seed.memberIssue.body;
    const memberIssueAfter = await rowJson("issues", seed.memberIssue.id);
    expect(memberIssueAfter.body).toBe(memberIssueBefore);
    expect(memberIssueAfter.owner_github_login).toBe(`member-${seedCounter}`);
    const memberPrAfter = await rowJson("pull_requests", seed.memberPullRequest.id);
    expect(memberPrAfter.author_github_login).toBe(`member-${seedCounter}`);
    expect(memberPrAfter.author_id).toBe(seed.member.id);
    expect(memberPrAfter.body).toBeNull();
    const memberSettlementAfter = await rowJson("settlements", seed.memberSettlement.id);
    expect(memberSettlementAfter.creditor_id).toBe(seed.member.id);
    // The member settlement names them only by the attribution key: no login
    // or numeric-id copies were ever written for it, and none appear now.
    expect(memberSettlementAfter.creditor_github_login).toBeNull();
    expect(memberSettlementAfter.creditor_github_user_id).toBeNull();
    expect(memberSettlementAfter.status).toBe("SETTLED");

    // The suppression is recorded with the resolved login, and is unique per
    // key: a re-run refreshes the stamp instead of failing.
    const [suppression] = await sql<{ provider: string; forge_id: string; login: string | null }[]>`
      select provider, forge_id::text as forge_id, login from data_subject_suppressions
      where provider = 'github' and forge_id = ${seed.person.forgeId}
    `;
    expect(suppression).toMatchObject({ provider: "github", forge_id: String(seed.person.forgeId), login: seed.person.login });

    // The change journal is kept: the append-only reconciliation history is
    // not rewritten by a removal, and retention prunes it later. The snapshot
    // was captured before the removal ran.
    expect(await rowJson("reconciliation_changes", seed.changeRecord.id)).toEqual(changeBefore);
    const [changeCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from reconciliation_changes
      where pull_request_id = ${seed.personPullRequest.id}
    `;
    expect(changeCount!.count).toBe(1);
  });

  it("case 4: a dry run plans without writing; --confirm records the suppression once", async () => {
    const seed = await seedHandScenario();
    const planned = await removeForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    }, { confirm: false });
    expect(planned.kind).toBe("PLANNED");
    if (planned.kind === "PLANNED") {
      expect(planned.perStore).toMatchObject({ issues: 3, pullRequests: 1, settlements: 1, evidenceFacts: 1 });
    }
    const personIssuePlanned = await rowJson("issues", seed.personIssue.id);
    expect(personIssuePlanned.owner_github_login).toBe(seed.person.login);
    expect(personIssuePlanned.body).toBe(seed.personIssue.body);
    const [suppressionCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from data_subject_suppressions
      where provider = 'github' and forge_id = ${seed.person.forgeId}
    `;
    expect(suppressionCount!.count).toBe(0);

    const confirmed = await removeForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    }, { confirm: true });
    expect(confirmed.kind).toBe("REMOVED");
    const personIssueConfirmed = await rowJson("issues", seed.personIssue.id);
    expect(personIssueConfirmed.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    const [suppressionAfter] = await sql<{ count: number }[]>`
      select count(*)::int as count from data_subject_suppressions
      where provider = 'github' and forge_id = ${seed.person.forgeId}
    `;
    expect(suppressionAfter!.count).toBe(1);
  });

  it("case 5: a person who sponsors a registration is refused with nothing written", async () => {
    const seed = await seedHandScenario();
    const [memberAsSponsor] = await sql<{ id: string }[]>`
      update users set github_user_id = ${seed.person.forgeId} where id = ${seed.member.id} returning id
    `;
    await sql`
      update registered_repositories set sponsor_id = ${memberAsSponsor!.id}
      where id = ${seed.repositoryId}
    `;
    const outcome = await removeForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    }, { confirm: true });
    expect(outcome).toMatchObject({
      kind: "SPONSOR_BLOCKED",
      provider: "github",
      forgeId: seed.person.forgeId,
      repositories: [{ ownerName: `ds-owner/repo-${seedCounter}`, provider: "github", instanceUrl: null }],
    });
    const personIssueBlocked = await rowJson("issues", seed.personIssue.id);
    expect(personIssueBlocked.owner_github_login).toBe(seed.person.login);
    const [suppressionCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from data_subject_suppressions
      where provider = 'github' and forge_id = ${seed.person.forgeId}
    `;
    expect(suppressionCount!.count).toBe(0);
  });

  it("case 6: a person with no rows is removed as a no-op that still records the suppression", async () => {
    const forgeId = 9_100_000 + nextSeedNumber();
    const outcome = await removeForgePerson(sql, { provider: "github", forgeId }, { confirm: true });
    expect(outcome).toMatchObject({ kind: "REMOVED", login: null });
    if (outcome.kind !== "REMOVED") return;
    expect(outcome.perStore).toEqual({
      users: 0, apiTokens: 0, forgeIdentities: 0, issues: 0, pullRequests: 0,
      settlements: 0, evidenceFacts: 0,
    });
    const [suppression] = await sql<{ login: string | null }[]>`
      select login from data_subject_suppressions where provider = 'github' and forge_id = ${forgeId}
    `;
    expect(suppression!.login).toBeNull();
  });

  it("case 8: the removal contends on the fold's repository locks and refuses while one is held", async () => {
    const seed = await seedHandScenario();
    // A raw client holds the fold pass's own session-level advisory lock on
    // the seeded repository — the same key shape withRepositoryReconciliation
    // takes (hashtextextended(repository id, the fold's lock namespace)).
    const holdClient = postgres(databaseUrl, { max: 1 });
    try {
      await holdClient`
        select pg_advisory_lock(hashtextextended(${seed.repositoryId}, ${repositoryLockNamespace}))
      `;
      // What this pins: the removal really contends on those keys — held, it
      // waits out its budget and refuses closed instead of racing a fold
      // pass's publication. The exact interleaving (a pass whose suppression
      // read preceded the removal committing after it) is not drivable here;
      // the shared lock is what makes it unreachable.
      await expect(removeForgePerson(sql, {
        provider: "github", forgeId: seed.person.forgeId,
      }, { confirm: true, lockWaitMs: 200 })).rejects.toThrow("Unable to coordinate the data-subject removal.");
      const [suppressionCount] = await sql<{ count: number }[]>`
        select count(*)::int as count from data_subject_suppressions
        where provider = 'github' and forge_id = ${seed.person.forgeId}
      `;
      expect(suppressionCount!.count).toBe(0);
      const refusedRow = await rowJson("issues", seed.personIssue.id);
      expect(refusedRow.owner_github_login).toBe(seed.person.login);
    } finally {
      await holdClient.end();
    }
    // Released, the removal acquires every lock and completes.
    const outcome = await removeForgePerson(sql, {
      provider: "github", forgeId: seed.person.forgeId,
    }, { confirm: true });
    expect(outcome).toMatchObject({ kind: "REMOVED", perStore: { issues: 3 } });
    const [suppression] = await sql<{ login: string | null }[]>`
      select login from data_subject_suppressions where provider = 'github' and forge_id = ${seed.person.forgeId}
    `;
    expect(suppression).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suppression at the reconciliation import (issue 1071's "the next
// reconciliation re-reads everything from the forge"): the real reconcile
// driver runs against a forge double seeded with the person, exactly as the
// incremental-reconciliation suite drives it.
// ---------------------------------------------------------------------------

type ForgeDouble = {
  store: PostgresFoldStore;
  clock: Date;
  issues: GitHubIssue[];
  run: (options?: { rederive?: boolean }) => Promise<{ adds: number; changes: number; removals: number } & Record<string, unknown>>;
};

describe("suppression at the reconciliation import", () => {
  it("case 7: a later pass over the same forge data never reinstates the person", async () => {
    const seedNumber = nextSeedNumber();
    const forgeId = 9_100_000 + seedNumber;
    const login = `outsider-${seedNumber}`;
    const sponsorGitHubId = 9_200_000 + seedNumber;
    const memberGitHubId = 9_300_000 + seedNumber;
    const githubRepositoryId = 9_400_000 + seedNumber;
    const [sponsor] = await sql<{ id: string; github_login: string }[]>`
      insert into users (github_user_id, github_login, encrypted_oauth_token)
      values (${sponsorGitHubId}, ${`sponsor-${seedNumber}`},
              ${Buffer.from(encryptToken("sponsor-token", TEST_ENCRYPTION_KEY,
                credentialBinding.userOAuthToken(sponsorGitHubId)), "utf8")})
      returning id, github_login
    `;
    const [member] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${memberGitHubId}, ${`member-${seedNumber}`}) returning id
    `;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
        created_at
      ) values (
        ${githubRepositoryId}, ${`ds-owner/repo-${seedNumber}`}, ${sponsor!.id}, 'PUBLIC',
        ${githubRepositoryId + 100}, ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z'
      ) returning id
    `;
    const repositoryId = String(repository!.id);
    const mergedAt = "2026-09-01T12:00:00Z";
    const personComment = {
      id: `comment-${seedNumber}`, databaseId: 900_000 + seedNumber,
      authorLogin: login, authorGitHubUserId: forgeId,
      body: "Seeing this too.", createdAt: "2026-09-01T09:00:00Z", lastEditedAt: null,
    };
    const sponsorRationale = {
      id: `comment-${seedNumber}-s`, databaseId: 900_100 + seedNumber,
      authorLogin: `sponsor-${seedNumber}`, authorGitHubUserId: sponsorGitHubId,
      body: "Settled on the recorded difficulty.", createdAt: "2026-09-01T11:30:00Z", lastEditedAt: null,
    };
    const closingPullRequest = (prId: number, number: number, author: string, authorId: number): GitHubPullRequest => ({
      id: prId, number, title: `Work ${number}`, body: "PR body", url: "https://github.com/ds-owner/repo/pull/1",
      state: "MERGED", mergedAt, mergeCommitOid: String(prId).padStart(40, "3"), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: author, authorGitHubUserId: authorId,
      repositoryGitHubId: githubRepositoryId, repositoryNameWithOwner: `ds-owner/repo-${seedNumber}`,
    });
    const personIssueId = 9_500_000 + seedNumber;
    const memberIssueId = 9_500_100 + seedNumber;
    const issue = (issueId: number, number: number, prNumber: number, author: string, authorId: number, prId: number): GitHubIssue => ({
      id: issueId, number, title: `Issue ${number}`, body: "Issue body",
      url: "https://github.com/ds-owner/repo/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-09-01T07:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      closedAt: "2026-09-01T12:00:00Z", authorLogin: author, authorGitHubUserId: authorId,
      labels: ["M"], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      history: [
        { kind: "LABELED", id: `opening-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "M", createdAt: "2026-09-01T08:00:00Z" },
        { kind: "LABELED", id: `settled-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "delivered/6", createdAt: "2026-09-01T11:00:00Z" },
      ],
      comments: issueId === personIssueId ? [personComment, sponsorRationale] : [sponsorRationale],
      closingPullRequests: [closingPullRequest(prId, prNumber, author, authorId)],
    });
    const double: ForgeDouble = {
      store: new PostgresFoldStore(sql, TEST_ENCRYPTION_KEY),
      clock: start,
      issues: [
        issue(personIssueId, 1, 11, login, forgeId, 9_600_000 + seedNumber),
        issue(memberIssueId, 2, 12, `member-${seedNumber}`, memberGitHubId, 9_600_100 + seedNumber),
      ],
      run: async (options?: { rederive?: boolean }) =>
        reconcileRepository(
          {
            store: double.store,
            github: gatewayDouble(double.issues, githubRepositoryId),
            now: () => double.clock,
          },
          repositoryId,
          options,
        ),
    };
    const personIssueRow = () =>
      sql<{ owner_github_login: string; body: string | null }[]>`
        select owner_github_login, body from issues
        where repository_id = ${repositoryId} and github_issue_id = ${personIssueId}
      `;
    const personPrRow = () =>
      sql<{ author_github_login: string | null; author_github_user_id: string | null; author_id: string | null }[]>`
        select author_github_login, author_github_user_id::text as author_github_user_id, author_id
        from pull_requests where repository_id = ${repositoryId} and github_pull_request_id = ${9_600_000 + seedNumber}
      `;
    const personSettlementRow = () =>
      sql<{ creditor_github_login: string | null; creditor_github_user_id: string | null; creditor_id: string | null; status: string }[]>`
        select creditor_github_login, creditor_github_user_id::text as creditor_github_user_id,
               creditor_id, status::text as status
        from settlements join issues on issues.id = settlements.issue_id
        where issues.repository_id = ${repositoryId} and issues.github_issue_id = ${personIssueId}
      `;
    const payloadRow = () =>
      sql<{ payload: { authorLogin: string | null; authorGitHubUserId: number | null;
        comments: Array<{ authorLogin: string | null }> } }[]>`
        select payload from repository_reconciliation_evidence_facts
        where repository_id = ${repositoryId} and kind = 'issue' and subject_key = ${String(personIssueId)}
      `;
    const memberSettlementRow = () =>
      sql<{ creditor_id: string | null; creditor_github_login: string | null; status: string }[]>`
        select creditor_id, creditor_github_login, status::text as status
        from settlements join issues on issues.id = settlements.issue_id
        where issues.repository_id = ${repositoryId} and issues.github_issue_id = ${memberIssueId}
      `;
    const changesNamingPerson = () =>
      sql<{ count: number }[]>`
        select count(*)::int as count from reconciliation_changes
        where before_state::text ~ (${`\\m${login}\\M`})::text or after_state::text ~ (${`\\m${login}\\M`})::text
      `;

    // Pass 1, no suppression: the person's identifiers land in every store
    // the fold writes, so the assertions below are about the removal working.
    double.clock = new Date("2026-09-08T10:02:00Z");
    const pass1 = await double.run();
    expect(pass1.skipped).toBe(false);
    expect(pass1.adds).toBe(2);
    const ownerBefore = await personIssueRow();
    expect(ownerBefore[0]!.owner_github_login).toBe(login);
    const prBefore = await personPrRow();
    expect(prBefore[0]!.author_github_login).toBe(login);
    expect(prBefore[0]!.author_github_user_id).toBe(String(forgeId));
    expect(prBefore[0]!.author_id).toBeNull();
    const settlementBefore = await personSettlementRow();
    expect(settlementBefore[0]!.status).toBe("UNCLAIMED");
    expect(settlementBefore[0]!.creditor_github_login).toBe(login);
    const payloadBefore = await payloadRow();
    expect(payloadBefore[0]!.payload.authorLogin).toBe(login);
    const changesBefore = await changesNamingPerson();
    expect(changesBefore[0]!.count).toBeGreaterThan(0);

    // The removal tombstones what pass 1 wrote and records the suppression.
    const removal = await removeForgePerson(sql, { provider: "github", forgeId }, { confirm: true });
    expect(removal).toMatchObject({ kind: "REMOVED", login });

    // Pass 2, a quiet partial pass over the same forge double: nothing is
    // reinstated and nothing is re-journaled.
    double.clock = new Date("2026-09-08T10:04:00Z");
    const pass2 = await double.run();
    expect(pass2.skipped).toBe(false);
    expect([pass2.adds, pass2.changes, pass2.removals]).toEqual([0, 0, 0]);
    expect((await personIssueRow())[0]!.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    const prAfter = await personPrRow();
    expect(prAfter[0]!.author_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(prAfter[0]!.author_github_user_id).toBeNull();
    expect(prAfter[0]!.author_id).toBeNull();
    const settlementAfter = await personSettlementRow();
    expect(settlementAfter[0]!.status).toBe("UNCLAIMED");
    expect(settlementAfter[0]!.creditor_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(settlementAfter[0]!.creditor_github_user_id).toBeNull();
    expect((await payloadRow())[0]!.payload.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect((await changesNamingPerson())[0]!.count).toBe(changesBefore[0]!.count);
    const memberAfter = await memberSettlementRow();
    expect(memberAfter[0]!.creditor_id).toBe(member!.id);
    expect(memberAfter[0]!.creditor_github_login).toBe(`member-${seedNumber}`);
    expect(memberAfter[0]!.status).toBe("SETTLED");

    // Pass 3, a full rederivation: the forge double still serves the person's
    // identifiers, and the import scrub tombstones them again before any
    // row is written.
    double.clock = new Date("2026-09-08T10:06:00Z");
    const pass3 = await double.run({ rederive: true });
    expect(pass3.skipped).toBe(false);
    expect([pass3.adds, pass3.changes, pass3.removals]).toEqual([0, 0, 0]);
    expect((await personIssueRow())[0]!.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    const prFull = await personPrRow();
    expect(prFull[0]!.author_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(prFull[0]!.author_github_user_id).toBeNull();
    const settlementFull = await personSettlementRow();
    expect(settlementFull[0]!.creditor_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(settlementFull[0]!.creditor_github_user_id).toBeNull();
    expect((await payloadRow())[0]!.payload.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect((await changesNamingPerson())[0]!.count).toBe(changesBefore[0]!.count);
    const memberFull = await memberSettlementRow();
    expect(memberFull[0]!.creditor_id).toBe(member!.id);
    expect(memberFull[0]!.status).toBe("SETTLED");
    expect(memberFull[0]!.creditor_github_login).toBe(`member-${seedNumber}`);
  });
});

function gatewayDouble(issues: GitHubIssue[], githubRepositoryId: number): ReconciliationGateway {
  return {
    getRepositoryById: async () => ({
      id: githubRepositoryId, owner: "ds-owner", name: "repo",
      fullName: `ds-owner/repo-${githubRepositoryId}`, visibility: "PUBLIC",
      url: "https://github.com/ds-owner/repo", canAdminister: true, ownerType: "USER",
    }),
    listIssues: async () => structuredClone(issues),
    getIssue: async () => null,
    getPullRequestClosingIssues: async (): Promise<GitHubIssueReference[]> => [],
    getPullRequestReviews: async (): Promise<GitHubPullRequestReview[]> => [],
    getPullRequestDiff: async () => "diff of the recorded work",
  };
}

// Whole-branch adversarial reproductions: appended temporarily by the reviewer.
describe("whole branch review regressions", () => {
  it("review: linked GitLab export resolves its account UUID", async () => {
    const seed = await seedHandScenario();
    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
      values (${seed.member.id}, 'gitlab', 'https://gitlab.example', ${seed.person.forgeId}, ${seed.person.login}, ${Buffer.from('review token')})`;
    const doc = await exportForgePerson(sql, {provider: 'gitlab', instanceUrl: 'https://gitlab.example/', forgeId: seed.person.forgeId});
    expect(storeOf(doc, 'users').rows).toEqual([expect.objectContaining({id: seed.member.id})]);
  });
  it("review: repeat removal retains the suppression login", async () => {
    const seed = await seedHandScenario();
    const request = {provider:'github',forgeId:seed.person.forgeId};
    await removeForgePerson(sql, request, {confirm:true});
    await removeForgePerson(sql, request, {confirm:true});
    const [suppression] = await sql`select login from data_subject_suppressions where provider='github' and forge_id=${seed.person.forgeId}`;
    expect(suppression.login).toBe(seed.person.login);
  });
  it("review: a known different numeric identity beats a reused login", async () => {
    const seed = await seedHandScenario();
    await sql`update pull_requests set author_github_login=${seed.person.login}, body='Other person legacy body' where id=${seed.memberPullRequest.id}`;
    await removeForgePerson(sql, {provider:'github',forgeId:seed.person.forgeId}, {confirm:true});
    const [row] = await sql`select author_github_user_id, body from pull_requests where id=${seed.memberPullRequest.id}`;
    expect(row.body).toBe('Other person legacy body');
    expect(Number(row.author_github_user_id)).toBe(seed.member.githubUserId);
  });
  it("review: resolve a login known only by a claim-assignee ID", async () => {
    const seed = await seedHandScenario();
    const historicalLogin = `historical-${seed.person.forgeId}`;
    await sql`update issues set owner_github_login=${historicalLogin}, claim_assignee_github_login=${historicalLogin}, claim_assignee_github_user_id=${seed.person.forgeId} where id=${seed.personIssue.id}`;
    await removeForgePerson(sql, {provider:'github',forgeId:seed.person.forgeId}, {confirm:true});
    const [row] = await sql`select owner_github_login,body from issues where id=${seed.personIssue.id}`;
    expect(row.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(row.body).toBeNull();
  });
  it("review: same GitLab id on another instance belongs to another person", async () => {
    const first = await seedHandScenario();
    const other = await seedHandScenario();
    await sql`update registered_repositories set provider='gitlab',instance_url='https://first.example',forge_project_id=github_repository_id where id=${first.repositoryId}`;
    await sql`update registered_repositories set provider='gitlab',instance_url='https://other.example',forge_project_id=github_repository_id where id=${other.repositoryId}`;
    await sql`update pull_requests set author_github_user_id=${first.person.forgeId} where id=${other.personPullRequest.id}`;
    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token) values
      (${first.member.id}, 'gitlab', 'https://first.example', ${first.person.forgeId}, ${first.person.login}, ${Buffer.from("first credential")}),
      (${other.member.id}, 'gitlab', 'https://other.example', ${first.person.forgeId}, ${other.person.login}, ${Buffer.from("other credential")})`;
    await removeForgePerson(sql, {provider:'gitlab',instanceUrl:'https://first.example/',forgeId:first.person.forgeId, login:first.person.login}, {confirm:true});
    const [row] = await sql`select author_github_login,body from pull_requests where id=${other.personPullRequest.id}`;
    expect(row.body).toBe(other.personPullRequest.body);
    expect((await rowJson("users", other.member.id)).deleted_at).toBeNull();
    const [otherIdentity] = await sql`select encrypted_token from user_forge_identities where user_id=${other.member.id}`;
    expect(otherIdentity!.encrypted_token).not.toBeNull();
  });
  it("review: provider scoping includes changes without a pull request", async () => {
    const seed = await seedHandScenario();
    await sql`update registered_repositories set provider='gitlab',instance_url='https://other.example',forge_project_id=github_repository_id where id=${seed.repositoryId}`;
    await sql`update reconciliation_changes set pull_request_id=null where id=${seed.changeRecord.id}`;
    const doc = await exportForgePerson(sql,{provider:'github',forgeId:seed.person.forgeId});
    expect(storeOf(doc,'reconciliation_changes').rows).not.toEqual(expect.arrayContaining([expect.objectContaining({id:seed.changeRecord.id})]));
  });
});

  it.each([false, true])("review lifecycle: repeat removal followed by full import (renamed=%s)", async (renamed) => {
    const seedNumber = nextSeedNumber();
    const forgeId = 9_100_000 + seedNumber;
    const login = `outsider-${seedNumber}`;
    const sponsorGitHubId = 9_200_000 + seedNumber;
    const memberGitHubId = 9_300_000 + seedNumber;
    const githubRepositoryId = 9_400_000 + seedNumber;
    const [sponsor] = await sql<{ id: string; github_login: string }[]>`
      insert into users (github_user_id, github_login, encrypted_oauth_token)
      values (${sponsorGitHubId}, ${`sponsor-${seedNumber}`},
              ${Buffer.from(encryptToken("sponsor-token", TEST_ENCRYPTION_KEY,
                credentialBinding.userOAuthToken(sponsorGitHubId)), "utf8")})
      returning id, github_login
    `;
    await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${memberGitHubId}, ${`member-${seedNumber}`}) returning id
    `;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
        created_at
      ) values (
        ${githubRepositoryId}, ${`ds-owner/repo-${seedNumber}`}, ${sponsor!.id}, 'PUBLIC',
        ${githubRepositoryId + 100}, ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z'
      ) returning id
    `;
    const repositoryId = String(repository!.id);
    const mergedAt = "2026-09-01T12:00:00Z";
    const personComment = {
      id: `comment-${seedNumber}`, databaseId: 900_000 + seedNumber,
      authorLogin: login, authorGitHubUserId: forgeId,
      body: "Seeing this too.", createdAt: "2026-09-01T09:00:00Z", lastEditedAt: null,
    };
    const sponsorRationale = {
      id: `comment-${seedNumber}-s`, databaseId: 900_100 + seedNumber,
      authorLogin: `sponsor-${seedNumber}`, authorGitHubUserId: sponsorGitHubId,
      body: "Settled on the recorded difficulty.", createdAt: "2026-09-01T11:30:00Z", lastEditedAt: null,
    };
    const closingPullRequest = (prId: number, number: number, author: string, authorId: number): GitHubPullRequest => ({
      id: prId, number, title: `Work ${number}`, body: "PR body", url: "https://github.com/ds-owner/repo/pull/1",
      state: "MERGED", mergedAt, mergeCommitOid: String(prId).padStart(40, "3"), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: author, authorGitHubUserId: authorId,
      repositoryGitHubId: githubRepositoryId, repositoryNameWithOwner: `ds-owner/repo-${seedNumber}`,
    });
    const personIssueId = 9_500_000 + seedNumber;
    const memberIssueId = 9_500_100 + seedNumber;
    const issue = (issueId: number, number: number, prNumber: number, author: string, authorId: number, prId: number): GitHubIssue => ({
      id: issueId, number, title: `Issue ${number}`, body: "Issue body",
      url: "https://github.com/ds-owner/repo/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-09-01T07:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      closedAt: "2026-09-01T12:00:00Z", authorLogin: author, authorGitHubUserId: authorId,
      labels: ["M"], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      history: [
        { kind: "LABELED", id: `opening-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "M", createdAt: "2026-09-01T08:00:00Z" },
        { kind: "LABELED", id: `settled-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "delivered/6", createdAt: "2026-09-01T11:00:00Z" },
      ],
      comments: issueId === personIssueId ? [personComment, sponsorRationale] : [sponsorRationale],
      closingPullRequests: [closingPullRequest(prId, prNumber, author, authorId)],
    });
    const double: ForgeDouble = {
      store: new PostgresFoldStore(sql, TEST_ENCRYPTION_KEY),
      clock: start,
      issues: [
        issue(personIssueId, 1, 11, login, forgeId, 9_600_000 + seedNumber),
        issue(memberIssueId, 2, 12, `member-${seedNumber}`, memberGitHubId, 9_600_100 + seedNumber),
      ],
      run: async (options?: { rederive?: boolean }) =>
        reconcileRepository(
          {
            store: double.store,
            github: gatewayDouble(double.issues, githubRepositoryId),
            now: () => double.clock,
          },
          repositoryId,
          options,
        ),
    };
    const personIssueRow = () =>
      sql<{ owner_github_login: string; body: string | null }[]>`
        select owner_github_login, body from issues
        where repository_id = ${repositoryId} and github_issue_id = ${personIssueId}
      `;


    await double.run();
    await removeForgePerson(sql,{provider:'github',forgeId},{confirm:true});
    await removeForgePerson(sql,{provider:'github',forgeId},{confirm:true});
    if (renamed) double.issues[0]!.authorLogin = `renamed-${forgeId}`;
    double.clock=new Date('2026-09-08T10:06:00Z');
    await double.run({rederive:true});
    const [actual]=await personIssueRow();
    expect(actual.owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
   });
  it("review lifecycle: cached fold preserves credited member attribution", async () => {
    const seedNumber = nextSeedNumber();
    const forgeId = 9_100_000 + seedNumber;
    const login = `outsider-${seedNumber}`;
    const sponsorGitHubId = 9_200_000 + seedNumber;
    const memberGitHubId = 9_300_000 + seedNumber;
    const githubRepositoryId = 9_400_000 + seedNumber;
    const [sponsor] = await sql<{ id: string; github_login: string }[]>`
      insert into users (github_user_id, github_login, encrypted_oauth_token)
      values (${sponsorGitHubId}, ${`sponsor-${seedNumber}`},
              ${Buffer.from(encryptToken("sponsor-token", TEST_ENCRYPTION_KEY,
                credentialBinding.userOAuthToken(sponsorGitHubId)), "utf8")})
      returning id, github_login
    `;
    await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${memberGitHubId}, ${`member-${seedNumber}`}) returning id
    `;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
        created_at
      ) values (
        ${githubRepositoryId}, ${`ds-owner/repo-${seedNumber}`}, ${sponsor!.id}, 'PUBLIC',
        ${githubRepositoryId + 100}, ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z'
      ) returning id
    `;
    const repositoryId = String(repository!.id);
    const mergedAt = "2026-09-01T12:00:00Z";
    const personComment = {
      id: `comment-${seedNumber}`, databaseId: 900_000 + seedNumber,
      authorLogin: login, authorGitHubUserId: forgeId,
      body: "Seeing this too.", createdAt: "2026-09-01T09:00:00Z", lastEditedAt: null,
    };
    const sponsorRationale = {
      id: `comment-${seedNumber}-s`, databaseId: 900_100 + seedNumber,
      authorLogin: `sponsor-${seedNumber}`, authorGitHubUserId: sponsorGitHubId,
      body: "Settled on the recorded difficulty.", createdAt: "2026-09-01T11:30:00Z", lastEditedAt: null,
    };
    const closingPullRequest = (prId: number, number: number, author: string, authorId: number): GitHubPullRequest => ({
      id: prId, number, title: `Work ${number}`, body: "PR body", url: "https://github.com/ds-owner/repo/pull/1",
      state: "MERGED", mergedAt, mergeCommitOid: String(prId).padStart(40, "3"), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: author, authorGitHubUserId: authorId,
      repositoryGitHubId: githubRepositoryId, repositoryNameWithOwner: `ds-owner/repo-${seedNumber}`,
    });
    const personIssueId = 9_500_000 + seedNumber;
    const memberIssueId = 9_500_100 + seedNumber;
    const issue = (issueId: number, number: number, prNumber: number, author: string, authorId: number, prId: number): GitHubIssue => ({
      id: issueId, number, title: `Issue ${number}`, body: "Issue body",
      url: "https://github.com/ds-owner/repo/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-09-01T07:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      closedAt: "2026-09-01T12:00:00Z", authorLogin: author, authorGitHubUserId: authorId,
      labels: ["M"], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      history: [
        { kind: "LABELED", id: `opening-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "M", createdAt: "2026-09-01T08:00:00Z" },
        { kind: "LABELED", id: `settled-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "delivered/6", createdAt: "2026-09-01T11:00:00Z" },
      ],
      comments: issueId === personIssueId ? [personComment, sponsorRationale] : [sponsorRationale],
      closingPullRequests: [closingPullRequest(prId, prNumber, author, authorId)],
    });
    const double: ForgeDouble = {
      store: new PostgresFoldStore(sql, TEST_ENCRYPTION_KEY),
      clock: start,
      issues: [
        issue(personIssueId, 1, 11, login, forgeId, 9_600_000 + seedNumber),
        issue(memberIssueId, 2, 12, `member-${seedNumber}`, memberGitHubId, 9_600_100 + seedNumber),
      ],
      run: async (options?: { rederive?: boolean }) =>
        reconcileRepository(
          {
            store: double.store,
            github: gatewayDouble(double.issues, githubRepositoryId),
            now: () => double.clock,
          },
          repositoryId,
          options,
        ),
    };
    const personSettlementRow = () =>
      sql<{ creditor_github_login: string | null; creditor_github_user_id: string | null; creditor_id: string | null; status: string }[]>`
        select creditor_github_login, creditor_github_user_id::text as creditor_github_user_id,
               creditor_id, status::text as status
        from settlements join issues on issues.id = settlements.issue_id
        where issues.repository_id = ${repositoryId} and issues.github_issue_id = ${personIssueId}
      `;


    const [person]=await sql`insert into users (github_user_id,github_login) values (${forgeId},${login}) returning id`;
    await double.run();
    const [before]=await personSettlementRow();
    expect(before.creditor_id).toBe(person.id);
    await removeForgePerson(sql,{provider:'github',forgeId},{confirm:true});
    double.clock=new Date('2026-09-08T10:04:00Z');
    await double.run();
    const [actual]=await personSettlementRow();
    expect(actual.creditor_id).toBe(person.id);
    expect(actual.status).toBe(before.status);
   });
describe("identity authority and access inventory", () => {
  it("exports only the numeric subject when another id reuses the login", async () => {
    const seed = await seedHandScenario();
    await sql`update pull_requests set author_github_login=${seed.person.login} where id=${seed.memberPullRequest.id}`;
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(storeOf(doc, "pull_requests").rows).toEqual([expect.objectContaining({ id: seed.personPullRequest.id })]);
  });
  it("refuses a GitLab request without an instance before writing", async () => {
    const seed = await seedHandScenario();
    await expect(removeForgePerson(sql, { provider: "gitlab", forgeId: seed.person.forgeId }, { confirm: true })).rejects.toThrow();
  });
  it.each([false, true])("linked GitLab removal resolves account and sponsor refusal (blocked=%s)", async (blocked) => {
    const seed = await seedHandScenario();
    const userId = blocked ? seed.sponsor.id : seed.member.id;
    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
      values (${userId}, 'gitlab', 'https://gitlab.example', ${seed.person.forgeId}, ${seed.person.login}, ${Buffer.from("test credential")})`;
    const outcome = await removeForgePerson(sql, { provider: "gitlab", instanceUrl: "https://gitlab.example", forgeId: seed.person.forgeId }, { confirm: true });
    expect(outcome.kind).toBe(blocked ? "SPONSOR_BLOCKED" : "REMOVED");
    expect((await rowJson("users", userId)).deleted_at === null).toBe(blocked);
  });
  it.each(["assignee", "actor"])("resolves aliases whose only id evidence is cache %s", async (role) => {
    const seed = await seedHandScenario();
    const alias = `cache-${role}-${seed.person.forgeId}`;
    const [fact] = await sql`select payload from repository_reconciliation_evidence_facts where repository_id=${seed.repositoryId}`;
    const payload = fact!.payload;
    if (role === "assignee") { payload.claimAssigneeGitHubLogin = alias; payload.claimAssigneeGitHubUserId = seed.person.forgeId; }
    else { payload.history.push({ kind: "LABELED", id: "actor-only", actorLogin: alias, actorGitHubUserId: seed.person.forgeId, label: "M", createdAt: "2026-09-01T08:00:00Z" }); }
    await sql`update repository_reconciliation_evidence_facts set payload=${sql.json(payload)} where repository_id=${seed.repositoryId}`;
    await sql`update issues set owner_github_login=${alias} where id=${seed.personIssue.id}`;
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(doc.logins).toContain(alias);
    await removeForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId }, { confirm: true });
    expect((await rowJson("issues", seed.personIssue.id)).owner_github_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    await removeForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId }, { confirm: true });
    const repeated = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(repeated.logins).toEqual(doc.logins);
    expect(repeated.logins).not.toContain(DATA_SUBJECT_TOMBSTONE_LOGIN);
  });

});

  it("review: GitHub removal clears the linked GitLab token of the deleted account", async () => {
    const seed = await seedHandScenario();
    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
      values (${seed.member.id}, 'gitlab', 'https://gitlab.example', ${seed.person.forgeId}, ${seed.person.login}, ${Buffer.from('review token')})`;
    await removeForgePerson(sql, {provider:'github', forgeId:seed.member.githubUserId}, {confirm:true});
    expect((await rowJson("users", seed.member.id)).deleted_at).not.toBeNull();
    const [identity] = await sql`select encrypted_token, forge_login from user_forge_identities where user_id=${seed.member.id}`;
    expect(identity.encrypted_token).toBeNull();
  });

  it.each([true, false])("review lifecycle: policy publication honours numeric actor authority (subject=%s)", async (actorIsSubject) => {
    const seedNumber = nextSeedNumber();
    const forgeId = 9_100_000 + seedNumber;
    const login = `outsider-${seedNumber}`;
    const sponsorGitHubId = 9_200_000 + seedNumber;
    const memberGitHubId = 9_300_000 + seedNumber;
    const githubRepositoryId = 9_400_000 + seedNumber;
    const [sponsor] = await sql<{ id: string; github_login: string }[]>`
      insert into users (github_user_id, github_login, encrypted_oauth_token)
      values (${sponsorGitHubId}, ${`sponsor-${seedNumber}`},
              ${Buffer.from(encryptToken("sponsor-token", TEST_ENCRYPTION_KEY,
                credentialBinding.userOAuthToken(sponsorGitHubId)), "utf8")})
      returning id, github_login
    `;
    await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${memberGitHubId}, ${`member-${seedNumber}`}) returning id
    `;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
        created_at
      ) values (
        ${githubRepositoryId}, ${`ds-owner/repo-${seedNumber}`}, ${sponsor!.id}, 'PUBLIC',
        ${githubRepositoryId + 100}, ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z'
      ) returning id
    `;
    const repositoryId = String(repository!.id);
    const mergedAt = "2026-09-01T12:00:00Z";
    const personComment = {
      id: `comment-${seedNumber}`, databaseId: 900_000 + seedNumber,
      authorLogin: login, authorGitHubUserId: forgeId,
      body: "Seeing this too.", createdAt: "2026-09-01T09:00:00Z", lastEditedAt: null,
    };
    const sponsorRationale = {
      id: `comment-${seedNumber}-s`, databaseId: 900_100 + seedNumber,
      authorLogin: `sponsor-${seedNumber}`, authorGitHubUserId: sponsorGitHubId,
      body: "Settled on the recorded difficulty.", createdAt: "2026-09-01T11:30:00Z", lastEditedAt: null,
    };
    const closingPullRequest = (prId: number, number: number, author: string, authorId: number): GitHubPullRequest => ({
      id: prId, number, title: `Work ${number}`, body: "PR body", url: "https://github.com/ds-owner/repo/pull/1",
      state: "MERGED", mergedAt, mergeCommitOid: String(prId).padStart(40, "3"), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: author, authorGitHubUserId: authorId,
      repositoryGitHubId: githubRepositoryId, repositoryNameWithOwner: `ds-owner/repo-${seedNumber}`,
    });
    const personIssueId = 9_500_000 + seedNumber;
    const memberIssueId = 9_500_100 + seedNumber;
    const issue = (issueId: number, number: number, prNumber: number, author: string, authorId: number, prId: number): GitHubIssue => ({
      id: issueId, number, title: `Issue ${number}`, body: "Issue body",
      url: "https://github.com/ds-owner/repo/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-09-01T07:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      closedAt: "2026-09-01T12:00:00Z", authorLogin: author, authorGitHubUserId: authorId,
      labels: ["M"], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      history: [
        { kind: "LABELED", id: `opening-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "M", createdAt: "2026-09-01T08:00:00Z" },
        { kind: "LABELED", id: `settled-${issueId}`, actorLogin: `sponsor-${seedNumber}`,
          actorGitHubUserId: sponsorGitHubId, label: "delivered/6", createdAt: "2026-09-01T11:00:00Z" },
      ],
      comments: issueId === personIssueId ? [personComment, sponsorRationale] : [sponsorRationale],
      closingPullRequests: [closingPullRequest(prId, prNumber, author, authorId)],
    });
    const double: ForgeDouble = {
      store: new PostgresFoldStore(sql, TEST_ENCRYPTION_KEY),
      clock: start,
      issues: [
        issue(personIssueId, 1, 11, login, forgeId, 9_600_000 + seedNumber),
        issue(memberIssueId, 2, 12, `member-${seedNumber}`, memberGitHubId, 9_600_100 + seedNumber),
      ],
      run: async (options?: { rederive?: boolean }) =>
        reconcileRepository(
          {
            store: double.store,
            github: gatewayDouble(double.issues, githubRepositoryId),
            now: () => double.clock,
          },
          repositoryId,
          options,
        ),
    };


    await double.run();
    await removeForgePerson(sql,{provider:'github',forgeId},{confirm:true});
    const opening=double.issues[0]!.history[0]!;
    opening.actorLogin=login; opening.actorGitHubUserId=actorIsSubject ? forgeId : memberGitHubId;
    double.clock=new Date('2026-09-08T10:06:00Z');
    await double.run({rederive:true});
    const actual=await sql`select violation from repository_policy_violations where repository_id=${repositoryId}`;
    expect(actual).toHaveLength(1);
    expect(actual[0]!.violation.openingSourceActorLogin).toBe(actorIsSubject ? DATA_SUBJECT_TOMBSTONE_LOGIN : login);
    if (actorIsSubject) expect(JSON.stringify(actual)).not.toContain(login);
    else expect(actual[0]!.violation.reason).toContain(login);
   });


  it("exports linked identities with secret presence flags for a GitHub account", async () => {
    const seed = await seedHandScenario();
    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
      values (${seed.member.id}, 'gitlab', 'https://gitlab.example', ${seed.person.forgeId}, ${seed.person.login}, ${Buffer.from("test credential")})`;
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.member.githubUserId });
    expect(storeOf(doc, "user_forge_identities").rows).toEqual([expect.objectContaining({ user_id: seed.member.id, hasStoredToken: true })]);
    expect(JSON.stringify(doc)).not.toContain("encrypted_token");
  });

  it("exports retained policy rows and the suppression decision itself", async () => {
    const seed = await seedHandScenario();
    await sql`insert into repository_policy_violations (repository_id, violation) values (${seed.repositoryId}, ${sql.json({ code: "OPENING_LABEL_UNAUTHORIZED", openingSourceActorLogin: seed.person.login, reason: `Actor ${seed.person.login}` })})`;
    await removeForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId }, { confirm: true });
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(storeOf(doc, "repository_policy_violations").count).toBe(1);
    expect(storeOf(doc, "data_subject_suppressions").rows).toEqual([expect.objectContaining({ forge_id: seed.person.forgeId })]);
  });
describe("actor-only publication lifecycle", () => {
  it("keeps an opening actor tombstoned after removal and a real materialization", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const forgeId = 9_100_000 + nextSeedNumber();
    const login = `actor-only-${forgeId}`;
    fold.issues[0]!.openingSourceActorLogin = login;
    fold.settlements[0]!.settledLabelActorLogin = login;
    fold.settlements[0]!.settledRationaleActorLogin = login;
    fold.selfWorkCalibrations[0]!.actualLabelActorLogin = login;
    fold.selfWorkCalibrations[0]!.rationaleActorLogin = login;
    const publish = async () => {
      const runId = await store.beginRun(repositoryId);
      await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold: structuredClone(fold) }));
      return runId;
    };
    await publish();
    const actors = () => sql`select opening_source_actor_login from issues where repository_id=${repositoryId} and github_issue_id=${fold.issues[0]!.githubIssueId}`;
    expect((await actors())[0]!.opening_source_actor_login).toBe(login);
    await removeForgePerson(sql, { provider: "github", forgeId, login }, { confirm: true });
    expect((await actors())[0]!.opening_source_actor_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    const postRemovalRun = await publish();
    expect((await actors())[0]!.opening_source_actor_login).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    const [journal] = await sql`select count(*)::int as count from reconciliation_changes as c join reconciliation_runs as r on r.id=c.reconciliation_run_id where r.id=${postRemovalRun} and c.after_state::text like ${`%${login}%`}`;
    expect(journal!.count).toBe(0);
  });
});

describe("publication identity authority", () => {
  it("keeps a recycled-login author, assignee, actor and commenter with different ids", async () => {
    const seed = await seedHandScenario();
    const [fact] = await sql`select payload from repository_reconciliation_evidence_facts where repository_id=${seed.repositoryId}`;
    const payload = fact!.payload;
    payload.claimAssigneeGitHubLogin = seed.person.login;
    payload.claimAssigneeGitHubUserId = seed.member.githubUserId;
    payload.history[0].actorLogin = seed.person.login;
    payload.history[0].actorGitHubUserId = seed.member.githubUserId;
    payload.comments[1].authorLogin = seed.person.login;
    payload.comments[1].authorGitHubUserId = seed.member.githubUserId;
    payload.closingPullRequests.push({ authorLogin: seed.person.login, authorGitHubUserId: seed.member.githubUserId });
    scrubIssueIdentity(payload, { forgeId: seed.person.forgeId, logins: new Set([seed.person.login]) });
    expect(payload.authorLogin).toBe(DATA_SUBJECT_TOMBSTONE_LOGIN);
    expect(payload.claimAssigneeGitHubUserId).toBe(seed.member.githubUserId);
    expect(payload.history[0].actorLogin).toBe(seed.person.login);
    expect(payload.comments[1].authorGitHubUserId).toBe(seed.member.githubUserId);
    expect(payload.closingPullRequests[1].authorGitHubUserId).toBe(seed.member.githubUserId);
  });
  it("applies suppression only in the requested GitLab instance at publication", async () => {
    const left = await materializeRepositoryFixture(sql);
    const right = await materializeRepositoryFixture(sql);
    const forgeId = left.fold.pullRequests[0]!.authorGitHubUserId!;
    for (const [fixture, origin] of [[left, "https://left.example"], [right, "https://right.example"]] as const) {
      await sql`update registered_repositories set provider='gitlab', instance_url=${origin}, forge_project_id=github_repository_id where id=${fixture.repositoryId}`;
      fixture.fold.pullRequests[0]!.authorGitHubUserId = forgeId;
    }
    await removeForgePerson(sql, { provider: "gitlab", instanceUrl: "https://LEFT.example/", forgeId }, { confirm: true });
    const leftCopy = structuredClone(left.fold);
    const rightCopy = structuredClone(right.fold);
    await sql.begin(async (tx) => {
      await scrubSuppressedForgeData(tx, left.repositoryId, { fold: leftCopy });
      await scrubSuppressedForgeData(tx, right.repositoryId, { fold: rightCopy });
    });
    expect(leftCopy.pullRequests[0]!.authorGitHubUserId).toBeNull();
    expect(rightCopy.pullRequests[0]!.authorGitHubUserId).toBe(forgeId);
    const [suppression] = await sql`select instance_url from data_subject_suppressions where provider='gitlab' and forge_id=${forgeId}`;
    expect(suppression!.instance_url).toBe("https://left.example");
  });
});

describe("journal namespace provenance", () => {
  it("exports PR-less policy records and a journal row surviving actual PR deletion only in its instance", async () => {
    const seed = await seedHandScenario();
    await sql`update registered_repositories set provider='gitlab',instance_url='https://journal.example',forge_project_id=github_repository_id where id=${seed.repositoryId}`;
    const [change] = await sql`select reconciliation_run_id from reconciliation_changes where id=${seed.changeRecord.id}`;
    const [policy] = await sql`insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind, after_state)
      values (${change!.reconciliation_run_id}, 'POLICY_VIOLATION', 'POLICY_VIOLATION', ${sql.json({ code: "OPENING_LABEL_UNAUTHORIZED", openingSourceActorLogin: seed.person.login })}) returning id`;
    await sql`delete from settlements where pull_request_id=${seed.personPullRequest.id}`;
    await sql`delete from pull_request_issues where pull_request_id=${seed.personPullRequest.id}`;
    await sql`delete from pull_requests where id=${seed.personPullRequest.id}`;
    expect((await rowJson("reconciliation_changes", seed.changeRecord.id)).pull_request_id).toBeNull();
    const right = await exportForgePerson(sql, { provider: "gitlab", instanceUrl: "https://journal.example", forgeId: seed.person.forgeId, login: seed.person.login });
    expect(storeOf(right, "reconciliation_changes").rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seed.changeRecord.id }), expect.objectContaining({ id: policy!.id }),
    ]));
    const other = await exportForgePerson(sql, { provider: "gitlab", instanceUrl: "https://other.example", forgeId: seed.person.forgeId, login: seed.person.login });
    expect(storeOf(other, "reconciliation_changes").rows).toEqual([]);
    const github = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId, login: seed.person.login });
    expect(storeOf(github, "reconciliation_changes").rows).toEqual([]);
  });
});

describe("access-copy numeric authority in JSON stores", () => {
  it("excludes a cache row whose reused login pairs all have a different numeric id", async () => {
    const seed = await seedHandScenario();
    const [fact] = await sql`select payload from repository_reconciliation_evidence_facts where repository_id=${seed.repositoryId}`;
    const payload = fact!.payload;
    payload.authorGitHubUserId = seed.member.githubUserId;
    payload.comments[0].authorGitHubUserId = seed.member.githubUserId;
    payload.closingPullRequests[0].authorGitHubUserId = seed.member.githubUserId;
    await sql`update repository_reconciliation_evidence_facts set payload=${sql.json(payload)} where repository_id=${seed.repositoryId}`;
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(storeOf(doc, "repository_reconciliation_evidence_facts").count).toBe(0);
  });
  it("excludes a journal identity with the subject's old login and a different id", async () => {
    const seed = await seedHandScenario();
    await sql`update reconciliation_changes set after_state=${sql.json({ creditorGitHubLogin: seed.person.login, creditorGitHubUserId: seed.member.githubUserId })} where id=${seed.changeRecord.id}`;
    const doc = await exportForgePerson(sql, { provider: "github", forgeId: seed.person.forgeId });
    expect(storeOf(doc, "reconciliation_changes").rows).toEqual([]);
  });
});

describe("ambiguous policy actor authority", () => {
  it("refuses to guess between different numeric actors using the same verified alias", async () => {
    const seed = await seedHandScenario();
    const [fact] = await sql`select payload from repository_reconciliation_evidence_facts where repository_id=${seed.repositoryId}`;
    const issue = fact!.payload;
    issue.history = [seed.person.forgeId, seed.member.githubUserId].map((id) => ({ kind: "LABELED", id: `opening-${id}`, actorLogin: seed.person.login, actorGitHubUserId: id, label: "M", createdAt: "2026-09-01T08:00:00Z" }));
    const fold = { issues: [], pullRequests: [], settlements: [], selfWorkCalibrations: [], unwritableClosures: [], ledgerEntries: [], policyViolations: [{ code: "OPENING_LABEL_UNAUTHORIZED" as const, githubIssueId: issue.id, openingLabel: "M", openingSourceActorLogin: seed.person.login, reason: `Applied by \`${seed.person.login}\`` }] };
    expect(() => scrubFoldResultForPerson(fold, { forgeId: seed.person.forgeId, logins: new Set([seed.person.login]) }, [issue])).toThrow("Ambiguous policy actor identity.");
  });
});
