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
    expect(factValues()).toEqual(["moonlit ridge", "5", "8"]);
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

  it("reads the supporting lines down one column beside the facts grid", () => {
    const { container } = render(
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

    const card = container.firstElementChild as HTMLElement;
    // The card grid places exactly two blocks, so nothing else can alternate
    // between its two columns.
    expect(card.children).toHaveLength(2);

    const [main, facts] = Array.from(card.children);
    expect(facts.tagName).toBe("DL");
    expect(facts.classList.contains("issue-facts")).toBe(true);

    // No supporting line is a direct grid child; they all sit inside the
    // first block with the heading.
    const directParagraphs = Array.from(card.children).filter((child) => child.tagName === "P");
    expect(directParagraphs).toHaveLength(0);

    expect(main.querySelector("h2")).not.toBeNull();
    const lines = Array.from(main.children).filter((child) => child.tagName === "P");
    expect(lines).toHaveLength(4);
    // Lines are identified by fixture data, never by label wording, so a
    // product-neutral rewording cannot fail a structural test.
    const markers = ["harbour-owner", "mira", "−3", "2026-09-01"];
    const order = lines.map((line) =>
      markers.findIndex((marker) => line.textContent?.includes(marker)),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("keeps the single reading column when the optional facts are absent", () => {
    const { container } = render(
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

    const card = container.firstElementChild as HTMLElement;
    expect(card.children).toHaveLength(2);
    const [main, facts] = Array.from(card.children);
    expect(facts.tagName).toBe("DL");
    expect(facts.classList.contains("issue-facts")).toBe(true);
    const lines = Array.from(main.children).filter((child) => child.tagName === "P");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent?.includes("2026-09-01")).toBe(true);
  });

  it("strips the catalog name prefix from an opening label that carries it", () => {
    render(
      <IssueCard
        issue={{
          id: "issue-42",
          repositoryName: "co-op/harbour",
          issueNumber: 42,
          title: "Map the tidal cache",
          url: "https://github.com/co-op/harbour/issues/42",
          openingName: "perceived difficulty",
          openingLabel: "perceived difficulty: 3",
          comparisonPoints: 5,
          reservePoints: 8,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    // The term carries the catalog name and the value carries only the value —
    // a perception-catalog label stores "<name>: <value>", so the name must
    // not repeat inside the opening row.
    expect(factTerms()).toEqual(["perceived difficulty", "Comparison", "Reserve"]);
    expect(factValues()).toEqual(["3", "5", "8"]);
  });

  it("leaves an opening label without the name prefix unchanged", () => {
    render(
      <IssueCard
        issue={{
          id: "issue-42",
          repositoryName: "co-op/harbour",
          issueNumber: 42,
          title: "Map the tidal cache",
          url: "https://github.com/co-op/harbour/issues/42",
          openingName: "perceived difficulty",
          openingLabel: "delta",
          comparisonPoints: 5,
          reservePoints: 8,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(factTerms()).toEqual(["perceived difficulty", "Comparison", "Reserve"]);
    expect(factValues()).toEqual(["delta", "5", "8"]);
  });

  it("renders each fact's value alone under its term", () => {
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
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    // The term carries the field name and the value carries only the value —
    // the opening row's label never repeats the term as a name prefix.
    expect(factTerms()).toEqual(["Promise band", "Comparison", "Reserve"]);
    expect(factValues()).toEqual(["moonlit ridge", "5", "8"]);
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

  it("rounds a fractional headroom to the digits a reader uses", () => {
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
          availableHeadroom: -4 / 7,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Headroom: −0.57")).toBeVisible();
    expect(screen.queryByText("Headroom: −0.5714285714285714")).not.toBeInTheDocument();
  });

  it("keeps the shared formatter's en-US grouping for a large positive headroom", () => {
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
          availableHeadroom: 1234.5,
          createdAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Headroom: +1,234.5")).toBeVisible();
    expect(screen.queryByText("Headroom: +1234.5")).not.toBeInTheDocument();
  });
});

function factTerms(): string[] {
  return Array.from(document.querySelectorAll("dl.issue-facts dt")).map((dt) => dt.textContent);
}

function factValues(): string[] {
  return Array.from(document.querySelectorAll("dl.issue-facts dd")).map((dd) => dd.textContent);
}
