/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardContent } from "@/app/dashboard/page";
import type { RegisteredRepositoryProjection } from "@/lib/dashboard/queries";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";
import { AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN } from "@/lib/github/types";

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
          openAudit: null,
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
              status: "SETTLED",
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
          openAudit: null,
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

  it("reads each settlement proof's credit count with the plural its count takes", () => {
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
              id: "settlement-6",
              status: "SETTLED",
              repositoryName: "co-op/harbour",
              issueNumber: 6,
              issueTitle: "Close the lock",
              issueUrl: "https://github.com/co-op/harbour/issues/6",
              pullRequestNumber: 11,
              pullRequestTitle: "Seal the lock",
              pullRequestUrl: "https://github.com/co-op/harbour/pull/11",
              proofSha256: "a".repeat(64),
              credits: 1,
              reviewRounds: 2,
              settledAt: "2026-09-04T00:00:00.000Z",
            },
            {
              id: "settlement-5",
              status: "SETTLED",
              repositoryName: "co-op/harbour",
              issueNumber: 5,
              issueTitle: "Chart the shoal",
              issueUrl: "https://github.com/co-op/harbour/issues/5",
              pullRequestNumber: 10,
              pullRequestTitle: "Buoy the shoal",
              pullRequestUrl: "https://github.com/co-op/harbour/pull/10",
              proofSha256: "b".repeat(64),
              credits: 2,
              reviewRounds: 1,
              settledAt: "2026-09-05T00:00:00.000Z",
            },
          ],
          openClaims: [],
          registeredRepositories: [],
          enforcementNotices: [],
          openAudit: null,
        }}
      />,
    );

    expect(screen.getByText("1 credit · review deduction 2")).toBeVisible();
    expect(screen.getByText("2 credits · review deduction 1")).toBeVisible();
  });

  it("does not present an unclaimed settlement's credits as moved", () => {
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
              id: "settlement-7",
              status: "UNCLAIMED",
              repositoryName: "co-op/harbour",
              issueNumber: 7,
              issueTitle: "Dredge the channel",
              issueUrl: "https://github.com/co-op/harbour/issues/7",
              pullRequestNumber: 8,
              pullRequestTitle: "Dredge it yourself",
              pullRequestUrl: "https://github.com/co-op/harbour/pull/8",
              proofSha256: "a".repeat(64),
              credits: 6,
              reviewRounds: 0,
              settledAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          openClaims: [],
          registeredRepositories: [],
          enforcementNotices: [],
          openAudit: null,
        }}
      />,
    );

    expect(screen.getByText(/Awaiting a claim/)).toBeVisible();
    expect(screen.getByText(/credits pending claim/)).toBeVisible();
    // The figure stays in the projection for the proof page link, but the widget
    // must not read it as a balance that already moved.
    expect(screen.queryByText("6 credits · review deduction 0")).not.toBeInTheDocument();
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
          openAudit: null,
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

  it("announces an open audit in its own section whatever the enforcement state and notices say", () => {
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
          registeredRepositories: [],
          enforcementState: "BANNED",
          enforcementNotices: [],
          openAudit: { id: "audit-9", openedAt: "2026-09-04T00:00:00.000Z" },
        }}
      />,
    );

    // Located structurally: the section carries its own heading id, and the
    // date the audit opened is shown. The section renders even though the
    // account is BANNED with no enforcement notices — the notice's presence
    // rides the open audit alone.
    const section = document.querySelector('section[aria-labelledby="account-audit-heading"]');
    expect(section).not.toBeNull();
    expect(section).toBeVisible();
    expect(within(section).getByRole("heading")).toBeVisible();
    expect(within(section).getByText(/2026-09-04/)).toBeVisible();
    // The day only: the raw timestamp form must not reach the page.
    expect(within(section).queryByText(/2026-09-04T/)).not.toBeInTheDocument();
  });

  it("announces the open audit with no enforcement state present and notices standing", () => {
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
          registeredRepositories: [],
          enforcementNotices: [{
            id: "notice-2",
            priorState: "ACTIVE",
            newState: "BANNED",
            reason: "Sustained overestimate pattern.",
            createdAt: "2026-09-02T00:00:00.000Z",
          }],
          openAudit: { id: "audit-7", openedAt: "2026-09-05T00:00:00.000Z" },
        }}
      />,
    );

    // No enforcementState key at all, and a standing notice: the section's
    // presence still rides the open audit alone.
    const section = document.querySelector('section[aria-labelledby="account-audit-heading"]');
    expect(section).not.toBeNull();
    expect(within(section).getByRole("heading")).toBeVisible();
    expect(within(section).getByText(/2026-09-05/)).toBeVisible();
    expect(within(section).queryByText(/2026-09-05T/)).not.toBeInTheDocument();
  });

  it("renders no audit section when no audit is open on the account", () => {
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
          registeredRepositories: [],
          enforcementNotices: [],
          openAudit: null,
        }}
      />,
    );

    expect(document.querySelector('section[aria-labelledby="account-audit-heading"]')).toBeNull();
  });

  it("reads an ambiguous claim assignee as a phrase, never the reserved sentinel login", () => {
    render(
      <DashboardContent
        memberName="Ada Lovelace"
        isModerator={false}
        dashboard={{
          settledBalance: 0,
          earnedTotal: 0,
          givenTotal: 0,
          reservedPoints: 6,
          availableHeadroom: -6,
          recentSettlements: [],
          openClaims: [{
            id: "claim-2",
            repositoryName: "co-op/harbour",
            issueNumber: 21,
            title: "Chart the double crew",
            url: "https://github.com/co-op/harbour/issues/21",
            assigneeGitHubLogin: AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN,
            openingName: "Offer band",
            openingLabel: "shoal",
            reservePoints: 6,
          }],
          registeredRepositories: [],
          enforcementNotices: [],
          openAudit: null,
        }}
      />,
    );

    expect(screen.getByText(/· assignment ambiguous ·/)).toBeVisible();
    expect(screen.queryByText(/__overflow_ambiguous_claim__/)).not.toBeInTheDocument();
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
          openAudit: null,
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
          openAudit: null,
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
          openAudit: null,
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
          openAudit: null,
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
          openAudit: null,
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
          openAudit: null,
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
