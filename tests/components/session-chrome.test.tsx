/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOutAction: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`the recovery route must not redirect, but it redirected to ${target}`);
  }),
}));

vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import SessionPage from "@/app/session/page";

// Issue 281: the recovery route rendered a bare main.landing-page, the same
// symptom issue 38 described for the landing route. The route now composes the
// same public shell. The recovery content itself keeps its session-flavored
// controls (the sign-out form, the member retry link) — those are the page's
// own content for people mid-recovery, so every session-implying assertion
// here is scoped to the chrome, never to the document.
describe("session recovery chrome", () => {
  it("renders the site chrome around the recovery content", async () => {
    render(await SessionPage({ searchParams: Promise.resolve({}) }));

    const header = screen.getByRole("banner");
    const wordmark = within(header).getByRole("link", { name: "Overflow home" });
    expect(wordmark).toHaveAttribute("href", "/");
    expect(within(wordmark).getByText("Overflow")).toBeVisible();
    within(header).getByRole("navigation", { name: "Site navigation" });
    expect(screen.getByRole("contentinfo")).toBeVisible();

    // The route keeps its own main and the shell adds none: one main, carrying
    // the skip link's target id, inside the shell.
    const mains = document.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    const main = mains[0];
    expect(main).toHaveClass("landing-page");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main?.closest(".app-shell")).not.toBeNull();
    expect(document.getElementById("main-content")).toBe(main);

    // The recovery content is intact inside that main: its heading and its own
    // sign-out form render there, not in the chrome.
    expect(within(main).getByRole("heading", { level: 1 })).toBeVisible();
    const signOut = within(main).getByRole("button", { name: "Sign out" });
    expect(signOut.closest("form")).not.toBeNull();
  });

  it("offers nothing in the chrome that implies a session", async () => {
    render(await SessionPage({ searchParams: Promise.resolve({}) }));

    const header = screen.getByRole("banner");
    expect(header.querySelector("form")).toBeNull();
    expect(within(header).queryByRole("button")).not.toBeInTheDocument();
    expect(header.querySelector(".member-stamp")).toBeNull();
    expect(header.querySelector(".session-controls")).toBeNull();
    // The chrome navigates nowhere but the public entry: the header's only
    // link is the wordmark, so no member navigation rides along.
    const headerLinks = within(header).queryAllByRole("link");
    expect(headerLinks).toHaveLength(1);
    expect(headerLinks[0]).toHaveClass("wordmark");
    expect(headerLinks[0]).toHaveAttribute("href", "/");
  });
});
