/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardContent } from "@/app/dashboard/page";
import { SettlementHistoryContent } from "@/app/settlements/page";
import { AppShell } from "@/components/app-shell";
import type { SettlementHistoryProjection } from "@/lib/dashboard/queries";

const settled: SettlementHistoryProjection = {
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
};

const unsettled: SettlementHistoryProjection = {
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
};

const unclaimed: SettlementHistoryProjection = {
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
};

function historyRows(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Settlement history" });
  return within(list).getAllByRole("listitem");
}

describe("settlement history page", () => {
  it("shows every settlement with the record behind its contribution to the balance", () => {
    render(
      <SettlementHistoryContent
        memberName="Ada Lovelace"
        isModerator={false}
        settlements={[settled, unsettled, unclaimed]}
      />,
    );

    const rows = historyRows();
    expect(rows).toHaveLength(3);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole("link", { name: "Issue #9: Close the lock" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/issues/9",
    );
    expect(first.getByText(/co-op\/harbour/)).toBeVisible();
    expect(first.getByText(/4 credits/)).toBeVisible();
    expect(first.getByText(/review deduction 3/)).toBeVisible();
    expect(first.getByText(/2026-09-03/)).toBeVisible();
    expect(first.getByRole("link", { name: "View proof for issue #9" })).toHaveAttribute(
      "href",
      "/settlements/settlement-9",
    );
  });

  it("keeps unsettled work visible as found and scored zero rather than as an error", () => {
    render(
      <SettlementHistoryContent memberName="Ada Lovelace" isModerator={false} settlements={[unsettled]} />,
    );

    const [row] = historyRows();
    expect(row).toBeDefined();
    expect(within(row as HTMLElement).getByText("Found · scored zero")).toBeVisible();
    expect(within(row as HTMLElement).getByText(/0 credits/)).toBeVisible();
    expect(within(row as HTMLElement).getByText(/settled label or its rationale comment/i)).toBeVisible();
    expect(within(row as HTMLElement).queryByText(/error|failed|broken/i)).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("link", { name: "View proof for issue #8" })).toHaveAttribute(
      "href",
      "/settlements/settlement-8",
    );
  });

  it("names each settlement's signed effect on the member's balance", () => {
    render(
      <SettlementHistoryContent
        memberName="Ada Lovelace"
        isModerator={false}
        settlements={[settled, unsettled, unclaimed]}
      />,
    );

    const rows = historyRows();
    expect(within(rows[0] as HTMLElement).getByText(/\+4/)).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText(/balance effect 0/i)).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText(/−6/)).toBeVisible();
  });

  it("states the depth the list is capped at", () => {
    render(
      <SettlementHistoryContent memberName="Ada Lovelace" isModerator={false} settlements={[settled]} />,
    );

    expect(screen.getByText(/most recent 200 settlements/i)).toBeVisible();
  });

  it("renders external issue titles as text", () => {
    render(
      <SettlementHistoryContent
        memberName="Ada Lovelace"
        isModerator={false}
        settlements={[{ ...settled, issueTitle: "<script>untrusted title</script>" }]}
      />,
    );

    expect(screen.getByRole("link", { name: /<script>untrusted title<\/script>/ })).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });

  it("uses the shared empty-state treatment when no settlement is party to the account", () => {
    const { container } = render(
      <SettlementHistoryContent memberName="Ada Lovelace" isModerator={false} settlements={[]} />,
    );

    expect(
      screen.getByRole("heading", { name: "No settlement is recorded against this account yet." }),
    ).toBeVisible();
    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Find eligible issues" })).toHaveAttribute("href", "/issues");
  });

  it("is reachable from the dashboard settlement card and the member navigation", () => {
    const { unmount } = render(
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
    expect(screen.getByRole("link", { name: "See the full settlement history" })).toHaveAttribute(
      "href",
      "/settlements",
    );
    unmount();

    render(
      <AppShell memberName="Ada Lovelace" isModerator={false}>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Settlements" })).toHaveAttribute("href", "/settlements");
  });
});
