import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import type { EnforcementState, PullRequestState } from "@/lib/db/types";
import { ClosedPrDisputeService } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 72_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "dispute_filing", user: "dispute_filing" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  execFileSync("pnpm", ["db:migrate"], {
    env: { ...process.env, OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD: "skip" },
  });
  sql = getSql();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("closed PR dispute filing", () => {
  it.each(["ACTIVE", "BANNED"] satisfies EnforcementState[])(
    "auto-resolves the same issue's landing and journals the live %s state without changing eligibility",
    async (state) => {
      const fixture = await buildFixture();
      const landing = await insertPullRequest(fixture, "MERGED");
      await sql`update users set enforcement_state = ${state} where id = ${fixture.contributorId}`;
      await sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${fixture.contributorId}, ${fixture.sponsorId}, 'ACTIVE', ${state}, 'Current state.', now() - interval '1 day')
      `;
      const [before] = await sql`
        select participation_eligible_at(${fixture.contributorId}, now()) as eligible
      `;
      const result = await store().fileDispute(filing(fixture));
      expect(result).toMatchObject({ kind: "ok", value: {
        contributorId: fixture.contributorId, pullRequestId: fixture.pullRequestId, issueId: fixture.issueId,
        landedPullRequestId: landing.id, landedCommitUrl: null, requestReason: "My contribution landed elsewhere.",
        state: "OPEN", decision: null, decidedBy: null, decidedBySoleModerator: false,
        decidedReason: null, decidedAt: null, moderatorFigure: null, awardedPoints: null,
        createdAt: expect.any(String),
      } });
      if (result.kind !== "ok") throw new Error("Expected a filed dispute.");
      const events = await sql`
        select target_user_id, actor_id, audit_id, prior_state, new_state, reason,
          dispute_request_id, contest_request_id, credential_kind, credential_token_id
        from moderation_events where dispute_request_id = ${result.value.id}
      `;
      expect(events).toEqual([{
        target_user_id: fixture.contributorId, actor_id: fixture.contributorId, audit_id: null,
        prior_state: state, new_state: state, reason: "My contribution landed elsewhere.",
        dispute_request_id: result.value.id, contest_request_id: null, credential_kind: null, credential_token_id: null,
      }]);
      const [after] = await sql`
        select enforcement_state, participation_eligible_at(${fixture.contributorId}, now()) as eligible
        from users where id = ${fixture.contributorId}
      `;
      expect(before.eligible).toBe(state === "ACTIVE");
      expect(after).toEqual({ enforcement_state: state, eligible: before.eligible });
    },
  );

  it("requires the stored author, even when the requester is the sponsor", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    await expect(store().fileDispute({ ...filing(fixture), accountId: fixture.sponsorId }))
      .resolves.toEqual({ kind: "forbidden" });
    await sql`update pull_requests set author_id = null where id = ${fixture.pullRequestId}`;
    await expect(store().fileDispute(filing(fixture))).resolves.toEqual({ kind: "forbidden" });
    await expectNoRequests(fixture);
  });

  it.each(["OPEN", "MERGED"] satisfies PullRequestState[])("refuses a target in state %s", async (state) => {
    const fixture = await buildFixture();
    await sql`update pull_requests set state = ${state} where id = ${fixture.pullRequestId}`;
    await expect(store().fileDispute({ ...filing(fixture), landedCommitUrl: "A landing commit" }))
      .resolves.toEqual({ kind: "invalid_state" });
    await expectNoRequests(fixture);
  });

  it("refuses unknown PRs as invalid state and unknown accounts as not found", async () => {
    const fixture = await buildFixture();
    await expect(store().fileDispute({ ...filing(fixture), pullRequestId: randomUUID() }))
      .resolves.toEqual({ kind: "invalid_state" });
    await expect(store().fileDispute({ ...filing(fixture), accountId: randomUUID() }))
      .resolves.toEqual({ kind: "not_found" });
  });

  it("requires landing evidence, ignoring unmerged same-issue rows and merges on other issues", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "OPEN");
    await insertPullRequest(fixture, "CLOSED");
    const otherIssueId = await insertIssue(fixture.repositoryId);
    await insertPullRequest({ ...fixture, issueId: otherIssueId }, "MERGED");
    await expect(store().fileDispute(filing(fixture))).resolves.toEqual({ kind: "invalid_input" });
    await expectNoRequests(fixture);
  });

  it("accepts a supplied merged PR in the same repository even on another issue", async () => {
    const fixture = await buildFixture();
    const otherIssueId = await insertIssue(fixture.repositoryId);
    const landing = await insertPullRequest({ ...fixture, issueId: otherIssueId }, "MERGED");
    await expect(store().fileDispute({ ...filing(fixture), landedPullRequestUrl: landing.url }))
      .resolves.toMatchObject({ kind: "ok", value: {
        issueId: fixture.issueId, landedPullRequestId: landing.id, landedCommitUrl: null,
      } });
  });

  it("accepts nonblank commit text without requiring a PR row", async () => {
    const fixture = await buildFixture();
    await expect(service().fileDispute({ id: fixture.contributorId }, {
      pullRequestId: fixture.pullRequestId, reason: "  Direct push.  ", landedCommitUrl: "  landing commit reference  ",
    })).resolves.toMatchObject({
      landedCommitUrl: "landing commit reference", landedPullRequestId: null, requestReason: "Direct push.",
    });
  });

  it("looks up supplied PR numbers only in the target's registered repository", async () => {
    const fixture = await buildFixture();
    const other = await buildFixture();
    const foreignLanding = await insertPullRequest(other, "MERGED");
    const url = foreignLanding.url.replace(other.ownerName, fixture.ownerName);
    await expect(store().fileDispute({ ...filing(fixture), landedPullRequestUrl: url }))
      .resolves.toEqual({ kind: "invalid_input" });
    await expectNoRequests(fixture);
  });

  it("matches supplied GitLab merge requests to the registered instance and project", async () => {
    const fixture = await buildFixture();
    const instanceUrl = "https://gitlab.example.test";
    const ownerName = `group/subgroup/${fixture.ownerName}`;
    await sql`
      update registered_repositories set provider = 'gitlab', instance_url = ${instanceUrl}, owner_name = ${ownerName}
      where id = ${fixture.repositoryId}
    `;
    const landing = await insertPullRequest({ ...fixture, issueId: await insertIssue(fixture.repositoryId) }, "MERGED");
    const number = landing.url.split("/").at(-1);
    const url = `${instanceUrl}/${ownerName}/-/merge_requests/${number}`;
    await expect(store().fileDispute({ ...filing(fixture), landedPullRequestUrl: url.replace(instanceUrl, "https://other.example.test") }))
      .resolves.toEqual({ kind: "invalid_input" });
    await expect(service().fileDispute({ id: fixture.contributorId }, { ...filing(fixture), landedPullRequestUrl: ` ${url} ` }))
      .resolves.toMatchObject({ landedPullRequestId: landing.id, landedCommitUrl: null });
  });

  it.each(["pull", "commit", "both"])("refuses redundant %s evidence when a same-issue merge exists", async (kind) => {
    const fixture = await buildFixture();
    const landing = await insertPullRequest(fixture, "MERGED");
    await expect(store().fileDispute({
      ...filing(fixture),
      ...(kind !== "commit" ? { landedPullRequestUrl: landing.url } : {}),
      ...(kind !== "pull" ? { landedCommitUrl: "commit reference" } : {}),
    })).resolves.toEqual({ kind: "invalid_input" });
    await expectNoRequests(fixture);
  });

  it("refuses both supplied evidence forms when there is no automatic landing", async () => {
    const fixture = await buildFixture();
    const landing = await insertPullRequest({ ...fixture, issueId: await insertIssue(fixture.repositoryId) }, "MERGED");
    await expect(store().fileDispute({
      ...filing(fixture), landedPullRequestUrl: landing.url, landedCommitUrl: "commit reference",
    })).resolves.toEqual({ kind: "invalid_input" });
    await expectNoRequests(fixture);
  });

  it.each(["OPEN", "CLOSED"] satisfies PullRequestState[])("refuses a supplied %s landing PR", async (state) => {
    const fixture = await buildFixture();
    const landing = await insertPullRequest(fixture, state);
    await expect(store().fileDispute({ ...filing(fixture), landedPullRequestUrl: landing.url }))
      .resolves.toEqual({ kind: "invalid_input" });
    await expectNoRequests(fixture);
  });

  it.each(["other repository", "other host", "unknown number", "malformed", "overflow number"])(
    "refuses supplied PR evidence with %s", async (kind) => {
      const fixture = await buildFixture();
      const landing = await insertPullRequest({ ...fixture, issueId: await insertIssue(fixture.repositoryId) }, "MERGED");
      const urls: Record<string, string> = {
        "other repository": landing.url.replace(fixture.ownerName, "elsewhere/repo"),
        "other host": landing.url.replace("github.com", "example.test"),
        "unknown number": `https://github.com/${fixture.ownerName}/pull/99999`,
        "malformed": "not a pull request URL", "overflow number": `https://github.com/${fixture.ownerName}/pull/99999999999999999999`,
      };
      await expect(store().fileDispute({ ...filing(fixture), landedPullRequestUrl: urls[kind] }))
        .resolves.toEqual({ kind: "invalid_input" });
      await expectNoRequests(fixture);
    },
  );

  it("maps duplicate OPEN filings to a conflict without leaving a second event", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    const first = await service().fileDispute({ id: fixture.contributorId }, filing(fixture));
    await expect(service().fileDispute({ id: fixture.contributorId }, filing(fixture)))
      .rejects.toMatchObject({ name: "ClosedPrDisputeError", code: "CONFLICT" });
    const requests = await store().listRequestsForAccount(fixture.contributorId);
    expect(requests.map((request) => request.id)).toEqual([first.id]);
    const events = await sql`select id from moderation_events where dispute_request_id = ${first.id}`;
    expect(events).toHaveLength(1);
  });

  it("serializes concurrent filings to one OPEN request", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    const results = await Promise.all([store().fileDispute(filing(fixture)), store().fileDispute(filing(fixture))]);
    expect(results.map((result) => result.kind).sort()).toEqual(["invalid_state", "ok"]);
    expect(await store().listRequestsForAccount(fixture.contributorId)).toHaveLength(1);
  });

  it("rolls back the request if the filing event fails", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    await sql.unsafe(`create function reject_dispute_event() returns trigger language plpgsql as $$
      begin if new.dispute_request_id is not null then raise exception 'filing event rejected'; end if; return new; end; $$`);
    await sql.unsafe(`create trigger reject_dispute_event before insert on moderation_events
      for each row execute function reject_dispute_event()`);
    try {
      await expect(store().fileDispute(filing(fixture))).rejects.toThrow("filing event rejected");
      await expectNoRequests(fixture);
    } finally {
      await sql.unsafe("drop trigger reject_dispute_event on moderation_events");
      await sql.unsafe("drop function reject_dispute_event()");
    }
  });

  it("propagates unrelated unique violations and rolls back the filing", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    await sql.unsafe(`create function reject_dispute_event() returns trigger language plpgsql as $$
      begin
        if new.dispute_request_id is not null then
          raise unique_violation using constraint = 'unrelated_event_unique';
        end if;
        return new;
      end; $$`);
    await sql.unsafe(`create trigger reject_dispute_event before insert on moderation_events
      for each row execute function reject_dispute_event()`);
    try {
      await expect(store().fileDispute(filing(fixture))).rejects.toMatchObject({
        code: "23505", constraint_name: "unrelated_event_unique",
      });
      await expectNoRequests(fixture);
    } finally {
      await sql.unsafe("drop trigger reject_dispute_event on moderation_events");
      await sql.unsafe("drop function reject_dispute_event()");
    }
  });

  it("lists only the contributor's disputes, including decided requests, newest first", async () => {
    const fixture = await buildFixture();
    const landing = await insertPullRequest(fixture, "MERGED");
    const [older] = await sql<{ id: string }[]>`
      insert into closed_pr_dispute_requests (
        contributor_id, pull_request_id, issue_id, landed_pull_request_id, request_reason,
        state, decision, decided_by, decided_by_sole_moderator, decided_reason, decided_at,
        moderator_figure, awarded_points, created_at
      ) values (
        ${fixture.contributorId}, ${fixture.pullRequestId}, ${fixture.issueId}, ${landing.id}, 'Older request.',
        'DECIDED', 'GRANTED', ${fixture.sponsorId}, true, 'The contribution landed.', '2026-01-01',
        8, 3, '2025-06-01'
      ) returning id
    `;
    const newer = await service().fileDispute({ id: fixture.contributorId }, filing(fixture));
    const theirs = await buildFixture();
    await insertPullRequest(theirs, "MERGED");
    await service().fileDispute({ id: theirs.contributorId }, filing(theirs));
    const listed = await service().listDisputes({ id: fixture.contributorId });
    expect(listed.map((request) => request.id)).toEqual([newer.id, older.id]);
    expect(listed[1]).toMatchObject({ state: "DECIDED", decision: "GRANTED", decidedBy: fixture.sponsorId,
      decidedReason: "The contribution landed.", decidedAt: "2026-01-01T00:00:00.000Z",
      moderatorFigure: 8, awardedPoints: 3, decidedBySoleModerator: true });
    expect(await service().listDisputes({ id: randomUUID() })).toEqual([]);
  });

  it.each(["", "   ", "x".repeat(2001)])("rejects a blank or oversized filing reason (%#)", async (reason) => {
    const fixture = await buildFixture();
    await expect(service().fileDispute({ id: fixture.contributorId }, { ...filing(fixture), reason }))
      .rejects.toMatchObject({ name: "ClosedPrDisputeError", code: "INVALID_INPUT" });
    await expectNoRequests(fixture);
  });

  it("trims identifiers and accepts a reason at the bound", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    await expect(service().fileDispute({ id: fixture.contributorId }, {
      pullRequestId: ` ${fixture.pullRequestId} `, reason: ` ${"x".repeat(2000)} `,
    })).resolves.toMatchObject({ pullRequestId: fixture.pullRequestId, requestReason: "x".repeat(2000) });
  });

  it.each([
    { pullRequestId: "   " }, { landedCommitUrl: "   " }, { landedPullRequestUrl: "   " },
  ])("rejects blank identifiers or supplied evidence (%#)", async (fields) => {
    const fixture = await buildFixture();
    await expect(service().fileDispute({ id: fixture.contributorId }, { ...filing(fixture), ...fields }))
      .rejects.toMatchObject({ name: "ClosedPrDisputeError", code: "INVALID_INPUT" });
    await expectNoRequests(fixture);
  });

  it("maps store refusals onto service error codes", async () => {
    const fixture = await buildFixture();
    await expect(service().fileDispute({ id: fixture.sponsorId }, filing(fixture)))
      .rejects.toMatchObject({ name: "ClosedPrDisputeError", code: "FORBIDDEN" });
    await expect(service().fileDispute({ id: fixture.contributorId }, { ...filing(fixture), pullRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service().fileDispute({ id: randomUUID() }, filing(fixture)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service().fileDispute({ id: fixture.contributorId }, filing(fixture)))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

function store() { return new PostgresClosedPrDisputeStore(sql); }
function service() { return new ClosedPrDisputeService(store()); }
function filing(fixture: { contributorId: string; pullRequestId: string }) {
  return { accountId: fixture.contributorId, pullRequestId: fixture.pullRequestId, reason: "My contribution landed elsewhere." };
}
async function expectNoRequests(fixture: { contributorId: string }) {
  expect(await sql`select id from closed_pr_dispute_requests where contributor_id = ${fixture.contributorId}`).toEqual([]);
  expect(await sql`select id from moderation_events where target_user_id = ${fixture.contributorId} and dispute_request_id is not null`).toEqual([]);
}
async function insertUser() {
  const id = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${id}, ${`disputer-${id}`}) returning id
  `;
  return row.id;
}
async function insertIssue(repositoryId: string) {
  const id = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
    values (${id}, ${repositoryId}, ${id}, 'Disputed work', '', 'https://example.test/issue', 'CLOSED', 'M', 5, 5)
    returning id
  `;
  return row.id;
}
async function insertPullRequest(fixture: { repositoryId: string; issueId: string; contributorId: string; ownerName: string }, state: PullRequestState) {
  const number = externalId++;
  const url = `https://github.com/${fixture.ownerName}/pull/${number}`;
  const [row] = await sql<{ id: string }[]>`
    insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
      url, title, body, author_id, state)
    values (${number}, ${fixture.repositoryId}, ${fixture.issueId}, ${number}, ${url}, 'Contribution', '', ${fixture.contributorId}, ${state})
    returning id
  `;
  return { id: row.id, url };
}
async function buildFixture() {
  const sponsorId = await insertUser();
  const contributorId = await insertUser();
  const id = externalId++;
  const ownerName = `owner/disputed-${id}`;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${id}, ${ownerName}, ${sponsorId}, 'PUBLIC', ${id}, ${sql.json(validDifficultyScheme())}) returning id
  `;
  const fixture = { sponsorId, contributorId, repositoryId: repository.id, ownerName, issueId: await insertIssue(repository.id) };
  return { ...fixture, pullRequestId: (await insertPullRequest(fixture, "CLOSED")).id };
}
