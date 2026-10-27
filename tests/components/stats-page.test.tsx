/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const currentRole = vi.fn();
const readStats = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@/auth", () => ({ auth, signIn: vi.fn() }));
  vi.doMock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));
  vi.doMock("@/lib/public-stats", () => ({ getSettledWorkStats: readStats, SETTLED_WORK_REFRESH_MINUTES: 7 }));
  auth.mockResolvedValue(null);
  readStats.mockResolvedValue({ pullRequests: 23, contributors: 4, points: 117, readAt: new Date("2026-10-27T11:12:00Z") });
});

afterEach(() => {
  auth.mockReset();
  currentRole.mockReset();
  readStats.mockReset();
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
  it("renders aggregate figures and their read time for a signed-out visitor", async () => {
    await renderStats();
    const main = screen.getByRole("main");
    expect(main).toHaveClass("page-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect([...main.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["23", "4", "117"]);
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
    readStats.mockResolvedValue({ pullRequests: 0, contributors: 0, points: 0, readAt: new Date("2026-10-27T11:12:00Z") });
    const empty = await renderStats();
    expect(screen.getAllByText("0")).toHaveLength(3);
    empty.unmount();
    readStats.mockResolvedValue({ pullRequests: 1, contributors: 1, points: 1, readAt: new Date("2026-10-27T11:12:00Z") });
    await renderStats();
    expect(screen.getAllByText("1")).toHaveLength(3);
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
    const link = landing.container.querySelector<HTMLAnchorElement>('.landing-hero a[href="/stats"]');
    expect(link).not.toBeNull();
    expect(link).toHaveClass("text-link");
    landing.unmount();
    await renderStats();
    expect(screen.getByText("23")).toBeVisible();
  });
});
