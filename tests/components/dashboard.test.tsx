/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardContent } from "@/app/dashboard/page";
import type { RegisteredRepositoryProjection } from "@/lib/dashboard/queries";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";

describe("member dashboard", () => {
  it("shows independently calculated ledger totals and reserved headroom", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 12,
          earnedTotal: 19,
          givenTotal: 7,
          reservedPoints: 4,
          availableHeadroom: 8,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Ledger position" })).toBeVisible();
    expect(screen.getByText("+12")).toBeVisible();
    expect(screen.getByText("Earned 19")).toBeVisible();
    expect(screen.getByText("Given 7")).toBeVisible();
    expect(screen.getByText("Reserved 4")).toBeVisible();
    expect(screen.getByText("Available headroom 8")).toBeVisible();
    expect(screen.queryByText(/churn/i)).not.toBeInTheDocument();
  });

  it("makes each recent settlement proof discoverable from the ledger", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 12,
          earnedTotal: 19,
          givenTotal: 7,
          reservedPoints: 4,
          availableHeadroom: 8,
          recentSettlements: [
            {
              id: "settlement-9",
              repositoryName: "co-op/harbour",
              issueNumber: 9,
              issueTitle: "Close the lock",
              issueUrl: "https://github.com/co-op/harbour/issues/9",
              pullRequestNumber: 12,
              pullRequestTitle: "Seal the lock",
              pullRequestUrl: "https://github.com/co-op/harbour/pull/12",
              proofSha256: "a".repeat(64),
              credits: 4,
              reviewRounds: 3,
              settledAt: "2026-09-03T00:00:00.000Z",
            },
          ],
          openClaims: [],
          registeredRepositories: [],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Recent settlement proofs" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Issue #9: Close the lock" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/issues/9",
    );
    expect(screen.getByRole("link", { name: "Pull request #12: Seal the lock" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/pull/12",
    );
    expect(screen.getByRole("link", { name: "View proof for issue #9" })).toHaveAttribute(
      "href",
      "/settlements/settlement-9",
    );
    expect(screen.getByText("4 credits · review deduction 3")).toBeVisible();
  });

  it("shows the dashboard operational queues and renders external text as text", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: -2,
          earnedTotal: 3,
          givenTotal: 5,
          reservedPoints: 7,
          availableHeadroom: -9,
          recentSettlements: [],
          openClaims: [{
            id: "claim-1",
            repositoryName: "co-op/harbour",
            issueNumber: 17,
            title: "<script>untrusted claim</script>",
            url: "https://github.com/co-op/harbour/issues/17",
            assigneeGitHubLogin: "mira",
            openingName: "Offer band",
            openingLabel: "shoal",
            reservePoints: 7,
          }],
          registeredRepositories: [{
            id: "repo-1",
            ownerName: "co-op/harbour",
            visibility: "PUBLIC",
            active: true,
            openingName: "Offer band",
            actualName: "Delivered band",
            unavailableReason: null,
            reconciliationState: "IDLE",
            reconciliationLastFailureAt: null,
          }],
          enforcementNotices: [{
            id: "notice-1",
            priorState: "UNDER_AUDIT",
            newState: "WARNED",
            reason: "Cohort review completed.",
            createdAt: "2026-09-03T00:00:00.000Z",
          }],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Open claims" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: /<script>untrusted claim<\/script>/ }),
    ).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("heading", { name: "Registered repositories" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Enforcement notices" })).toBeVisible();
    expect(screen.getByText(/UNDER_AUDIT → WARNED/)).toBeVisible();
  });

  it("names why each unavailable repository went dark and says nothing extra for an available one", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            { ...registered("repo-1", "co-op/harbour"), unavailableReason: "NOT_FOUND" },
            { ...registered("repo-2", "co-op/lighthouse"), unavailableReason: "NOT_PUBLIC" },
            { ...registered("repo-3", "co-op/breakwater"), unavailableReason: "IDENTITY_MISMATCH" },
            registered("repo-4", "co-op/seawall"),
          ],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByText(/co-op\/harbour.*· unavailable: not found on GitHub or no longer public$/)).toBeVisible();
    expect(screen.getByText(/co-op\/lighthouse.*· unavailable: no longer public$/)).toBeVisible();
    expect(screen.getByText(/co-op\/breakwater.*· unavailable: identity mismatch$/)).toBeVisible();
    expect(screen.getByText(/co-op\/seawall/)).not.toHaveTextContent(/unavailable/i);
    expect(screen.queryByText(/NOT_FOUND|NOT_PUBLIC|IDENTITY_MISMATCH/)).not.toBeInTheDocument();
  });

  it("keeps an unrecognized unavailability reason from reaching the sponsor as a raw value", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            { ...registered("repo-1", "co-op/harbour"), unavailableReason: "ARCHIVED_UPSTREAM" },
          ],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByText(/co-op\/harbour.*· unavailable$/)).toBeVisible();
    expect(screen.queryByText(/ARCHIVED_UPSTREAM/)).not.toBeInTheDocument();
  });

  it("tells the sponsor which repositories the queue is behind on and stays silent about the rest", () => {
    const failedAt = new Date("2026-09-04T11:00:00.000Z");
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            {
              ...registered("repo-1", "co-op/harbour"),
              reconciliationState: "FAILED",
              reconciliationLastFailureAt: failedAt,
            },
            {
              ...registered("repo-2", "co-op/lighthouse"),
              reconciliationState: "RUNNING",
              reconciliationLastFailureAt: failedAt,
            },
            {
              ...registered("repo-3", "co-op/breakwater"),
              reconciliationState: "PENDING",
              reconciliationLastFailureAt: failedAt,
            },
            { ...registered("repo-4", "co-op/jetty"), reconciliationState: "RUNNING" },
            { ...registered("repo-5", "co-op/quay"), reconciliationState: "PENDING" },
            registered("repo-6", "co-op/seawall"),
          ],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByText(
      /co-op\/harbour.*· reconciliation is failing \(last failed 2026-09-04\); Overflow keeps retrying$/,
    )).toBeVisible();
    expect(screen.getByText(/co-op\/lighthouse.*· retrying reconciliation after a failure$/)).toBeVisible();
    expect(screen.getByText(/co-op\/breakwater.*· retrying reconciliation after a failure$/)).toBeVisible();
    expect(screen.getByText(/co-op\/jetty.*· reconciliation queued$/)).toBeVisible();
    expect(screen.getByText(/co-op\/quay.*· reconciliation queued$/)).toBeVisible();
    expect(screen.getByText(/co-op\/seawall/)).not.toHaveTextContent(/reconciliation/i);
    // The queue's own vocabulary is an implementation detail the sponsor is never shown.
    expect(screen.queryByText(/FAILED|RUNNING|PENDING|IDLE/)).not.toBeInTheDocument();
  });

  it("shows both the unavailability and the reconciliation clause on one repository's line", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            {
              ...registered("repo-1", "co-op/harbour"),
              unavailableReason: "NOT_FOUND",
              reconciliationState: "FAILED",
              reconciliationLastFailureAt: new Date("2026-09-04T11:00:00.000Z"),
            },
          ],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByText(
      /co-op\/harbour.*· unavailable: not found on GitHub or no longer public · reconciliation is failing \(last failed 2026-09-04\); Overflow keeps retrying$/,
    )).toBeVisible();
  });

  it("keeps a failing repository readable when the queue holds no time for the failure", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            { ...registered("repo-1", "co-op/harbour"), reconciliationState: "FAILED" },
          ],
          enforcementNotices: [],
        }}
      />,
    );

    expect(screen.getByText(/co-op\/harbour.*· reconciliation is failing; Overflow keeps retrying$/)).toBeVisible();
    expect(screen.queryByText(/last failed/)).not.toBeInTheDocument();
  });

  it("promises no retry for a failing repository that is no longer active", () => {
    const failedAt = new Date("2026-09-04T11:00:00.000Z");
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 0,
          recentSettlements: [],
          openClaims: [],
          registeredRepositories: [
            {
              ...registered("repo-1", "co-op/harbour"),
              active: false,
              reconciliationState: "FAILED",
              reconciliationLastFailureAt: failedAt,
            },
            {
              ...registered("repo-2", "co-op/lighthouse"),
              active: true,
              reconciliationState: "FAILED",
              reconciliationLastFailureAt: failedAt,
            },
            // A queued job still drains for an inactive repository, because claiming one does not
            // consult `active`; only the sweep's revival of a FAILED job does.
            { ...registered("repo-3", "co-op/breakwater"), active: false, reconciliationState: "PENDING" },
            {
              ...registered("repo-4", "co-op/seawall"),
              active: false,
              reconciliationState: "FAILED",
            },
          ],
          enforcementNotices: [],
        }}
      />,
    );

    // Only the sweep revives a FAILED job and it enqueues active repositories only, so promising
    // a retry here would be a plain untruth on a line that already says "inactive".
    expect(screen.getByText(
      /co-op\/harbour.*· reconciliation is failing \(last failed 2026-09-04\); it will not be retried while the repository is inactive$/,
    )).toBeVisible();
    expect(screen.getByText(/co-op\/harbour/)).not.toHaveTextContent(/keeps retrying/);
    expect(screen.getByText(
      /co-op\/lighthouse.*· reconciliation is failing \(last failed 2026-09-04\); Overflow keeps retrying$/,
    )).toBeVisible();
    expect(screen.getByText(/co-op\/breakwater.*· reconciliation queued$/)).toBeVisible();
    expect(screen.getByText(
      /co-op\/seawall.*· reconciliation is failing; it will not be retried while the repository is inactive$/,
    )).toBeVisible();
  });

  it("renders positive, negative, and zero balances without inventing a floor", () => {
    const { rerender } = render(
      <BalanceCard
        dashboard={{
          settledBalance: 3,
          earnedTotal: 3,
          givenTotal: 0,
          reservedPoints: 0,
          availableHeadroom: 3,
        }}
      />,
    );
    expect(screen.getByText("+3")).toBeVisible();

    rerender(
      <BalanceCard
        dashboard={{
          settledBalance: -2,
          earnedTotal: 1,
          givenTotal: 3,
          reservedPoints: 4,
          availableHeadroom: -6,
        }}
      />,
    );
    expect(screen.getByText("−2")).toBeVisible();
    expect(screen.getByText("Available headroom −6")).toBeVisible();

    rerender(
      <BalanceCard
        dashboard={{
          settledBalance: 0,
          earnedTotal: 5,
          givenTotal: 5,
          reservedPoints: 0,
          availableHeadroom: 0,
        }}
      />,
    );
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.getByText("Available headroom 0")).toBeVisible();
  });

  it("keeps moderator navigation and controls out of member sessions", () => {
    const { rerender } = render(
      <AppShell memberName="Lin" isModerator={false}>
        <h1>Member view</h1>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "Moderation" })).not.toBeInTheDocument();

    rerender(
      <AppShell memberName="Lin" isModerator>
        <h1>Moderator view</h1>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Moderation" })).toHaveAttribute("href", "/moderation");
  });
});

function registered(id: string, ownerName: string): RegisteredRepositoryProjection {
  return {
    id,
    ownerName,
    visibility: "PUBLIC",
    active: true,
    openingName: "Offer band",
    actualName: "Delivered band",
    unavailableReason: null,
    reconciliationState: "IDLE",
    reconciliationLastFailureAt: null,
  };
}
