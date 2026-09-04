/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardContent } from "@/app/dashboard/page";
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
          creditFloor: 5,
          recentSettlements: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Ledger position" })).toBeVisible();
    expect(screen.getByText("+12")).toBeVisible();
    expect(screen.getByText("Earned 19")).toBeVisible();
    expect(screen.getByText("Given 7")).toBeVisible();
    expect(screen.getByText("Reserved 4")).toBeVisible();
    expect(screen.getByText("Available headroom 8")).toBeVisible();
    expect(screen.getByText("Optional credit floor 5")).toBeVisible();
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
    expect(screen.queryByText(/credit floor/i)).not.toBeInTheDocument();

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
