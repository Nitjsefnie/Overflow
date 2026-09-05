/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard/session", () => ({
  isModeratorSession: vi.fn(() => false),
  requireMemberPageSession: vi.fn(),
}));

import { RulesContent } from "@/app/rules/page";

describe("rules page", () => {
  it("names the repository sponsor, not the issue owner, as the only rating authority", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/repository sponsor.{0,40}earliest starting-difficulty label/i)).toBeVisible();
    expect(screen.getByText(/exactly one final-difficulty label must be active on the issue when the window closes/i)).toBeVisible();
    expect(screen.getByText(/its standing application must be by the repository sponsor between the pull request's final commit and merge/i)).toBeVisible();
    expect(screen.getByText(/only the sponsor prices work: labels and comments from anyone else/i)).toBeVisible();
    expect(screen.queryByText(/issue owner/i)).not.toBeInTheDocument();
  });

  it("states that a rationale comment edited after the window closes does not count", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/edited after the window closes does not count/i)).toBeVisible();
    expect(screen.getByText(/window closes 15 minutes after merge/i)).toBeVisible();
  });

  it("states the merge-time policy for dismissed reviews", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/changes-requested reviews submitted before merge/i)).toBeVisible();
    expect(screen.getByText(/dismissed after the merge still counts/i)).toBeVisible();
    expect(screen.getByText(/dismissed before the merge does not/i)).toBeVisible();
    expect(screen.getByText(/a dismissal exactly at merge also leaves the round counted/i)).toBeVisible();
    expect(screen.getByText(/no timing tolerance applies to reviews/i)).toBeVisible();
  });

  it("requires dismissal history establishing that a dismissed review requested changes", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/a dismissed review counts only if its dismissal history establishes that it requested changes; missing history or an unknown previous state does not count/i)).toBeVisible();
  });

  it("pairs rationale with the standing label and preserves the earlier-comment tolerance", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/earliest qualifying comment at or after the standing label/i)).toBeVisible();
    expect(screen.getByText(/if none exists, a comment up to 15 minutes before that label can count/i)).toBeVisible();
  });
});
