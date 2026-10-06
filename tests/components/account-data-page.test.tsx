/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

import { AppShell, PublicAppShell } from "@/components/app-shell";
import { LandingPage } from "@/app/page";
import {
  RECEIPT_FAILED_RETENTION_DAYS,
  RECEIPT_PENDING_RETENTION_DAYS,
  RECEIPT_PROCESSED_RETENTION_DAYS,
  RUN_TERMINAL_RETENTION_DAYS,
} from "@/lib/retention/prune";
import { SANCTION_EFFECT_RULES } from "@/lib/sanctions";

async function renderAccountDataPage(): Promise<void> {
  const { default: AccountDataPage } = await import("@/app/account-data/page");
  render(<AccountDataPage />);
}

function anchorByHref(href: string): HTMLAnchorElement {
  const anchor = document.querySelector(`a[href="${href}"]`);
  expect(anchor, `expected an anchor with href "${href}"`).not.toBeNull();
  return anchor as HTMLAnchorElement;
}

function sectionLabelledBy(headingId: string): Element {
  const heading = document.getElementById(headingId);
  expect(heading, `expected a heading with id "${headingId}"`).not.toBeNull();
  const section = heading!.closest("section.surface");
  expect(section, `expected "${headingId}" inside a section.surface`).not.toBeNull();
  expect(section).toHaveAttribute("aria-labelledby", headingId);
  return section!;
}

