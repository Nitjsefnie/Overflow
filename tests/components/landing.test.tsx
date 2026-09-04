/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LandingPage } from "@/app/page";

describe("landing page", () => {
  it("offers a semantic GitHub sign-in path", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "Cooperative credit for open-source work." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/signin/github",
    );
  });

  it("does not present churn as a member metric", () => {
    render(<LandingPage />);

    expect(screen.queryByText(/churn/i)).not.toBeInTheDocument();
  });
});
