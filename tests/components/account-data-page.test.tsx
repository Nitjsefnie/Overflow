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
    expect(sections.length).toBe(13);
    for (const section of sections) {
      const labelledBy = section.getAttribute("aria-labelledby");
      expect(labelledBy, "every section names the heading that labels it").toBeTruthy();
      expect(section.querySelector(`#${CSS.escape(labelledBy!)}`)).not.toBeNull();
      expect(section.querySelector("h2")).not.toBeNull();
    }
  });

  it("keeps every internal link on a page route or the generated notices asset", async () => {
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
    // The build writes this file into the dist dir; its route serves the URL.
    routes.add("/third-party-notices.txt");

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
    expect(external).toContain("https://github.com/Nitjsefnie/Overflow/security/advisories/new");
  });

  it("reaches the request route from the deletion description", async () => {
    await renderAccountDataPage();

    const deletionSection = document.getElementById("account-data-deletion-heading")!.closest("section");
    expect(deletionSection, "the deletion section exists").not.toBeNull();
    expect(
      deletionSection!.querySelector('a[href="https://github.com/Nitjsefnie/Overflow/issues"]'),
      "the deletion description names where to request it",
    ).not.toBeNull();
  });

  it("names the dashboard's in-app controls from the controls section, so a signed-in member needs no public request", async () => {
    await renderAccountDataPage();

    const controlsSection = document.getElementById("account-data-controls-heading")!.closest("section");
    expect(controlsSection, "the controls section exists").not.toBeNull();
    expect(
      controlsSection!.querySelector('a[href="/dashboard"]'),
      "the controls section names the in-app controls on the dashboard",
    ).not.toBeNull();
  });

  it("names the dashboard's in-app deletion control from the deletion description too", async () => {
    await renderAccountDataPage();

    const deletionSection = document.getElementById("account-data-deletion-heading")!.closest("section");
    expect(deletionSection, "the deletion section exists").not.toBeNull();
    expect(
      deletionSection!.querySelector('a[href="/dashboard"]'),
      "the deletion description names the in-app deletion control on the dashboard",
    ).not.toBeNull();
  });

  it("reaches the request route from the controls section too, for someone who cannot sign in", async () => {
    await renderAccountDataPage();

    const controlsSection = document.getElementById("account-data-controls-heading")!.closest("section");
    expect(controlsSection, "the controls section exists").not.toBeNull();
    expect(
      controlsSection!.querySelector('a[href="https://github.com/Nitjsefnie/Overflow/issues"]'),
      "the controls section names where to request deletion or an export",
    ).not.toBeNull();
  });

  it("reaches the request route from the non-member section", async () => {
    await renderAccountDataPage();

    const nonMemberSection = document.getElementById("account-data-non-member-heading")!.closest("section");
    expect(nonMemberSection, "the non-member section exists").not.toBeNull();
    expect(
      nonMemberSection!.querySelector('a[href="https://github.com/Nitjsefnie/Overflow/issues"]'),
      "the non-member section names where to ask for removal",
    ).not.toBeNull();
  });

  it("places the non-member and server-log sections between access and retention", async () => {
    await renderAccountDataPage();

    const sectionLabelledBy = (headingId: string): Element => {
      const heading = document.getElementById(headingId);
      expect(heading, `expected a heading with id "${headingId}"`).not.toBeNull();
      const section = heading!.closest("section.surface");
      expect(section, `expected "${headingId}" inside a section.surface`).not.toBeNull();
      expect(section).toHaveAttribute("aria-labelledby", headingId);
      return section!;
    };
    const follows = (earlier: Element, later: Element): boolean =>
      (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    const access = sectionLabelledBy("account-data-access-heading");
    const nonMember = sectionLabelledBy("account-data-non-member-heading");
    const logs = sectionLabelledBy("account-data-logs-heading");
    const retention = sectionLabelledBy("account-data-retention-heading");

    expect(follows(access, nonMember), "the non-member section follows who can see it").toBe(true);
    expect(follows(nonMember, logs), "the server-log section follows the non-member section").toBe(true);
    expect(follows(logs, retention), "retention follows the server-log section").toBe(true);
    expect(nonMember.nextElementSibling, "the server-log section comes immediately after").toBe(logs);
  });

  it("points the deletion description's authorization limit at GitHub's application settings", async () => {
    await renderAccountDataPage();

    const deletionSection = document.getElementById("account-data-deletion-heading")!.closest("section");
    expect(deletionSection, "the deletion section exists").not.toBeNull();
    expect(
      deletionSection!.querySelector('a[href="https://github.com/settings/applications"]'),
      "the deletion description names where to revoke Overflow's authorization on GitHub",
    ).not.toBeNull();
  });

  it("opens with the controller section, which carries both contact routes", async () => {
    await renderAccountDataPage();

    const sections = Array.from(document.querySelectorAll("main section.surface"));
    const controller = document.getElementById("account-data-controller-heading")?.closest("section");
    expect(controller, "the controller section exists").not.toBeNull();
    expect(controller).toHaveAttribute("aria-labelledby", "account-data-controller-heading");
    expect(controller!.querySelector("h2")).not.toBeNull();
    expect(
      sections[0],
      "the controller section is the first surface after the page heading",
    ).toBe(controller);
    expect(
      controller!.querySelector('a[href="https://github.com/Nitjsefnie/Overflow/issues"]'),
      "the controller section names the public issue tracker",
    ).not.toBeNull();
    expect(
      controller!.querySelector('a[href="https://github.com/Nitjsefnie/Overflow/security/advisories/new"]'),
      "the controller section names the private vulnerability reporting form",
    ).not.toBeNull();
  });

  it("places the scoring and rights sections before the controls and deletion sections", async () => {
    await renderAccountDataPage();

    const sectionLabelledBy = (headingId: string): Element => {
      const heading = document.getElementById(headingId);
      expect(heading, `expected a heading with id "${headingId}"`).not.toBeNull();
      const section = heading!.closest("section.surface");
      expect(section, `expected "${headingId}" inside a section.surface`).not.toBeNull();
      expect(section).toHaveAttribute("aria-labelledby", headingId);
      return section!;
    };
    const follows = (earlier: Element, later: Element): boolean =>
      (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    const scoring = sectionLabelledBy("account-data-scoring-heading");
    const rights = sectionLabelledBy("account-data-rights-heading");
    const controls = sectionLabelledBy("account-data-controls-heading");
    const deletion = sectionLabelledBy("account-data-deletion-heading");

    expect(follows(scoring, controls), "the scoring section precedes your controls").toBe(true);
    expect(follows(rights, controls), "the rights section precedes your controls").toBe(true);
    expect(follows(controls, deletion), "deletion follows your controls").toBe(true);
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
