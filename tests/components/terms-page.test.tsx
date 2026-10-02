/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DISPUTE_CONTESTABLE_CASE, DISPUTE_RULES } from "@/lib/disputes";

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

  it("states the correction rules it points /rules at, from the source both pages render", async () => {
    await renderTermsPage();

    // The section is found by its heading, not by position or a marker class:
    // the heading NAMES the case the section carries, and a heading that names
    // a case the rules page does not carry is the defect this test exists to
    // catch. The lookup itself is load-bearing — the mutant that puts ", or a
    // sanction" back into the heading leaves every other assertion in the file
    // satisfied, and this one cannot find the section at all. The same literal
    // shape this file already uses on "What an account is" above.
    const region = screen.getByRole("region", { name: "Contesting a settlement" });

    // The list EQUALS the constant the rules page renders, element for element
    // and in order. Compared, not asserted as prose: this never names a rule,
    // so it survives a faithful rewording of all three and still goes red on
    // the defect it targets — a promise on the terms page that the rules page
    // does not carry. The mutants it defeats are the ones this page can hold
    // INSIDE this section: a hand-copied list that drifts from the constant (one
    // bullet reworded here, the same bullet untouched in src/lib/disputes.ts),
    // a bullet deleted from this page alone, and a sanction case added here that
    // the constant does not list. It says nothing about a promise added to
    // another section of the page — the "How sanctions work" section is a
    // non-goal of this change and no assertion here reaches it. The mirrored
    // assertion on the rules page is what covers /rules drifting instead.
    const items = [...region.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([...DISPUTE_RULES]);

    // Exactly one paragraph, and it is the pointer at /rules. This is the other
    // half of the same claim: the rules are the list, so a promise the list
    // does not carry can only be prose, and prose in this section is a second
    // paragraph. A length check rather than a text match — it pins the SHAPE
    // (one list, one pointer) and names no sentence. The paragraph is then
    // required to carry the pointer, so a section that deleted the pointer
    // and kept a paragraph of new promises fails the second half rather than
    // satisfying the first. The mutant it defeats is the one this section was
    // written around: the terms page's own "…or a sanction is [wrong], you can
    // ask for it to be corrected", a promise the rules page's Disputes section
    // does not carry and never did.
    const paragraphs = [...region.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.querySelector('a[href="/rules"]')).not.toBeNull();
  });

  it("names the contestable case the shared source names, in the revision paragraph", async () => {
    await renderTermsPage();

    // The revision paragraph says what a reader cites a date over, so it makes
    // the same claim the Disputes list does — the case you can contest. It sat
    // outside the list as a hand-written phrase, which is how it came to
    // promise a sanction could be contested while the rules it points at
    // carried no such case. The page now interpolates DISPUTE_CONTESTABLE_CASE
    // there, so the phrase cannot drift without an edit to the shared source.
    //
    // Both halves are structural, no prose: the paragraph must carry the
    // constant, and it must not name "sanction" — the one word that actually
    // drifted, pinned as the negative half because "contesting a sanction or a
    // settlement" CONTAINS the constant as a substring, so the positive half
    // alone is satisfied by the very reintroduction this is written against.
    // That word is not a general rule against other cases; it is the specific
    // regression, and a future case would be added to the shared source rather
    // than written into this sentence.
    //
    // Exactly one marker, and the literal "terms" rather than
    // TERMS_REVISION.document: a document name read from the module the page
    // renders can agree with itself. The marker suite owns the question of
    // which document this page is; this one is about the case the paragraph
    // names, and a second marker would let the claim be made twice and be
    // satisfied by the copy that got it right.
    const markers = [...document.querySelectorAll("p[data-legal-revision]")];
    expect(markers, "the terms page states its revision once").toHaveLength(1);
    const revision = markers[0]!.textContent ?? "";
    expect(revision).toContain(DISPUTE_CONTESTABLE_CASE);
    expect(revision).not.toContain("sanction");
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
