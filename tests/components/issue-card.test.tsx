/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssueCard } from "@/components/issue-card";

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
