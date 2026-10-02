/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ACCOUNT_DATA_REVISION, TERMS_REVISION, type LegalRevision } from "@/lib/legal-revisions";

// Each document's identity is named as a LITERAL here, never taken from the
// constant it is checking. A selector or an assertion built from
// `revision.document` reads back whatever the page renders, so the two sides
// can be swapped together and the suite still agrees with itself — a
// mutation-verified false green. A route identity is a fact about routing
// rather than about page copy, so naming it in a test is not asserting prose.
const TERMS_DOCUMENT = "terms";
const ACCOUNT_DATA_DOCUMENT = "account-data";

// Whole tokens, not partial ones: "1.0.1" has to read as one token, or a
// superseded patch version reduces to the release it supersedes and passes for
// it.
const VERSION_TOKEN = /\b\d+\.\d+(?:\.\d+)*\b/g;
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

// Scoped to the page's own main on purpose: PublicAppShell's nav and footer
// also carry /terms and /account-data, so a document-wide query finds a marker
// the page itself no longer renders.
function mainOf(page: string): Element {
  const main = document.querySelector("main.page-content");
  expect(main, `the ${page} page supplies its own main.page-content`).not.toBeNull();
  return main!;
}

function markerWithin(main: Element, document: string): Element {
  const marker = main.querySelector(`[data-legal-revision="${document}"]`);
  expect(marker, `the ${document} page renders its revision marker`).not.toBeNull();
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
  });
});
