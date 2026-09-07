/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  audits: vi.fn(async () => []),
  history: vi.fn(async () => []),
  recalibrating: vi.fn(async () => []),
  moderators: vi.fn<() => Promise<{ accountId: string; githubLogin: string; isConfigured: boolean }[]>>(async () => []),
  candidates: vi.fn(async () => []),
  repositories: vi.fn(async () => []),
  closures: vi.fn(async () => ({ queue: [], history: [] })),
  corrections: vi.fn(async () => []),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/navigation")>(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: async () => {} }));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession: async () => ({
    user: { id: "moderator-1", role: "MODERATOR", name: "Moderator" },
  }),
  isModeratorSession: (session: { user: { role: string } }) => session.user.role === "MODERATOR",
}));
vi.mock("@/lib/dashboard/queries", () => ({
  listOpenAudits: loaders.audits,
  listEnforcementHistory: loaders.history,
  listRecalibratingAccounts: loaders.recalibrating,
  listAuditCandidates: loaders.candidates,
  listModerationRepositories: loaders.repositories,
  listUnwritableClosures: loaders.closures,
}));
vi.mock("@/lib/moderation/postgres-store", () => ({
  PostgresModerationStore: class { listModerators = loaders.moderators; },
}));
vi.mock("@/lib/overrides/postgres-store", () => ({ PostgresSettlementOverrideStore: class {} }));
vi.mock("@/lib/overrides/service", () => ({
  SettlementOverrideService: class { listOpenRequests = loaders.corrections; },
}));

const storeKey = Symbol.for("overflow.github.graphql-budget");
let previousStore: PropertyDescriptor | undefined;

beforeEach(async () => {
  previousStore = Object.getOwnPropertyDescriptor(globalThis, storeKey);
  vi.resetModules();
  vi.clearAllMocks();
  loaders.moderators.mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-07T14:15:00.000Z"));
  vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "600");
  const { createGitHubGraphqlBudgetStore } = await import("@/lib/github/rate-limit-budget");
  const store = createGitHubGraphqlBudgetStore();
  store.record("sponsor-1", {
    remaining: 42, limit: 5000, cost: 1,
    observedAt: new Date("2026-09-07T14:15:00.000Z"),
    resetAt: new Date("2026-09-07T15:00:00.000Z"),
  });
  Reflect.set(globalThis, storeKey, store);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (previousStore) Object.defineProperty(globalThis, storeKey, previousStore);
  else Reflect.deleteProperty(globalThis, storeKey);
});

