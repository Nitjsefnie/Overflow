/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DATA_REVISION,
  RULES_REVISION,
  TERMS_REVISION,
  type LegalRevision,
} from "@/lib/legal-revisions";

// Each document's identity is named as a LITERAL here, never taken from the
// constant it is checking. A selector or an assertion built from
// `revision.document` reads back whatever the page renders, so the two sides
// can be swapped together and the suite still agrees with itself — a
// mutation-verified false green. A route identity is a fact about routing
// rather than about page copy, so naming it in a test is not asserting prose.
const TERMS_DOCUMENT = "terms";
const ACCOUNT_DATA_DOCUMENT = "account-data";
const RULES_DOCUMENT = "rules";

// Whole tokens, not partial ones: "1.0.1" has to read as one token, or a
// superseded patch version reduces to the release it supersedes and passes for
// it. The leading "v" is optional because a second version written as "v2.0"
// carries no word boundary before its digits — "v" and "2" are both word
// characters — so a recogniser without it skipped the token entirely and the
// second version sat beside the true one unnoticed. A mutation-verified false
// green, both ways.
const VERSION_TOKEN = /\bv?\d+\.\d+(?:\.\d+)*\b/g;
const DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g;

async function renderTermsPage(): Promise<Element> {
  const { default: TermsPage } = await import("@/app/terms/page");
  render(<TermsPage />);
  return mainOf(TERMS_DOCUMENT);
}

async function renderAccountDataPage(): Promise<Element> {
  const { default: AccountDataPage } = await import("@/app/account-data/page");
  render(<AccountDataPage />);
  return mainOf(ACCOUNT_DATA_DOCUMENT);
}

// The rules page has two shells, and both are mount points a visitor reaches:
// a signed-in member gets AppShell's main, everyone else gets the main
// PublicRulesContent brings itself. The marker lives in the section both share,
// and each of these renders one shell so the document-wide main lookup below
// cannot resolve to the other render.
async function renderPublicRulesPage(): Promise<Element> {
  const { PublicRulesContent } = await import("@/app/rules/page");
  render(<PublicRulesContent />);
  return mainOf(RULES_DOCUMENT);
}

async function renderMemberRulesPage(): Promise<Element> {
  const { RulesContent } = await import("@/app/rules/page");
  render(<RulesContent memberName="Ada" isModerator={false} />);
  return mainOf(RULES_DOCUMENT);
}

// Scoped to the page's own main on purpose: PublicAppShell's nav and footer
// also carry /terms and /account-data, so a document-wide query finds a marker
// the page itself no longer renders.
function mainOf(page: string): Element {
  const main = document.querySelector("main.page-content");
  expect(main, `the ${page} page supplies its own main.page-content`).not.toBeNull();
  return main!;
}

// The tag is load-bearing and no existing count can catch it: a <section> only
// becomes a landmark when it has an accessible name, so an UNNAMED <section>
// here contributes no region, terms-page.test.tsx (5), rules.test.tsx (6) and
// account-data-page.test.tsx (13 sections) all stay at their counts, and the
// sibling-position assertion is satisfied by any element. A mutation-verified
// false green on all three pages. Asserting the tag is what makes "the marker
// adds no section" a fact rather than a convention, and it lives here so one
// line covers every document.
function markerWithin(main: Element, document: string): Element {
  const marker = main.querySelector(`[data-legal-revision="${document}"]`);
  expect(marker, `the ${document} page renders its revision marker`).not.toBeNull();
  expect(marker!.tagName, `the ${document} marker is a paragraph, not a section`).toBe("P");
  return marker!;
}

function tokensIn(marker: Element, pattern: RegExp): string[] {
  return [...new Set(marker.textContent?.match(pattern) ?? [])];
}

