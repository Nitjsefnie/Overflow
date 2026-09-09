/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssueCard } from "@/components/issue-card";
import { AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN } from "@/lib/github/types";

describe("eligible issue card", () => {
  it("renders repository-configured catalog language and reserve data", () => {
    render(
      <IssueCard
        issue={{
          id: "issue-42",
          repositoryName: "co-op/harbour",
          issueNumber: 42,
          title: "Map the tidal cache",
          url: "https://github.com/co-op/harbour/issues/42",
          openingName: "Promise band",
          openingLabel: "moonlit ridge",
          comparisonPoints: 5,
          reservePoints: 8,
          sponsorLogin: "harbour-owner",
          assigneeGitHubLogin: "mira",
          claimState: "CLAIMED",
          availableHeadroom: -3,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Map the tidal cache" })).toBeVisible();
    expect(screen.getByText("Promise band: moonlit ridge")).toBeVisible();
    expect(screen.getByText("Comparison 5")).toBeVisible();
    expect(screen.getByText("Reserve 8")).toBeVisible();
    expect(screen.getByText("Sponsor: harbour-owner")).toBeVisible();
    expect(screen.getByText("Claim: assigned to mira")).toBeVisible();
    expect(screen.getByText("Headroom: −3")).toBeVisible();
  });

  it("reads an ambiguous multiple-assignee claim as a phrase instead of the reserved sentinel login", () => {
    render(
      <IssueCard
        issue={{
          id: "issue-77",
          repositoryName: "co-op/harbour",
          issueNumber: 77,
          title: "Chart the double crew",
          url: "https://github.com/co-op/harbour/issues/77",
          openingName: "Promise band",
          openingLabel: "delta",
          comparisonPoints: 3,
          reservePoints: 6,
          sponsorLogin: "harbour-owner",
          assigneeGitHubLogin: AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN,
          claimState: "CLAIMED",
          availableHeadroom: -6,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Claim: assignment ambiguous")).toBeVisible();
    // The sentinel is a machine value; a reader never sees the reserved login itself.
    expect(screen.queryByText(/__overflow_ambiguous_claim__/)).not.toBeInTheDocument();
  });

  it("treats GitHub strings as text rather than markup", () => {
    render(
      <IssueCard
        issue={{
          id: "issue-99",
          repositoryName: "co-op/harbour",
          issueNumber: 99,
          title: "<strong>untrusted GitHub title</strong>",
          url: "https://github.com/co-op/harbour/issues/99",
          openingName: "Promise band",
          openingLabel: "blue / green",
          comparisonPoints: 1,
          reservePoints: 1,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("<strong>untrusted GitHub title</strong>")).toBeVisible();
    expect(document.querySelector("strong")).toBeNull();
  });
});
