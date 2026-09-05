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
    expect(screen.getByText(/repository sponsor must apply exactly one final-difficulty label/i)).toBeVisible();
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
    expect(screen.getByText(/no timing tolerance applies to reviews/i)).toBeVisible();
  });

  it("pairs rationale with the standing label and preserves the earlier-comment tolerance", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/earliest qualifying comment at or after the standing label/i)).toBeVisible();
    expect(screen.getByText(/if none exists, a comment up to 15 minutes before that label can count/i)).toBeVisible();
  });
});
