/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DATA_REVISION,
  RULES_REVISION,
  TERMS_REVISION,
  type LegalRevision,
} from "@/lib/legal-revisions";
import * as legalRevisions from "@/lib/legal-revisions";

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
//
// The second alternative is a bare integer, and it is gated on the word
// "version" for a reason that is not stylistic: an ungated \d+ alternative
// matches the 2026 inside the marker's own ISO date, so every page would fail
// against its own correct text. The (?!\.\d) is what keeps "version 1.0" out of
// this alternative, so the dotted branch still reads the true version whole
// rather than "1" here and ".0" there. A mutation-verified false green, twice.
const VERSION_TOKEN = /\bv?\d+\.\d+(?:\.\d+)*\b|\bversion\s+(\d+)(?!\.\d)/gi;

// The two recognisers used to have different widths, which is how "Superseded
// 2 October 2026." sat beside the ISO date with the date set unchanged and the
// suite green. This one is a shape list, like its sibling: a date written in a
// shape it does not name is invisible to it, and that residue is the class the
// final review parked rather than closed.
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December" +
  "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

const DATE_TOKEN = new RegExp(
  [
    "\\b\\d{4}-\\d{2}-\\d{2}\\b",
    `\\b\\d{1,2}\\s+(?:${MONTHS})\\.?\\s+\\d{4}\\b`,
    `\\b(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b`,
  ].join("|"),
  "gi",
);

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
//
// EVERY marker on the page, not the first match. This used to be a single
// querySelector, which answered with exactly one element and left every other
// [data-legal-revision] on the page outside the exclusivity set entirely: a
// second <p data-legal-revision="terms" data-version="0.9"> beside the true one
// rendered both claims to the reader and the suite stayed 12/12. That is the
// defect this branch exists to close, moved from a second token inside one
// element to a second element on the page. Checking each element's own identity
// rather than counting them also catches a foreign document's marker carried
// onto the wrong page, which a length check would not.
function revisionMarkers(main: Element, document: string): Element[] {
  const markers = [...main.querySelectorAll("[data-legal-revision]")];
  expect(markers.length, `the ${document} page renders a revision marker`).toBeGreaterThan(0);
  for (const marker of markers) {
    expect(
      marker.getAttribute("data-legal-revision"),
      `every revision claim on the ${document} page is the ${document} document's`,
    ).toBe(document);
    expect(marker.tagName, `a revision marker on the ${document} page is a paragraph`).toBe("P");
  }
  return markers;
}

// matchAll, not match, because VERSION_TOKEN's bare-integer branch carries the
// token in a capture group while its dotted branch is the whole match; `match`
// would hand back "version 2" where the token is "2". matchAll copies the
// pattern rather than advancing the shared global's lastIndex, so the same
// regex can be reused across every call without state leaking between them.
function tokensIn(marker: Element, pattern: RegExp): string[] {
  const found = [...(marker.textContent?.matchAll(pattern) ?? [])].map(
    (match) => match[1] ?? match[0],
  );
  return [...new Set(found)];
}

// What a reader is shown is the marker's prose, not its data attributes, so
// the rendered text has to carry the values — and ONLY the values. Presence
// alone lets a second, contradicting version number sit beside the true one:
// the reader sees two numbers and the pin says nothing, which is the
// mutation-verified false green this replaces. Exact textContent equality is
// barred by the never-assert-prose rule, so what is constrained here is the
// SHAPE of the rendered values: the version-shaped tokens are the constant and
// nothing else, so a second one makes it a different set. Run over every
// marker on the page, not the first match — see revisionMarkers above.
function expectStatesOnlyItsOwnRevision(markers: Element[], revision: LegalRevision): void {
  for (const marker of markers) {
    expect(marker).toHaveAttribute("data-version", revision.version);
    expect(marker).toHaveAttribute("data-effective-date", revision.effectiveDate);
    expect(tokensIn(marker, VERSION_TOKEN)).toEqual([revision.version]);
    expect(tokensIn(marker, DATE_TOKEN)).toEqual([revision.effectiveDate]);
  }
}

