/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const currentRole = vi.fn();
const readStats = vi.fn();
const readProgress = vi.fn();
const refusedAttempts = {
  MISSING_CATALOG_LABELS: 2, WEBHOOK_SCOPE_MISSING: 3, NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED: 5,
  NOT_PUBLIC: 7, ALREADY_REGISTERED: 13, OTHER: 0,
};
const refusalLabels = Object.fromEntries(
  Object.keys(refusedAttempts).map((kind, index) => [kind, `sentinel-refusal-${index}`]),
) as Record<keyof typeof refusedAttempts, string>;

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@/auth", () => ({ auth, signIn: vi.fn() }));
  vi.doMock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));
  vi.doMock("@/lib/public-stats", async () => ({
    ...await vi.importActual<typeof import("@/lib/public-stats")>("@/lib/public-stats"),
    getSettledWorkStats: readStats, getOwnerProgressStats: readProgress, SETTLED_WORK_REFRESH_MINUTES: 7,
    REGISTRATION_REFUSAL_LABELS: refusalLabels,
  }));
  auth.mockResolvedValue(null);
  readStats.mockResolvedValue({ pullRequests: 23, contributors: 4, points: 117, noRoundPullRequests: 19, meanReviewRounds: 3 / 7, readAt: new Date("2026-10-27T11:12:00Z") });
  readProgress.mockResolvedValue({
    registrationStarts: 101, repositories: 58, githubRepositories: 41, gitlabRepositories: 17,
    listedIssue: 29, contributorReviewed: 19, listedSecondIssue: 11,
    refusedAttempts,
  });
});

afterEach(() => {
  auth.mockReset();
  currentRole.mockReset();
  readStats.mockReset();
  readProgress.mockReset();
  vi.doUnmock("@/auth");
  vi.doUnmock("@/lib/moderation/current-role");
  vi.doUnmock("@/lib/public-stats");
  vi.resetModules();
});

async function renderStats() {
  const { default: StatsPage } = await import("@/app/stats/page");
  return render(await StatsPage());
}

