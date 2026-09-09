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
    expect(ledgerTotalValues()).toEqual(["19", "7", "4", "8"]);
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
    expect(cellValue("enforcement-notices-heading", "2026-09-03", "Transition")).toBe(
      "Under audit → Warned",
    );
    expect(screen.queryByText(/UNDER_AUDIT|WARNED/)).not.toBeInTheDocument();
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
    // The labelledby target is the heading itself: a refactor that drops or
    // renames its id would leave the section silently unlabelled.
    const heading = within(section).getByRole("heading");
    expect(heading).toBeVisible();
    expect(heading).toHaveAttribute("id", "account-audit-heading");
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
    // The labelledby target is the heading itself: a refactor that drops or
    // renames its id would leave the section silently unlabelled.
    const heading = within(section).getByRole("heading");
    expect(heading).toBeVisible();
    expect(heading).toHaveAttribute("id", "account-audit-heading");
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

    expect(cellValue("open-claims-heading", "Chart the double crew", "Assignee")).toBe(
      "assignment ambiguous",
    );
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

    const repos = "registered-repositories-heading";
    expect(cellValue(repos, "co-op/harbour", "Status")).toBe(
      "unavailable: not found on GitHub or no longer public",
    );
    expect(cellValue(repos, "co-op/lighthouse", "Status")).toBe("unavailable: no longer public");
    expect(cellValue(repos, "co-op/breakwater", "Status")).toBe("unavailable: identity mismatch");
    // The available repository says nothing extra: no Status cell, no unavailable copy.
    expect(listItem(repos, "co-op/seawall")).not.toHaveTextContent(/unavailable/i);
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

    expect(cellValue("registered-repositories-heading", "co-op/harbour", "Status")).toBe(
      "unavailable",
    );
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

    const repos = "registered-repositories-heading";
    expect(cellValue(repos, "co-op/harbour", "Reconciliation")).toBe(
      "reconciliation is failing (last failed 2026-09-04); Overflow keeps retrying",
    );
    expect(cellValue(repos, "co-op/lighthouse", "Reconciliation")).toBe(
      "retrying reconciliation after a failure",
    );
    expect(cellValue(repos, "co-op/breakwater", "Reconciliation")).toBe(
      "retrying reconciliation after a failure",
    );
    expect(cellValue(repos, "co-op/jetty", "Reconciliation")).toBe("reconciliation queued");
    expect(cellValue(repos, "co-op/quay", "Reconciliation")).toBe("reconciliation queued");
    expect(cellValue(repos, "co-op/seawall", "Reconciliation")).toBeNull();
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

    const repos = "registered-repositories-heading";
    expect(cellValue(repos, "co-op/harbour", "Status")).toBe(
      "unavailable: not found on GitHub or no longer public",
    );
    expect(cellValue(repos, "co-op/harbour", "Reconciliation")).toBe(
      "reconciliation is failing (last failed 2026-09-04); Overflow keeps retrying",
    );
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

    expect(cellValue("registered-repositories-heading", "co-op/harbour", "Reconciliation")).toBe(
      "reconciliation is failing; Overflow keeps retrying",
    );
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
    // a retry here would be a plain untruth on a line that already reads "Inactive".
    const repos = "registered-repositories-heading";
    expect(cellValue(repos, "co-op/harbour", "Activity")).toBe("Inactive");
    expect(cellValue(repos, "co-op/harbour", "Reconciliation")).toBe(
      "reconciliation is failing (last failed 2026-09-04); it will not be retried while the repository is inactive",
    );
    expect(cellValue(repos, "co-op/lighthouse", "Reconciliation")).toBe(
      "reconciliation is failing (last failed 2026-09-04); Overflow keeps retrying",
    );
    expect(cellValue(repos, "co-op/breakwater", "Reconciliation")).toBe("reconciliation queued");
    expect(cellValue(repos, "co-op/seawall", "Reconciliation")).toBe(
      "reconciliation is failing; it will not be retried while the repository is inactive",
    );
  });

  it("lays every dashboard list section out as labelled grids of terms above values", () => {
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
          openClaims: [{
            id: "claim-1",
            repositoryName: "co-op/harbour",
            issueNumber: 17,
            title: "Close the lock",
            url: "https://github.com/co-op/harbour/issues/17",
            assigneeGitHubLogin: "mira",
            openingName: "Offer band",
            openingLabel: "shoal",
            reservePoints: 7,
          }],
          registeredRepositories: [registered("repo-1", "co-op/harbour")],
          enforcementNotices: [{
            id: "notice-1",
            priorState: "ACTIVE",
            newState: "BANNED",
            reason: "Sustained overestimate pattern.",
            createdAt: "2026-09-02T00:00:00.000Z",
          }],
          openAudit: null,
        }}
      />,
    );

    // Every list in the three sections is a grid: each list item's cells pair
    // exactly one term above its value — the bordered-grid treatment the
    // dashboard's other multi-value blocks use.
    for (const labelledBy of [
      "open-claims-heading",
      "registered-repositories-heading",
      "enforcement-notices-heading",
    ]) {
      const section = sectionFor(labelledBy);
      const items = within(section).getAllByRole("listitem");
      expect(items).toHaveLength(1);
      for (const item of items) {
        const cells = item.querySelectorAll("dl > div");
        expect(cells.length).toBeGreaterThan(0);
        for (const cell of cells) {
          expect(cell.querySelectorAll("dt")).toHaveLength(1);
          expect(cell.querySelectorAll("dd")).toHaveLength(1);
          expect(cell.children[0].tagName).toBe("DT");
          expect(cell.children[1].tagName).toBe("DD");
        }
      }
    }
    expect(cellValue("open-claims-heading", "co-op/harbour", "Catalog")).toBe("Offer band: shoal");
    expect(cellValue("open-claims-heading", "co-op/harbour", "Reserve")).toBe("7");
    expect(cellValue("registered-repositories-heading", "co-op/harbour", "Catalog")).toBe(
      "Offer band / Delivered band",
    );
    expect(cellValue("enforcement-notices-heading", "2026-09-02", "Recorded")).toBe("2026-09-02");
    expect(cellValue("enforcement-notices-heading", "2026-09-02", "Transition")).toBe(
      "Active → Banned",
    );
  });

  it("shows repository visibility as display text, never the stored form", () => {
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
            registered("repo-1", "co-op/harbour"),
            { ...registered("repo-2", "co-op/lighthouse"), visibility: "PRIVATE" },
          ],
          enforcementNotices: [],
          openAudit: null,
        }}
      />,
    );

    const repos = "registered-repositories-heading";
    expect(cellValue(repos, "co-op/harbour", "Visibility")).toBe("Public");
    expect(cellValue(repos, "co-op/lighthouse", "Visibility")).toBe("Private");
    expect(screen.queryByText(/PUBLIC|PRIVATE/)).not.toBeInTheDocument();
  });

  it("renders the Account audit section beside the three list grids when an audit is open", () => {
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
          openClaims: [{
            id: "claim-1",
            repositoryName: "co-op/harbour",
            issueNumber: 17,
            title: "Close the lock",
            url: "https://github.com/co-op/harbour/issues/17",
            assigneeGitHubLogin: "mira",
            openingName: "Offer band",
            openingLabel: "shoal",
            reservePoints: 7,
          }],
          registeredRepositories: [registered("repo-1", "co-op/harbour")],
          enforcementNotices: [{
            id: "notice-1",
            priorState: "RECALIBRATING",
            newState: "ACTIVE",
            reason: "Sustained overestimate pattern.",
            createdAt: "2026-09-02T00:00:00.000Z",
          }],
          openAudit: { id: "audit-1", openedAt: "2026-09-06T00:00:00.000Z" },
        }}
      />,
    );

    // The audit section's presence rides the open audit alone; the three
    // grids render beside it, and the audit keeps its own heading.
    const section = sectionFor("account-audit-heading");
    expect(within(section).getByRole("heading", { name: "Account audit" })).toBeVisible();
  });

  it("keeps the three list sections' empty states rendering without any list item", () => {
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

    // Structurally: each section still stands, carries its rendered empty
    // copy, and holds no grid rows.
    for (const labelledBy of [
      "open-claims-heading",
      "registered-repositories-heading",
      "enforcement-notices-heading",
    ]) {
      const section = sectionFor(labelledBy);
      expect(within(section).queryAllByRole("listitem")).toHaveLength(0);
      expect(section.querySelectorAll("p").length).toBeGreaterThan(0);
    }
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
    expect(ledgerTotalValues()).toEqual(["1", "3", "4", "−6"]);

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
    expect(document.querySelector(".balance-number")?.textContent).toBe("0");
    expect(ledgerTotalValues()).toEqual(["5", "5", "0", "0"]);
  });

  it("renders each ledger total's value alone under its term", () => {
    render(
      <BalanceCard
        dashboard={{
          settledBalance: 12,
          earnedTotal: 19,
          givenTotal: 7,
          reservedPoints: 4,
          availableHeadroom: 8,
        }}
      />,
    );

    // The term carries the field name and the value carries only the value —
    // the figure itself never repeats the term as a prefix.
    expect(ledgerTotalTerms()).toEqual(["Earned", "Given", "Reserved", "Available headroom"]);
    expect(ledgerTotalValues()).toEqual(["19", "7", "4", "8"]);
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

function ledgerTotalTerms(): string[] {
  return Array.from(document.querySelectorAll("dl.ledger-totals dt")).map((dt) => dt.textContent);
}

function ledgerTotalValues(): string[] {
  return Array.from(document.querySelectorAll("dl.ledger-totals dd")).map((dd) => dd.textContent);
}

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

function sectionFor(labelledBy: string): HTMLElement {
  const section = document.querySelector(`section[aria-labelledby="${labelledBy}"]`);
  if (section === null) throw new Error(`no section labelled by ${labelledBy}`);
  return section as HTMLElement;
}

function listItem(labelledBy: string, rowKey: string): HTMLElement {
  const item = Array.from(sectionFor(labelledBy).querySelectorAll("li")).find(
    (li) => li.textContent?.includes(rowKey),
  );
  if (item === undefined) throw new Error(`no list item containing "${rowKey}" in ${labelledBy}`);
  return item;
}

/** The value under `term` in the row holding `rowKey`, or null when that row has no such cell. */
function cellValue(labelledBy: string, rowKey: string, term: string): string | null {
  for (const cell of listItem(labelledBy, rowKey).querySelectorAll("dl > div")) {
    if (cell.querySelector("dt")?.textContent === term) {
      return cell.querySelector("dd")?.textContent ?? "";
    }
  }
  return null;
}
