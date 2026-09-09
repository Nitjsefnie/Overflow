/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "viewer-1", role: "MEMBER", name: "Ada Lovelace" },
  }),
}));

import MembersStandingsPage from "@/app/members/page";

function respondWith(options: { standings?: unknown[] | Error } = {}) {
  sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("join ledger_entries")) {
      if (options.standings instanceof Error) {
        throw options.standings;
      }
      return options.standings ?? [];
    }
    throw new Error(`Unexpected query: ${text}`);
  });
}

function standingRow(
  login: string,
  earnedTotal: number,
  givenTotal: number,
  id = `account-${login}`,
): Record<string, unknown> {
  return { id, github_login: login, earned_total: earnedTotal, given_total: givenTotal };
}

function standingsRows(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Member standings" });
  return within(list).getAllByRole("listitem");
}

describe("member standings page", () => {
  it("lists the standings in the order the ledger reports them with each account's totals", async () => {
    respondWith({
      standings: [
        standingRow("mira", 12, 6),
        standingRow("zeta", 6, 6),
        standingRow("alpha", 0, 6),
      ],
    });
    render(await MembersStandingsPage());

    const rows = standingsRows();
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("mira")).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText("earned 12 · given 6 · net +6")).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText("zeta")).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText("earned 6 · given 6 · net 0")).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText("alpha")).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText("earned 0 · given 6 · net −6")).toBeVisible();
  });

  it("marks the signed-in member's own row and no other", async () => {
    respondWith({
      standings: [
        standingRow("beta", 6, 0),
        standingRow("ada", 0, 6, "viewer-1"),
        standingRow("gamma", 4, 0),
      ],
    });
    render(await MembersStandingsPage());

    const [first, own, third] = standingsRows();
    expect(own).toHaveAttribute("aria-current", "true");
    expect(within(own as HTMLElement).getByText("You")).toBeVisible();
    expect(first).not.toHaveAttribute("aria-current");
    expect(within(first as HTMLElement).queryByText("You")).toBeNull();
    expect(third).not.toHaveAttribute("aria-current");
    expect(within(third as HTMLElement).queryByText("You")).toBeNull();
  });

  it("uses the shared empty-state treatment when no account holds a ledger entry", async () => {
    respondWith({ standings: [] });
    const { container } = render(await MembersStandingsPage());

    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "No ledger entry is recorded yet." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Find eligible issues" })).toHaveAttribute("href", "/issues");
  });

  it("renders the error empty state when the standings query fails", async () => {
    respondWith({ standings: new Error("Standings unavailable") });
    const { container } = render(await MembersStandingsPage());

    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "The member standings could not be loaded." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Retry the member standings" })).toHaveAttribute("href", "/members");
  });
});