describe("settled work page", () => {
  it("places both figure sections under peer headings beneath the page heading", async () => {
    await renderStats();
    const main = screen.getByRole("main");
    const pageHeading = main.querySelector(".page-heading h1");
    expect(pageHeading).not.toBeNull();
    const sections = main.querySelectorAll("section.surface");
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const heading = section.querySelector(":scope > h2");
      expect(heading).not.toBeNull();
      expect(pageHeading!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("renders aggregate figures and their read time for a signed-out visitor", async () => {
    await renderStats();
    const main = screen.getByRole("main");
    expect(main).toHaveClass("page-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect([...main.querySelectorAll("section.surface")[0]!.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["23", "4", "117", "19", "0.43"]);
    expect(screen.getByRole("main").querySelectorAll("section.surface")[0]!.querySelector("[role='status']")).toBeNull();
    expect(screen.getByText("23")).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
    expect(screen.getByText("117")).toBeVisible();
    expect(main.querySelector("time")).toHaveAttribute("datetime", "2026-10-27T11:12:00.000Z");
    expect(main.querySelector("time")).toHaveTextContent("2026-10-27 11:12 UTC");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("states the cache's refresh interval from the exported constant", async () => {
    await renderStats();
    // The mock's 7 differs from the shipped 10, so a page that hardcodes its own number fails here.
    expect(screen.getByRole("main").querySelector("time[datetime='PT7M']")).toHaveTextContent("7 minutes");
  });

  it("renders zero and one without suppressing either count", async () => {
    readStats.mockResolvedValue({ pullRequests: 0, contributors: 0, points: 0, noRoundPullRequests: 0, meanReviewRounds: null, readAt: new Date("2026-10-27T11:12:00Z") });
    const empty = await renderStats();
    const emptySection = screen.getByRole("main").querySelectorAll("section.surface")[0]!;
    expect([...emptySection.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["0", "0", "0", "0"]);
    // With no settled pull request there is no mean: a note stands in for the figure.
    const note = emptySection.querySelector("[role='status']");
    expect(note).toBeVisible();
    expect(note!.textContent!.trim().length).toBeGreaterThan(0);
    expect(note!.querySelector("strong")).toBeNull();
    expect(note!.textContent).not.toMatch(/\d|NaN/);
    empty.unmount();
    readStats.mockResolvedValue({ pullRequests: 1, contributors: 1, points: 1, noRoundPullRequests: 1, meanReviewRounds: 0, readAt: new Date("2026-10-27T11:12:00Z") });
    await renderStats();
    const oneSection = screen.getByRole("main").querySelectorAll("section.surface")[0]!;
    expect([...oneSection.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["1", "1", "1", "1", "0"]);
    expect(oneSection.querySelector("[role='status']")).toBeNull();
  });

  it.each(["public", "signed-in"])("renders every owner-progress figure in its section for a %s visitor", async (visitor) => {
    if (visitor === "signed-in") {
      auth.mockResolvedValue({ user: { id: "member-1", name: "Ada" } });
      currentRole.mockResolvedValue("MEMBER");
    }
    const { container } = await renderStats();
    const sections = screen.getByRole("main").querySelectorAll("section.surface");
    expect(sections[1]).toBeDefined();
    expect([...sections[1]!.querySelectorAll("strong")].map((node) => node.textContent))
      .toEqual(["101", "58", "41", "17", "29", "19", "11", "2", "3", "5", "7", "13", "0"]);
    for (const [kind, count] of Object.entries(refusedAttempts)) {
      const label = refusalLabels[kind as keyof typeof refusedAttempts];
      const row = [...sections[1]!.querySelectorAll("p")].find((candidate) => candidate.textContent!.endsWith(label));
      expect(row, `row for ${label}`).toBeDefined();
      expect(row!.querySelector("strong")?.textContent).toBe(String(count));
    }
    expect(container.querySelector("script")).toBeNull();
  });

  it.each(["public", "signed-in"])("preserves settled figures when owner progress fails for a %s visitor", async (visitor) => {
    if (visitor === "signed-in") {
      auth.mockResolvedValue({ user: { id: "member-1", name: "Ada" } });
      currentRole.mockResolvedValue("MEMBER");
    }
    readProgress.mockRejectedValue(new Error("owner-progress unavailable"));
    await renderStats();
    const sections = screen.getByRole("main").querySelectorAll("section.surface");
    const settledFigures = [...sections[0]!.querySelectorAll("strong")];
    expect(settledFigures.map((node) => node.textContent)).toEqual(["23", "4", "117", "19", "0.43"]);
    for (const figure of settledFigures) expect(figure).toBeVisible();
    const status = sections[1]!.querySelector("[role='status']");
    expect(status).toBeVisible();
    expect(status!.textContent!.trim().length).toBeGreaterThan(0);
    expect(sections[1]!.querySelector("strong")).toBeNull();
  });

  it.each(["MEMBER", "MODERATOR"] as const)("uses the live %s role for member chrome", async (role) => {
    auth.mockResolvedValue({ user: { id: "member-1", name: "Ada", role: role === "MEMBER" ? "MODERATOR" : "MEMBER" } });
    currentRole.mockResolvedValue(role);
    await renderStats();
    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Moderation" }) !== null).toBe(role === "MODERATOR");
    expect(screen.getByText("23")).toBeVisible();
  });

  it.each([null, new Error("role lookup failed")])("falls back to public chrome when the ledger role is %s", async (result) => {
    auth.mockResolvedValue({ user: { id: "member-1", name: "Ada" } });
    if (result instanceof Error) currentRole.mockRejectedValue(result);
    else currentRole.mockResolvedValue(result);
    await renderStats();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(screen.getByText("23")).toBeVisible();
  });

  it("propagates a failed aggregate read", async () => {
    readStats.mockRejectedValue(new Error("ledger unavailable"));
    const { default: StatsPage } = await import("@/app/stats/page");
    await expect(StatsPage()).rejects.toThrow("ledger unavailable");
  });

  it("links the signed-out landing page to the route that renders the figures", async () => {
    const { default: HomePage } = await import("@/app/page");
    const landing = render(await HomePage());
    const main = within(landing.container).getByRole("main");
    const nav = within(main).getByRole("navigation");
    expect(main.lastElementChild).toBe(nav);
    const link = nav.querySelector<HTMLAnchorElement>('a[href="/stats"]');
    expect(link).not.toBeNull();
    expect(link).toHaveClass("text-link");
    expect(link).toHaveAccessibleName();
    landing.unmount();
    await renderStats();
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    expect(screen.getByText("23")).toBeVisible();
  });
});
