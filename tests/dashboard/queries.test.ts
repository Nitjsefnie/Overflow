import { describe, expect, it } from "vitest";
import {
  getCalibrationComparison,
  getDashboard,
  getSettlementProof,
  listEligibleIssues,
  listOpenAudits,
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
  it("derives headroom from settled balance minus outsider reservations without a default floor", async () => {
    const { sql } = sqlHarness([
      [{ settled_balance: -2, earned_total: 3, given_total: 5, reserved_points: 7 }],
    ]);

    const dashboard = await getDashboard("member-1", { sql });

    expect(dashboard).toEqual({
      settledBalance: -2,
      earnedTotal: 3,
      givenTotal: 5,
      reservedPoints: 7,
      availableHeadroom: -9,
    });
  });

  it("only displays an explicitly configured credit floor", async () => {
    const { sql } = sqlHarness([
      [{ settled_balance: 12, earned_total: 19, given_total: 7, reserved_points: 4 }],
    ]);

    const dashboard = await getDashboard("member-1", { sql, creditFloor: 5 });

    expect(dashboard).toEqual({
      settledBalance: 12,
      earnedTotal: 19,
      givenTotal: 7,
      reservedPoints: 4,
      availableHeadroom: 8,
      creditFloor: 5,
    });
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

    const issues = await listEligibleIssues("member-1", { sql });

    expect(issues.map((issue) => issue.id)).toEqual(["issue-old-high", "issue-new-high", "issue-low"]);
    expect(captures[0]?.text).toMatch(/order by\s+issues\.opening_reserve_points desc,\s+issues\.created_at asc/i);
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

  it("compares independently returned self-work and outsider calibration samples", async () => {
    const { sql } = sqlHarness([
      [
        {
          github_repository_id: 1,
          github_issue_id: 10,
          github_pull_request_id: 100,
          proof_sha256: proof,
          offered_difficulty: 5,
          settled_difficulty: 6,
        },
        {
          github_repository_id: 1,
          github_issue_id: 11,
          github_pull_request_id: 101,
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
          proof_sha256: proof,
          offered_difficulty: 4,
          settled_difficulty: 7,
        },
        {
          github_repository_id: 1,
          github_issue_id: 13,
          github_pull_request_id: 103,
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
      },
    ]);
    const projectedSql = captures.map((capture) => capture.text).join("\n").toLowerCase();
    expect(projectedSql).not.toMatch(/encrypted_oauth_token|access_token|auth_secret|webhook_secret|credential/);
  });
});
