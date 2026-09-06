/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettlementProofPage from "@/app/settlements/[id]/page";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "member-1", role: "MEMBER", name: "Member" },
  }),
}));

const settlementRow = {
  id: "settlement-1",
  status: "SETTLED",
  repository_name: "co-op/harbour",
  opening_name: "Offer band",
  actual_name: "Delivered band",
  issue_number: 17,
  issue_title: "Repair the tide gate",
  issue_url: "https://github.com/co-op/harbour/issues/17",
  opening_label: "shoal",
  settled_label: "landed/4",
  settled_label_event_id: "label-event-1",
  settled_label_actor_login: "sponsor",
  settled_label_applied_at: "2026-09-05T10:00:00.000Z",
  settled_rationale_comment_id: "rationale-1",
  settled_rationale_actor_login: "sponsor",
  settled_rationale_commented_at: "2026-09-05T10:00:00.000Z",
  pull_request_number: 18,
  pull_request_title: "Repair the gate",
  pull_request_url: "https://github.com/co-op/harbour/pull/18",
  merge_commit_oid: "0123456789abcdef0123456789abcdef01234567",
  merged_at: "2026-09-05T11:00:00.000Z",
  proof_sha256: "a".repeat(64),
  opening_comparison_points: 7,
  settled_points: 4,
  review_rounds: 1,
  credits: 3,
  balance_effect: 3,
  settled_at: "2026-09-05T11:00:00.000Z",
};

function respondWith(corrections: unknown[] | Error) {
  sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("from settlement_override_requests")) {
      if (corrections instanceof Error) {
        throw corrections;
      }
      return corrections;
    }
    if (text.includes("from settlements")) {
      return [settlementRow];
    }
    throw new Error(`Unexpected query: ${text}`);
  });
}

const settlementParams = { params: Promise.resolve({ id: "settlement-1" }) };

describe("settlement proof page", () => {
  it("distinguishes declined, empty, and unreadable correction history while keeping the proof and recourse", async () => {
    respondWith([{
      id: "request-1",
      issue_id: "issue-1",
      requester_id: "member-1",
      reason: "The settled label was recorded late.",
      state: "DECLINED",
      settled_points: null,
      decided_by_id: "moderator-1",
      decision_reason: "The recorded evidence stands.",
      created_at: "2026-09-05T12:00:00.000Z",
      decided_at: "2026-09-05T13:00:00.000Z",
    }]);
    render(await SettlementProofPage(settlementParams));
    expect(screen.getByText("Declined")).toBeVisible();
    expect(screen.getByRole("article", { name: "co-op/harbour settlement" })).toBeVisible();

    cleanup();
    respondWith([]);
    render(await SettlementProofPage(settlementParams));
    const emptyRecourse = screen.getByRole("region", { name: "Is this settlement wrong?" }).textContent;
    const emptyHistoryProof = screen.getByRole("article", { name: "co-op/harbour settlement" }).outerHTML;
    expect(screen.getByText("No correction has been requested for this settlement.")).toBeVisible();
    expect(screen.getByRole("article", { name: "co-op/harbour settlement" })).toBeVisible();

    cleanup();
    respondWith(new Error("Correction history unavailable"));
    render(await SettlementProofPage(settlementParams));

    const failedRecourse = screen.getByRole("region", { name: "Is this settlement wrong?" });
    expect.soft(failedRecourse.textContent).not.toBe(emptyRecourse);
    expect.soft(within(failedRecourse).queryByText(/correction history.*settlement.*could not be loaded/i)).toBeVisible();
    expect.soft(within(failedRecourse).queryByText(/No correction has been requested/)).toBeNull();
    const proof = screen.getByRole("article", { name: "co-op/harbour settlement" });
    expect(proof).toBeVisible();
    expect(proof.outerHTML).toBe(emptyHistoryProof);
    expect(within(proof).getByText("Delivered band").nextElementSibling).toHaveTextContent("landed/4 · 4");
    expect(screen.getByRole("button", { name: "Report this settlement as incorrect" })).toBeVisible();
  });

  it("offers ledger recovery without reading corrections when the settlement proof query fails", async () => {
    sql.mockClear();
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("from settlements")) {
        throw new Error("Settlement proof query unavailable");
      }
      if (text.includes("from settlement_override_requests")) {
        return [];
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    render(await SettlementProofPage(settlementParams));

    const recovery = screen.getByRole("region", { name: /settlement proof.*could not be loaded/i });
    expect(recovery).toBeVisible();
    expect(within(recovery).getByRole("link")).toHaveAttribute("href", "/dashboard");
    const queries = sql.mock.calls.map(([strings]) => (strings as TemplateStringsArray).join("?"));
    expect(queries).toEqual([expect.stringContaining("from settlements")]);
    expect(queries.some((query) => query.includes("from settlement_override_requests"))).toBe(false);
  });
});
