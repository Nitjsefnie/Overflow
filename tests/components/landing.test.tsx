/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { LandingPage } from "@/app/page";

describe("landing page", () => {
  afterEach(() => {
    signIn.mockReset();
  });

  it("submits GitHub sign-in through a server action", async () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "Cooperative credit for open-source work." })).toBeVisible();
    const signInButton = screen.getByRole("button", { name: "Sign in with GitHub" });
    expect(signInButton.closest("form")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).not.toBeInTheDocument();
    fireEvent.click(signInButton);

    await waitFor(() => expect(signIn).toHaveBeenCalledWith("github"));
  });

  it("does not render a noninteractive landing mark", () => {
    const { container } = render(<LandingPage />);

    expect(container.querySelector(".landing-mark")).toBeNull();
  });

  it("does not present churn as a member metric", () => {
    render(<LandingPage />);

    expect(screen.queryByText(/churn/i)).not.toBeInTheDocument();
  });
});
