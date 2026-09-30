/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

const { sql, unsafe } = vi.hoisted(() => ({ sql: vi.fn(), unsafe: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getSql: () => Object.assign(sql, { unsafe }) }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "viewer-1", role: "MEMBER", name: "Ada Lovelace" },
  }),
}));

import IssuesPage from "@/app/issues/page";

// Bind the page/route graph to this file's mocks and release it afterward.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

function respondWith(options: { issues?: unknown[] | Error } = {}) {
  // The board serves through the unnamed-statement escape hatch, so the
  // mocked client answers both call shapes with the same text match.
  const respond = (text: string) => {
    if (text.includes("from issues")) {
      if (options.issues instanceof Error) {
        throw options.issues;
      }
      return options.issues ?? [];
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  sql.mockImplementation(async (strings: TemplateStringsArray) => respond(strings.join("?")));
  unsafe.mockImplementation(async (text: string) => respond(text));
}

/**
 * A row the board query actually selects: every field the projection reads
 * with readText/readNumber, so a thrown type error is a real defect and not a
 * stub's shape.
 */
function issueRow(n: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    repository_name: "octo/overflow",
    issue_number: n,
    title: `Issue ${n}`,
    url: `https://github.com/octo/overflow/issues/${n}`,
    opening_name: "Scope",
    opening_label: "size/M",
    opening_comparison_points: 5,
    opening_reserve_points: 5,
    claim_assignee_github_login: null,
    available_headroom: 3,
    created_at: "2026-09-09T00:00:00.000Z",
  };
}

function issueCards(container: HTMLElement): Element[] {
  return [...container.querySelectorAll(".issue-card")];
}

describe("issues board page", () => {
  it("renders the issue cards the board query returned", async () => {
    respondWith({ issues: [issueRow(1), issueRow(2)] });
    const { container } = render(await IssuesPage());

    expect(issueCards(container)).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Issue 1" })).toBeVisible();
  });

  it("keeps the shared empty-state treatment when the board query returns no rows", async () => {
    respondWith({ issues: [] });
    const { container } = render(await IssuesPage());

    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "No eligible issues are open." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Register one repository" })).toHaveAttribute(
      "href",
      "/repositories/new",
    );
    expect(screen.queryByRole("navigation", { name: "Eligible issue pages" })).not.toBeInTheDocument();
  });

  it("renders the error empty state when the board query fails", async () => {
    respondWith({ issues: new Error("Board unavailable") });
    const { container } = render(await IssuesPage());

    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Eligible issues could not be loaded." }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Retry eligible issues" })).toHaveAttribute(
      "href",
      "/issues",
    );
  });

  it("turns the query string into the window the board query is paged with", async () => {
    respondWith({ issues: [issueRow(1)] });
    await IssuesPage({ searchParams: Promise.resolve({ page: "4", pageSize: "3" }) });

    // The window is the query's final interpolation pair; its leading values
    // are the account id and the filters.
    // The unnamed path carries the values as one trailing array: the window
    // is its final pair.
    const values = unsafe.mock.lastCall![1] as unknown[];
    const [limit, offset] = values.slice(-2);
    expect(limit).toBe(3);
    expect(offset).toBe(9);
  });

  it("defaults the window to the first page at 200 rows for an unpaginated reader", async () => {
    respondWith({ issues: [issueRow(1)] });
    await IssuesPage();

    // The unnamed path carries the values as one trailing array: the window
    // is its final pair.
    const values = unsafe.mock.lastCall![1] as unknown[];
    const [limit, offset] = values.slice(-2);
    expect(limit).toBe(200);
    expect(offset).toBe(0);
  });

  it("offers the next page on a full page and preserves the filters in the link", async () => {
    // The stub returns rows unwindowed, so the full page here is one row at
    // pageSize=1 — a page the page must read as "more may exist".
    respondWith({ issues: [issueRow(1)] });
    const { container } = render(
      await IssuesPage({
        searchParams: Promise.resolve({
          repository: "octo/overflow",
          openingLabel: "size/M",
          claimState: "ALL",
          page: "1",
          pageSize: "1",
        }),
      }),
    );

    expect(issueCards(container)).toHaveLength(1);
    // URLSearchParams's own encoding: the slash in "owner/name" renders
    // %2F, and the replaced page keeps its original position in the string.
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/issues?repository=octo%2Foverflow&openingLabel=size%2FM&claimState=ALL&page=2&pageSize=1",
    );
    expect(screen.queryByRole("link", { name: "Previous page" })).not.toBeInTheDocument();
  });

  it("preserves the filters on both links from a middle page", async () => {
    respondWith({ issues: [issueRow(1), issueRow(2)] });
    render(
      await IssuesPage({
        searchParams: Promise.resolve({ page: "2", pageSize: "2" }),
      }),
    );

    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/issues?pageSize=2",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/issues?page=3&pageSize=2",
    );
    expect(screen.getByRole("navigation", { name: "Eligible issue pages" })).toBeInTheDocument();
  });

  it("offers no next page on a short page and no pager at all on the first page", async () => {
    respondWith({ issues: [issueRow(1), issueRow(2)] });
    render(
      await IssuesPage({ searchParams: Promise.resolve({ page: "1", pageSize: "3" }) }),
    );

    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Previous page" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Eligible issue pages" }),
    ).not.toBeInTheDocument();
  });

  it("still offers the previous page from a deep page past the last row", async () => {
    respondWith({ issues: [] });
    render(await IssuesPage({ searchParams: Promise.resolve({ page: "2" }) }));

    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute("href", "/issues");
    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
  });
});
