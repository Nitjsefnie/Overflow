import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import { closeSql, getSql } from "@/lib/db/client";
import type { EnforcementState, PullRequestState } from "@/lib/db/types";
import type { GitHubPullRequestReview } from "@/lib/github/types";
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

  it("allows concurrent pending disputes on different closed PRs of one issue", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    const contributorId = await insertUser();
    const otherPr = await insertPullRequest({ ...fixture, contributorId }, "CLOSED");
    const results = await Promise.all([
      store().fileDispute(filing(fixture)),
      store().fileDispute(filing({ contributorId, pullRequestId: otherPr.id })),
    ]);
    expect(results).toEqual([
      { kind: "ok", value: expect.objectContaining({ state: "OPEN", issueId: fixture.issueId }) },
      { kind: "ok", value: expect.objectContaining({ state: "OPEN", issueId: fixture.issueId }) },
    ]);
    expect(await sql`select id from closed_pr_dispute_requests where issue_id = ${fixture.issueId}`).toHaveLength(2);
  });

  it.each([false, true])("refuses filing after the issue was credited (other PR=%s)", async (otherPr) => {
    const fixture = await decisionFixture();
    await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, decision(fixture));
    const contributorId = otherPr ? await insertUser() : fixture.contributorId;
    const pullRequestId = otherPr ? (await insertPullRequest({ ...fixture, contributorId }, "CLOSED")).id : fixture.pullRequestId;
    const input = filing({ contributorId, pullRequestId });
    await expect(service().fileDispute({ id: contributorId }, input)).rejects.toMatchObject({
      code: "CONFLICT", message: "this issue has already been credited through a granted dispute",
    });
    await expect(store().fileDispute(input)).resolves.toEqual({ kind: "issue_already_credited" });
    expect(await sql`select id from closed_pr_dispute_requests where issue_id = ${fixture.issueId}`).toHaveLength(1);
    expect(await sql`select id from moderation_events where dispute_request_id = ${fixture.requestId}`).toHaveLength(2);
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
        'DECIDED', 'DENIED', ${fixture.sponsorId}, true, 'Insufficient evidence.', '2026-01-01',
        null, null, '2025-06-01'
      ) returning id
    `;
    const newer = await service().fileDispute({ id: fixture.contributorId }, filing(fixture));
    const theirs = await buildFixture();
    await insertPullRequest(theirs, "MERGED");
    await service().fileDispute({ id: theirs.contributorId }, filing(theirs));
    const listed = await service().listDisputes({ id: fixture.contributorId });
    expect(listed.map((request) => request.id)).toEqual([newer.id, older.id]);
    expect(listed[1]).toMatchObject({ state: "DECIDED", decision: "DENIED", decidedBy: fixture.sponsorId,
      decidedReason: "Insufficient evidence.", decidedAt: "2026-01-01T00:00:00.000Z",
      moderatorFigure: null, awardedPoints: null, decidedBySoleModerator: true });
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

describe("closed PR dispute decisions", () => {
  it.each(["sponsorId", "contributorId", "landingCreditorId"] as const)(
    "refuses the conflicted %s while another live moderator exists", async (identity) => {
      const fixture = await decisionFixture();
      await sql`update users set role = 'MODERATOR' where id = ${fixture[identity]}`;
      await expect(store().decideDispute({ ...decision(fixture), moderatorAccountId: fixture[identity] }))
        .resolves.toEqual({ kind: "forbidden_imposer" });
      await expect(service().decideDispute(fixture.requestId, { id: fixture[identity] }, decision(fixture)))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      await expectUndecided(fixture.requestId);
    },
  );

  it("uses only sponsor and contributor conflicts for a commit landing", async () => {
    const fixture = await decisionFixture(true);
    for (const id of [fixture.sponsorId, fixture.contributorId, fixture.landingCreditorId]) {
      await sql`update users set role = 'MODERATOR' where id = ${id}`;
    }
    for (const id of [fixture.sponsorId, fixture.contributorId]) {
      await expect(store().decideDispute({ ...decision(fixture), moderatorAccountId: id }))
        .resolves.toEqual({ kind: "forbidden_imposer" });
    }
    // No PR/forge identity records a landing author for the supplied commit.
    await expect(store().decideDispute({ ...decision(fixture), moderatorAccountId: fixture.landingCreditorId }))
      .resolves.toMatchObject({ kind: "ok", value: { decidedBy: fixture.landingCreditorId, decidedBySoleModerator: false } });
  });

  it.each(["sponsorId", "contributorId", "landingCreditorId", "moderatorId"] as const)(
    "allows sole live moderator %s and records the flag from the fresh roster", async (identity) => {
      const fixture = await decisionFixture();
      await sql`update users set role = 'MEMBER' where role = 'MODERATOR'`;
      await sql`update users set role = 'MODERATOR' where id = ${fixture[identity]}`;
      const retired = await insertUser();
      await sql`update users set role = 'MODERATOR', deleted_at = now() where id = ${retired}`;
      const result = await service().decideDispute(fixture.requestId, { id: fixture[identity] }, decision(fixture));
      expect(result).toMatchObject({ state: "DECIDED", decision: "GRANTED", moderatorFigure: 6,
        awardedPoints: 6, decidedBy: fixture[identity], decidedBySoleModerator: true });
      const [row] = await sql`select decided_by_sole_moderator from closed_pr_dispute_requests where id = ${fixture.requestId}`;
      expect(row.decided_by_sole_moderator).toBe(true);
    },
  );

  it("grants with one adjustment, linked decision event, reversal and balanced ledger legs", async () => {
    const fixture = await decisionFixture();
    const settlementId = await insertLandingSettlement(fixture, fixture.landingCreditorId);
    const before = await sql`select * from settlements where id = ${settlementId}`;
    await setReviews(fixture, [review(10), review(10), review(11), { ...review(12), state: "APPROVED" }]);
    const secondModerator = await insertUser();
    await sql`update users set role = 'MODERATOR' where id = ${secondModerator}`;
    await sql`update users set enforcement_state = 'BANNED' where id = ${fixture.contributorId}`;
    const result = await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, decision(fixture));
    expect(result).toMatchObject({ decision: "GRANTED", moderatorFigure: 6, awardedPoints: 4,
      decidedBySoleModerator: false, decidedReason: "Contribution confirmed.", decidedAt: expect.any(String) });
    const adjustments = await sql`select * from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`;
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ target_account_id: fixture.sponsorId, reason: "Contribution confirmed." });
    const events = await sql`
      select id, target_user_id, actor_id, prior_state, new_state, reason, audit_id, dispute_request_id
      from moderation_events where dispute_request_id = ${fixture.requestId} and actor_id = ${fixture.moderatorId}
    `;
    expect(events).toEqual([{ id: adjustments[0].moderation_event_id, target_user_id: fixture.contributorId,
      actor_id: fixture.moderatorId, prior_state: "BANNED", new_state: "BANNED", reason: "Contribution confirmed.",
      audit_id: null, dispute_request_id: fixture.requestId }]);
    const lines = await sql`
      select settlement_id, creditor_id, amount from dispute_credit_adjustment_lines
      where adjustment_id = ${adjustments[0].id} order by amount
    `;
    expect(lines).toEqual([
      { settlement_id: settlementId, creditor_id: fixture.landingCreditorId, amount: -7 },
      { settlement_id: null, creditor_id: fixture.contributorId, amount: 4 },
    ]);
    const legs = await sql`
      select settlement_id, account_id, counterparty_id, amount from ledger_entries
      where created_at = (select created_at from dispute_credit_adjustments where id = ${adjustments[0].id})
      order by amount
    `;
    expect(legs).toEqual([
      { settlement_id: settlementId, account_id: fixture.landingCreditorId, counterparty_id: fixture.sponsorId, amount: -7 },
      { settlement_id: null, account_id: fixture.sponsorId, counterparty_id: fixture.contributorId, amount: -4 },
      { settlement_id: null, account_id: fixture.contributorId, counterparty_id: fixture.sponsorId, amount: 4 },
      { settlement_id: settlementId, account_id: fixture.sponsorId, counterparty_id: fixture.landingCreditorId, amount: 7 },
    ]);
    const balances = await sql`select account_id, balance from balances
      where account_id = any(${[fixture.sponsorId, fixture.contributorId, fixture.landingCreditorId]}::uuid[])`;
    expect(new Map(balances.map((row) => [row.account_id, row.balance])))
      .toEqual(new Map([[fixture.sponsorId, -4], [fixture.contributorId, 4], [fixture.landingCreditorId, 0]]));
    expect(await sql`select * from settlements where id = ${settlementId}`).toEqual(before);
  });

  it("reverses a landing settlement whose creditor is the contributor too", async () => {
    const fixture = await decisionFixture();
    const settlementId = await insertLandingSettlement(fixture, fixture.contributorId);
    await expect(store().decideDispute(decision(fixture))).resolves.toMatchObject({ kind: "ok" });
    expect(await adjustmentLines(fixture.requestId)).toEqual([
      { settlement_id: settlementId, creditor_id: fixture.contributorId, amount: -7 },
      { settlement_id: null, creditor_id: fixture.contributorId, amount: 6 },
    ]);
  });

  it("reverses only the disputed issue when the landing settled several issues", async () => {
    const fixture = await decisionFixture();
    const disputedSettlement = await insertLandingSettlement(fixture, fixture.landingCreditorId);
    const otherIssue = await insertIssue(fixture.repositoryId);
    const otherSettlement = await insertLandingSettlement({ ...fixture, issueId: otherIssue }, fixture.landingCreditorId);
    const before = await sql`select * from settlements where id = any(${[disputedSettlement, otherSettlement]}::uuid[]) order by id`;
    await expect(store().decideDispute(decision(fixture))).resolves.toMatchObject({ kind: "ok" });
    expect(await adjustmentLines(fixture.requestId)).toEqual([
      { settlement_id: disputedSettlement, creditor_id: fixture.landingCreditorId, amount: -7 },
      { settlement_id: null, creditor_id: fixture.contributorId, amount: 6 },
    ]);
    expect(await sql`select * from settlements where id = any(${[disputedSettlement, otherSettlement]}::uuid[]) order by id`)
      .toEqual(before);
    const [otherBalance] = await sql`select sum(amount)::integer as balance from ledger_entries
      where settlement_id = ${otherSettlement} and account_id = ${fixture.landingCreditorId}`;
    expect(otherBalance.balance).toBe(7);
  });

  it("selects the disputed issue on an explicit landing and leaves unmatched issue/PR records alone", async () => {
    for (const matchesDisputedIssue of [false, true]) {
      const fixture = await decisionFixture(true);
      const primaryIssue = await insertIssue(fixture.repositoryId);
      const landing = await insertPullRequest({ ...fixture, issueId: primaryIssue, contributorId: fixture.landingCreditorId }, "MERGED");
      await sql`update closed_pr_dispute_requests set landed_pull_request_id = ${landing.id}, landed_commit_url = null
        where id = ${fixture.requestId}`;
      const primarySettlement = await insertLandingSettlement({ ...fixture, landingId: landing.id, issueId: primaryIssue }, fixture.landingCreditorId);
      const disputedLanding = matchesDisputedIssue ? landing : await insertPullRequest(fixture, "MERGED");
      const disputedSettlement = await insertLandingSettlement({ ...fixture, landingId: disputedLanding.id }, fixture.landingCreditorId);
      const before = await sql`select * from settlements where id = any(${[primarySettlement, disputedSettlement]}::uuid[]) order by id`;
      await expect(store().decideDispute(decision(fixture))).resolves.toMatchObject({ kind: "ok" });
      expect(await adjustmentLines(fixture.requestId)).toEqual([
        ...(matchesDisputedIssue ? [{ settlement_id: disputedSettlement, creditor_id: fixture.landingCreditorId, amount: -7 }] : []),
        { settlement_id: null, creditor_id: fixture.contributorId, amount: 6 },
      ]);
      expect(await sql`select * from settlements where id = any(${[primarySettlement, disputedSettlement]}::uuid[]) order by id`)
        .toEqual(before);
    }
  });

  it.each(["self-work", "no-record", "commit", "zero-credit"])("grants without a reversal for %s landing", async (kind) => {
    const fixture = await decisionFixture(kind === "commit");
    if (kind === "self-work") await insertLandingSettlement(fixture, fixture.sponsorId, fixture.landingCreditorId);
    if (kind === "zero-credit") await insertLandingSettlement(fixture, fixture.landingCreditorId, fixture.sponsorId, 0);
    await expect(store().decideDispute(decision(fixture)))
      .resolves.toMatchObject({ kind: "ok", value: { awardedPoints: 6 } });
    expect(await adjustmentLines(fixture.requestId))
      .toEqual([{ settlement_id: null, creditor_id: fixture.contributorId, amount: 6 }]);
  });

  it.each([2, 3])("records a reversal-only zero-net grant with %i rounds", async (rounds) => {
    const fixture = await decisionFixture();
    const settlementId = await insertLandingSettlement(fixture, fixture.landingCreditorId);
    await setReviews(fixture, Array.from({ length: rounds }, (_, index) => review(index + 1)));
    await expect(store().decideDispute({ ...decision(fixture), figure: 2 }))
      .resolves.toMatchObject({ kind: "ok", value: { decision: "GRANTED", moderatorFigure: 2, awardedPoints: 0 } });
    expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`).toHaveLength(1);
    expect(await adjustmentLines(fixture.requestId)).toEqual([{ settlement_id: settlementId, creditor_id: fixture.landingCreditorId, amount: -7 }]);
    expect(await decisionEvents(fixture.requestId)).toHaveLength(1);
  });

  it.each(["self-work", "no-record", "commit", "zero-credit"])("writes no adjustment for zero award with %s landing", async (kind) => {
    const fixture = await decisionFixture(kind === "commit");
    if (kind === "self-work") await insertLandingSettlement(fixture, fixture.sponsorId, fixture.landingCreditorId);
    if (kind === "zero-credit") await insertLandingSettlement(fixture, fixture.landingCreditorId, fixture.sponsorId, 0);
    await setReviews(fixture, [review(1), review(2)]);
    await expect(store().decideDispute({ ...decision(fixture), figure: 2 }))
      .resolves.toMatchObject({ kind: "ok", value: { awardedPoints: 0, decision: "GRANTED" } });
    expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`).toEqual([]);
  });

  it("preserves pre-sanction eligibility when the decision began before the sanction", async () => {
    const fixture = await decisionFixture();
    let markLocked!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => { markLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = sql.begin(async (transaction) => {
      await transaction`select id from closed_pr_dispute_requests where id = ${fixture.requestId} for update`;
      const [backend] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
      markLocked(backend.pid);
      await released;
    });
    const holderPid = await locked;
    const deciding = store().decideDispute({ ...decision(fixture), decision: "DENIED" });
    try {
      await waitingOnBackend(holderPid);
      await vi.waitFor(async () => {
        expect(await waitingOnBackend(holderPid)).toBe(1);
      }, { timeout: 5000 });
      const [beforeSanction] = await sql<{ at: string }[]>`select clock_timestamp()::text as at`;
      await sql.begin(async (transaction) => {
        await transaction`update users set enforcement_state = 'BANNED' where id = ${fixture.contributorId}`;
        await transaction`insert into moderation_events
          (target_user_id, actor_id, prior_state, new_state, reason, created_at)
          values (${fixture.contributorId}, ${fixture.moderatorId}, 'ACTIVE', 'BANNED',
            'Concurrent sanction.', clock_timestamp())`;
      });
      release();
      await holder;
      await expect(deciding).resolves.toMatchObject({ kind: "ok" });
      const [eligibility] = await sql<{ eligible: boolean; original_cutoff: boolean }[]>`
        select participation_eligible_at(${fixture.contributorId}, ${beforeSanction.at}::timestamptz) as eligible,
          decided_at < ${beforeSanction.at}::timestamptz as original_cutoff
        from closed_pr_dispute_requests where id = ${fixture.requestId}
      `;
      expect(eligibility.eligible, "decision changed pre-sanction eligibility").toBe(true);
      expect(eligibility.original_cutoff).toBe(true);
    } finally {
      release();
      await Promise.allSettled([holder, deciding]);
    }
  });

  it("waits for the contributor transition and preserves committed sanction eligibility", async () => {
    const fixture = await decisionFixture();
    const gateId = externalId++;
    // Gate the event as well, so a missing/late user lock still reaches the outcome assertions.
    await sql.unsafe(`create function hold_dispute_history() returns trigger language plpgsql as $$
      begin
        if new.dispute_request_id = '${fixture.requestId}'::uuid then
          perform pg_advisory_xact_lock(hashtext(current_database()), ${gateId});
        end if;
        return new;
      end; $$`);
    await sql.unsafe(`create trigger hold_dispute_history before insert on moderation_events
      for each row execute function hold_dispute_history()`);
    let markLocked!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => { markLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(current_database()), ${gateId})`;
      await transaction`update users set enforcement_state = 'BANNED' where id = ${fixture.contributorId}`;
      await transaction`insert into moderation_events
        (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${fixture.contributorId}, ${fixture.moderatorId}, 'ACTIVE', 'BANNED',
          'Uncommitted sanction.', clock_timestamp())`;
      const [backend] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
      markLocked(backend.pid);
      await released;
    });
    const holderPid = await locked;
    const deciding = store().decideDispute({ ...decision(fixture), decision: "DENIED" });
    try {
      await waitingOnBackend(holderPid);
      await vi.waitFor(async () => {
        expect(await waitingOnBackend(holderPid)).toBe(1);
      }, { timeout: 5000 });
      release();
      await holder;
      await expect(deciding).resolves.toMatchObject({ kind: "ok" });
      const [afterDecision] = await sql<{ at: string }[]>`select clock_timestamp()::text as at`;
      const [eligibility] = await sql<{ eligible: boolean }[]>`
        select participation_eligible_at(${fixture.contributorId}, ${afterDecision.at}::timestamptz) as eligible
      `;
      expect(eligibility.eligible, "decision ignored the committed sanction").toBe(false);
      const events = await sql`select prior_state, new_state from moderation_events
        where dispute_request_id = ${fixture.requestId} and actor_id = ${fixture.moderatorId}`;
      expect(events).toEqual([{ prior_state: "BANNED", new_state: "BANNED" }]);
    } finally {
      release();
      await Promise.allSettled([holder, deciding]);
      await sql.unsafe("drop trigger hold_dispute_history on moderation_events");
      await sql.unsafe("drop function hold_dispute_history()");
    }
  });

  it("counts reviews at database decision time, not the closed PR's absent merge timestamp", async () => {
    const fixture = await decisionFixture();
    const [clock] = await sql<{ past: string; future: string }[]>`
      select (now() - interval '1 hour')::text as past, (now() + interval '1 hour')::text as future
    `;
    await setReviews(fixture, [
      { ...review(1), submittedAt: clock.past },
      { ...review(2, "DISMISSED"), dismissal: { at: clock.past, previousState: "CHANGES_REQUESTED" } },
      { ...review(3, "DISMISSED"), dismissal: { at: clock.future, previousState: "CHANGES_REQUESTED" } },
      { ...review(4), submittedAt: clock.future },
    ]);
    await expect(store().decideDispute(decision(fixture)))
      .resolves.toMatchObject({ kind: "ok", value: { awardedPoints: 4 } });
  });

  it.each(["absent", "wrong repository", "wrong kind", "wrong PR", "no reviews", "not array", "bad review", "json string"])(
    "refuses a grant with %s evidence without recording a decision", async (kind) => {
      const fixture = await decisionFixture();
      await sql`delete from repository_reconciliation_evidence_facts where repository_id = ${fixture.repositoryId}`;
      if (kind === "wrong repository") {
        const other = await decisionFixture();
        await sql`insert into repository_reconciliation_evidence_facts (repository_id, kind, subject_key, payload)
          select ${other.repositoryId}, 'pull_request', github_pull_request_id::text, '{"reviews":[]}'::jsonb
          from pull_requests where id = ${fixture.pullRequestId}`;
        await sql`update users set role = 'MODERATOR' where id = ${fixture.moderatorId}`;
      } else if (kind !== "absent") {
        const payload = kind === "no reviews" ? {} : kind === "not array" ? { reviews: {} }
          : kind === "bad review" ? { reviews: [null] } : kind === "json string" ? "not a review object" : { reviews: [] };
        await setReviewPayload(fixture, payload);
        if (kind === "wrong kind") await sql`update repository_reconciliation_evidence_facts set kind = 'issue'
          where repository_id = ${fixture.repositoryId}`;
        if (kind === "wrong PR") await sql`update repository_reconciliation_evidence_facts set subject_key = 'unknown'
          where repository_id = ${fixture.repositoryId}`;
      }
      await expect(store().decideDispute(decision(fixture))).resolves.toEqual({ kind: "insufficient_evidence" });
      await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, decision(fixture)))
        .rejects.toMatchObject({ name: "ClosedPrDisputeError", code: "INSUFFICIENT_EVIDENCE" });
      await expectUndecided(fixture.requestId);
    },
  );

  it("denies without review evidence or a figure and ignores a supplied figure", async () => {
    for (const figure of [undefined, 9]) {
      const fixture = await decisionFixture();
      await sql`delete from repository_reconciliation_evidence_facts where repository_id = ${fixture.repositoryId}`;
      await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, {
        decision: "DENIED", decidedReason: "  Insufficient claim.  ", figure,
      })).resolves.toMatchObject({ decision: "DENIED", state: "DECIDED", moderatorFigure: null,
        awardedPoints: null, decidedReason: "Insufficient claim." });
      expect(await decisionEvents(fixture.requestId)).toHaveLength(1);
      expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`).toEqual([]);
    }
  });

  it("serializes competing decisions to exactly one decision, event and adjustment", async () => {
    const fixture = await decisionFixture();
    const results = await Promise.all([store().decideDispute(decision(fixture)), store().decideDispute(decision(fixture))]);
    expect(results.map((result) => result.kind).sort()).toEqual(["already_decided", "ok"]);
    expect(await decisionEvents(fixture.requestId)).toHaveLength(1);
    expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`).toHaveLength(1);
    await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, decision(fixture)))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["event", "award", "reversal"])("rolls back every grant write when the %s insert fails", async (failure) => {
    const fixture = await decisionFixture();
    await insertLandingSettlement(fixture, fixture.landingCreditorId);
    const table = failure === "event" ? "moderation_events" : "dispute_credit_adjustment_lines";
    const predicate = failure === "event" ? `new.dispute_request_id = '${fixture.requestId}'::uuid`
      : failure === "award" ? "new.amount > 0" : "new.amount < 0";
    await sql.unsafe(`create function reject_dispute_decision() returns trigger language plpgsql as $$
      begin if ${predicate} then raise exception 'decision write rejected'; end if; return new; end; $$`);
    await sql.unsafe(`create trigger reject_dispute_decision before insert on ${table}
      for each row execute function reject_dispute_decision()`);
    try {
      await expect(store().decideDispute(decision(fixture))).rejects.toThrow("decision write rejected");
      await expectUndecided(fixture.requestId);
    } finally {
      await sql.unsafe(`drop trigger reject_dispute_decision on ${table}`);
      await sql.unsafe("drop function reject_dispute_decision()");
    }
  });

  it.each([undefined, 0, 11, 1.5, NaN])("requires an integer grant figure from 1 to 10 (%s)", async (figure) => {
    const fixture = await decisionFixture();
    await expect(store().decideDispute({ ...decision(fixture), figure })).resolves.toEqual({ kind: "invalid_input" });
    await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, { ...decision(fixture), figure }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expectUndecided(fixture.requestId);
  });

  it.each([1, 10])("accepts the figure endpoint %i with bounded reasons and trimmed identifiers", async (figure) => {
    const fixture = await decisionFixture();
    await expect(service().decideDispute(` ${fixture.requestId} `, { id: fixture.moderatorId }, {
      decision: "GRANTED", figure, decidedReason: ` ${"x".repeat(2000)} `,
    })).resolves.toMatchObject({ moderatorFigure: figure, awardedPoints: figure, decidedReason: "x".repeat(2000) });
  });

  it.each(["", "   ", "x".repeat(2001)])("refuses invalid decision reasons (%#)", async (decidedReason) => {
    const fixture = await decisionFixture();
    await expect(store().decideDispute({ ...decision(fixture), decidedReason })).resolves.toEqual({ kind: "invalid_input" });
    await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, { ...decision(fixture), decidedReason }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expectUndecided(fixture.requestId);
  });

  it("refuses unknown requests and invalid service decisions or identifiers", async () => {
    const fixture = await decisionFixture();
    await expect(store().decideDispute({ ...decision(fixture), requestId: randomUUID() })).resolves.toEqual({ kind: "not_found" });
    await expect(service().decideDispute(randomUUID(), { id: fixture.moderatorId }, decision(fixture)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service().decideDispute(" ", { id: fixture.moderatorId }, decision(fixture)))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, {
      ...decision(fixture), decision: "OTHER" as "GRANTED",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expectUndecided(fixture.requestId);
  });

  it.each(["MEMBER", "deleted"])("refuses a %s account removed from the live moderator roster", async (kind) => {
    const fixture = await decisionFixture();
    if (kind === "MEMBER") await sql`update users set role = 'MEMBER' where id = ${fixture.moderatorId}`;
    else await sql`update users set deleted_at = now() where id = ${fixture.moderatorId}`;
    await expect(store().decideDispute(decision(fixture))).resolves.toEqual({ kind: "forbidden" });
    await expectUndecided(fixture.requestId);
  });

  it("lists the cross-repository open queue oldest first, followed by newest decided history", async () => {
    const first = await decisionFixture();
    const second = await decisionFixture();
    const history = await decisionFixture();
    await service().decideDispute(first.requestId, { id: history.moderatorId }, { ...decision(first), decision: "DENIED" });
    await service().decideDispute(history.requestId, { id: history.moderatorId }, { ...decision(history), decision: "DENIED" });
    const third = await decisionFixture();
    await sql`update closed_pr_dispute_requests set created_at = '2026-01-01' where id = ${third.requestId}`;
    const listed = await service().listDisputes();
    expect(listed.filter((row) => [first.requestId, second.requestId, history.requestId, third.requestId].includes(row.id))
      .map((row) => row.id)).toEqual([third.requestId, second.requestId, history.requestId, first.requestId]);
    expect(listed.find((row) => row.id === history.requestId)).toMatchObject({ state: "DECIDED", decision: "DENIED" });
    expect(await service().listDisputes({ id: second.contributorId })).toHaveLength(1);
  });
});

