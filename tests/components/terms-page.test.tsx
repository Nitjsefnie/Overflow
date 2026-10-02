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

  it("cites the terms that set the age floor in the account section's statement", async () => {
    await renderTermsPage();

    // What an account presupposes — that its holder is old enough to hold one
    // — is only checkable because the statement cites the exact terms the floor
    // comes from. A reader depends on that citation, not on the sentence's
    // wording, so this pins the link and survives a faithful paraphrase.
    //
    // The statement is found by its marker class, not by its position. Every
    // positional reconstruction tried — last paragraph, distinct from the
    // account-creation paragraph, that paragraph carrying /account-data — was
    // defeated by a mutant that deletes the statement and appends a bare
    // citation-only paragraph, which becomes the last paragraph and satisfies
    // all of them. The class is the same handle shape this file already uses
    // on main.page-content below.
    //
    // THE CLASS CARRIES IDENTITY, NOT SOMETHING A READER SEES. It marks which
    // paragraph is the statement; nothing renders it differently. It is
    // legitimate only because the two assertions below independently require
    // the citation to be present and visible inside it — the class alone
    // would pass on a statement that cites nothing, and no assertion here
    // reads the statement's words. Do not "simplify" the class away: it is
    // what stops the statement being deleted outright.
    //
    // Exact href, not a docs.github.com prefix: the section also mentions
    // GitHub, and a prefix match is satisfied by any of GitHub's pages, so it
    // would go green on a page whose age floor cites nothing at all.
    //
    // Visible, not merely present: a hidden anchor carries no citation to a
    // reader, so presence alone is not the property being relied on. This
    // catches hidden, display:none, visibility:hidden and opacity:0 — it is
    // a rendered-visibility check, not a geometry check, so an anchor clipped
    // to a sliver still passes it.
    //
    // Scoped to the account section: PublicAppShell's chrome and the page's own
    // other sections carry external links already, and a document-wide query
    // passes with this section's link deleted. The scope is also what makes
    // the marker a statement in THIS section.
    const section = screen.getByRole("region", { name: "What an account is" });
    const statement = section.querySelector("p.account-age-floor");
    expect(
      statement,
      "the account section states what holding an account presupposes",
    ).not.toBeNull();

    const citation = statement!.querySelector(
      'a[href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"]',
    );
    expect(
      citation,
      "the statement cites the terms the age floor comes from",
    ).not.toBeNull();
    expect(citation, "the citation is one a reader can see").toBeVisible();
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
