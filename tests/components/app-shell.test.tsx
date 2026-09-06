/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOutAction: vi.fn(),
}));

vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));

import { AppShell } from "@/components/app-shell";

describe("application shell sign-out", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { session: "a member session", isModerator: false },
    { session: "a moderator session", isModerator: true },
  ])(
    "groups a sign-out submit button with the member stamp in one header cell for $session",
    ({ isModerator }) => {
      render(
        <AppShell memberName="Lin" isModerator={isModerator}>
          <p>content</p>
        </AppShell>,
      );

      const header = screen.getByRole("banner");
      const signOut = within(header).getByRole("button", { name: "Sign out" });
      const stamp = within(header).getByText("Lin").closest("p");

      expect(signOut).toHaveAttribute("type", "submit");
      expect(signOut.closest("form")).not.toBeNull();
      expect(stamp).toBeVisible();

      const cluster = signOut.closest(".session-controls");

      expect(cluster).not.toBeNull();
      expect(cluster?.parentElement).toBe(header);
      expect(cluster).toContainElement(stamp);
    },
  );

  it("clears the session with a form the browser submits, not a link that only navigates", () => {
    render(
      <AppShell memberName="Lin" isModerator={false}>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.queryByRole("link", { name: /sign ?out/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" }).tagName).toBe("BUTTON");
  });

  it("submits sign-out through the shared server action", async () => {
    render(
      <AppShell memberName="Lin" isModerator={false}>
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mocks.signOutAction).toHaveBeenCalledTimes(1));
  });
});