describe("moderation budget integration", () => {
  it("contains a throwing assessment in the budget section alone", async () => {
    const budget = await import("@/lib/github/rate-limit-budget");
    vi.spyOn(budget, "assessGraphqlBudget").mockImplementation(() => {
      throw new Error("assessment failed");
    });
    const { default: ModerationPage } = await import("@/app/moderation/page");
    const { container } = render(await ModerationPage());

    expect(Array.from(container.querySelectorAll("section"), node => node.getAttribute("aria-labelledby"))).toEqual([
      "moderation-title", "open-audit-heading", "no-audits-heading",
      "settlement-corrections-heading", "unwritable-closures-heading",
      "recalibrating-heading", "moderators-heading", "unwritable-closure-history-heading",
      "enforcement-history-heading", "github-budget-heading",
    ]);
    expect(screen.queryByTestId("github-budget-panel")).toBeNull();
    const indicator = container.querySelector('[aria-labelledby="github-budget-heading"] > p');
    expect(indicator).toBeVisible();
    expect((indicator?.textContent ?? "").trim()).not.toBe("");
    for (const loader of Object.values(loaders)) expect(loader).toHaveBeenCalledTimes(1);
  });

  it("expires a hold using the clock of each page render", async () => {
    const { default: ModerationPage } = await import("@/app/moderation/page");
    render(await ModerationPage());
    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "BELOW_RESERVE");

    cleanup();
    vi.setSystemTime(new Date("2026-09-07T15:00:00.001Z"));
    render(await ModerationPage());
    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "UNKNOWN");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads the current store and reserve on every page render", async () => {
    const { gitHubGraphqlBudget } = await import("@/lib/github/rate-limit-budget");
    const store = gitHubGraphqlBudget();
    const read = vi.spyOn(store, "read");
    const { default: ModerationPage } = await import("@/app/moderation/page");
    render(await ModerationPage());

    expect(read).toHaveBeenCalledExactlyOnceWith("sponsor-1");
    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "BELOW_RESERVE");
    expect(screen.getByTestId("github-budget-remaining")).toHaveTextContent(/^42$/);
    expect(screen.getByTestId("github-budget-limit")).toHaveTextContent(/^5000$/);
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^600$/);
    const [firstReset, firstObserved] = screen.getByTestId("github-budget-panel").querySelectorAll("dl > dd > time");
    expect(firstReset).toBeVisible();
    expect(firstReset).toHaveTextContent("2026-09-07T15:00:00.000Z");
    expect(firstReset).toHaveAttribute("datetime", "2026-09-07T15:00:00.000Z");
    expect(firstObserved).toBeVisible();
    expect(firstObserved).toHaveTextContent("2026-09-07T14:15:00.000Z");
    expect(firstObserved).toHaveAttribute("datetime", "2026-09-07T14:15:00.000Z");

    cleanup();
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "800");
    vi.setSystemTime(new Date("2026-09-07T15:01:00.000Z"));
    store.record("sponsor-1", {
      remaining: 4200, limit: null, cost: 1,
      observedAt: new Date("2026-09-07T15:01:00.000Z"),
      resetAt: new Date("2026-09-07T16:00:00.000Z"),
    });
    render(await ModerationPage());

    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("github-budget-panel")).toHaveAttribute("data-budget-state", "AVAILABLE");
    expect(screen.getByTestId("github-budget-remaining")).toHaveTextContent(/^4200$/);
    expect(screen.getByTestId("github-budget-reserve")).toHaveTextContent(/^800$/);
    expect(screen.queryByTestId("github-budget-limit")).toBeNull();
    const [secondReset, secondObserved] = screen.getByTestId("github-budget-panel").querySelectorAll("dl > dd > time");
    expect(secondReset).toBeVisible();
    expect(secondReset).toHaveTextContent("2026-09-07T16:00:00.000Z");
    expect(secondReset).toHaveAttribute("datetime", "2026-09-07T16:00:00.000Z");
    expect(secondObserved).toBeVisible();
    expect(secondObserved).toHaveTextContent("2026-09-07T15:01:00.000Z");
    expect(secondObserved).toHaveAttribute("datetime", "2026-09-07T15:01:00.000Z");
  });
  it("attributes each reading and distinguishes no owners from a known unobserved owner", async () => {
    const { gitHubGraphqlBudget, createGitHubGraphqlBudgetStore } = await import("@/lib/github/rate-limit-budget");
    const store = gitHubGraphqlBudget();
    store.record("sponsor-2", { remaining: 4200, limit: null, cost: 1,
      resetAt: new Date("2026-09-07T16:00:00Z"), observedAt: new Date("2026-09-07T14:16:00Z") });
    store.noteState("sponsor-3", "UNKNOWN");
    const { default: ModerationPage } = await import("@/app/moderation/page");
    render(await ModerationPage());
    const panels = screen.getAllByTestId("github-budget-panel");
    expect(panels).toHaveLength(3);
    for (const [index, owner, state, remaining] of [
      [0, "sponsor-1", "BELOW_RESERVE", "42"],
      [1, "sponsor-2", "AVAILABLE", "4200"],
      [2, "sponsor-3", "UNKNOWN", null],
    ] as const) {
      const panel = panels[index];
      expect(panel).toHaveAttribute("data-budget-owner", owner);
      expect(panel).toHaveAttribute("data-budget-state", state);
      expect(within(panel).getByTestId("github-budget-owner")).toHaveTextContent(owner);
      expect(within(panel).getByTestId("github-budget-owner")).toBeVisible();
      if (remaining === null) expect(within(panel).queryByTestId("github-budget-remaining")).toBeNull();
      else expect(within(panel).getByTestId("github-budget-remaining").textContent).toBe(remaining);
    }
    cleanup();
    Reflect.set(globalThis, storeKey, createGitHubGraphqlBudgetStore());
    render(await ModerationPage());
    expect(screen.queryByTestId("github-budget-panel")).toBeNull();
    const empty = screen.getByTestId("github-budget-empty");
    expect(empty).toBeVisible();
    expect(empty).toHaveAttribute("data-budget-state", "UNKNOWN");
    expect((empty.textContent ?? "").trim()).not.toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses a login already loaded by the roster while retaining the account identity", async () => {
    loaders.moderators.mockResolvedValue([{ accountId: "sponsor-1", githubLogin: "octocat", isConfigured: false }]);
    const { default: ModerationPage } = await import("@/app/moderation/page");
    render(await ModerationPage());
    const panel = screen.getByTestId("github-budget-panel");
    expect(panel).toHaveAttribute("data-budget-owner", "sponsor-1");
    expect(within(panel).getByTestId("github-budget-owner")).toHaveTextContent(/^octocat$/);
    expect(within(panel).getByTestId("github-budget-owner")).toBeVisible();
    expect(loaders.moderators).toHaveBeenCalledTimes(1);
  });

});
