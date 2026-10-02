/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ACCOUNT_DATA_REVISION, TERMS_REVISION, type LegalRevision } from "@/lib/legal-revisions";

async function renderTermsPage(): Promise<Element> {
  const { default: TermsPage } = await import("@/app/terms/page");
  render(<TermsPage />);
  return mainOf("terms");
}

async function renderAccountDataPage(): Promise<Element> {
  const { default: AccountDataPage } = await import("@/app/account-data/page");
  render(<AccountDataPage />);
  return mainOf("account-data");
}

// Scoped to the page's own main on purpose: PublicAppShell's nav and footer
// also carry /terms and /account-data, so a document-wide query finds a marker
// the page itself no longer renders.
function mainOf(page: string): Element {
  const main = document.querySelector("main.page-content");
  expect(main, `the ${page} page supplies its own main.page-content`).not.toBeNull();
  return main!;
}

function markerWithin(main: Element, revision: LegalRevision): Element {
  const marker = main.querySelector(`[data-legal-revision="${revision.document}"]`);
  expect(marker, `the ${revision.document} page renders its revision marker`).not.toBeNull();
  return marker!;
}

// The marker is a pin, not prose: a reader cites the version and the date, so
// the test reads the values the module exports rather than the sentence
// wrapped around them. The attributes carry them for machine readers; the
// rendered text is what a reader actually sees and cites.
function expectStatesItsRevision(marker: Element, revision: LegalRevision): void {
  expect(marker).toHaveAttribute("data-version", revision.version);
  expect(marker).toHaveAttribute("data-effective-date", revision.effectiveDate);
  expect(marker.textContent).toContain(revision.version);
  expect(marker.textContent).toContain(revision.effectiveDate);
}

describe("legal revision markers", () => {
  it("states the terms revision on the terms page", async () => {
    const main = await renderTermsPage();

    expectStatesItsRevision(markerWithin(main, TERMS_REVISION), TERMS_REVISION);
  });

  it("states the account-data revision on the account-data page", async () => {
    const main = await renderAccountDataPage();

    expectStatesItsRevision(markerWithin(main, ACCOUNT_DATA_REVISION), ACCOUNT_DATA_REVISION);
  });

  it("places the terms marker in the page's own heading, where it needs no scrolling", async () => {
    // Placement is part of what the marker promises: inside the existing
    // page-heading section, immediately after the h1, adding no section and
    // so no landmark region.
    const terms = await renderTermsPage();
    const termsHeading = terms.querySelector("section.page-heading > h1");
    expect(termsHeading, "the terms page has a page-heading section").not.toBeNull();
    expect(markerWithin(terms, TERMS_REVISION).previousElementSibling).toBe(termsHeading);
  });

  it("places the account-data marker in the page's own heading, where it needs no scrolling", async () => {
    const accountData = await renderAccountDataPage();
    const accountDataHeading = accountData.querySelector("section.page-heading > h1");
    expect(accountDataHeading, "the account-data page has a page-heading section").not.toBeNull();
    expect(markerWithin(accountData, ACCOUNT_DATA_REVISION).previousElementSibling).toBe(
      accountDataHeading,
    );
  });

  it("gives each document its own marker identity", () => {
    // Two pages rendering one document's values is the defect this whole change
    // exists to prevent, so the identities are distinct at the source.
    expect(TERMS_REVISION.document).not.toBe(ACCOUNT_DATA_REVISION.document);
  });
});
