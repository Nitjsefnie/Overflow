/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RulesContent } from "@/app/rules/page";
import { AppShell } from "@/components/app-shell";

describe("rules page", () => {
  it("states the credit formula that decides every settlement", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    expect(screen.getByText("credits = max(0, actual points − distinct review rounds)")).toBeVisible();
  });

  it("states each piece of evidence a settlement requires", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const evidence = screen.getByRole("region", { name: "What makes work settle" });
    expect(evidence).toHaveTextContent("closedByPullRequestsReferences");
    expect(evidence).toHaveTextContent("between the closing pull request's final commit and its merge");
    expect(evidence).toHaveTextContent("names that label");
    expect(evidence).toHaveTextContent("Pull request labels never price work.");
  });

  it("states the fifteen-minute tolerance on that evidence", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    expect(screen.getByText(/fifteen minutes/)).toBeVisible();
  });

  it("states the moderation ladder in order", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const ladder = screen.getByRole("region", { name: "Moderation" });
    expect(ladder).toHaveTextContent("audit → warn → recalibrate → ban");
  });

  it("states that self-work creates no ledger entry", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    expect(screen.getByText(/creates no ledger entry/)).toBeVisible();
  });

  it("states how opening difficulty is decided", () => {
    render(<RulesContent memberName="Ada Lovelace" isModerator={false} />);

    const opening = screen.getByRole("region", { name: "What work is worth before it starts" });
    expect(opening).toHaveTextContent("before the first assignment");
  });

  it("is reachable from the member navigation", () => {
    render(
      <AppShell memberName="Ada Lovelace" isModerator={false}>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/rules");
  });
});
