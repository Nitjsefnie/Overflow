/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ModerationPage from "@/app/moderation/page";
import { UnwritableClosureQueue } from "@/components/unwritable-closure-queue";
import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

const { sql, memberSession } = vi.hoisted(() => ({
  sql: vi.fn(),
  memberSession: vi.fn(async () => ({
    user: { id: "moderator-1", role: "MODERATOR", name: "Moderator" },
  })),
}));

// The moderation page now renders the client-side open-audit form, which reads the
// app router; a bare render has no router mounted.
vi.mock("next/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/navigation")>(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: memberSession,
}));

function closure(overrides: Partial<UnwritableClosureProjection> = {}): UnwritableClosureProjection {
  return {
    id: "closure-1",
    kind: "SETTLEMENT_EVIDENCE_REJECTED",
    reason: "The settled label was applied after the evidence window.",
    recordedAt: "2026-09-05T10:00:00.000Z",
    repositoryName: "co-op/harbour",
    issueNumber: 17,
    issueTitle: "Repair the tide gate",
    issueUrl: "https://github.com/co-op/harbour/issues/17",
    pullRequest: { number: 18, title: "Repair the gate", url: "https://github.com/co-op/harbour/pull/18" },
    settlementId: "settlement-1",
    settlementParties: { creditorLogin: "mira", debtorLogin: "quinn" },
    calibrationId: null,
    calibrationOwnerLogin: null,
    viewerCanRequestCorrection: true,
    latestCorrection: null,
    ...overrides,
  };
}

/** A closure the sponsor closed themselves: a calibration stands where the settlement would. */
function selfWorked(overrides: Partial<UnwritableClosureProjection> = {}): UnwritableClosureProjection {
  return closure({
    settlementId: null,
    settlementParties: null,
    calibrationId: "calibration-1",
    calibrationOwnerLogin: "grace",
    ...overrides,
  });
}

/**
 * The settlement corrections region is located by its heading id, never by the
 * heading's wording: a page may reword its copy without invalidating coverage.
 */
function settlementCorrectionsRegion(): HTMLElement {
  const section = screen.getAllByRole("region").find(
    (region) => region.getAttribute("aria-labelledby") === "settlement-corrections-heading",
  );
  expect(section, "the settlement corrections region renders").toBeDefined();
  return section!;
}

/**
 * One open correction request whose settled outcome is no longer materialized:
 * the settlement and calibration joins both come back empty, so the queue
 * renders the request without evidence rows. Only the fields
 * `listOpenRequests` maps are present, keyed as its query aliases them.
 */
function openCorrectionRow(): Record<string, unknown> {
  return {
    id: "request-1",
    reason: "The rationale comment landed fourteen hours late.",
    created_at: "2026-09-05T10:00:00.000Z",
    requester_login: "mira",
    repository_name: "co-op/harbour",
    issue_number: 17,
    issue_title: "Repair the tide gate",
    issue_url: "https://github.com/co-op/harbour/issues/17",
    settlement_id: null,
    settlement_status: null,
    opening_comparison_points: null,
    settled_label: null,
    settlement_settled_points: null,
    review_rounds: null,
    credits: null,
    pull_request_number: null,
    pull_request_title: null,
    pull_request_url: null,
    calibration_id: null,
    calibration_owner_login: null,
    calibration_opening_comparison_points: null,
    calibration_actual_points: null,
    calibration_pull_request_number: null,
    calibration_pull_request_title: null,
    calibration_pull_request_url: null,
  };
}

/**
 * What a reader of the settlement corrections region depends on: the heading,
 * an explanation paragraph beneath it, and the correction queue — or its load
 * error — beneath that, in that order, all visible. The wording is never
 * asserted: a substring-preserving negation in the copy must not be caught
 * here (issue 218 accepts that radius), but removing, emptying or reordering
 * these elements must fail.
 *
 * The order is pinned where the two slots' tag shapes differ: with entries the
 * queue renders a list, so the paragraph → list chain distinguishes the
 * explanation slot from the queue slot. The empty-queue and load-error
 * branches render a paragraph in both slots, so there they pin presence,
 * visibility and emptiness only.
 */
