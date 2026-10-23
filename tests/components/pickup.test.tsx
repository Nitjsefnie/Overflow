/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import ModerationPage from "@/app/moderation/page";
import type { PickupProjection } from "@/lib/dashboard/ledger-panels";

vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { pickup } = vi.hoisted(() => ({
  pickup: vi.fn<() => Promise<PickupProjection>>(),
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
vi.mock("@/lib/dashboard/ledger-panels", () => ({ listCreditIssued: async () => [], listPickup: pickup }));

beforeEach(() => { pickup.mockReset(); });

function pickupRegion(): HTMLElement {
  const section = screen.getAllByRole("region").find(
    (region) => region.getAttribute("aria-labelledby") === "pickup-heading",
  );
  expect(section, "the pickup region renders").toBeDefined();
  expect(section!).toHaveClass("surface");
  const heading = within(section!).getByRole("heading", { level: 2 });
  expect(heading).toHaveAttribute("id", "pickup-heading");
  expect(heading).toBeVisible();
  expect(heading.previousElementSibling).toHaveClass("eyebrow");
  return section!;
}

describe("moderation pickup panel", () => {
  it("compares both posted-price figures side by side", async () => {
    pickup.mockResolvedValue({
      outsideAssignedPostedPrice: 19, unassignedPostedPrice: 9,
      outsideAssignedIssueCount: 3, unassignedIssueCount: 2,
    });
    render(await ModerationPage());

    const section = pickupRegion();
    const terms = within(section).getAllByRole("term");
    const figures = within(section).getAllByRole("definition");
    expect(terms).toHaveLength(2);
    expect(figures).toHaveLength(2);
    expect(section.querySelector("dl")).toHaveClass("proof-grid");
    for (const [index, value] of ["19", "9"].entries()) {
      expect(terms[index]).toBeVisible();
      expect(terms[index]).not.toBeEmptyDOMElement();
      expect(figures[index]).toBeVisible();
      expect(figures[index].querySelector("strong")?.textContent).toBe(value);
    }
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  it("shows an empty state when neither bucket has open issues", async () => {
    pickup.mockResolvedValue({
      outsideAssignedPostedPrice: 0, unassignedPostedPrice: 0,
      outsideAssignedIssueCount: 0, unassignedIssueCount: 0,
    });
    render(await ModerationPage());

    const section = pickupRegion();
    expect(within(section).queryByRole("definition")).toBeNull();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(section.lastElementChild?.tagName).toBe("P");
    expect(section.lastElementChild).toBeVisible();
    expect(section.lastElementChild).not.toBeEmptyDOMElement();
    expect(section.querySelectorAll(":scope > p")).toHaveLength(3);
  });

  it("contains a failed read in the pickup section while retaining its credit-issued sibling", async () => {
    pickup.mockRejectedValue(new Error("Pickup read failed"));
    render(await ModerationPage());

    const section = pickupRegion();
    const alert = within(section).getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).not.toBeEmptyDOMElement();
    expect(within(section).queryByRole("definition")).toBeNull();
    expect(screen.getAllByRole("region").find(
      (region) => region.getAttribute("aria-labelledby") === "credit-issued-heading",
    )).toBeVisible();
  });
});