describe("grant financial uniqueness", () => {
  it.each([false, true])("refuses a second grant for the same PR without repeating award or reversal (settlement=%s)", async (hasSettlement) => {
    const fixture = await decisionFixture();
    if (hasSettlement) await insertLandingSettlement(fixture, fixture.landingCreditorId);
    await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, decision(fixture));
    // Bypass filing to exercise the per-PR financial constraint independently.
    const [repeated] = await sql<{ id: string }[]>`insert into closed_pr_dispute_requests
      (contributor_id, pull_request_id, issue_id, landed_pull_request_id, request_reason)
      values (${fixture.contributorId}, ${fixture.pullRequestId}, ${fixture.issueId}, ${fixture.landingId}, 'Existing pending request.')
      returning id`;
    await sql`insert into moderation_events
      (target_user_id, actor_id, prior_state, new_state, reason, dispute_request_id)
      values (${fixture.contributorId}, ${fixture.contributorId}, 'ACTIVE', 'ACTIVE', 'Existing filing.', ${repeated.id})`;
    await expect(service().decideDispute(repeated.id, { id: fixture.moderatorId }, decision(fixture)))
      .rejects.toMatchObject({ code: "ALREADY_GRANTED", message: "this issue has already been credited through a granted dispute" });
    await expect(store().decideDispute({ ...decision(fixture), requestId: repeated.id })).resolves.toEqual({ kind: "already_granted" });
    await expectUndecided(repeated.id);
    const balances = await sql`select account_id, balance from balances
      where account_id = any(${[fixture.sponsorId, fixture.contributorId, fixture.landingCreditorId]}::uuid[])`;
    expect(balances.find((row) => row.account_id === fixture.contributorId)?.balance).toBe(6);
    expect(balances.find((row) => row.account_id === fixture.sponsorId)?.balance).toBe(-6);
    if (hasSettlement) expect(balances.find((row) => row.account_id === fixture.landingCreditorId)?.balance).toBe(0);
    expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${fixture.requestId}`).toHaveLength(1);
  });

  it.each([false, true])("refuses granting another PR on the same issue with only one award (settlement=%s)", async (hasSettlement) => {
    const fixture = await decisionFixture();
    if (hasSettlement) await insertLandingSettlement(fixture, fixture.landingCreditorId);
    const contributorId = await insertUser();
    const otherPr = await insertPullRequest({ ...fixture, contributorId }, "CLOSED");
    await setReviews({ ...fixture, pullRequestId: otherPr.id }, []);
    const pending = await service().fileDispute({ id: contributorId }, filing({ contributorId, pullRequestId: otherPr.id }));
    await expect(store().decideDispute(decision(fixture)))
      .resolves.toMatchObject({ kind: "ok", value: { moderatorFigure: 6, awardedPoints: 6 } });
    await expect(service().decideDispute(pending.id, { id: fixture.moderatorId }, { ...decision(fixture), figure: 10 }))
      .rejects.toMatchObject({ code: "ALREADY_GRANTED", message: "this issue has already been credited through a granted dispute" });
    await expect(store().decideDispute({ ...decision(fixture), requestId: pending.id }))
      .resolves.toEqual({ kind: "already_granted" });
    await expectUndecided(pending.id);
    expect(await sql`select requests.id from closed_pr_dispute_requests requests
      where issue_id = ${fixture.issueId} and decision = 'GRANTED'`).toEqual([{ id: fixture.requestId }]);
    expect(await sql`select adjustments.dispute_id from dispute_credit_adjustments adjustments
      join closed_pr_dispute_requests requests on requests.id = adjustments.dispute_id
      where requests.issue_id = ${fixture.issueId}`).toEqual([{ dispute_id: fixture.requestId }]);
    const lines = await adjustmentLines(fixture.requestId);
    expect(lines.filter((line) => line.amount > 0)).toEqual([
      { settlement_id: null, creditor_id: fixture.contributorId, amount: 6 },
    ]);
    expect(lines.filter((line) => line.amount < 0)).toHaveLength(hasSettlement ? 1 : 0);
  });

  it("allows re-filing and granting after denial", async () => {
    const fixture = await decisionFixture();
    await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, { ...decision(fixture), decision: "DENIED" });
    const repeated = await service().fileDispute({ id: fixture.contributorId }, filing(fixture));
    expect(await service().decideDispute(repeated.id, { id: fixture.moderatorId }, decision(fixture)))
      .toMatchObject({ decision: "GRANTED", awardedPoints: 6 });
  });

  it("serializes distinct historical requests at the grant index", async () => {
    const fixture = await decisionFixture();
    await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, { ...decision(fixture), decision: "DENIED" });
    const repeated = await service().fileDispute({ id: fixture.contributorId }, filing(fixture));
    await service().decideDispute(repeated.id, { id: fixture.moderatorId }, { ...decision(fixture), decision: "DENIED" });
    // Exercise the financial constraint independently of the one-OPEN-request gate.
    let markLocked!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => { markLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = sql.begin(async (tx) => {
      await tx`update closed_pr_dispute_requests set decision = 'GRANTED', moderator_figure = 6, awarded_points = 6
        where id = ${fixture.requestId}`;
      const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      markLocked(backend.pid);
      await released;
    });
    const pid = await locked;
    const contender = sql`update closed_pr_dispute_requests set decision = 'GRANTED', moderator_figure = 6, awarded_points = 6
      where id = ${repeated.id}`.then(() => "unexpected second grant", (error: unknown) => error);
    try {
      await waitingOnBackend(pid);
      await vi.waitFor(async () => { expect(await waitingOnBackend(pid)).toBe(1); }, { timeout: 1500 });
      release();
      await holder;
      expect(await contender).toMatchObject({ code: "23505", constraint_name: "closed_pr_dispute_requests_one_grant_per_pull_request" });
    } finally {
      release();
      await Promise.allSettled([holder, contender]);
    }
  });
});

  it("FINAL-P3 filing must not backdate a concurrent sanction", async () => {
    const fixture = await buildFixture();
    await insertPullRequest(fixture, "MERGED");
    let markLocked!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => { markLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = sql.begin(async (transaction) => {
      await transaction`select id from users where id = ${fixture.contributorId} for update`;
      const [backend] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
      markLocked(backend.pid);
      await released;
      await transaction`update users set enforcement_state = 'BANNED' where id = ${fixture.contributorId}`;
      await transaction`insert into moderation_events
        (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${fixture.contributorId}, ${fixture.sponsorId}, 'ACTIVE', 'BANNED',
          'Concurrent sanction during filing.', clock_timestamp())`;
    });
    const holderPid = await locked;
    const filingResult = store().fileDispute(filing(fixture));
    try {
      await waitingOnBackend(holderPid);
      await vi.waitFor(async () => { expect(await waitingOnBackend(holderPid)).toBe(1); }, { timeout: 5000 });
      const [probe] = await sql<{ at: string }[]>`select clock_timestamp()::text as at`;
      release();
      await holder;
      await expect(filingResult).resolves.toMatchObject({ kind: "ok" });
      const [historical] = await sql<{ eligible: boolean }[]>`
        select participation_eligible_at(${fixture.contributorId}, ${probe.at}::timestamptz) as eligible`;
      expect(historical.eligible, "filing backdated the sanction before its actual transition").toBe(true);
    } finally {
      release();
      await Promise.allSettled([holder, filingResult]);
    }
  });


it.each([false, true])("replays dispute debt through the view and eligible board (reversal=%s)", async (reversal) => {
  const fixture = await decisionFixture();
  const borrowerId = reversal ? fixture.landingCreditorId : fixture.sponsorId;
  if (reversal) {
    await insertLandingSettlement(fixture, borrowerId);
    // Prior ordinary debt leaves -3; the landing reversal takes this account to -10.
    for (const credits of [7, 3]) {
      const debt = await decisionFixture();
      await insertLandingSettlement(debt, debt.landingCreditorId, borrowerId, credits);
    }
    await sql`update users set role = 'MODERATOR' where id = ${fixture.moderatorId}`;
  }
  await service().decideDispute(fixture.requestId, { id: fixture.moderatorId }, { ...decision(fixture), figure: 10 });
  for (let index = 0; index < 2; index += 1) {
    const laterWork = await decisionFixture();
    await sql`update pull_requests set author_id = ${borrowerId}, merged_at = clock_timestamp() where id = ${laterWork.landingId}`;
    await insertLandingSettlement(laterWork, borrowerId);
  }
  const [balance] = await sql`select balance from balances where account_id = ${borrowerId}`;
  expect(Number(balance.balance)).toBe(4);
  const [limit] = await sql`select repaid_debt, credit_limit from account_credit_limits where account_id = ${borrowerId}`;
  // Preserve both independent consumers' outcomes even when one assertion fails.
  expect.soft(Number(limit.repaid_debt), "completed work repays dispute debt").toBe(10);
  expect.soft(Number(limit.credit_limit)).toBe(11);
  // Return to -10 after repayment: at limit 11 both openings board; at default 10 only the repayment exception does.
  for (let index = 0; index < 2; index += 1) {
    const laterDebt = await decisionFixture();
    await sql`update pull_requests set merged_at = clock_timestamp() where id = ${laterDebt.landingId}`;
    await insertLandingSettlement(laterDebt, laterDebt.landingCreditorId, borrowerId);
  }
  const [repo] = await sql<{ id: string; owner_name: string }[]>`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${externalId++}, ${`owner/repayment-${externalId++}`}, ${borrowerId}, 'PUBLIC', ${externalId++},
      ${sql.json(validDifficultyScheme())}) returning id, owner_name`;
  const openings = [await insertIssue(repo.id), await insertIssue(repo.id)];
  await sql`update issues set state = 'OPEN' where id = any(${openings}::uuid[])`;
  const board = await listEligibleIssues(fixture.contributorId, { repository: repo.owner_name });
  expect(board.map((row) => row.id).sort(), "board must use the same dispute repayment limit").toEqual(openings.sort());
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

async function decisionFixture(commit = false) {
  await sql`update users set role = 'MEMBER' where role = 'MODERATOR'`;
  const fixture = await buildFixture();
  const moderatorId = await insertUser();
  const landingCreditorId = await insertUser();
  await sql`update users set role = 'MODERATOR' where id = ${moderatorId}`;
  const landing = commit ? null : await insertPullRequest({ ...fixture, contributorId: landingCreditorId }, "MERGED");
  const request = await service().fileDispute({ id: fixture.contributorId }, {
    ...filing(fixture), ...(commit ? { landedCommitUrl: "https://example.test/commit/landed" } : {}),
  });
  await sql`insert into repository_reconciliation_evidence
    (repository_id, version, format_version, checkpoint, last_full_pass_at)
    values (${fixture.repositoryId}, 1, 4, now(), now())`;
  await setReviews(fixture, []);
  return { ...fixture, moderatorId, landingCreditorId, landingId: landing?.id ?? null, requestId: request.id };
}

function decision(fixture: { requestId: string; moderatorId: string }) {
  return { requestId: fixture.requestId, moderatorAccountId: fixture.moderatorId,
    decision: "GRANTED" as const, figure: 6, decidedReason: "Contribution confirmed." };
}

function review(id: number, state: GitHubPullRequestReview["state"] = "CHANGES_REQUESTED"): GitHubPullRequestReview {
  return { id, state, submittedAt: "2025-01-01T00:00:00.000Z", dismissal: null };
}

async function setReviews(fixture: { repositoryId: string; pullRequestId: string }, reviews: GitHubPullRequestReview[]) {
  await setReviewPayload(fixture, { reviews });
}

async function setReviewPayload(fixture: { repositoryId: string; pullRequestId: string }, payload: unknown) {
  await sql`insert into repository_reconciliation_evidence_facts (repository_id, kind, subject_key, payload)
    select ${fixture.repositoryId}, 'pull_request', github_pull_request_id::text, ${sql.json(payload as never)}
    from pull_requests where id = ${fixture.pullRequestId}
    on conflict (repository_id, kind, subject_key) do update set payload = excluded.payload`;
}

async function insertLandingSettlement(
  fixture: Awaited<ReturnType<typeof decisionFixture>>, creditorId: string, debtorId = fixture.sponsorId, credits = 7,
) {
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${fixture.landingId}, ${fixture.issueId}, ${fixture.repositoryId})`;
  const [row] = await sql<{ id: string }[]>`insert into settlements
    (pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points, settled_points,
      review_rounds, credits, proof_sha256, status)
    values (${fixture.landingId}, ${fixture.issueId}, ${creditorId}, ${debtorId}, 5, 7, ${7 - credits},
      ${credits}, ${randomUUID().replaceAll("-", "").repeat(2)}, 'SETTLED') returning id`;
  return row.id;
}

async function decisionEvents(requestId: string) {
  return sql`select id from moderation_events where dispute_request_id = ${requestId}
    and actor_id <> (select contributor_id from closed_pr_dispute_requests where id = ${requestId})`;
}

async function adjustmentLines(requestId: string) {
  return sql`select lines.settlement_id, lines.creditor_id, lines.amount from dispute_credit_adjustment_lines lines
    join dispute_credit_adjustments adjustments on adjustments.id = lines.adjustment_id
    where adjustments.dispute_id = ${requestId} order by lines.amount`;
}

async function expectUndecided(requestId: string) {
  expect(await sql`select state, decision, moderator_figure, awarded_points, decided_by from closed_pr_dispute_requests
    where id = ${requestId}`).toEqual([{ state: "OPEN", decision: null, moderator_figure: null, awarded_points: null, decided_by: null }]);
  expect(await sql`select id from moderation_events where dispute_request_id = ${requestId}`).toHaveLength(1);
  expect(await sql`select id from dispute_credit_adjustments where dispute_id = ${requestId}`).toEqual([]);
}

async function waitingOnBackend(holderPid: number): Promise<number> {
  const [activity] = await sql<{ waiting: number }[]>`
    select count(*)::integer as waiting from pg_stat_activity
    where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))
  `;
  return activity.waiting;
}