function expectExplanationAboveQueue(section: HTMLElement, queueTag: "P" | "OL"): void {
  const heading = within(section).getByRole("heading");
  expect(heading).toHaveAttribute("id", "settlement-corrections-heading");
  const explanation = heading.nextElementSibling as HTMLElement | null;
  expect(explanation?.tagName, "an explanation paragraph renders directly beneath the heading").toBe("P");
  expect(explanation!).toBeVisible();
  expect(explanation!).not.toBeEmptyDOMElement();
  const queue = explanation!.nextElementSibling as HTMLElement | null;
  expect(queue?.tagName, "the correction queue renders directly beneath the explanation").toBe(queueTag);
  expect(queue!).toBeVisible();
  expect(queue!).not.toBeEmptyDOMElement();
}

/**
 * A fallback alert communicates only what a reader can see: every element
 * inside it that carries text is visible, and the visible text carries at
 * least one non-format character once trimmed — whitespace-only text and
 * zero-width (`Cf`-only) text both fail, so the alert cannot read as blank
 * to a person while satisfying either shape of "nonblank" check.
 */
function expectReaderVisibleAlert(alert: HTMLElement): void {
  expect(alert).toBeVisible();
  for (const element of alert.querySelectorAll<HTMLElement>("*")) {
    if (hasNonblankText(element)) {
      expect(element, "a text-bearing element inside the alert renders visibly").toBeVisible();
    }
  }
  expect(visibleText(alert).trim(), "the alert's visible text carries a non-format character").toMatch(/\P{Cf}/u);
}

function hasNonblankText(element: Element): boolean {
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
  );
}

/**
 * The text a reader sees: every text node whose element chain is visible.
 * Descends only into elements jest-dom's own predicate would call visible
 * (display, visibility, opacity, `hidden`, `aria-hidden`, each level checked
 * on the way down), so what this returns is exactly the visible text.
 */
function visibleText(element: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE && isShown(node as HTMLElement)) {
      text += visibleText(node as HTMLElement);
    }
  }
  return text;
}

function isShown(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return !(element.hidden || element.getAttribute("aria-hidden") === "true");
}

