/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOutAction: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`the recovery route must not redirect, but it redirected to ${target}`);
  }),
  getSql: vi.fn(() => {
    throw new Error("the recovery route must not reach the database");
  }),
  getCurrentUserRole: vi.fn(() => {
    throw new Error("the recovery route must not look a role up");
  }),
}));

vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db/client", () => ({ getSql: mocks.getSql }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: mocks.getCurrentUserRole }));

import SessionPage, { SessionRecovery } from "@/app/session/page";

describe("session recovery route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("tells an unavailable-ledger visitor the sign-in still holds and offers a retry", () => {
    render(<SessionRecovery reason="unavailable" />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/ledger could not be reached/i);
    expect(screen.getByText(/sign-in is still valid/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Try the ledger again" })).toHaveAttribute("href", "/dashboard");
  });

  it("tells a stale-session visitor to clear the sign-in and offers no retry", () => {
    render(<SessionRecovery reason="stale" />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/clear this sign-in and start again/i);
    expect(screen.getByText(/if you were signed in/i)).toBeVisible();
    expect(screen.getByText(/sign in again/i)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Try the ledger again" })).not.toBeInTheDocument();
  });

  it.each([
    { name: "a missing reason", reason: undefined },
    { name: "an unknown reason", reason: "banana" },
    { name: "the reason repeated as an array value", reason: ["unavailable", "stale"] as unknown as string },
  ])("treats $name as a stale session", ({ reason }) => {
    render(<SessionRecovery reason={reason} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/clear this sign-in and start again/i);
    expect(screen.queryByRole("link", { name: "Try the ledger again" })).not.toBeInTheDocument();
  });

  it.each(["unavailable", "stale"])("submits sign-out through a server action for reason %s", async (reason) => {
    render(<SessionRecovery reason={reason} />);

    const signOutButton = screen.getByRole("button", { name: "Sign out" });
    expect(signOutButton.closest("form")).not.toBeNull();
    fireEvent.click(signOutButton);

    await waitFor(() => expect(mocks.signOutAction).toHaveBeenCalledTimes(1));
  });

  it("renders the unavailable copy from the search param without redirecting or touching the ledger", async () => {
    render(await SessionPage({ searchParams: Promise.resolve({ reason: "unavailable" }) }));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/ledger could not be reached/i);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.getCurrentUserRole).not.toHaveBeenCalled();
  });

  it("falls back to the stale copy when the route is opened with no search params at all", async () => {
    render(await SessionPage({}));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/clear this sign-in and start again/i);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.getCurrentUserRole).not.toHaveBeenCalled();
  });
});
