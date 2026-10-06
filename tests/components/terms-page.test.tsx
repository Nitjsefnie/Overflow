/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DISPUTE_CONTESTABLE_CASE, DISPUTE_RULES } from "@/lib/disputes";
import { SANCTION_EFFECT_RULES } from "@/lib/sanctions";

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
    //
    // COST OF THAT LOOKUP, because the literal reads like something to
    // "simplify". `aria-labelledby` derives the region's accessible name from
    // the heading's TEXT, so this resolves only while the heading names what it
    // claims to name. Swapping it for the element id —
    // `#terms-disputes-heading`, or
    // `querySelector("section[aria-labelledby='terms-disputes-heading']")` —
    // keeps every id and class check satisfied under that mutant and silently
    // hands back the kill this lookup exists to make. Do not.
    const region = screen.getByRole("region", { name: "Contesting a settlement" });

    // The heading is the ONE place on either page that names the contestable
    // case by hand, and it stays a literal on purpose: src/lib/disputes.ts
    // holds the case, this file holds the literal, and neither is read from the
    // other. This assertion is what keeps those two in step. The mutant it
    // defeats is DISPUTE_CONTESTABLE_CASE widened to "a settlement or a
    // sanction" with the list widened to match and this heading left at
    // "Contesting a settlement" — a legitimate product change carried out half
    // way, which every other assertion in the suite satisfies, and which ships
    // a heading contradicting the list under it and the revision paragraph
    // above it. It is the mirror of the lookup above: that one fails when the
    // heading names a case nothing else names, this one when the case gains a
    // name the heading does not carry.
    //
    // Contained, never asserted as prose — the compared value is the exported
    // constant, so no sentence is written here. The cost of the literal anchor
    // above is what a widening now pays, and it is a deliberate one: adding a
    // contestable case updates this heading AND the literal two lines up in the
    // same commit, so the product change arrives as a diff that shows both. A
    // widening that leaves this heading alone fails here.
    const heading = region.querySelector("h2");
    expect(heading, "the section is labelled by its own heading").not.toBeNull();
    expect(heading!.textContent ?? "").toContain(DISPUTE_CONTESTABLE_CASE);

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

  it("renders the sanction effects from the shared source, in the How sanctions work section", async () => {
    await renderTermsPage();

    // The sanction effects are shared legal text (src/lib/sanctions.ts), so the
    // section's own list is compared against the constant, element for element:
    // the page can neither drop a fact nor reword one away from the other two
    // pages that render the same list. The section is resolved by its heading —
    // the aria name is the heading's TEXT — so a heading renamed away from what
    // the section carries fails here rather than silently skipping the pin.
    // Exactly one list, so the facts cannot be stated twice in the section with
    // one copy drifting.
    const section = screen.getByRole("region", { name: "How sanctions work" });
    const lists = [...section.querySelectorAll("ul")];
    expect(lists, "the sanctions section renders one list of sanction effects").toHaveLength(1);
    const items = [...lists[0]!.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([...SANCTION_EFFECT_RULES]);
  });

  it("names where a sanction may be contested, citing the rules page and the filing page, in the sanctions section", async () => {
    await renderTermsPage();

    // The one-source pattern the settlement section established: the terms
    // page points at the rules page rather than restating the route, so the two
    // pages cannot disagree about how a sanction is contested. The pointer
    // lives in the sanctions section — the place a reader is told sanctions
    // exist — and the filing page is named beside it, because that is where
    // the reader who is told they may ask actually asks. Both links are pinned
    // by href, not by their sentences: a reader depends on the routes
    // resolving, and the one-source pattern is carried by where the pointer
    // aims, never by the words around it. Scoped to the section, since the
    // shell chrome carries /rules elsewhere on the page.
    const section = screen.getByRole("region", { name: "How sanctions work" });
    expect(
      section.querySelector('p a[href="/rules"]'),
      "the sanctions section cites the rules page for where a sanction may be contested",
    ).not.toBeNull();
    expect(
      section.querySelector('a[href="/contests"]'),
      "the sanctions section names the filing page where the reader is told they may ask",
    ).not.toBeNull();
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
    // The paragraph must carry that interpolation as a MARKED element, and the
    // marked element must BE the constant. Asserting on the mark rather than on
    // the paragraph's text is what makes both directions come out right:
    //
    //   - A hand-written paragraph — "contesting a sanction or a settlement",
    //     or the same drift phrased as "a penalty or a settlement" — contains
    //     no marked element at all, so the length check kills every hand-written
    //     superset whatever words it is phrased in. A test that forbade the
    //     word "sanction" instead died on a synonym and had to be special-cased
    //     against the legitimate change it was written to allow.
    //   - A case genuinely added to the shared source — "a settlement or a
    //     sanction" with a matching rule, both pages updated together — is
    //     still the constant, so it passes. The test forbids a hand-written
    //     promise the rules do not carry; it says nothing about which cases
    //     there are.
    //
    // The mark carries IDENTITY, not something a reader sees: it is an inline
    // span with no styling, and it marks which words are the interpolated case
    // so nothing has to recognise them. It is legitimate only because the
    // second assertion reads the words inside it — a bare presence check would
    // pass on a marked element that named nothing. Do not "simplify" it away.
    //
    // Exactly one revision marker, and the selector deliberately does NOT filter
    // by document: a document name read from TERMS_REVISION.document is read
    // from the module the page itself renders, so the two sides can be swapped
    // together and the assertion agrees with itself. The marker suite owns which
    // document this page is; this one is about the case the paragraph names. A
    // second marker would let the claim be made twice and be satisfied by the
    // copy that got it right.
    const markers = [...document.querySelectorAll("p[data-legal-revision]")];
    expect(markers, "the terms page states its revision once").toHaveLength(1);
    const marked = [...markers[0]!.querySelectorAll("[data-dispute-case]")];
    expect(marked, "the revision paragraph names the case from the shared source").toHaveLength(1);
    expect(marked[0]!.textContent).toBe(DISPUTE_CONTESTABLE_CASE);
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
