/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard/session", () => ({
  isModeratorSession: vi.fn(() => false),
  requireMemberPageSession: vi.fn(),
}));

import { RulesContent } from "@/app/rules/page";

describe("rules page", () => {
  it("tells contributors to claim before starting on an open, unassigned issue", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/claim an issue before work begins by commenting \/claim on the open, unassigned issue/i)).toBeVisible();
  });

  it("requires the whole claim comment to be exactly the command", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/the comment body must be exactly \/claim; a sentence containing the command is not a claim/i)).toBeVisible();
  });

  it("explains that the claim comment makes an account assignable and prevents advance assignment", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/github will not accept an assignee who has not interacted with the repository, so nobody can assign you in advance; the claim comment makes your account assignable/i)).toBeVisible();
  });

  it("identifies the claim comment as the only route without write access", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/for contributors without write access, that comment is the only claiming route/i)).toBeVisible();
  });

  it("attributes the claim command to each repository's workflow", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/the command is provided by a workflow each repository ships, not by overflow/i)).toBeVisible();
  });

  it("states that repositories without the command have no claiming route", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/claiming works only where the repository provides the command; a repository without it has no claiming route/i)).toBeVisible();
  });

  it("connects claiming to the assignment used for point reservations", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/a claim creates the assignment used for the sponsor's point reservation described below/i)).toBeVisible();
  });

  it("explains that unclaim and release are aliases removing only your own assignment", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/\/unclaim and \/release are two names for the same command; comment either one to remove only your own assignment/i)).toBeVisible();
  });

  it("requires releasing stopped work before the closing merge to remove reserved points", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    expect(screen.getByText(/release an issue you stop working on before the merge that would close it, because the assignment holds reserve points until it is removed/i)).toBeVisible();
  });

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