function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// The never-signed-in section renders two lists: what reconciliation stores
// about them, then the kept-duration list. The kept list's placement — second
// of two, introduced by a paragraph — is structure, so it locates the list
// without matching its or its introduction's wording.
function keptList(section: Element): Element {
  const lists = Array.from(section.querySelectorAll("ul"));
  expect(
    lists,
    "the section renders two lists: what it stores, then how long it is kept",
  ).toHaveLength(2);
  const kept = lists[1]!;
  expect(
    kept.previousElementSibling?.tagName,
    "the kept list is introduced by a paragraph",
  ).toBe("P");
  return kept;
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
    expect(
      new Set(sections.map((section) => section.getAttribute("aria-labelledby"))).size,
      "no labelledby id names two sections",
    ).toBe(sections.length);
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

  it("states the legacy body-text retention instead of the retracted flat claim", async () => {
    await renderAccountDataPage();

    const notice = sectionLabelledBy("account-data-non-member-heading").textContent ?? "";

    expect(
      notice,
      "the retracted flat claim is gone: pre-2026-09-26 body text can persist while a repository stays registered",
    ).not.toContain("None of the free text is retained");
    expect(
      notice,
      "the notice states that body text written before 2026-09-26 may persist until the repository is unregistered",
    ).toMatch(/body text written before 2026-09-26 may persist until the repository is unregistered/i);
    expect(
      notice,
      "the no-writes claim covers all three body kinds: issue, pull request, and comment",
    ).toMatch(/writes no issue, pull request, or comment body text/i);
    expect(
      notice,
      "the unregister-scrub clause keeps the settlement-window parenthetical",
    ).toMatch(/\(unless a settlement from the last few minutes is still being computed\)/i);
  });

  it("places the non-member and server-log sections between access and retention", async () => {
    await renderAccountDataPage();

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

  it("places the keeps list in the deletion section: second of four lists, four items, the free-text item last", async () => {
    await renderAccountDataPage();

    const deletion = sectionLabelledBy("account-data-deletion-heading");
    const [removesList, keepsList, afterwardsList, preconditionsList] = Array.from(
      deletion.querySelectorAll("ul"),
    );
    expect(removesList, "the deletion section's first list holds what deletion removes").toBeDefined();
    expect(keepsList, "the deletion section's second list holds what deletion keeps").toBeDefined();
    expect(afterwardsList, "the deletion section's third list holds what happens afterwards").toBeDefined();
    expect(
      preconditionsList,
      "the deletion section's fourth list holds the preconditions and limits",
    ).toBeDefined();
    for (const list of [removesList!, keepsList!, afterwardsList!, preconditionsList!]) {
      expect(
        list.previousElementSibling?.tagName,
        "each of the deletion section's lists is introduced by a paragraph",
      ).toBe("P");
    }
    expect(follows(removesList!, keepsList!), "the keeps list follows the removes list").toBe(true);
    expect(follows(keepsList!, afterwardsList!), "the afterwards list follows the keeps list").toBe(true);
    expect(
      follows(afterwardsList!, preconditionsList!),
      "the preconditions list follows the afterwards list",
    ).toBe(true);

    const keepsItems = Array.from(keepsList!.querySelectorAll("li"));
    expect(
      keepsItems,
      "the keeps list holds four items: the retained identifiers, role and standing, the ledger records, and the free text others wrote",
    ).toHaveLength(4);
    expect(
      follows(keepsItems[2]!, keepsItems[3]!),
      "the free-text item is the keeps list's last item, after the ledger-records item",
    ).toBe(true);
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

    const purposes = sectionLabelledBy("account-data-purposes-heading");
    const recipients = sectionLabelledBy("account-data-recipients-heading");
    const scoring = sectionLabelledBy("account-data-scoring-heading");
    const rights = sectionLabelledBy("account-data-rights-heading");
    const controls = sectionLabelledBy("account-data-controls-heading");
    const deletion = sectionLabelledBy("account-data-deletion-heading");

    expect(follows(purposes, scoring), "scoring follows the purposes list that points at it below").toBe(true);
    expect(follows(recipients, rights), "your rights follow the transfers text that points at them below").toBe(true);
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

  it("renders the sanction effects from the shared source, in the Scoring and sanctions section", async () => {
    await renderAccountDataPage();

    // The sanction effects are shared legal text (src/lib/sanctions.ts), so the
    // Scoring and sanctions list's tail is compared against the constant, element
    // for element: the notice can neither drop a fact nor reword one away from
    // the two legal pages that render the same list. The list's head is the
    // section's four pre-existing items (automated pricing, the credit limit,
    // the enforcement state, and the moderators who apply sanctions); they are
    // left outside the comparison deliberately — wording is never asserted — and
    // the tail comparison is what pins the shared facts' presence and order.
    // The contest-request item that closes the list is pinned by shape, not by
    // words: the whole list is the four hand-written head facts, the shared
    // rules in order, and one closing item resolved in the contest-item test
    // below. Comparing the full list keeps the shared tail exactly the shared
    // rules even with the closing item after it.
    const scoring = sectionLabelledBy("account-data-scoring-heading");
    const lists = [...scoring.querySelectorAll("ul")];
    expect(lists, "the scoring section renders one list").toHaveLength(1);
    const items = [...lists[0]!.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      ...SANCTION_EFFECT_RULES,
      expect.any(String),
    ]);
  });

  it("discloses the sanction-contest request data facts in the scoring section", async () => {
    await renderAccountDataPage();

    // The notice passage for the contest-request data has no shared constant to
    // resolve (the /rules and /terms publications carry the shared ones), so
    // this follows the file's precedent for notice passages — the failure-alert
    // and body-text-retention pins: a marker class carries the item's identity,
    // and the three facts a reader depends on are pinned as fact patterns, not
    // as full sentences. The class is legitimate for the same reason
    // p.account-age-floor is: the assertions below independently require the
    // item to exist and to carry the facts, so a bare class with nothing in it
    // satisfies nothing, and the class alone is what keeps the item findable
    // when a rewording moves its words.
    //
    // The marker class carries identity, not something a reader sees; nothing
    // renders it differently. Do not "simplify" it away: without it the item is
    // indistinguishable from the shared-rules items the test above pins, and a
    // deleted passage would fail nowhere.
    const scoring = sectionLabelledBy("account-data-scoring-heading");
    const item = scoring.querySelector("li.sanction-contest-data");
    expect(item, "the scoring section carries the contest-request data item").not.toBeNull();
    // It is its own list item closing the section's list — after the shared
    // sanction-effect rules, so the tail pin above keeps reading exactly them,
    // and never wedged inside another item.
    const listItems = [...scoring.querySelectorAll("li")];
    expect(listItems[listItems.length - 1]).toBe(item);

    const text = item!.textContent ?? "";
    // STORED: the request and its reason, the contested sanction, the decision fields.
    expect(text, "the request and its reason are named as stored").toMatch(
      /the request and its reason are stored/i,
    );
    expect(text, "the contested sanction is named as stored").toMatch(/the sanction they contest/i);
    expect(text, "the decision fields are named").toMatch(/the decision fields/i);
    expect(text, "the sole-moderator record is among the stored fields").toMatch(
      /only live moderator/i,
    );
    // EXPORTED: own requests both as requester and as deciding moderator.
    expect(text, "the account export is named as carrying own contest requests").toMatch(
      /account export[\s\S]*own contest requests/i,
    );
    expect(text, "both roles are named: filer and deciding moderator").toMatch(
      /those you filed and those you decided as a moderator/i,
    );
    // KEPT AFTER DELETION: pseudonymised like all moderation events, reasons persist.
    expect(text, "deletion is named as keeping them pseudonymised").toMatch(
      /Deleting your account keeps them pseudonymised/i,
    );
    expect(text, "the reasons are named as persisting").toMatch(/reasons stay/i);
  });

  it("discloses the failure-alert mail route in the recipients list", async () => {
    await renderAccountDataPage();

    const recipients = sectionLabelledBy("account-data-recipients-heading");
    const item = Array.from(recipients.querySelectorAll("li")).find((candidate) =>
      /smtp\.gmail\.com/i.test(candidate.textContent ?? ""),
    );
    expect(item, "the recipients list discloses the failure-alert mail route").toBeDefined();

    const text = item!.textContent ?? "";
    expect(text, "failure alerts are what get mailed").toMatch(
      /failure alerts mail [\s\S]*journal (?:entries|excerpts)/i,
    );
    expect(text, "the destination is the operator's mailbox").toMatch(/operator.s mailbox/i);
    expect(text, "the mail is forwarded by Google's smtp.gmail.com relay").toMatch(
      /host.s mail relay[\s\S]*smtp\.gmail\.com/i,
    );
    expect(text, "Google LLC (US) is named as processing the content the relay forwards").toMatch(
      /smtp\.gmail\.com[\s\S]*Google LLC \(US\)\s+processes/i,
    );
    expect(
      text,
      "the mailed journal excerpts may carry personal data, with repository names and logins as the examples",
    ).toMatch(/personal data[\s\S]*repository names[\s\S]*logins/i);
  });

  it("places the privileged-action export in the retention list, tenth of eleven items", async () => {
    await renderAccountDataPage();

    const retention = sectionLabelledBy("account-data-retention-heading");
    const lists = Array.from(retention.querySelectorAll("ul"));
    expect(lists, "the retention section renders one list").toHaveLength(1);
    const items = Array.from(lists[0]!.querySelectorAll("li"));
    expect(
      items,
      "the retention list holds eleven items, the privileged-action export among them tenth",
    ).toHaveLength(11);
    const [backupsItem, exportItem, nightlyCopyItem] = items.slice(8, 11);
    expect(
      follows(backupsItem!, exportItem!),
      "the export item follows the daily-backups item",
    ).toBe(true);
    expect(
      follows(exportItem!, nightlyCopyItem!),
      "the nightly-copy item follows the export item",
    ).toBe(true);
  });

  it("pins the change log's retention horizon to the constant, from the kept list's third item", async () => {
    await renderAccountDataPage();

    const kept = keptList(sectionLabelledBy("account-data-non-member-heading"));
    const items = Array.from(kept.querySelectorAll("li"));
    expect(
      items,
      "the kept list holds six items: re-reads, an unreadable repository, the change log, webhook receipts, unregistering, and the backups pointer",
    ).toHaveLength(6);
    const changeLogItem = items[2]!;
    const receiptsItem = items[3]!;
    expect(
      follows(changeLogItem, receiptsItem),
      "the receipts item follows the change-log item",
    ).toBe(true);

    const text = changeLogItem.textContent ?? "";
    expect(
      text,
      "the stated horizon is the constant's value, so bumping the constant without following here fails this test",
    ).toMatch(new RegExp(`\\b${RUN_TERMINAL_RETENTION_DAYS}\\b`));
  });

  it("pins the receipt windows to the constants, from the kept list's fourth item", async () => {
    await renderAccountDataPage();

    const kept = keptList(sectionLabelledBy("account-data-non-member-heading"));
    const items = Array.from(kept.querySelectorAll("li"));
    expect(
      items,
      "the kept list holds six items: re-reads, an unreadable repository, the change log, webhook receipts, unregistering, and the backups pointer",
    ).toHaveLength(6);
    const receiptsItem = items[3]!;
    expect(
      follows(items[2]!, receiptsItem),
      "the receipts item follows the change-log item",
    ).toBe(true);

    const text = receiptsItem.textContent ?? "";
    expect(text, "a processed receipt's 30-day window is the constant's value").toMatch(
      new RegExp(`\\b${RECEIPT_PROCESSED_RETENTION_DAYS}\\b`),
    );
    expect(text, "a failed receipt's window is the constant's value").toMatch(
      new RegExp(`\\b${RECEIPT_FAILED_RETENTION_DAYS}\\b`),
    );
    expect(text, "an abandoned receipt's window is the constant's value").toMatch(
      new RegExp(`\\b${RECEIPT_PENDING_RETENTION_DAYS}\\b`),
    );
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