describe("legal revision markers", () => {
  it("states the terms revision, and only that revision, on the terms page", async () => {
    const main = await renderTermsPage();

    expectStatesOnlyItsOwnRevision(revisionMarkers(main, TERMS_DOCUMENT), TERMS_REVISION);
  });

  it("states the account-data revision, and only that revision, on the account-data page", async () => {
    const main = await renderAccountDataPage();

    expectStatesOnlyItsOwnRevision(
      revisionMarkers(main, ACCOUNT_DATA_DOCUMENT),
      ACCOUNT_DATA_REVISION,
    );
  });

  it("states the rules revision, and only that revision, on the public rules page", async () => {
    // The terms page sends a reader here for disputes, and the disputes section
    // of THIS page is the text they are held to, so the public shell — the one a
    // signed-out reader in a dispute actually gets — is the view that has to
    // carry the stamp.
    const main = await renderPublicRulesPage();

    expectStatesOnlyItsOwnRevision(revisionMarkers(main, RULES_DOCUMENT), RULES_REVISION);
  });

  it("states the same rules revision on the member view of the rules page", async () => {
    // The other mount point: a member reading the rules under AppShell. Same
    // document, same revision, and a pin that only covered the public shell
    // would let the member view drop the marker unnoticed.
    const main = await renderMemberRulesPage();

    expectStatesOnlyItsOwnRevision(revisionMarkers(main, RULES_DOCUMENT), RULES_REVISION);
  });

  it("places the rules marker in the page's own heading, where it needs no scrolling", async () => {
    // Same position as the other two documents: inside the existing
    // page-heading section, immediately after the h1, adding no section and so
    // no landmark region — rules.test.tsx counts six and must stay untouched.
    const rules = await renderPublicRulesPage();
    const rulesHeading = rules.querySelector("section.page-heading > h1");
    expect(rulesHeading, "the rules page has a page-heading section").not.toBeNull();
    for (const marker of revisionMarkers(rules, RULES_DOCUMENT)) {
      expect(marker.previousElementSibling).toBe(rulesHeading);
    }
  });

  it("places the terms marker in the page's own heading, where it needs no scrolling", async () => {
    // Placement is part of what the marker promises: inside the existing
    // page-heading section, immediately after the h1, adding no section and
    // so no landmark region.
    const terms = await renderTermsPage();
    const termsHeading = terms.querySelector("section.page-heading > h1");
    expect(termsHeading, "the terms page has a page-heading section").not.toBeNull();
    for (const marker of revisionMarkers(terms, TERMS_DOCUMENT)) {
      expect(marker.previousElementSibling).toBe(termsHeading);
    }
  });

  it("places the account-data marker in the page's own heading, where it needs no scrolling", async () => {
    const accountData = await renderAccountDataPage();
    const accountDataHeading = accountData.querySelector("section.page-heading > h1");
    expect(accountDataHeading, "the account-data page has a page-heading section").not.toBeNull();
    for (const marker of revisionMarkers(accountData, ACCOUNT_DATA_DOCUMENT)) {
      expect(marker.previousElementSibling).toBe(accountDataHeading);
    }
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

  it("pins each document's version to the literal a reader cites", () => {
    // The version is the one value in this registry no assertion above reaches.
    // expectStatesOnlyItsOwnRevision reads data-version from the page and
    // compares it to the constant, and checks the rendered token
    // against the same constant — so a revert of a constant to its prior value
    // left every one of them satisfied, and a reader citing the prior version
    // was handed superseded text — the revision in which the terms page still
    // promised a sanction could be contested while the rules it pointed at
    // carried no such case. Checked against itself from both sides is not a
    // pin.
    //
    // Literal here, from the same third source as the document identities, and
    // for the same reason. Bumping a REVISION constant is a deliberate edit
    // of this file's expectation — that is what makes the bump reviewable: the
    // bump and the pin it trips arrive in the same diff.
    expect(TERMS_REVISION.version).toBe("1.2");
    expect(ACCOUNT_DATA_REVISION.version).toBe("1.6");
    expect(RULES_REVISION.version).toBe("1.2");
  });
});

// The inventory, read from the module instead of listed here. A registry entry
// nothing renders used to be invisible: a PRIVACY_REVISION constant with no page
// consuming it was 28/28 green and typechecked, because an unused export is
// legal TypeScript. Deriving the list means a new entry is exercised the day it
// is added and an orphan one fails the moment it is added. `LegalRevision` is a
// type, erased at runtime, so it is not in Object.values and needs no filter
// for it; the filter is for anything else the module might grow.
const REGISTERED = Object.values(legalRevisions).filter(
  (value): value is LegalRevision => typeof value === "object" && value !== null && "document" in value,
);

// How each document's page is rendered in jsdom. The keys are LITERALS: this
// is a second list of document names beside the registry's, and a name present
// in one and not the other is drift the reconciliation test below exists to
// catch. Deriving the inventory from the module's exports is what makes that
// reconciliation possible; it does not remove the second list.
//
// These derived tests are ADDITIVE. The per-document tests above stay, because
// they carry the literal identity anchors, and an identity taken from the
// module cannot anchor to a literal. Dispatching the derived cases through a
// literal-keyed map also catches a swapped module identity on this side as well
// as on the anchor side, so that boundary is narrower than the anchor alone. The
// hardcoded-version boundary is untouched: a marker rendering a literal version
// instead of the constant still passes, because the value comparison still reads
// the constant on both sides.
const PAGE_RENDERERS: Record<string, () => Promise<Element>> = {
  "terms": renderTermsPage,
  "account-data": renderAccountDataPage,
  "rules": renderPublicRulesPage,
};

describe("the revision registry and the pages that render it", () => {
  it("reconciles the registry against the pages, in both directions", () => {
    const registered = REGISTERED.map((revision) => revision.document).sort();
    expect(
      Object.keys(PAGE_RENDERERS).sort(),
      "every registered document has a page rendered here, and every rendered page has an entry",
    ).toEqual(registered);
  });

  it.each(REGISTERED.map((revision) => [revision.document, revision] as const))(
    "renders the %s revision, and only that revision, on its own page",
    async (document, revision) => {
      const render = PAGE_RENDERERS[document];
      expect(render, `the ${document} document has a page rendered here`).toBeDefined();
      const main = await render!();

      expectStatesOnlyItsOwnRevision(revisionMarkers(main, document), revision);
    },
  );
});
