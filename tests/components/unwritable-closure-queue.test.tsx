/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ModerationPage from "@/app/moderation/page";
import { UnwritableClosureQueue } from "@/components/unwritable-closure-queue";
import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "moderator-1", role: "MODERATOR", name: "Moderator" },
  }),
}));

function closure(overrides: Partial<UnwritableClosureProjection> = {}): UnwritableClosureProjection {
  return {
    id: "closure-1",
    kind: "SETTLEMENT_EVIDENCE_REJECTED",
    reason: "The settled label was applied after the evidence window.",
    recordedAt: "2026-09-05T10:00:00.000Z",
    repositoryName: "co-op/harbour",
    issueNumber: 17,
    issueTitle: "Repair the tide gate",
    issueUrl: "https://github.com/co-op/harbour/issues/17",
    pullRequest: { number: 18, title: "Repair the gate", url: "https://github.com/co-op/harbour/pull/18" },
    settlementId: "settlement-1",
    latestCorrection: null,
    ...overrides,
  };
}

describe("unwritable closure queue", () => {
  it("explains when no closures are waiting on evidence", () => {
    render(<UnwritableClosureQueue closures={[]} />);

    expect(screen.getByText("No closures are waiting on evidence.")).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it.each([
    ["OPEN", "open"],
    ["GRANTED", "granted"],
    ["DECLINED", "declined"],
  ] as const)("shows rejected evidence with its settlement path and %s correction", (state, label) => {
    render(<UnwritableClosureQueue closures={[closure({
      latestCorrection: { state, requestedAt: "2026-09-05T12:00:00.000Z" },
    })]} />);

    const entry = within(screen.getByRole("listitem"));
    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(entry.getByText("co-op/harbour").tagName).toBe("STRONG");
    expect(entry.getByText(/recorded 2026-09-05T10:00:00.000Z/)).toBeVisible();
    expect(entry.getByRole("link", { name: "#" + "17 Repair the tide gate" })).toHaveAttribute("href", "https://github.com/co-op/harbour/issues/17");
    expect(entry.getByRole("link", { name: "#" + "18 Repair the gate" })).toHaveAttribute("href", "https://github.com/co-op/harbour/pull/18");
    expect(entry.getByText("The settled label was applied after the evidence window.")).toHaveClass("override-reason");
    expect(entry.getByRole("link", { name: "Open the settlement to request a correction" })).toHaveAttribute("href", "/settlements/settlement-1");
    expect(entry.getByText(`Correction ${label} · reported 2026-09-05T12:00:00.000Z`)).toBeVisible();
  });

  it("offers the settlement correction path when no correction has been requested", () => {
    render(<UnwritableClosureQueue closures={[closure()]} />);

    expect(screen.getByRole("link", { name: "Open the settlement to request a correction" })).toHaveAttribute("href", "/settlements/settlement-1");
    expect(screen.queryByText(/Correction .* · reported/)).toBeNull();
  });

  it("keeps both kinds visible without a settlement and explains why no correction is offered", () => {
    render(<UnwritableClosureQueue closures={[
      closure({ settlementId: null }),
      closure({
        id: "closure-2",
        kind: "NO_CLOSING_PULL_REQUEST",
        reason: "No merged GitHub GraphQL closing pull request was found.",
        pullRequest: null,
        settlementId: null,
      }),
    ]} />);

    const entries = screen.getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(within(entry).getByText("No settlement is materialized for this closure, so there is nothing to correct.")).toHaveClass("mono-meta");
      expect(within(entry).queryByRole("link", { name: "Open the settlement to request a correction" })).toBeNull();
    }
    expect(within(entries[0]).getByRole("link", { name: /Repair the gate/ })).toBeVisible();
    expect(within(entries[1]).getAllByRole("link")).toHaveLength(1);
    expect(within(entries[1]).getByText("No merged GitHub GraphQL closing pull request was found.")).toHaveClass("override-reason");
  });
});

describe("moderation closure section", () => {
  it("loads the closure queue between settlement corrections and recalibration", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (!strings.join("?").includes("from unwritable_closures")) return [];
      return [{
        id: "closure-1",
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        reason: "The settled label was applied after the evidence window.",
        recorded_at: "2026-09-05T10:00:00.000Z",
        repository_name: "co-op/harbour",
        issue_number: 17,
        issue_title: "Repair the tide gate",
        issue_url: "https://github.com/co-op/harbour/issues/17",
        pull_request_number: 18,
        pull_request_title: "Repair the gate",
        pull_request_url: "https://github.com/co-op/harbour/pull/18",
        settlement_id: "settlement-1",
        correction_state: null,
        correction_requested_at: null,
      }];
    });

    render(await ModerationPage());

    const section = screen.getByRole("region", { name: "Rejected settlement evidence" });
    expect(section).toHaveClass("surface", "override-card");
    expect(within(section).getByText("Closures that settled nothing")).toBeVisible();
    expect(within(section).getByRole("heading")).toHaveAttribute("id", "unwritable-closures-heading");
    expect(within(section).getByText("The settled label was applied after the evidence window.")).toBeVisible();
    expect(within(section).getByRole("link", { name: "Open the settlement to request a correction" })).toHaveAttribute("href", "/settlements/settlement-1");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(headings.indexOf("Settlement corrections"), headings.indexOf("Settlement corrections") + 3)).toEqual([
      "Settlement corrections", "Rejected settlement evidence", "Recalibration plans and reactivation",
    ]);
  });

  it("shows a closure load error without hiding the other moderation queues", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("from unwritable_closures")) throw new Error("Closure query unavailable");
      return [];
    });

    render(await ModerationPage());

    expect(screen.getByText("The closure queue could not be loaded.")).toBeVisible();
    expect(screen.getByText("No settlement corrections are waiting.")).toBeVisible();
    expect(screen.getByText("No account audits are open.")).toBeVisible();
    expect(screen.getByText("No accounts are recalibrating.")).toBeVisible();
    expect(screen.queryByText("No closures are waiting on evidence.")).toBeNull();
  });
});
