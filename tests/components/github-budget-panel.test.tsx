/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubBudgetPanel } from "@/components/github-budget-panel";
import { createGitHubGraphqlBudgetStore, type GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";

const storeKey = Symbol.for("overflow.github.graphql-budget");
const previousStore = Object.getOwnPropertyDescriptor(globalThis, storeKey);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (previousStore) Object.defineProperty(globalThis, storeKey, previousStore);
  else Reflect.deleteProperty(globalThis, storeKey);
});

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
    expect(screen.getByTestId("github-budget-remaining")).toBeVisible();
    expect(screen.getByTestId("github-budget-limit")).toHaveTextContent(/^5000$/);
    expect(screen.getByTestId("github-budget-limit")).toBeVisible();
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.getByTestId("github-budget-reserve")).toBeVisible();
    const [reset, observed] = screen.getByTestId("github-budget-panel").querySelectorAll("dl > dd > time");
    expect(reset).toBeVisible();
    expect(reset).toHaveTextContent("2026-09-07T15:00:00.000Z");
    expect(reset).toHaveAttribute("datetime", "2026-09-07T15:00:00.000Z");
    expect(observed).toBeVisible();
    expect(observed).toHaveTextContent("2026-09-07T14:15:00.000Z");
    expect(observed).toHaveAttribute("datetime", "2026-09-07T14:15:00.000Z");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([42, 0])("marks a held budget of %i and omits an absent limit", (remaining) => {
    render(<GitHubBudgetPanel assessment={{
      state: "BELOW_RESERVE", reading: { ...reading, remaining, limit: null }, reserve: 500,
    }} />);

    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "BELOW_RESERVE");
    expect(screen.getByTestId("github-budget-remaining").textContent).toBe(String(remaining));
    expect(screen.getByTestId("github-budget-remaining")).toBeVisible();
    expect(screen.queryByTestId("github-budget-limit")).toBeNull();
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.getByTestId("github-budget-reserve")).toBeVisible();
    const [reset, observed] = screen.getByTestId("github-budget-panel").querySelectorAll("dl > dd > time");
    expect(reset).toBeVisible();
    expect(reset).toHaveTextContent("2026-09-07T15:00:00.000Z");
    expect(reset).toHaveAttribute("datetime", "2026-09-07T15:00:00.000Z");
    expect(observed).toBeVisible();
    expect(observed).toHaveTextContent("2026-09-07T14:15:00.000Z");
    expect(observed).toHaveAttribute("datetime", "2026-09-07T14:15:00.000Z");
    const indicator = screen.getByRole("status");
    expect(indicator).toBeVisible();
    expect((indicator.textContent ?? "").trim()).not.toBe("");
  });

  it("distinguishes an unobserved budget from an exhausted reading", () => {
    render(<GitHubBudgetPanel assessment={{ state: "UNKNOWN", reading: null, reserve: 500 }} />);

    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "UNKNOWN");
    const indicator = screen.getByTestId("github-budget-panel").querySelector(":scope > p");
    expect(indicator).toBeVisible();
    expect((indicator?.textContent ?? "").trim()).not.toBe("");
    expect(screen.queryByTestId("github-budget-remaining")).toBeNull();
    expect(screen.queryByTestId("github-budget-limit")).toBeNull();
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^500$/);
    expect(screen.getByTestId("github-budget-reserve")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders only its assessment with either an empty or populated shared store", () => {
    const store = createGitHubGraphqlBudgetStore();
    Reflect.set(globalThis, storeKey, store);
    const read = vi.spyOn(store, "read");
    const assessment: GitHubGraphqlBudgetAssessment = {
      state: "UNKNOWN", reading: { ...reading, remaining: 42 }, reserve: 500,
    };
    const first = render(<GitHubBudgetPanel assessment={assessment} />);
    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "UNKNOWN");
    expect(screen.queryByRole("status")).toBeNull();
    const output = first.container.innerHTML;
    cleanup();

    store.record({ ...reading, remaining: 1 });
    const second = render(<GitHubBudgetPanel assessment={assessment} />);
    expect(second.container.innerHTML).toBe(output);
    expect(read).not.toHaveBeenCalled();
  });

  it("renders the same assessment across clock changes without reading the clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T14:15:00.000Z"));
    const clockReads = vi.fn();
    vi.stubGlobal("Date", new Proxy(Date, {
      construct(target, args) {
        if (args.length === 0) clockReads();
        return Reflect.construct(target, args);
      },
      apply(target, thisArg, args) {
        clockReads();
        return Reflect.apply(target, thisArg, args);
      },
    }));
    const assessment: GitHubGraphqlBudgetAssessment = {
      state: "BELOW_RESERVE", reading: { ...reading, remaining: 42 }, reserve: 500,
    };
    const first = render(<GitHubBudgetPanel assessment={assessment} />);
    const output = first.container.innerHTML;
    cleanup();

    vi.setSystemTime(new Date("2026-09-07T15:00:00.001Z"));
    const second = render(<GitHubBudgetPanel assessment={assessment} />);
    expect(second.container.innerHTML).toBe(output);
    expect(clockReads).not.toHaveBeenCalled();
  });
});