describe("unwritable closure queue", () => {
  it("explains when no closures are waiting on evidence", () => {
    render(<UnwritableClosureQueue closures={[]} />);

    expect(screen.getByText("No closures are waiting on evidence.")).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it.each(["OPEN", "DECLINED"] as const)("shows rejected evidence with its settlement path and %s correction", (state) => {
    const correction = { state, requestedAt: "2026-09-05T12:00:00.000Z" };
    render(<UnwritableClosureQueue closures={[closure({
      latestCorrection: correction,
    })]} />);

    const entry = within(screen.getByRole("listitem"));
    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(entry.getByText("co-op/harbour").tagName).toBe("STRONG");
    expect(entry.getByText(/recorded 2026-09-05T10:00:00.000Z/)).toBeVisible();
    expect(entry.getByRole("link", { name: "#" + "17 Repair the tide gate" })).toHaveAttribute("href", "https://github.com/co-op/harbour/issues/17");
    expect(entry.getByRole("link", { name: "#" + "18 Repair the gate" })).toHaveAttribute("href", "https://github.com/co-op/harbour/pull/18");
    expect(entry.getByText("The settled label was applied after the evidence window.")).toHaveClass("override-reason");
    expect(screen.getByRole("listitem").querySelector('a[href="/settlements/settlement-1"]')).toHaveAttribute("href", "/settlements/settlement-1");
    const item = screen.getByRole("listitem");
    const status = item.querySelector("data");
    const time = item.querySelector("time");
    expect(status).toBeVisible();
    expect(status).toHaveAttribute("value", correction.state);
    expect(status?.textContent).toBe(correction.state.toLowerCase());
    expect(time).toBeVisible();
    expect(time).toHaveAttribute("dateTime", correction.requestedAt);
    expect(time?.textContent).toBe(correction.requestedAt);
  });

  it("offers the settlement correction path when no correction has been requested", () => {
    const { container } = render(<UnwritableClosureQueue closures={[closure()]} />);

    const entry = screen.getByRole("listitem");
    const list = screen.getByRole("list");
    const repository = within(entry).getByText("co-op/harbour");
    const issue = within(entry).getByRole("link", { name: "#" + "17 Repair the tide gate" });
    const pullRequest = within(entry).getByRole("link", { name: "#" + "18 Repair the gate" });
    const reason = entry.querySelector("p.override-reason");
    const correctionPath = entry.querySelector('a[href="/settlements/settlement-1"]');
    const parties = entry.querySelector("p.mono-meta");
    expect(list.tagName).toBe("OL");
    expect(repository).toBeVisible();
    expect(issue).toHaveAttribute("href", "https://github.com/co-op/harbour/issues/17");
    expect(pullRequest).toHaveAttribute("href", "https://github.com/co-op/harbour/pull/18");
    expect(reason).toBeVisible();
    expect(correctionPath).toBeVisible();
    expect(correctionPath).toHaveAttribute("href", "/settlements/settlement-1");
    expect(parties).toBeVisible();
    expect(Array.from(parties!.querySelectorAll("code"), (code) => code.textContent)).toEqual(["mira", "quinn"]);
    expect(entry.querySelector("data")).toBeNull();
    expect(entry.querySelector("time")).toBeNull();
    // Whatever markup a correction is written with, the entry renders exactly
    // these six paragraphs: an added correction line fails here regardless of
    // its markup, and a correction rendered anywhere outside the entry fails
    // one of the containment levels beneath it.
    expect(Array.from(entry.children)).toEqual([
      repository.closest("p"),
      issue.closest("p"),
      pullRequest.closest("p"),
      reason,
      correctionPath!.closest("p"),
      parties,
    ]);
    expect(Array.from(list.children)).toEqual([entry]);
    expect(Array.from(container.children)).toEqual([list]);
    expect(Array.from(document.body.children)).toEqual([container]);
  });

  it.each([
    { creditorLogin: "mira", sentence: "Only a party can request a correction: mira or quinn.", logins: ["mira", "quinn"] },
    { creditorLogin: null, sentence: "Only a party can request a correction: quinn.", logins: ["quinn"] },
  ])("names the correction parties when the creditor is $creditorLogin", ({ creditorLogin, sentence, logins }) => {
    render(<UnwritableClosureQueue closures={[closure({
      settlementParties: { creditorLogin, debtorLogin: "quinn" },
    })]} />);

    const explanation = screen.getByText(/Only a party can request a correction:/);
    expect(explanation).toHaveTextContent(sentence);
    expect(explanation).toHaveClass("mono-meta");
    expect(explanation.tagName).toBe("P");
    expect(Array.from(explanation.querySelectorAll("code"), (code) => code.textContent)).toEqual(logins);
    const link = screen.getByRole("link", { name: "Open the settlement to request a correction" });
    expect(link.parentElement?.nextElementSibling).toBe(explanation);
  });

  it.each([
    { creditorLogin: "mira", logins: ["mira", "quinn"] },
    { creditorLogin: null, logins: ["quinn"] },
  ])("withholds the settlement link from a non-party with creditor $creditorLogin", ({ creditorLogin, logins }) => {
    render(<UnwritableClosureQueue closures={[closure({
      viewerCanRequestCorrection: false,
      settlementParties: { creditorLogin, debtorLogin: "quinn" },
    })]} />);

    const entry = screen.getByRole("listitem");
    expect(entry.querySelector('a[href^="/settlements/"]')).toBeNull();
    const guidance = entry.querySelector("p.mono-meta");
    expect(guidance).toBeVisible();
    expect(Array.from(guidance!.querySelectorAll("code"), (code) => code.textContent)).toEqual(logins);
  });

  it("keeps both kinds visible without a settlement and explains why no correction is offered", () => {
    render(<UnwritableClosureQueue closures={[
      closure({ settlementId: null, settlementParties: null }),
      closure({
        id: "closure-2",
        kind: "NO_CLOSING_PULL_REQUEST",
        reason: "No merged GitHub GraphQL closing pull request was found.",
        pullRequest: null,
        settlementId: null,
        settlementParties: null,
      }),
    ]} />);

    const entries = screen.getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(within(entry).getByText("No settlement is materialized for this closure, so there is nothing to correct.")).toHaveClass("mono-meta");
      expect(within(entry).queryByRole("link", { name: "Open the settlement to request a correction" })).toBeNull();
      expect(within(entry).queryByText(/Only a party can request a correction:/)).toBeNull();
    }
    expect(within(entries[0]).getByRole("link", { name: /Repair the gate/ })).toBeVisible();
    expect(within(entries[1]).getAllByRole("link")).toHaveLength(1);
    expect(within(entries[1]).getByText("No merged GitHub GraphQL closing pull request was found.")).toHaveClass("override-reason");
  });
});

describe("self-worked closure in the queue", () => {
  it("links the calibration and names the sponsor as the only account that can correct it", () => {
    render(<UnwritableClosureQueue closures={[selfWorked()]} />);

    const entry = within(screen.getByRole("listitem"));
    expect(screen.getByRole("listitem").querySelector('a[href="/calibration/calibration-1"]')).toHaveAttribute(
      "href",
      "/calibration/calibration-1",
    );
    const explanation = entry.getByText(/Only the sponsor can request a correction:/);
    expect(explanation).toHaveTextContent("Only the sponsor can request a correction: grace.");
    expect(Array.from(explanation.querySelectorAll("code"), (code) => code.textContent)).toEqual(["grace"]);
    expect(entry.queryByText(/No settlement is materialized for this closure/)).toBeNull();
    expect(entry.queryByRole("link", { name: "Open the settlement to request a correction" })).toBeNull();
  });

  it("withholds the calibration link from a non-sponsor and names the sponsor", () => {
    render(<UnwritableClosureQueue closures={[selfWorked({ viewerCanRequestCorrection: false })]} />);

    const entry = screen.getByRole("listitem");
    expect(entry.querySelector('a[href^="/calibration/"]')).toBeNull();
    const guidance = entry.querySelector("p.mono-meta");
    expect(guidance).toBeVisible();
    expect(Array.from(guidance!.querySelectorAll("code"), (code) => code.textContent)).toEqual(["grace"]);
  });

  it("shows the latest correction against a self-worked closure", () => {
    const correction = { state: "DECLINED", requestedAt: "2026-09-05T12:00:00.000Z" } as const;
    render(<UnwritableClosureQueue closures={[selfWorked({
      latestCorrection: correction,
    })]} />);

    const item = screen.getByRole("listitem");
    const status = item.querySelector("data");
    const time = item.querySelector("time");
    expect(status).toBeVisible();
    expect(status).toHaveAttribute("value", correction.state);
    expect(status?.textContent).toBe(correction.state.toLowerCase());
    expect(time).toBeVisible();
    expect(time).toHaveAttribute("dateTime", correction.requestedAt);
    expect(time?.textContent).toBe(correction.requestedAt);
  });
});

describe("moderation closure section", () => {
  it.each([
    { kind: "eligible", viewerId: "00000000-0000-4000-8000-000000000001", eligible: true },
    { kind: "unrelated", viewerId: "00000000-0000-4000-8000-000000000002", eligible: false },
  ])("loads correction access for the authenticated $kind viewer", async ({ viewerId, eligible }) => {
    memberSession.mockResolvedValueOnce({
      user: { id: viewerId, role: "MODERATOR", name: "Moderator" },
    });
    const closureBindings: unknown[][] = [];
    sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join("?").includes("from unwritable_closures")) return [];
      closureBindings.push(values);
      return [{
        id: "closure-1",
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        reason: "The settled label was applied after the evidence window.",
        recorded_at: "2026-09-05T10:00:00.000Z",
        repository_name: "co-op/harbour",
        issue_number: 17,
        issue_title: "Repair the tide gate",
        issue_url: "https://github.com/co-op/harbour/issues/17",
        pull_request_number: null,
        pull_request_title: null,
        pull_request_url: null,
        settlement_id: "settlement-1",
        creditor_login: "mira",
        debtor_login: "quinn",
        calibration_id: null,
        calibration_owner_login: null,
        viewer_can_request_correction:
          values[0] === "00000000-0000-4000-8000-000000000001"
          || values[1] === "00000000-0000-4000-8000-000000000003",
        correction_state: null,
        correction_requested_at: null,
      }];
    });

    render(await ModerationPage());

    expect.soft(closureBindings).toEqual([[viewerId, viewerId, viewerId]]);
    const queue = screen.getAllByRole("region").find(
      (region) => region.getAttribute("aria-labelledby") === "unwritable-closures-heading",
    )!;
    const entry = within(queue).getByRole("listitem");
    const correctionLink = entry.querySelector('a[href="/settlements/settlement-1"]');
    if (eligible) {
      expect(correctionLink).toBeVisible();
    } else {
      expect(correctionLink).toBeNull();
      const guidance = entry.querySelector("p.mono-meta");
      expect(guidance).toBeVisible();
      expect(Array.from(guidance!.querySelectorAll("code"), (code) => code.textContent)).toEqual(["mira", "quinn"]);
    }
  });

  it("renders live entries in the queue and grants in a history landmark immediately before enforcement history", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (!strings.join("?").includes("from unwritable_closures")) return [];
      return [null, "GRANTED", "OPEN", "DECLINED"].map((state, index) => ({
        id: `closure-${index}`,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        reason: "The settled label was applied after the evidence window.",
        recorded_at: "2026-09-05T10:00:00.000Z",
        repository_name: "co-op/harbour",
        issue_number: 17 + index,
        issue_title: `Issue ${17 + index}`,
        issue_url: `https://github.com/co-op/harbour/issues/${17 + index}`,
        pull_request_number: null,
        pull_request_title: null,
        pull_request_url: null,
        settlement_id: `settlement-${index}`,
        creditor_login: "mira",
        debtor_login: "quinn",
        calibration_id: null,
        calibration_owner_login: null,
        viewer_can_request_correction: true,
        correction_state: state,
        correction_requested_at: state === null ? null : "2026-09-05T12:00:00.000Z",
      }));
    });

    render(await ModerationPage());

    const regions = screen.getAllByRole("region");
    const queue = regions.find((region) => region.getAttribute("aria-labelledby") === "unwritable-closures-heading")!;
    const history = regions.find((region) => region.getAttribute("aria-labelledby") === "unwritable-closure-history-heading")!;
    expect(queue).toBeVisible();
    expect(history).toBeVisible();
    expect(history).toHaveClass("surface");
    expect(within(history).getByRole("heading", { level: 2 })).toHaveAttribute("id", "unwritable-closure-history-heading");
    expect(queue.previousElementSibling).toHaveAttribute("aria-labelledby", "settlement-corrections-heading");
    expect(queue.nextElementSibling).toHaveAttribute("aria-labelledby", "recalibrating-heading");
    expect(history.nextElementSibling).toHaveAttribute("aria-labelledby", "enforcement-history-heading");
    expect(within(queue).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/co-op/harbour/issues/17", "/settlements/settlement-0",
      "https://github.com/co-op/harbour/issues/19", "/settlements/settlement-2",
      "https://github.com/co-op/harbour/issues/20", "/settlements/settlement-3",
    ]);
    expect(within(history).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/co-op/harbour/issues/18",
    ]);
  });

  it("loads the closure queue between settlement corrections and recalibration", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (!strings.join("?").includes("from unwritable_closures")) return [];
      return [{
        id: "closure-1",
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        reason: "The settled label was applied after the evidence window.",
        recorded_at: "2026-09-05T10:00:00.000Z",
        repository_name: "co-op/harbour",
        issue_number: 17,
        issue_title: "Repair the tide gate",
        issue_url: "https://github.com/co-op/harbour/issues/17",
        pull_request_number: 18,
        pull_request_title: "Repair the gate",
        pull_request_url: "https://github.com/co-op/harbour/pull/18",
        settlement_id: "settlement-1",
        creditor_login: "mira",
        debtor_login: "quinn",
        calibration_id: null,
        calibration_owner_login: null,
        viewer_can_request_correction: true,
        correction_state: null,
        correction_requested_at: null,
      }];
    });

    render(await ModerationPage());

    const section = screen.getByRole("region", { name: "Rejected settlement evidence" });
    expect(section).toHaveClass("surface", "override-card");
    expect(within(section).getByText("Closures that settled nothing")).toBeVisible();
    expect(within(section).getByRole("heading")).toHaveAttribute("id", "unwritable-closures-heading");
    expect(within(section).getByText("The settled label was applied after the evidence window.")).toBeVisible();
    expect(within(section).getByRole("link", { name: "Open the settlement to request a correction" })).toHaveAttribute("href", "/settlements/settlement-1");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(headings.indexOf("Settlement corrections"), headings.indexOf("Settlement corrections") + 3)).toEqual([
      "Settlement corrections", "Rejected settlement evidence", "Recalibration plans and reactivation",
    ]);
  });

  it("renders the settlement corrections explanation between the heading and the correction queue", async () => {
    // When the queue has an entry it renders a list, and the paragraph → list
    // chain is what pins the order and names the missing element: the other
    // two branches render a paragraph in both slots, where a queue rendered
    // before the explanation would be invisible.
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("from settlement_override_requests")) {
        return [openCorrectionRow()];
      }
      return [];
    });
    render(await ModerationPage());

    const listedSection = settlementCorrectionsRegion();
    expectExplanationAboveQueue(listedSection, "OL");
    expect(within(listedSection).getAllByRole("listitem")).toHaveLength(1);

    cleanup();
    sql.mockImplementation(async () => []);

    render(await ModerationPage());

    expectExplanationAboveQueue(settlementCorrectionsRegion(), "P");

    // The same structure holds when the queue itself could not be loaded: the
    // explanation still renders, with the load error beneath it.
    cleanup();
    sql.mockImplementation(async () => {
      throw new Error("Settlement correction queue unavailable");
    });
    render(await ModerationPage());

    expectExplanationAboveQueue(settlementCorrectionsRegion(), "P");
  });

  it("shows a closure load error without hiding the other moderation queues", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("from unwritable_closures")) throw new Error("Closure query unavailable");
      return [];
    });

    render(await ModerationPage());

    const queue = screen.getAllByRole("region").find(
      (region) => region.getAttribute("aria-labelledby") === "unwritable-closures-heading",
    )!;
    expectReaderVisibleAlert(within(queue).getByRole("alert"));
    expect(screen.getByText("No settlement corrections are waiting.")).toBeVisible();
    expect(screen.getByText("No account audits are open.")).toBeVisible();
    expect(screen.getByText("No accounts are recalibrating.")).toBeVisible();
    expect(screen.queryByText("No closures are waiting on evidence.")).toBeNull();
    const history = screen.getAllByRole("region").find(
      (region) => region.getAttribute("aria-labelledby") === "unwritable-closure-history-heading",
    )!;
    expect(history).toBeVisible();
    expect(within(history).getByRole("heading", { level: 2 })).toHaveAttribute("id", "unwritable-closure-history-heading");
    expectReaderVisibleAlert(within(history).getByRole("alert"));
    expect(within(history).queryByRole("list")).toBeNull();
  });
});
