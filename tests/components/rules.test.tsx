/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));

const currentRole = vi.hoisted(() => vi.fn());

vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));

import { PublicRulesContent, RulesContent } from "@/app/rules/page";
import {
  DISPUTE_CONTESTABLE_CASE,
  DISPUTE_RULES,
  SANCTION_CONTESTABLE_CASE,
  SANCTION_CONTEST_RULES,
} from "@/lib/disputes";
import { SANCTION_EFFECT_RULES } from "@/lib/sanctions";

async function renderRulesPage(): Promise<void> {
  const { default: RulesPage } = await import("@/app/rules/page");
  render(await RulesPage());
}

// Both shells, as one table: RulesSections is rendered by each of them, so
// every assertion about text this section states has to hold on both, and
// listing the pair twice is how one of them quietly stops being checked.
const MOUNT_POINTS = [
  ["member view", <RulesContent key="member" memberName="Ada" isModerator={false} />],
  ["public view", <PublicRulesContent key="public" />],
] as const;

describe("rules page", () => {
  afterEach(() => {
    auth.mockReset();
    currentRole.mockReset();
  });

  it.each([false, true])("renders the Rules heading with isModerator=%s", (isModerator) => {
    render(<RulesContent memberName="Ada" isModerator={isModerator} />);

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
  });

  it("renders the member name passed to the shell", () => {
    render(<RulesContent memberName="Grace Hopper" isModerator={false} />);

    expect(screen.getByText("Grace Hopper")).toBeVisible();
  });

  it("points maintainers at a claim system they can install", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    // A reader depends on this link resolving, not on the sentence around it.
    const claim = screen.getByRole("link", { name: /claim/i });
    expect(claim).toHaveAttribute("href", "https://github.com/Nitjsefnie-Actions/claim");
  });

  it("exposes six named section landmarks", () => {
    render(<RulesContent memberName="Ada" isModerator={false} />);

    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(6);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
  });

  it("renders the rules for a signed-out visitor inside the public shell, with no session", async () => {
    auth.mockResolvedValue(null);
    await renderRulesPage();

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(6);
    for (const region of regions) {
      expect(region).toHaveAccessibleName();
    }
    // No member chrome: no session stamp, no sign-out control, and no main
    // supplied by the member shell — the public view brings its own.
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("renders the same public view with no session read at all", () => {
    render(<PublicRulesContent />);

    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    expect(screen.getAllByRole("region")).toHaveLength(6);
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  });

  it("keeps the member view for a member session", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada Lovelace", role: "MEMBER" } });
    currentRole.mockResolvedValue("MEMBER");
    await renderRulesPage();

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it("keeps the moderator flag for a moderator session", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue("MODERATOR");
    await renderRulesPage();

    expect(screen.getByRole("link", { name: "Moderation" })).toBeVisible();
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it("renders the member view with no Moderation link when the ledger demotes a JWT moderator", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue("MEMBER");
    await renderRulesPage();

    expect(screen.queryByRole("link", { name: "Moderation" })).not.toBeInTheDocument();
    expect(screen.getByText(/Signed in as/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it("renders the Moderation link when the ledger promotes a JWT member", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MEMBER" } });
    currentRole.mockResolvedValue("MODERATOR");
    await renderRulesPage();

    expect(screen.getByRole("link", { name: "Moderation" })).toBeVisible();
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it("falls back to the public view when the ledger has no record for the session's id", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockResolvedValue(null);
    await renderRulesPage();

    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it("falls back to the public view when the ledger lookup fails", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada", role: "MODERATOR" } });
    currentRole.mockRejectedValue(new Error("the ledger is unreachable"));
    await renderRulesPage();

    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const main = document.querySelector("main.page-content");
    expect(main, "the public rules view supplies its own main.page-content").not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
    expect(currentRole).toHaveBeenCalledWith("u1");
  });

  it.each(MOUNT_POINTS)("states the correction rules the terms page points here at, in the %s", (_label, element) => {
    render(element);

    // The mirror of the terms-page assertion, and the same constant, because
    // /rules is where a dispute is actually decided: the terms page names this
    // section as the source of truth, so a rule that drifts HERE is a reader
    // held to text the pointer's promise no longer matches. That direction was
    // the one unasserted of the two, and the mutant that re-hardcoded these
    // three <li> by hand with the third drifted to "One open dispute per issue
    // at a time" left the whole suite green. Compared, never asserted as prose:
    // this names no rule, so a faithful rewording of all three still passes.
    //
    // Both mount points, not one. RulesContent and PublicRulesContent are
    // separate shells a visitor reaches and both render RulesSections, so a pin
    // on the public shell alone would leave the member view unchecked — and the
    // marker suite already establishes that the revision stamp has to hold on
    // both.
    //
    // Scoped to the page's own main: the shells' nav and footer are outside it,
    // so a document-wide query cannot resolve to anything the page does not
    // render. The region is then found by its heading — the same literal anchor
    // shape terms-page.test.tsx uses — and its bullets are read in order, so a
    // reordering is a difference rather than a set.
    //
    // COST OF THAT LOOKUP — it is a kill, not a convenience. `aria-labelledby`
    // derives the region's accessible name from the heading's TEXT, so this
    // lookup resolves only while the heading names what it says it names. The
    // reviewer's mutant — rewording the Disputes heading so it re-promises a
    // sanction the list below it does not carry — satisfies every id, every
    // class and every element query in this file, and fails HERE alone.
    // Rewriting it as a query on the element id (`#rules-disputes-heading`, or
    // `querySelector("section[aria-labelledby='rules-disputes-heading']")`)
    // would read as a harmless simplification, keep the whole suite green and
    // silently hand back the mutant. Do not.
    const main = document.querySelector<HTMLElement>("main.page-content");
    expect(main, "the rules view supplies its own main.page-content").not.toBeNull();
    const region = within(main!).getByRole("region", { name: "Disputes" });
    // Two lists now: the settlement case's rules and the sanction case's, each
    // compared against its own constant element for element. Scoping to the
    // lists rather than to the region's whole li set is what keeps the two
    // cases from standing in for each other — a sanction bullet pasted into the
    // settlement list, or a settlement bullet dropped when the sanction part
    // landed, misaligns one of the two comparisons rather than passing a
    // document-wide count.
    const lists = [...region.querySelectorAll("ul")];
    expect(lists, "the Disputes section renders one list per contestable case").toHaveLength(2);
    const settlementItems = [...lists[0]!.querySelectorAll("li")].map((item) => item.textContent);
    expect(settlementItems).toEqual([...DISPUTE_RULES]);
    const sanctionItems = [...lists[1]!.querySelectorAll("li")].map((item) => item.textContent);
    expect(sanctionItems).toEqual([...SANCTION_CONTEST_RULES]);
  });

  it.each(MOUNT_POINTS)("names the sanction case in its own heading and points the ask at the filing page, in the %s", (_label, element) => {
    render(element);

    // The mirror of the terms-page heading pin: the section inside Disputes is
    // found by the region's name — the kill-bearing lookup shape, since the
    // accessible name is the outer heading's TEXT — and the sanction part's
    // heading is then required to carry the shared source's case, never a
    // hand-written copy of it. A hand-written heading that drifts from
    // SANCTION_CONTESTABLE_CASE fails the containment read; a legitimate
    // widening of the constant in src/lib/disputes.ts still passes, because
    // the heading resolves the constant rather than a literal.
    //
    // The filing-page pointer is the other half: the rules the part states say
    // the sanctioned account can ask, and the pointer is where the ask goes. A
    // part that kept its rules and dropped the route would leave a reader told
    // they may ask with nothing telling them where — so the presence of the
    // link, not its sentence, is what is pinned.
    const main = document.querySelector<HTMLElement>("main.page-content");
    expect(main, "the rules view supplies its own main.page-content").not.toBeNull();
    const region = within(main!).getByRole("region", { name: "Disputes" });
    const heading = region.querySelector("h3");
    expect(heading, "the sanction case has its own heading inside the Disputes section").not.toBeNull();
    expect(heading!.textContent ?? "").toContain(SANCTION_CONTESTABLE_CASE);
    expect(
      region.querySelector('a[href="/contests"]'),
      "the sanction part points the sanctioned account's ask at the filing page",
    ).not.toBeNull();
  });

  it.each(MOUNT_POINTS)("names the contestable case the shared source names, in the %s revision paragraph", (_label, element) => {
    render(element);

    // This page's revision paragraph sat ONE sentence above the list it points
    // at and made the same claim by hand — "A correction to a settlement is
    // decided under the Disputes section of this page" — which is how a reader
    // could be told a case is contestable with nothing below it saying so. The
    // page now interpolates DISPUTE_CONTESTABLE_CASE there, exactly as the
    // terms page's own revision paragraph does, so the two pages cannot disagree
    // about which case a correction reaches.
    //
    // The mutant that survives every other assertion in the suite is this
    // sentence with "a settlement" changed to "a sanction": terms-page,
    // rules and legal-revisions-marker all stay 35/35 green on it, because
    // nothing read it. The assertion that kills it is the marked-element shape,
    // not a word ban — a hand-written sentence contains no [data-dispute-case]
    // at all, so the length check fails whatever words it is phrased in, and
    // the equality then reads the words when a mark IS present. A case
    // legitimately added to the shared source is still the constant and still
    // passes.
    //
    // Scoped to the page's own main, and to the revision marker inside it, for
    // the same reason the terms-page mirror is: the shells' nav and footer sit
    // outside main.page-content. The selector does NOT filter by document name —
    // a document read from RULES_REVISION.document comes from the module this
    // page renders, so the two sides could be swapped together and agree with
    // themselves. legal-revisions-marker.test.tsx owns WHICH document this is.
    const main = document.querySelector<HTMLElement>("main.page-content");
    expect(main, "the rules view supplies its own main.page-content").not.toBeNull();
    const markers = [...main!.querySelectorAll("p[data-legal-revision]")];
    expect(markers, "the rules page states its revision once").toHaveLength(1);
    const marked = [...markers[0]!.querySelectorAll("[data-dispute-case]")];
    expect(marked, "the revision paragraph names the case from the shared source").toHaveLength(1);
    expect(marked[0]!.textContent).toBe(DISPUTE_CONTESTABLE_CASE);
  });

  it.each(MOUNT_POINTS)("renders the sanction effects from the shared source, in the %s Moderation section", (_label, element) => {
    render(element);

    // The sanction effects are shared legal text (src/lib/sanctions.ts), so the
    // Moderation list's tail is compared against the constant, element for
    // element, on BOTH mount points — the member view and the public view render
    // the same section, and a pin on one alone would leave the other unchecked.
    // The list's head is the section's pre-existing hand-written bullet; it is
    // matched by shape (expect.any(String)) and not by words, because wording is
    // never asserted — but its presence is: the tail comparison misaligns if the
    // bullet is deleted, so the pin covers the list's whole length.
    const main = document.querySelector<HTMLElement>("main.page-content");
    expect(main, "the rules view supplies its own main.page-content").not.toBeNull();
    const region = within(main!).getByRole("region", { name: "Moderation" });
    const lists = [...region.querySelectorAll("ul")];
    expect(lists, "the Moderation section renders one list").toHaveLength(1);
    const items = [...lists[0]!.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([expect.any(String), ...SANCTION_EFFECT_RULES]);
  });

  it("renders the member view for a session with no role claim when the ledger vouches", async () => {
    auth.mockResolvedValue({ user: { id: "u1", name: "Ada" } });
    currentRole.mockResolvedValue("MEMBER");
    await renderRulesPage();

    expect(screen.getByText(/Signed in as/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    expect(currentRole).toHaveBeenCalledWith("u1");
  });
});
