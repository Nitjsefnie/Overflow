/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubBudgetPanel } from "@/components/github-budget-panel";

const reading = {
  remaining: 4200,
  limit: 5000,
  cost: 1,
  resetAt: new Date("2026-09-07T15:00:00.000Z"),
  observedAt: new Date("2026-09-07T14:15:00.000Z"),
};

describe("GitHub budget panel", () => {
  it("renders the available budget figures and both instants", () => {
    render(<GitHubBudgetPanel assessment={{ state: "AVAILABLE", reading, reserve: 500 }} />);

    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "AVAILABLE");
    expect(screen.getByTestId("github-budget-remaining")).toHaveTextContent(/^4200$/);
    expect(screen.getByTestId("github-budget-limit")).toHaveTextContent(/^5000$/);
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.getByText("2026-09-07T15:00:00.000Z")).toBeVisible();
    expect(screen.getByText("2026-09-07T15:00:00.000Z")).toHaveAttribute("datetime", "2026-09-07T15:00:00.000Z");
    expect(screen.getByText("2026-09-07T14:15:00.000Z")).toBeVisible();
    expect(screen.getByText("2026-09-07T14:15:00.000Z")).toHaveAttribute("datetime", "2026-09-07T14:15:00.000Z");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("marks a held budget, preserves zero, and omits an absent limit", () => {
    render(<GitHubBudgetPanel assessment={{
      state: "BELOW_RESERVE", reading: { ...reading, remaining: 0, limit: null }, reserve: 500,
    }} />);

    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "BELOW_RESERVE");
    expect(screen.getByTestId("github-budget-remaining")).toHaveTextContent(/^0$/);
    expect(screen.queryByTestId("github-budget-limit")).toBeNull();
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.getByText("2026-09-07T15:00:00.000Z")).toBeVisible();
    expect(screen.getByText("2026-09-07T14:15:00.000Z")).toBeVisible();
    expect(screen.getByRole("status")).toBeVisible();
  });

  it("distinguishes an unobserved budget from an exhausted reading", () => {
    render(<GitHubBudgetPanel assessment={{ state: "UNKNOWN", reading: null, reserve: 500 }} />);

    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "UNKNOWN");
    expect(screen.queryByTestId("github-budget-remaining")).toBeNull();
    expect(screen.queryByTestId("github-budget-limit")).toBeNull();
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
