/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import NewRepositoryPage from "@/app/repositories/new/page";

const mocks = vi.hoisted(() => ({
  getTokenSummary: vi.fn(),
  requireMemberPageSession: vi.fn(),
  signInForRepositoryRegistration: vi.fn(),
  redirect: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/tokens/postgres-store", () => ({
  PostgresApiTokenStore: class { getTokenSummary = mocks.getTokenSummary; },
}));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession: mocks.requireMemberPageSession,
  isModeratorSession: () => false,
}));
vi.mock("@/lib/auth/sign-in-actions", () => ({
  signInForRepositoryRegistration: mocks.signInForRepositoryRegistration,
}));

function memberSession(canAdministerWebhooks: boolean) {
  return { user: { id: "member-id", name: "Ada", role: "MEMBER", canAdministerWebhooks } };
}

beforeEach(() => {
  spyOnConsoleOutput();
  mocks.getTokenSummary.mockReset().mockResolvedValue(null);
  mocks.signInForRepositoryRegistration.mockReset();
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
  }
});

// Issue 599: a contributor who signed in with no scope reaches this page
// without webhook administration. The page says so and sends them through
// GitHub authorization again for the wider grant, in place of a form whose
// submission could only fail.
describe("repository registration page scope gate", () => {
  it("replaces the registration form with the explanation and the widening sign-in for a hookless session", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());

    expect(screen.queryByRole("form", { name: "Register one repository" })).not.toBeInTheDocument();
    const notice = screen.getByRole("region", { name: "Webhook administration required" });
    expect(notice).toHaveTextContent(/admin:repo_hook/);
    const authorize = screen.getByRole("button", { name: "Authorize webhook administration on GitHub" });
    expect(authorize.closest("form")).not.toBeNull();
    fireEvent.click(authorize);

    await waitFor(() => expect(mocks.signInForRepositoryRegistration).toHaveBeenCalledTimes(1));
  });

  it("keeps the catalog-change form and the token panel available to a hookless session", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());

    expect(screen.getByRole("form", { name: "Change a repository's difficulty catalog" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Overflow API token" })).toBeInTheDocument();
  });

  it("renders the registration form and no widening sign-in for a session that can administer webhooks", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(true));

    render(await NewRepositoryPage());

    expect(screen.getByRole("form", { name: "Register one repository" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Webhook administration required" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Authorize webhook administration on GitHub" })).not.toBeInTheDocument();
  });
});
