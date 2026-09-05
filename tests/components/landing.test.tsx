/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
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

function declaredValue(selector: string, property: string): string {
  const stylesheet = readFileSync("src/app/globals.css", "utf8");
  const rule = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, head]) => head.trim() === selector);
  if (!rule) throw new Error(`no top-level rule for ${selector}`);
  const declaration = rule[2]
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${property}:`));
  if (!declaration) throw new Error(`no ${property} declared on ${selector}`);
  return declaration.slice(property.length + 1).trim();
}

function clampTerms(value: string): { min: number; preferred: number; max: number } {
  const clamp = /clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)rem\s*\)/.exec(value);
  if (!clamp) throw new Error(`expected a rem/vw/rem clamp, got ${value}`);
  return { min: Number(clamp[1]), preferred: Number(clamp[2]), max: Number(clamp[3]) };
}

// Issue 39: the sign-in button was the only control on the signed-out landing
// page and it sat entirely below the fold. Measured in headless Chromium at
// 1440x800, the h1 rendered at 136px (the 8.5rem clamp ceiling) and wrapped to
// four 142.8px lines, putting the button at y 848 -> 897 against a fold at 800.
// The same page at the values pinned below renders the h1 in three lines and
// puts the button at 614 -> 663 (1440x800, 137px of slack), 614 -> 663
// (1366x768, 105px), 611 -> 660 (1280x720, 60px), 661 -> 709 (1920x1080,
// 371px) and 484 -> 533 (390x844, 311px).
//
// jsdom performs no layout and resolves neither clamp() nor vw, so no test in
// this suite can measure the fold. What it can do is hold the stylesheet at the
// values the browser proved sufficient: raising any of them again costs the
// fold and has to be re-measured.
describe("landing hero fold budget", () => {
  it("keeps the hero type scale within the measured above-the-fold budget", () => {
    const fontSize = clampTerms(declaredValue(".landing-hero h1", "font-size"));

    // Governs every viewport at or above 1200px wide, where the ceiling binds:
    // 1920x1080, 1440x800, 1366x768 and 1280x720.
    expect(fontSize.max).toBeLessThanOrEqual(7);
    // Governs the band below it, where the preferred term binds: at 1024x768
    // the h1 renders at 102.4px and the button lands at 564 -> 613.
    expect(fontSize.preferred).toBeLessThanOrEqual(10);
    // Governs 390x844, where the floor binds: 56px, button at 484 -> 533.
    expect(fontSize.min).toBeLessThanOrEqual(3.5);
  });

  it("keeps the landing page block padding within the measured budget", () => {
    const padding = clampTerms(declaredValue(".landing-page", "padding"));

    // 96px of block padding at 1440x800 was 32px of the overflow past the fold.
    expect(padding.max).toBeLessThanOrEqual(5);
    expect(padding.preferred).toBeLessThanOrEqual(6);
  });
});
