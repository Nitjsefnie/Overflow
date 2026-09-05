import { describe, expect, it } from "vitest";
import {
  getCalibrationComparison,
  getDashboard,
  getSettlementProof,
  listEligibleIssues,
  listEnforcementHistory,
  listOpenAudits,
  listRecalibratingAccounts,
  listSettlementHistory,
  SETTLEMENT_HISTORY_LIMIT,
  type DashboardSql,
} from "@/lib/dashboard/queries";

type QueryCapture = { text: string; values: unknown[] };

function sqlHarness(responses: unknown[][]): { sql: DashboardSql; captures: QueryCapture[] } {
  const captures: QueryCapture[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    captures.push({ text: strings.join("?"), values });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected dashboard query.");
    }
    return response;
  }) as DashboardSql;
  return { sql, captures };
}

const proof = "a".repeat(64);

describe("dashboard projections", () => {
  it("projects open claims, registered repositories, and enforcement notices without credentials", async () => {
    const { sql, captures } = sqlHarness([
      [{ settled_balance: -4, earned_total: 2, given_total: 6, reserved_points: 5, enforcement_state: "WARNED" }],
      [],
      [
        {
          id: "claim-1",
          repository_name: "co-op/harbour",
          issue_number: 17,
          title: "Repair the tide gate",
          url: "https://github.com/co-op/harbour/issues/17",
          assignee_github_login: "member",
          opening_name: "Offer band",
          opening_label: "shoal",
          reserve_points: 5,
        },
      ],
      [
        {
          id: "repo-1",
          owner_name: "co-op/harbour",
          visibility: "PUBLIC",
          active: true,
          opening_name: "Offer band",
          actual_name: "Delivered band",
        },
      ],
      [
        {
          id: "event-1",
          prior_state: "UNDER_AUDIT",
          new_state: "WARNED",
          reason: "Persistent calibration pattern confirmed.",
          created_at: "2026-09-03T00:00:00.000Z",
        },
      ],
    ]);

    const dashboard = await getDashboard("member-1", { sql });

    expect(dashboard).toMatchObject({
      enforcementState: "WARNED",
      openClaims: [
        expect.objectContaining({
          id: "claim-1",
          assigneeGitHubLogin: "member",
          openingName: "Offer band",
          openingLabel: "shoal",
        }),
      ],
      registeredRepositories: [
        expect.objectContaining({
          id: "repo-1",
          ownerName: "co-op/harbour",
          openingName: "Offer band",
          actualName: "Delivered band",
        }),
      ],
      enforcementNotices: [
        expect.objectContaining({ id: "event-1", newState: "WARNED" }),
      ],
    });
    expect(captures.map((capture) => capture.text).join("\n").toLowerCase()).not.toMatch(
      /encrypted_oauth_token|access_token|webhook_secret|credential/,
    );
  });

  it("derives headroom from settled balance minus outsider reservations without a default floor", async () => {
    const { sql } = sqlHarness([
      [{ settled_balance: -2, earned_total: 3, given_total: 5, reserved_points: 7 }],
      [],
      [],
      [],
      [],
    ]);

    const dashboard = await getDashboard("member-1", { sql });

    expect(dashboard).toEqual({
      settledBalance: -2,
      earnedTotal: 3,
      givenTotal: 5,
      reservedPoints: 7,
      availableHeadroom: -9,
      recentSettlements: [],
      openClaims: [],
      registeredRepositories: [],
      enforcementNotices: [],
    });
  });

  it("projects recent settlement proof links without credentials, secrets, or churn fields", async () => {
    const { sql, captures } = sqlHarness([
      [{ settled_balance: 12, earned_total: 19, given_total: 7, reserved_points: 4 }],
      [
        {
          id: "settlement-9",
          repository_name: "co-op/harbour",
          issue_number: 9,
          issue_title: "Close the lock",
          issue_url: "https://github.com/co-op/harbour/issues/9",
          pull_request_number: 12,
          pull_request_title: "Seal the lock",
          pull_request_url: "https://github.com/co-op/harbour/pull/12",
          proof_sha256: proof,
          credits: 4,
          review_rounds: 3,
          settled_at: "2026-09-03T00:00:00.000Z",
        },
      ],
      [],
      [],
      [],
    ]);

    const dashboard = await getDashboard("member-1", { sql });

    expect(dashboard.recentSettlements).toEqual([
      {
        id: "settlement-9",
        repositoryName: "co-op/harbour",
        issueNumber: 9,
        issueTitle: "Close the lock",
        issueUrl: "https://github.com/co-op/harbour/issues/9",
        pullRequestNumber: 12,
        pullRequestTitle: "Seal the lock",
        pullRequestUrl: "https://github.com/co-op/harbour/pull/12",
        proofSha256: proof,
        credits: 4,
        reviewRounds: 3,
        settledAt: "2026-09-03T00:00:00.000Z",
      },
    ]);
    const projectionSql = captures[1]?.text.toLowerCase() ?? "";
    expect(projectionSql).toMatch(/from settlements/);
    expect(projectionSql).toMatch(/order by settlements\.created_at desc/);
    expect(projectionSql).not.toMatch(/encrypted_oauth_token|access_token|auth_secret|webhook_secret|credential|churn/);
  });

  it("uses repository reserve order first and oldest issues second for eligible work", async () => {
    const { sql, captures } = sqlHarness([
      [
        {
          id: "issue-old-high",
          repository_name: "co-op/harbour",
          issue_number: 3,
          title: "Older high reserve",
          url: "https://github.com/co-op/harbour/issues/3",
          opening_name: "Promise band",
          opening_label: "delta",
          opening_comparison_points: 6,
          opening_reserve_points: 9,
          created_at: "2026-09-01T00:00:00.000Z",
        },
        {
          id: "issue-new-high",
          repository_name: "co-op/harbour",
          issue_number: 4,
          title: "Newer high reserve",
          url: "https://github.com/co-op/harbour/issues/4",
          opening_name: "Promise band",
          opening_label: "delta",
          opening_comparison_points: 6,
          opening_reserve_points: 9,
          created_at: "2026-09-02T00:00:00.000Z",
        },
        {
          id: "issue-low",
          repository_name: "co-op/harbour",
          issue_number: 5,
          title: "Lower reserve",
          url: "https://github.com/co-op/harbour/issues/5",
          opening_name: "Promise band",
          opening_label: "stream",
          opening_comparison_points: 2,
          opening_reserve_points: 4,
          created_at: "2026-08-30T00:00:00.000Z",
        },
      ],
    ]);

    const issues = await listEligibleIssues("member-1", {}, { sql });

    expect(issues.map((issue) => issue.id)).toEqual(["issue-old-high", "issue-new-high", "issue-low"]);
    expect(captures[0]?.text).toMatch(/order by\s+issues\.opening_reserve_points desc,\s+issues\.created_at asc/i);
  });

  it("applies repository, offered-label, and claim-state filters server side and projects operational context", async () => {
    const { sql, captures } = sqlHarness([
      [
        {
          id: "issue-claimed",
          repository_name: "co-op/harbour",
          sponsor_login: "sponsor",
          issue_number: 8,
          title: "Chart the shoal",
          url: "https://github.com/co-op/harbour/issues/8",
          opening_name: "Offer band",
          opening_label: "shoal",
          opening_comparison_points: 4,
          opening_reserve_points: 6,
          claim_assignee_github_login: "contributor",
          available_headroom: -3,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    ]);

    const issues = await listEligibleIssues(
      "member-1",
      { repository: "co-op/harbour", openingLabel: "shoal", claimState: "CLAIMED" },
      { sql },
    );

    expect(issues).toEqual([
      expect.objectContaining({
        sponsorLogin: "sponsor",
        assigneeGitHubLogin: "contributor",
        claimState: "CLAIMED",
        availableHeadroom: -3,
        openingName: "Offer band",
        openingLabel: "shoal",
      }),
    ]);
    expect(captures[0]?.values).toContain("co-op/harbour");
    expect(captures[0]?.values).toContain("shoal");
    expect(captures[0]?.values).toContain("CLAIMED");
  });

  it("returns issue and pull-request proof with the hand-calculated review deduction", async () => {
    const { sql } = sqlHarness([
      [
        {
          id: "settlement-1",
          status: "SETTLED",
          repository_name: "co-op/harbour",
          issue_number: 9,
          issue_title: "Close the lock",
          issue_url: "https://github.com/co-op/harbour/issues/9",
          pull_request_number: 12,
          pull_request_title: "Seal the lock",
          pull_request_url: "https://github.com/co-op/harbour/pull/12",
          proof_sha256: proof,
          opening_comparison_points: 9,
          settled_points: 7,
          review_rounds: 3,
          credits: 4,
          settled_at: "2026-09-03T00:00:00.000Z",
        },
      ],
    ]);

    const settlement = await getSettlementProof("member-1", "settlement-1", { sql });

    expect(settlement).toEqual({
      id: "settlement-1",
      status: "SETTLED",
      repositoryName: "co-op/harbour",
      issueNumber: 9,
      issueTitle: "Close the lock",
      issueUrl: "https://github.com/co-op/harbour/issues/9",
      pullRequestNumber: 12,
      pullRequestTitle: "Seal the lock",
      pullRequestUrl: "https://github.com/co-op/harbour/pull/12",
      proofSha256: proof,
      openingComparisonPoints: 9,
      settledPoints: 7,
      reviewRounds: 3,
      credits: 4,
      settledAt: "2026-09-03T00:00:00.000Z",
    });
  });

  it("projects configured rating names, authoritative event evidence, merge SHA, and signed balance effect", async () => {
    const { sql } = sqlHarness([
      [
        {
          id: "settlement-1",
          status: "SETTLED",
          repository_name: "co-op/harbour",
          opening_name: "Offer band",
          actual_name: "Delivered band",
          issue_number: 9,
          issue_title: "Close the lock",
          issue_url: "https://github.com/co-op/harbour/issues/9",
          opening_label: "shoal",
          settled_label: "landed/7",
          settled_label_event_id: "label-event-7",
          settled_label_actor_login: "owner",
          settled_label_applied_at: "2026-09-03T10:00:00.000Z",
          settled_rationale_comment_id: "comment-7",
          settled_rationale_actor_login: "owner",
          settled_rationale_commented_at: "2026-09-03T10:30:00.000Z",
          pull_request_number: 12,
          pull_request_title: "Seal the lock",
          pull_request_url: "https://github.com/co-op/harbour/pull/12",
          merge_commit_oid: "0123456789abcdef0123456789abcdef01234567",
          merged_at: "2026-09-03T11:00:00.000Z",
          proof_sha256: proof,
          opening_comparison_points: 9,
          settled_points: 7,
          review_rounds: 3,
          credits: 4,
          balance_effect: -4,
          settled_at: "2026-09-03T11:00:00.000Z",
        },
      ],
    ]);

    const settlement = await getSettlementProof("member-1", "settlement-1", { sql });

    expect(settlement).toMatchObject({
      openingName: "Offer band",
      actualName: "Delivered band",
      openingLabel: "shoal",
      settledLabel: "landed/7",
      settledLabelEventId: "label-event-7",
      settledRationaleCommentId: "comment-7",
      mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
      mergedAt: "2026-09-03T11:00:00.000Z",
      balanceEffect: -4,
    });
  });

  it("compares independently returned self-work and outsider calibration samples", async () => {
    const { sql } = sqlHarness([
      [
        {
          github_repository_id: 1,
          github_issue_id: 10,
          github_pull_request_id: 100,
          merged_at: "2026-01-03T00:00:00.000Z",
          proof_sha256: proof,
          offered_difficulty: 5,
          settled_difficulty: 6,
        },
        {
          github_repository_id: 1,
          github_issue_id: 11,
          github_pull_request_id: 101,
          merged_at: "2026-01-04T00:00:00.000Z",
          proof_sha256: proof,
          offered_difficulty: 7,
          settled_difficulty: 5,
        },
      ],
      [
        {
          github_repository_id: 1,
          github_issue_id: 12,
          github_pull_request_id: 102,
          merged_at: "2026-01-05T00:00:00.000Z",
          proof_sha256: proof,
          offered_difficulty: 4,
          settled_difficulty: 7,
        },
        {
          github_repository_id: 1,
          github_issue_id: 13,
          github_pull_request_id: 103,
          merged_at: "2026-01-06T00:00:00.000Z",
          proof_sha256: proof,
          offered_difficulty: 8,
          settled_difficulty: 7,
        },
      ],
    ]);

    const comparison = await getCalibrationComparison("member-1", { sql });

    expect(comparison).toEqual({
      selfWork: { count: 2, meanDelta: -0.5, medianDelta: -0.5 },
      outsider: { count: 2, meanDelta: 1, medianDelta: 1 },
      differenceBetweenMeans: -1.5,
    });
  });

  it("projects open audits without credential columns", async () => {
    const { sql, captures } = sqlHarness([
      [
        {
          id: "audit-1",
          target_account_id: "account-1",
          target_login: "mira",
          reporter_login: "moderator",
          repository_name: "co-op/harbour",
          opened_at: "2026-09-04T00:00:00.000Z",
          settled_sample_size: 20,
          cohort_statistics: { differenceBetweenMeans: -1.5 },
        },
      ],
    ]);

    const audits = await listOpenAudits({ sql });

    expect(audits).toEqual([
      {
        id: "audit-1",
        targetAccountId: "account-1",
        targetLogin: "mira",
        reporterLogin: "moderator",
        repositoryName: "co-op/harbour",
        openedAt: "2026-09-04T00:00:00.000Z",
        settledSampleSize: 20,
        differenceBetweenMeans: -1.5,
        cohortStatistics: { differenceBetweenMeans: -1.5 },
      },
    ]);
    const projectedSql = captures.map((capture) => capture.text).join("\n").toLowerCase();
    expect(projectedSql).not.toMatch(/encrypted_oauth_token|access_token|auth_secret|webhook_secret|credential/);
  });

  it("projects reproducible audit evidence, enforcement history, and recalibrating accounts", async () => {
    const cohortDefinition = {
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
      selfWorkPairs: [{ githubIssueId: 1, mergedAt: "2026-01-03T00:00:00.000Z" }],
      outsiderSettlementPairs: [{ githubIssueId: 2, mergedAt: "2026-01-04T00:00:00.000Z" }],
    };
    const cohortStatistics = {
      selfWork: { count: 1, meanDelta: 1, medianDelta: 1 },
      outsider: { count: 1, meanDelta: -1, medianDelta: -1 },
      differenceBetweenMeans: 2,
    };
    const { sql, captures } = sqlHarness([
      [
        {
          id: "audit-1",
          target_account_id: "account-1",
          target_login: "mira",
          reporter_login: "moderator",
          repository_name: null,
          state: "OPEN",
          prior_enforcement_state: "ACTIVE",
          opened_at: "2026-09-04T00:00:00.000Z",
          sample_started_at: "2026-01-01T00:00:00.000Z",
          sample_ended_at: "2026-02-01T00:00:00.000Z",
          settled_sample_size: 1,
          cohort_definition: cohortDefinition,
          cohort_statistics: cohortStatistics,
        },
      ],
      [
        {
          id: "event-1",
          target_account_id: "account-1",
          target_login: "mira",
          actor_login: "moderator",
          prior_state: "ACTIVE",
          new_state: "UNDER_AUDIT",
          reason: "Review opened.",
          recalibration_plan: null,
          created_at: "2026-09-04T00:00:00.000Z",
        },
      ],
      [
        {
          id: "account-2",
          github_login: "quinn",
          confirmed_miscalibration_count: 2,
        },
      ],
    ]);

    const [audits, history, recalibrating] = await Promise.all([
      listOpenAudits({ sql }),
      listEnforcementHistory({ sql }),
      listRecalibratingAccounts({ sql }),
    ]);

    expect(audits[0]).toMatchObject({
      cohortDefinition,
      cohortStatistics,
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(history[0]).toMatchObject({ targetLogin: "mira", newState: "UNDER_AUDIT" });
    expect(recalibrating[0]).toEqual({
      id: "account-2",
      githubLogin: "quinn",
      confirmedPatternCount: 2,
    });
    expect(captures.map((capture) => capture.text).join("\n").toLowerCase()).not.toMatch(
      /encrypted_oauth_token|access_token|webhook_secret|credential/,
    );
  });
});

describe("settlement history", () => {
  it("lists every settlement the account is party to, newest first, without hiding unsettled work", async () => {
    const { sql, captures } = sqlHarness([
      [
        {
          id: "settlement-9",
          status: "SETTLED",
          repository_name: "co-op/harbour",
          issue_number: 9,
          issue_title: "Close the lock",
          issue_url: "https://github.com/co-op/harbour/issues/9",
          credits: 4,
          review_rounds: 3,
          balance_effect: 4,
          settled_at: "2026-09-03T00:00:00.000Z",
        },
        {
          id: "settlement-8",
          status: "UNSETTLED",
          repository_name: "co-op/harbour",
          issue_number: 8,
          issue_title: "Chart the shoal",
          issue_url: "https://github.com/co-op/harbour/issues/8",
          credits: 0,
          review_rounds: 1,
          balance_effect: 0,
          settled_at: "2026-09-02T00:00:00.000Z",
        },
        {
          id: "settlement-7",
          status: "UNCLAIMED",
          repository_name: "co-op/harbour",
          issue_number: 7,
          issue_title: "Dredge the channel",
          issue_url: "https://github.com/co-op/harbour/issues/7",
          credits: 6,
          review_rounds: 0,
          balance_effect: -6,
          settled_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    ]);

    const settlements = await listSettlementHistory("member-1", { sql });

    expect(settlements).toEqual([
      {
        id: "settlement-9",
        status: "SETTLED",
        repositoryName: "co-op/harbour",
        issueNumber: 9,
        issueTitle: "Close the lock",
        issueUrl: "https://github.com/co-op/harbour/issues/9",
        credits: 4,
        reviewRounds: 3,
        balanceEffect: 4,
        settledAt: "2026-09-03T00:00:00.000Z",
      },
      {
        id: "settlement-8",
        status: "UNSETTLED",
        repositoryName: "co-op/harbour",
        issueNumber: 8,
        issueTitle: "Chart the shoal",
        issueUrl: "https://github.com/co-op/harbour/issues/8",
        credits: 0,
        reviewRounds: 1,
        balanceEffect: 0,
        settledAt: "2026-09-02T00:00:00.000Z",
      },
      {
        id: "settlement-7",
        status: "UNCLAIMED",
        repositoryName: "co-op/harbour",
        issueNumber: 7,
        issueTitle: "Dredge the channel",
        issueUrl: "https://github.com/co-op/harbour/issues/7",
        credits: 6,
        reviewRounds: 0,
        balanceEffect: -6,
        settledAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const query = captures[0]?.text ?? "";
    expect(query).not.toMatch(/status in/i);
    expect(query).toMatch(/order by\s+settlements\.created_at desc/i);
    expect(captures[0]?.values).toContain("member-1");
  });

  it("selects both sides of the settlement and caps the list at a stated depth", async () => {
    const { sql, captures } = sqlHarness([[]]);

    const settlements = await listSettlementHistory("member-1", { sql });

    expect(settlements).toEqual([]);
    const query = captures[0]?.text ?? "";
    expect(query).toMatch(/settlements\.creditor_id = \?/);
    expect(query).toMatch(/settlements\.debtor_id = \?/);
    expect(query).toMatch(/limit/i);
    expect(captures[0]?.values).toContain(SETTLEMENT_HISTORY_LIMIT);
    expect(SETTLEMENT_HISTORY_LIMIT).toBeGreaterThan(5);
  });

  it("rejects a settlement row whose status is not a ledger status", async () => {
    const { sql } = sqlHarness([
      [
        {
          id: "settlement-9",
          status: "MYSTERY",
          repository_name: "co-op/harbour",
          issue_number: 9,
          issue_title: "Close the lock",
          issue_url: "https://github.com/co-op/harbour/issues/9",
          credits: 4,
          review_rounds: 3,
          balance_effect: 4,
          settled_at: "2026-09-03T00:00:00.000Z",
        },
      ],
    ]);

    await expect(listSettlementHistory("member-1", { sql })).rejects.toThrow("Settlement status was invalid.");
  });
});
