/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`the landing route must not redirect, but it redirected to ${target}`);
  }),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signIn: mocks.signIn }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import HomePage from "@/app/page";

// Issue 38: the signed-out entry route rendered a bare main.landing-page with no
// site chrome, while every signed-in page carried the header, navigation and
// footer through AppShell. These cases walk the route itself (with the session
// mocked away) because the behavior a reader depends on lives in the composition:
// the chrome around the landing content, not the content components alone.
describe("signed-out landing chrome", () => {
  beforeEach(() => {
    // Signed out by default; the member-redirect case overrides this once.
    mocks.auth.mockResolvedValue(undefined);
  });

  it("renders the site chrome around the landing content", async () => {
    render(await HomePage());

    const header = screen.getByRole("banner");
    const wordmark = within(header).getByRole("link", { name: "Overflow home" });
    expect(wordmark).toHaveAttribute("href", "/");
    expect(wordmark.querySelector(".mark")).not.toBeNull();

    within(header).getByRole("navigation", { name: "Site navigation" });

    expect(screen.getByRole("contentinfo")).toBeVisible();

    // The landing view keeps its own main (the fold-budget guard and the session
    // recovery view both address main.landing-page), so the shell must not add a
    // second one: the landing main is the skip link's target and sits inside the
    // shell, with the hero content inside the main.
    const main = document.querySelector("main.landing-page");
    expect(main).not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
    expect(main?.closest(".app-shell")).not.toBeNull();
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main-content");

    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    const signInButton = screen.getByRole("button", { name: "Sign in with GitHub" });
    expect(signInButton.closest("form")).not.toBeNull();
    expect(signInButton.closest("main")).toBe(main);
  });

  it("carries no navigation link until its route is proven to render signed-out", async () => {
    render(await HomePage());

    const nav = screen.getByRole("navigation", { name: "Site navigation" });

    // Every chrome link must land on a route that renders for a signed-out
    // visitor. Today only / does, and the wordmark already carries it, so the
    // nav stays linkless; adding one means proving the route public first
    // (see the links case below) and this list is where the proof lands.
    expect(
      within(nav).queryAllByRole("link"),
      "a navigation link appeared without a proof that its route renders for a signed-out visitor",
    ).toEqual([]);
  });

  it("keeps every chrome link on a route a signed-out visitor can reach", async () => {
    // This very render is the proof for "/": the route resolved with no session
    // and produced the landing content. A second public route would need the
    // same kind of proof here before the chrome may link it.
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();

    // Same-document fragments (the skip link) point back at this page, so only
    // route links need a public render.
    const linked = Array.from(
      new Set(
        Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => anchor.getAttribute("href"))
          .filter((href) => href !== null && !href.startsWith("#")),
      ),
    );
    expect(linked.length).toBeGreaterThan(0);

    const proven = new Set(["/"]);
    expect(
      linked.filter((href) => !proven.has(href)),
      "the chrome links a route this suite has no signed-out render for; prove it renders signed-out and add it to the proven set",
    ).toEqual([]);
  });

  it("offers a signed-out visitor nothing that implies a session", async () => {
    render(await HomePage());

    const header = screen.getByRole("banner");
    expect(header.querySelector("form")).toBeNull();
    expect(within(header).queryByRole("button")).not.toBeInTheDocument();
    expect(header.querySelector(".member-stamp")).toBeNull();
    expect(header.querySelector(".session-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/dashboard"]')).toBeNull();
  });

  it.each(["MEMBER", "MODERATOR"] as const)(
    "still sends a signed-in %s from the landing route to the dashboard",
    async (role) => {
      mocks.auth.mockResolvedValueOnce({ user: { id: "acc-1", role } });

      // The route's guard is unchanged by the chrome: a member visiting the
      // public entry is still redirected before anything renders.
      await expect(HomePage()).rejects.toThrow("/dashboard");
      expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
    },
  );
});
