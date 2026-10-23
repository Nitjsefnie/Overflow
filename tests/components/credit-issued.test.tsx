/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import ModerationPage from "@/app/moderation/page";
import type { CreditIssuedProjection } from "@/lib/dashboard/ledger-panels";

vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { creditIssued } = vi.hoisted(() => ({
  creditIssued: vi.fn<() => Promise<CreditIssuedProjection[]>>(),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/navigation")>(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => async () => [] }));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: async () => {} }));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession: async () => ({ user: { id: "moderator-1", role: "MODERATOR", name: "Moderator" } }),
  isModeratorSession: () => true,
}));
vi.mock("@/lib/dashboard/ledger-panels", () => ({ listCreditIssued: creditIssued }));

beforeEach(() => { creditIssued.mockReset(); });

function creditIssuedRegion(): HTMLElement {
  const section = screen.getAllByRole("region").find(
    (region) => region.getAttribute("aria-labelledby") === "credit-issued-heading",
  );
  expect(section, "the credit-issued region renders").toBeDefined();
  expect(section!).toHaveClass("surface");
  const heading = within(section!).getByRole("heading", { level: 2 });
  expect(heading).toHaveAttribute("id", "credit-issued-heading");
  expect(heading).toBeVisible();
  expect(heading.previousElementSibling).toHaveClass("eyebrow");
  const explanation = heading.nextElementSibling;
  expect(explanation?.tagName).toBe("P");
  expect(explanation).toBeVisible();
  expect(explanation).not.toBeEmptyDOMElement();
  return section!;
}

describe("moderation credit issued panel", () => {
  it("renders each hourly total with its UTC bucket start", async () => {
    creditIssued.mockResolvedValue([
      { bucketStartedAt: "2026-09-02T13:00:00.000Z", issuedTotal: 5 },
      { bucketStartedAt: "2026-09-01T10:00:00.000Z", issuedTotal: 6 },
    ]);
    render(await ModerationPage());

    const section = creditIssuedRegion();
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const [index, instant, displayed, total] of [
      [0, "2026-09-02T13:00:00.000Z", "2026-09-02 13:00 UTC", "5"],
      [1, "2026-09-01T10:00:00.000Z", "2026-09-01 10:00 UTC", "6"],
    ] as const) {
      const time = rows[index].querySelector("time");
      expect(time).toHaveAttribute("datetime", instant);
      expect(time).toHaveTextContent(displayed);
      expect(time).toBeVisible();
      expect(rows[index].querySelector("strong")?.textContent).toBe(total);
    }
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  it("renders an empty state after the explanation when no buckets exist", async () => {
    creditIssued.mockResolvedValue([]);
    render(await ModerationPage());

    const section = creditIssuedRegion();
    expect(within(section).queryByRole("list")).toBeNull();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(section.lastElementChild?.tagName).toBe("P");
    expect(section.lastElementChild).toBeVisible();
    expect(section.lastElementChild).not.toBeEmptyDOMElement();
    expect(section.querySelectorAll(":scope > p")).toHaveLength(3);
  });

  it("renders a load alert without losing sibling sections when the query rejects", async () => {
    creditIssued.mockRejectedValue(new Error("Ledger read failed"));
    render(await ModerationPage());

    const section = creditIssuedRegion();
    expect(within(section).queryByRole("list")).toBeNull();
    const alert = within(section).getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).not.toBeEmptyDOMElement();
    expect(section.lastElementChild).toBe(alert);
    expect(screen.getAllByRole("region").find(
      (region) => region.getAttribute("aria-labelledby") === "enforcement-history-heading",
    )).toBeVisible();
  });
});
