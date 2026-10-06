/** @vitest-environment jsdom */

import { render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/dashboard/page";
import { emptyDashboard } from "../support/empty-dashboard";
import type { SqlClient } from "@/lib/db/types";

/**
 * Drives the one prop computation no other test reaches: DashboardPage (the
 * default export) reads the signed-in account's moderator standing through the
 * deletion path's own helper and hands the two booleans to DashboardContent.
 * The redirect guard (tests/dashboard/page-module-redirect-guard.test.ts) is a
 * source scan, and DashboardContent renders are handed their props from the
 * outside, so without this a mutant hardwiring `false` into the page's
 * computation survives (review round, mutant E2).
 *
 * The mocks stop at the boundaries the page cannot answer for in a unit run —
 * the session gate and the ledger read — plus the SQL client seam, which the
 * standing read reaches with a one-row stub. findLiveModeratorStanding and
 * isLastLiveModeratorStanding run FOR REAL against that stub, so the page's
 * live-moderator predicate is driven, not assumed.
 */

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh }) }));

const { requireMemberPageSession, getDashboard, getSql } = vi.hoisted(() => ({
  requireMemberPageSession: vi.fn(),
  getDashboard: vi.fn(),
  getSql: vi.fn(),
}));

vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession,
  isModeratorSession: (session: { user: { role: string } }) => session.user.role === "MODERATOR",
}));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboard }));
vi.mock("@/lib/db/client", () => ({ getSql }));

/**
 * The row set the standing read resolves to; each case plants it before
 * rendering. The stub answers the read's tagged-template call with it, so the
 * REAL findLiveModeratorStanding and isLastLiveModeratorStanding decide what
 * the page hands down. An EMPTY planting is the missing-account case: the read
 * finds no row for the session's account id.
 */
let standingRows: { is_live_moderator: boolean; other_live_moderators: number }[];

// The stub ignores the tag's (strings, values) arguments: the read's row
// shape is fixed by the planting, and nothing else in the page flow reaches it.
const sqlStub = (() => Promise.resolve(standingRows)) as unknown as SqlClient;

async function renderDashboardPage(): Promise<void> {
  render(await DashboardPage());
}

function accountControls(): HTMLElement {
  const section = document.querySelector('section[aria-labelledby="account-controls-heading"]');
  if (section === null) throw new Error("the dashboard rendered no account-controls section");
  return section as HTMLElement;
}

beforeEach(() => {
  requireMemberPageSession.mockResolvedValue({
    user: { id: "internal-id", role: "MEMBER", name: "Ada Lovelace", canAdministerWebhooks: false },
  });
  getDashboard.mockResolvedValue(emptyDashboard());
  getSql.mockReturnValue(sqlStub);
  // A never-resolving fetch keeps the mount effects (the forge identities
  // panel) quiescent for the rest of each case.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.MODERATOR_GITHUB_USER_IDS;
});

afterAll(() => vi.resetModules());

describe("the dashboard page drives the account controls' moderator-standing props", () => {
  it("warns when the signed-in account is the instance's last live moderator and a floor is configured", async () => {
    standingRows = [{ is_live_moderator: true, other_live_moderators: 0 }];
    process.env.MODERATOR_GITHUB_USER_IDS = "583231";

    await renderDashboardPage();

    const warning = within(accountControls()).getByRole("status");
    expect(warning).toBeVisible();
    expect(warning.textContent).toContain("no in-product moderator");
    expect(warning.textContent).toContain("MODERATOR_GITHUB_USER_IDS");
    // The floor is configured, so the absence sentence stays off.
    expect(warning.textContent).not.toContain("No GitHub user id is configured");
    expect(getSql).toHaveBeenCalledTimes(1);
  });

  it("names the absent floor when the last live moderator has none configured", async () => {
    standingRows = [{ is_live_moderator: true, other_live_moderators: 0 }];

    await renderDashboardPage();

    const warning = within(accountControls()).getByRole("status");
    expect(warning.textContent).toContain("No GitHub user id is configured in MODERATOR_GITHUB_USER_IDS right now.");
  });

  it("warns through the real predicate: a second live moderator keeps the warning down", async () => {
    standingRows = [{ is_live_moderator: true, other_live_moderators: 1 }];
    process.env.MODERATOR_GITHUB_USER_IDS = "583231";

    await renderDashboardPage();

    expect(within(accountControls()).queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders no warning for an ordinary member", async () => {
    standingRows = [{ is_live_moderator: false, other_live_moderators: 0 }];

    await renderDashboardPage();

    expect(within(accountControls()).queryByRole("status")).not.toBeInTheDocument();
  });

  it("degrades a session naming a missing account row to the ordinary-member props and still renders", async () => {
    // The read finds no row for the session's account id: the stub answers
    // empty, so findLiveModeratorStanding's own guard decides. The page must
    // render the dashboard with the not-last-moderator props — never the
    // ledger-unavailable error state the read's throw would produce.
    standingRows = [];
    requireMemberPageSession.mockResolvedValue({
      user: { id: "missing-account-row", role: "MEMBER", name: "Ghost", canAdministerWebhooks: false },
    });

    await renderDashboardPage();

    // The page rendered: the account-controls section exists.
    expect(getSql).toHaveBeenCalledTimes(1);
    expect(within(accountControls()).getByRole("button", { name: "Delete account" })).toBeVisible();
    expect(within(accountControls()).queryByRole("status")).not.toBeInTheDocument();
  });
});
