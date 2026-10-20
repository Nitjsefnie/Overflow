/** @vitest-environment jsdom */

import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage, { DashboardContent } from "@/app/dashboard/page";
import { emptyDashboard } from "../support/empty-dashboard";
import type { RegisteredRepositoryProjection } from "@/lib/dashboard/queries";
import type { SqlClient } from "@/lib/db/types";

vi.hoisted(() => { vi.resetModules(); });
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
const { getDashboard } = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboard }));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession: async () => ({ user: { id: "sponsor", name: "Sponsor", role: "MEMBER" } }),
  isModeratorSession: () => false,
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => sqlStub }));

const installUrl = "https://github.com/apps/overflow-reconcile/installations/new";
const listed: RegisteredRepositoryProjection = {
  id: "offered", ownerName: "co-op/harbour", visibility: "PUBLIC", active: true,
  openingName: "opening", actualName: "actual", unavailableReason: null,
  reconciliationState: "IDLE", reconciliationLastFailureAt: null,
};
const dashboard = () => ({
  ...emptyDashboard(), registeredRepositories: [listed, { ...listed, id: "other", ownerName: "co-op/other" }],
});
let failOfferRead = false;
const sqlStub = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  if (strings.join("").includes("registered_repositories")) {
    if (failOfferRead) throw new Error("offer read failed");
    return Promise.resolve(values.includes("sponsor") ? [{ id: "offered" }] : []);
  }
  return Promise.resolve([{ is_live_moderator: false, other_live_moderators: 1 }]);
}) as unknown as SqlClient;

beforeEach(() => {
  failOfferRead = false;
  getDashboard.mockResolvedValue(dashboard());
  vi.stubEnv("GITHUB_APP_SLUG", "overflow-reconcile");
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => vi.resetModules());

function installationLinks() {
  return document.querySelectorAll(`a[href="${installUrl}"]`);
}

describe("dashboard installation offer rendering", () => {
  // Omitting the offer or its repository guard changes the exact link count and row placement.
  it("adds one offer row before the unregister row only for the offered repository", () => {
    render(createElement(DashboardContent, {
      memberName: "Sponsor", isModerator: false, dashboard: dashboard(),
      appInstallUrl: installUrl, appInstallOfferRepositoryIds: new Set(["offered"]),
    }));
    expect(installationLinks()).toHaveLength(1);
    const row = installationLinks()[0].closest("dd")!.parentElement!;
    expect(row.querySelector("dt")).not.toBeNull();
    expect(row.nextElementSibling?.querySelector("button")).not.toBeNull();
    const lists = document.querySelectorAll('#registered-repositories-heading + ul dl');
    expect(lists[0].querySelectorAll(":scope > div")).toHaveLength(6);
    expect(lists[1].querySelectorAll(":scope > div")).toHaveLength(5);
  });

  // Either missing guard exposes an offer without both configuration and eligibility.
  it.each([
    { url: null, ids: new Set(["offered"]) },
    { url: installUrl, ids: new Set<string>() },
  ])("renders no offer with $url and $ids", ({ url, ids }) => {
    render(createElement(DashboardContent, {
      memberName: "Sponsor", isModerator: false, dashboard: dashboard(),
      appInstallUrl: url, appInstallOfferRepositoryIds: ids,
    }));
    expect(installationLinks()).toHaveLength(0);
    for (const list of document.querySelectorAll('#registered-repositories-heading + ul dl')) {
      expect(list.querySelectorAll(":scope > div")).toHaveLength(5);
    }
  });
});

describe("dashboard page installation offer wiring", () => {
  it("reads the configured URL and the signed-in sponsor's offers", async () => {
    render(await DashboardPage());
    expect(installationLinks()).toHaveLength(1);
  });

  it.each([undefined, "", "invalid/slug"])("skips the offer read when the slug is %s", async (slug) => {
    vi.stubEnv("GITHUB_APP_SLUG", slug);
    failOfferRead = true;
    render(await DashboardPage());
    expect(document.querySelector("#registered-repositories-heading")).not.toBeNull();
    expect(installationLinks()).toHaveLength(0);
  });

  it("uses the page error path when a configured offer read fails", async () => {
    failOfferRead = true;
    render(await DashboardPage());
    expect(document.querySelector("#dashboard-error-title")).not.toBeNull();
    expect(document.querySelector("#registered-repositories-heading")).toBeNull();
  });
});
