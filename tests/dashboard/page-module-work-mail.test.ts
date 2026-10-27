/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/dashboard/page";
import { emptyDashboard } from "../support/empty-dashboard";
import type { SqlClient } from "@/lib/db/types";

/**
 * Drives the page's work-mail mount decision: the panel mounts when the
 * feature is configured, or when the signed-in account still has a stored
 * address (so the opt-out outlives switching the feature off). The real
 * config reader and the real store read run; only the session gate, the
 * ledger read and the SQL client are stubbed.
 */

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });

vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));

const { requireMemberPageSession, getDashboard, getSql } = vi.hoisted(() => ({
  requireMemberPageSession: vi.fn(),
  getDashboard: vi.fn(),
  getSql: vi.fn(),
}));

vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession,
  isModeratorSession: () => false,
}));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboard }));
vi.mock("@/lib/db/client", () => ({ getSql }));

const SUBSCRIPTIONS = "contributor_work_mail_subscriptions";
let subscriptionRows: object[];
let subscriptionReads: unknown[][];

// Answers the subscription read with the planted rows and every other read (the moderator standing) as an ordinary member.
const sqlStub = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  if (strings.join("").includes(SUBSCRIPTIONS)) {
    subscriptionReads.push(values);
    return Promise.resolve(subscriptionRows);
  }
  return Promise.resolve([{ is_live_moderator: false, other_live_moderators: 0 }]);
}) as unknown as SqlClient;

const storedRow = {
  id: "00000000-0000-4000-8000-000000000001", address: "kept@mail.example.org", confirmed_at: new Date(),
  confirm_expires_at: null, last_notified_at: null, created_at: new Date(), updated_at: new Date(),
};

function enableWorkMail() {
  vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_SMTP_URL", `smtps://sender:${["fixture", "secret"].join("-")}@smtp.mail.example.org`);
  vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_FROM", "work@mail.example.org");
  vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_DAILY_LIMIT", "40");
}

function workMailPanel(): Element | null {
  return document.querySelector('section[aria-labelledby="work-mail-heading"]');
}

beforeEach(() => {
  for (const name of ["SMTP_URL", "FROM", "DAILY_LIMIT"]) {
    vi.stubEnv(`OVERFLOW_CONTRIBUTOR_MAIL_${name}`, "");
    vi.stubEnv(`CONTRIBUTOR_MAIL_${name}`, "");
  }
  subscriptionRows = [];
  subscriptionReads = [];
  requireMemberPageSession.mockResolvedValue({
    user: { id: "internal-id", role: "MEMBER", name: "Ada Lovelace", canAdministerWebhooks: false },
  });
  getDashboard.mockResolvedValue(emptyDashboard());
  getSql.mockReturnValue(sqlStub);
  // A never-resolving fetch keeps the client panels' mount effects quiescent.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => vi.resetModules());

describe("the dashboard page's work-mail mount decision", () => {
  it("mounts no panel when the feature is off and the account stores no address", async () => {
    render(await DashboardPage());

    expect(document.querySelector("#account-controls-heading")).not.toBeNull();
    expect(workMailPanel()).toBeNull();
    expect(subscriptionReads).toEqual([["internal-id"]]);
  });

  it("mounts the panel when the feature is off but the account still stores an address", async () => {
    subscriptionRows = [storedRow];

    render(await DashboardPage());

    expect(workMailPanel()).not.toBeNull();
    expect(subscriptionReads).toEqual([["internal-id"]]);
  });

  it("mounts the panel when the feature is configured, with no address stored", async () => {
    enableWorkMail();

    render(await DashboardPage());

    expect(workMailPanel()).not.toBeNull();
  });

  it("mounts no panel when the configuration is partial", async () => {
    enableWorkMail();
    vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_DAILY_LIMIT", "");

    render(await DashboardPage());

    expect(workMailPanel()).toBeNull();
  });
});
