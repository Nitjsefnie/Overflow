/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { AppShell, PublicAppShell } from "@/components/app-shell";
import { LandingPage } from "@/app/page";

async function renderAccountDataPage(): Promise<void> {
  const { default: AccountDataPage } = await import("@/app/account-data/page");
  render(<AccountDataPage />);
}

function anchorByHref(href: string): HTMLAnchorElement {
  const anchor = document.querySelector(`a[href="${href}"]`);
  expect(anchor, `expected an anchor with href "${href}"`).not.toBeNull();
  return anchor as HTMLAnchorElement;
}

describe("account-data notice page", () => {
  it("renders the page-heading structure and one labelled section per disclosure area", async () => {
    await renderAccountDataPage();

    const main = document.querySelector("main.page-content");
    expect(main, "the notice supplies its own main.page-content as the skip-link target").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");

    const heading = main!.querySelector(".page-heading h1");
    expect(heading, "the notice opens with a page-heading h1").not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBe(heading);

    const sections = Array.from(main!.querySelectorAll("section.surface"));
    expect(sections.length).toBe(6);
    for (const section of sections) {
      const labelledBy = section.getAttribute("aria-labelledby");
      expect(labelledBy, "every section names the heading that labels it").toBeTruthy();
      expect(section.querySelector(`#${CSS.escape(labelledBy!)}`)).not.toBeNull();
      expect(section.querySelector("h2")).not.toBeNull();
    }
  });

  it("keeps every internal link on a route that exists in src/app", async () => {
    await renderAccountDataPage();

    const routes = new Set(
      readdirSync(resolve(process.cwd(), "src/app"), { recursive: true })
        .map(String)
        .filter((path) => path.endsWith("page.tsx"))
        .map((path) => {
          const directory = path.slice(0, -"page.tsx".length).replace(/\/+$/, "");
          return directory === "" ? "/" : `/${directory}`;
        }),
    );

    const internal = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.startsWith("//"));

    expect(internal.length).toBeGreaterThan(0);
    expect(internal.filter((href) => !routes.has(href))).toEqual([]);
  });

  it("points its external links at github.com over https, including the two named controls", async () => {
    await renderAccountDataPage();

    const external = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => /^https?:/i.test(href));

    expect(external.length).toBeGreaterThan(0);
    expect(
      external.filter((href) => {
        const url = new URL(href);
        return url.protocol !== "https:" || url.hostname !== "github.com";
      }),
    ).toEqual([]);
    // The two controls the notice hands the reader: the GitHub authorization
    // settings page and the repository's issue tracker.
    expect(external).toContain("https://github.com/settings/applications");
    expect(external).toContain("https://github.com/Nitjsefnie/Overflow/issues");
  });

  it("offers nothing that submits or collects an email address", async () => {
    await renderAccountDataPage();

    expect(document.querySelector("form")).toBeNull();
    const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
      (anchor) => anchor.getAttribute("href") ?? "",
    );
    expect(hrefs.filter((href) => href.startsWith("mailto:") || /emails/i.test(href))).toEqual([]);
  });
});

describe("routes that link the notice", () => {
  it("links /account-data from the public site navigation", () => {
    render(
      <PublicAppShell>
        <p>content</p>
      </PublicAppShell>,
    );

    const navigation = screen.getByRole("navigation", { name: "Site navigation" });
    const link = Array.from(navigation.querySelectorAll("a")).find(
      (candidate) => candidate.getAttribute("href") === "/account-data",
    );
    expect(link, "the public navigation links /account-data").toBeDefined();
    expect(link!).toBeVisible();
  });

  it("links /account-data from the signed-in shell footer", () => {
    render(
      <AppShell memberName="Lin" isModerator={false}>
        <p>public notice link must reach signed-in members too</p>
      </AppShell>,
    );

    const footer = screen.getByRole("contentinfo");
    const link = Array.from(footer.querySelectorAll("a")).find(
      (candidate) => candidate.getAttribute("href") === "/account-data",
    );
    expect(link, "the signed-in shell footer links /account-data").toBeDefined();
    expect(link!).toBeVisible();
  });

  it("links /account-data directly beneath the landing sign-in form", () => {
    render(<LandingPage />);

    const link = anchorByHref("/account-data");
    expect(link).toBeVisible();

    const form = screen.getByRole("button", { name: "Sign in with GitHub" }).closest("form")!;
    expect(link.parentElement).toBe(form.parentElement);
    expect(form.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