// What a reader is shown is the marker's prose, not its data attributes, so
// the rendered text has to carry the values — and ONLY the values. Presence
// alone lets a second, contradicting version number sit beside the true one:
// the reader sees two numbers and the pin says nothing, which is the
// mutation-verified false green this replaces. Exact textContent equality is
// barred by the never-assert-prose rule, so what is constrained here is the
// SHAPE of the rendered values: the version-shaped tokens are the constant and
// nothing else, so a second one makes it a different set.
function expectStatesOnlyItsOwnRevision(marker: Element, revision: LegalRevision): void {
  expect(marker).toHaveAttribute("data-version", revision.version);
  expect(marker).toHaveAttribute("data-effective-date", revision.effectiveDate);
  expect(tokensIn(marker, VERSION_TOKEN)).toEqual([revision.version]);
  expect(tokensIn(marker, DATE_TOKEN)).toEqual([revision.effectiveDate]);
}

describe("legal revision markers", () => {
  it("states the terms revision, and only that revision, on the terms page", async () => {
    const main = await renderTermsPage();

    expectStatesOnlyItsOwnRevision(markerWithin(main, TERMS_DOCUMENT), TERMS_REVISION);
  });

  it("states the account-data revision, and only that revision, on the account-data page", async () => {
    const main = await renderAccountDataPage();

    expectStatesOnlyItsOwnRevision(markerWithin(main, ACCOUNT_DATA_DOCUMENT), ACCOUNT_DATA_REVISION);
  });

  it("states the rules revision, and only that revision, on the public rules page", async () => {
    // The terms page sends a reader here for disputes, and the disputes section
    // of THIS page is the text they are held to, so the public shell — the one a
    // signed-out reader in a dispute actually gets — is the view that has to
    // carry the stamp.
    const main = await renderPublicRulesPage();

    expectStatesOnlyItsOwnRevision(markerWithin(main, RULES_DOCUMENT), RULES_REVISION);
  });

  it("states the same rules revision on the member view of the rules page", async () => {
    // The other mount point: a member reading the rules under AppShell. Same
    // document, same revision, and a pin that only covered the public shell
    // would let the member view drop the marker unnoticed.
    const main = await renderMemberRulesPage();

    expectStatesOnlyItsOwnRevision(markerWithin(main, RULES_DOCUMENT), RULES_REVISION);
  });

  it("places the rules marker in the page's own heading, where it needs no scrolling", async () => {
    // Same position as the other two documents: inside the existing
    // page-heading section, immediately after the h1, adding no section and so
    // no landmark region — rules.test.tsx counts six and must stay untouched.
    const rules = await renderPublicRulesPage();
    const rulesHeading = rules.querySelector("section.page-heading > h1");
    expect(rulesHeading, "the rules page has a page-heading section").not.toBeNull();
    expect(markerWithin(rules, RULES_DOCUMENT).previousElementSibling).toBe(rulesHeading);
  });

  it("places the terms marker in the page's own heading, where it needs no scrolling", async () => {
    // Placement is part of what the marker promises: inside the existing
    // page-heading section, immediately after the h1, adding no section and
    // so no landmark region.
    const terms = await renderTermsPage();
    const termsHeading = terms.querySelector("section.page-heading > h1");
    expect(termsHeading, "the terms page has a page-heading section").not.toBeNull();
    expect(markerWithin(terms, TERMS_DOCUMENT).previousElementSibling).toBe(termsHeading);
  });

  it("places the account-data marker in the page's own heading, where it needs no scrolling", async () => {
    const accountData = await renderAccountDataPage();
    const accountDataHeading = accountData.querySelector("section.page-heading > h1");
    expect(accountDataHeading, "the account-data page has a page-heading section").not.toBeNull();
    expect(markerWithin(accountData, ACCOUNT_DATA_DOCUMENT).previousElementSibling).toBe(
      accountDataHeading,
    );
  });

  it("pins each document's identity to its own literal", () => {
    // Distinctness is not identity: swapping the two strings leaves them
    // distinct, and this assertion used to be distinctness. Both pages then
    // stamped themselves with the other document's name and every test in the
    // file agreed. The literals above are the third source, the one neither
    // the module nor the page is read from.
    expect(TERMS_REVISION.document).toBe(TERMS_DOCUMENT);
    expect(ACCOUNT_DATA_REVISION.document).toBe(ACCOUNT_DATA_DOCUMENT);
    expect(RULES_REVISION.document).toBe(RULES_DOCUMENT);
  });
});
