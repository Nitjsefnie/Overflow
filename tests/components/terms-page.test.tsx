/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function renderTermsPage(): Promise<void> {
  const { default: TermsPage } = await import("@/app/terms/page");
  render(<TermsPage />);
}

describe("terms page", () => {
  it("renders the Terms heading and its section landmarks with no session", async () => {
    await renderTermsPage();

    expect(screen.getByRole("heading", { level: 1, name: "Terms" })).toBeVisible();
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(5);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
  });

  it("supplies its own main.page-content as the skip-link target", async () => {
    await renderTermsPage();

    const main = document.querySelector("main.page-content");
    expect(main, "the terms page supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("resolves its internal links to the account-data and rules pages", async () => {
    await renderTermsPage();

    // A reader depends on these resolving, not on the sentences around them.
    // Scoped to the notice's own main: PublicAppShell's nav and footer both
    // carry /account-data, so a document-wide query passes with the page's
    // own link deleted.
    const notice = document.querySelector("main.page-content");
    expect(notice, "the terms page supplies its own main.page-content").not.toBeNull();
    expect(notice!.querySelector('a[href="/account-data"]')).not.toBeNull();
    expect(notice!.querySelector('a[href="/rules"]')).not.toBeNull();
  });

  it("cites the upstream source of the age floor inside the account section", async () => {
    await renderTermsPage();

    // What an account presupposes — that its holder is old enough to hold one
    // — is only checkable because the section cites where the floor comes from.
    // A reader depends on that citation, not on the sentence's wording, so this
    // pins the link and survives a faithful paraphrase.
    //
    // Scoped to the account section: PublicAppShell's chrome and the page's own
    // other sections carry external links already, and a document-wide query
    // passes with this section's link deleted.
    const section = screen.getByRole("region", { name: "What an account is" });
    expect(
      section.querySelector('a[href^="https://docs.github.com/"]'),
      "the account section cites the source of the age floor",
    ).not.toBeNull();
  });

  it("keeps every internal link on a page route", async () => {
    await renderTermsPage();

    const routes = new Set(
      readdirSync(resolve(process.cwd(), "src/app"), { recursive: true })
        .map(String)
        .filter((path) => path.endsWith("page.tsx"))
        .map((path) => {
          const directory = path.slice(0, -"page.tsx".length).replace(/\/+$/, "");
          return directory === "" ? "/" : `/${directory}`;
        }),
    );
    // The build writes this file into the dist dir; its route serves the URL,
    // and the shell footer links it from every page.
    routes.add("/third-party-notices.txt");

    const internal = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.startsWith("//"));

    expect(internal.length).toBeGreaterThan(0);
    expect(internal.filter((href) => !routes.has(href))).toEqual([]);
  });
});
