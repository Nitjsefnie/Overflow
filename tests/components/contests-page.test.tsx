/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { redirect, refresh } = vi.hoisted(() => ({ redirect: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh }) }));

import { SanctionContestsContent } from "@/app/contests/page";
import { SANCTION_CONTESTABLE_CASE, SANCTION_CONTEST_RULES } from "@/lib/disputes";
import type {
  FileableSanction,
  SanctionContestRequest,
} from "@/lib/moderation/sanction-contest-service";

const memberId = "00000000-0000-4000-8000-000000000001";

function openRequest(): SanctionContestRequest {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    accountId: memberId,
    sanctionEventId: "00000000-0000-4000-8000-000000000003",
    requestReason: "The cited review rounds were counted from the same reviewer twice.",
    state: "OPEN",
    decision: null,
    decidedBy: null,
    decidedBySoleModerator: false,
    decidedReason: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    decidedAt: null,
  };
}

function decidedRequest(): SanctionContestRequest {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    accountId: memberId,
    sanctionEventId: "00000000-0000-4000-8000-000000000003",
    requestReason: "The recalibration's cohort was not representative.",
    state: "DECIDED",
    decision: "DENIED",
    decidedBy: "00000000-0000-4000-8000-000000000002",
    decidedBySoleModerator: true,
    decidedReason: "The pattern was confirmed by independent review.",
    createdAt: "2026-09-01T10:00:00.000Z",
    decidedAt: "2026-09-02T10:00:00.000Z",
  };
}

function recalibrating(): FileableSanction {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    newState: "RECALIBRATING",
    reason: "The third confirmed account-level pattern requires recalibration.",
    occurredAt: "2026-09-01T09:00:00.000Z",
  };
}

function renderContent(
  sanctions: readonly FileableSanction[] | null,
  requests: readonly SanctionContestRequest[] | null,
) {
  return render(
    <SanctionContestsContent memberName="Ada" isModerator={false} sanctions={sanctions} requests={requests} />,
  );
}

describe("sanction contests page", () => {
  it("renders the rules the account files under, from the shared constant", () => {
    renderContent([recalibrating()], [openRequest()]);

    const rulesList = screen.getByRole("list", { name: "The sanction contest rules" });
    const items = within(rulesList).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([...SANCTION_CONTEST_RULES]);
  });

  it("interpolates the sanction case where the page names what it contests", () => {
    renderContent([recalibrating()], [openRequest()]);

    const marked = document.querySelectorAll("[data-sanction-contest]");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toBe(SANCTION_CONTESTABLE_CASE);
  });

  it("offers the filing form with the live sanction as a choice", () => {
    renderContent([recalibrating()], []);

    const form = screen.getByRole("region", { name: "Request a contest" });
    const select = within(form).getByLabelText("Which sanction?");
    expect(select).toHaveProperty("tagName", "SELECT");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(within(form).getByLabelText(/Why should this sanction be contested/)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Request the contest" })).toBeInTheDocument();
  });

  it("withholds the form while a request for that sanction is still open", () => {
    renderContent([recalibrating()], [openRequest()]);

    // One open request, covering the only live sanction: nothing to file again.
    expect(screen.queryByRole("button", { name: "Request the contest" })).not.toBeInTheDocument();
    const formRegion = screen.getByRole("region", { name: "Request a contest" });
    expect(within(formRegion).getByText(/still with a moderator/)).toBeInTheDocument();
  });

  it("withholds only the contested sanction and keeps the form for an uncontested one", () => {
    const secondSanction: FileableSanction = {
      id: "00000000-0000-4000-8000-000000000009",
      newState: "BANNED",
      reason: "The fifth confirmed account-level pattern requires a ban.",
      occurredAt: "2026-09-20T09:00:00.000Z",
    };
    renderContent([recalibrating(), secondSanction], [openRequest()]);

    // The open request covers the RECALIBRATING sanction only, so the form
    // survives with exactly the other sanction as its choice.
    const select = within(screen.getByRole("region", { name: "Request a contest" })).getByLabelText("Which sanction?");
    const options = within(select).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect((options[0] as HTMLOptionElement).value).toBe(secondSanction.id);
    expect(within(screen.getByRole("region", { name: "Request a contest" })).queryByText(/still with a moderator/)).not.toBeInTheDocument();
  });

  it("keeps the form available when the history could not be read", () => {
    renderContent([recalibrating()], null);

    expect(screen.getByRole("button", { name: "Request the contest" })).toBeInTheDocument();
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });

  it("explains that there is nothing to contest without a live sanction", () => {
    renderContent([], []);

    expect(screen.queryByRole("button", { name: "Request the contest" })).not.toBeInTheDocument();
    expect(screen.getByText(/no live sanction/)).toBeInTheDocument();
  });

  it("names the unreadable sanctions read instead of claiming there is no live sanction", () => {
    renderContent(null, []);

    // A failed read is not a clean bill of health: on the recourse page for
    // sanctioned accounts, the no-sanction sentence reads as a substantive
    // denial, so the failed state must name the load and never that claim.
    expect(screen.queryByText(/no live sanction/)).not.toBeInTheDocument();
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request the contest" })).not.toBeInTheDocument();
  });

  it("resyncs the form's selection when the fileable list changes under it", () => {
    const secondSanction: FileableSanction = {
      id: "00000000-0000-4000-8000-000000000009",
      newState: "BANNED",
      reason: "The fifth confirmed account-level pattern requires a ban.",
      occurredAt: "2026-09-20T09:00:00.000Z",
    };
    const view = renderContent([recalibrating()], []);
    const selectBefore = screen.getByLabelText("Which sanction?");
    expect((selectBefore as HTMLSelectElement).value).toBe(recalibrating().id);

    // The server owns the list: after a refresh the filed sanction can drop
    // out of the fileable set, and a stale selection would resubmit it blind.
    view.rerender(
      <SanctionContestsContent
        memberName="Ada"
        isModerator={false}
        sanctions={[secondSanction]}
        requests={[]}
      />,
    );
    const selectAfter = screen.getByLabelText("Which sanction?");
    expect((selectAfter as HTMLSelectElement).value).toBe(secondSanction.id);
  });

  it("lists the request history with each outcome", () => {
    renderContent([recalibrating()], [decidedRequest(), openRequest()]);

    const history = screen.getByRole("list", { name: "Your contest requests" });
    const items = within(history).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const decidedItem = items.find((item) => item.textContent?.includes("The recalibration's cohort was not representative."));
    expect(decidedItem).toBeDefined();
    expect(decidedItem!.textContent).toContain("DENIED");
    expect(decidedItem!.textContent).toContain("The pattern was confirmed by independent review.");
    expect(decidedItem!.textContent).toContain("the only live moderator");
    expect(decidedItem!.textContent).toContain("2026-09-02");

    const openItem = items.find((item) => item.textContent?.includes("still with a moderator"));
    expect(openItem).toBeDefined();
  });

  it("exposes named section landmarks for the page's regions", () => {
    renderContent([recalibrating()], [openRequest()]);

    for (const name of ["Request a contest", "The sanction contest rules", "Your contest requests"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });
});
