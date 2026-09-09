/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard/session", () => ({
  isModeratorSession: vi.fn(() => false),
  requireMemberPageSession: vi.fn(),
}));

import { RulesContent } from "@/app/rules/page";

describe("rules page", () => {
  it.each([false, true])("renders the Rules heading with isModerator=%s", (isModerator) => {
    render(<RulesContent memberName="Ada" isModerator={isModerator} />);

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
  });

  it("renders the member name passed to the shell", () => {
    render(<RulesContent memberName="Grace Hopper" isModerator={false} />);

    expect(screen.getByText("Grace Hopper")).toBeVisible();
  });

  it("points maintainers at a claim system they can install", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    // A reader depends on this link resolving, not on the sentence around it.
    const claim = screen.getByRole("link", { name: /claim/i });
    expect(claim).toHaveAttribute("href", "https://github.com/Nitjsefnie-Actions/claim");
  });

  it("exposes six named section landmarks", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(6);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
  });
});
