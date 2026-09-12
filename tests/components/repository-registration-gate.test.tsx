/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** The linked GitLab identity the identities route answers with; never a token. */
const gitlabIdentity = {
  id: "gl-1",
  provider: "gitlab",
  instanceUrl: "https://gitlab.example",
  forgeLogin: "gl-user",
  verifiedAt: "2026-09-01T00:00:00.000Z",
};

const registrationForm = () => screen.getByRole("form", { name: "Register one repository" });
const authorizeButton = () => screen.queryByRole("button", { name: "Authorize webhook administration on GitHub" });
const scopeNotice = () => screen.queryByRole("region", { name: "Webhook administration required" });

beforeEach(() => {
  spyOnConsoleOutput();
  mocks.getTokenSummary.mockReset().mockResolvedValue(null);
  mocks.signInForRepositoryRegistration.mockReset();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/api/forge-identities")) {
      return Response.json({ identities: [gitlabIdentity] });
    }
    return Response.json({ labels: [] });
  }));
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

// Issue 599: a contributor who signed in with no scope reaches this page
// without GitHub webhook administration. Registering a GitHub repository
// needs it, so choosing GitHub shows why and sends them through GitHub
// authorization again for the wider grant. Registering a GitLab project
// does not — its hook is created with the linked identity's PAT — so the
// Forge choice and the GitLab path stay reachable regardless.
describe("repository registration page scope gate", () => {
  it("keeps the Forge choice for a hookless session and gates only the GitHub path", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());

    const forge = screen.getByRole("combobox", { name: "Forge" });
    expect(forge).toHaveValue("github");
    expect(registrationForm()).toContainElement(forge);
    // The GitHub path is gated: no repository field, no submit, the
    // explanation and the widening action instead.
    expect(within(registrationForm()).queryByRole("textbox", { name: "GitHub repository" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register repository" })).not.toBeInTheDocument();
    const notice = scopeNotice();
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent(/admin:repo_hook/);
    const authorize = authorizeButton();
    expect(authorize).not.toBeNull();
    const remedyForm = authorize!.closest("form");
    expect(remedyForm).not.toBeNull();
    // Its own form: the widening action never rides the registration submit.
    expect(remedyForm).not.toBe(registrationForm());
    fireEvent.click(authorize!);

    await waitFor(() => expect(mocks.signInForRepositoryRegistration).toHaveBeenCalledTimes(1));
  });

  it("lets a hookless session choose GitLab and reach the GitLab registration fields and submit", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());
    fireEvent.change(screen.getByRole("combobox", { name: "Forge" }), { target: { value: "gitlab" } });

    expect(screen.getByRole("combobox", { name: "Instance" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register repository" })).toBeEnabled();
    expect(scopeNotice()).toBeNull();
    expect(authorizeButton()).toBeNull();
    await waitFor(() => expect(screen.getByRole("option", { name: /gitlab\.example/ })).toBeInTheDocument());
  });

  it("re-gates the GitHub path when a hookless session switches back from GitLab", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());
    const forge = screen.getByRole("combobox", { name: "Forge" });
    fireEvent.change(forge, { target: { value: "gitlab" } });
    fireEvent.change(forge, { target: { value: "github" } });

    expect(scopeNotice()).not.toBeNull();
    expect(authorizeButton()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Register repository" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("keeps the catalog-change form and the token panel available to a hookless session", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(false));

    render(await NewRepositoryPage());

    expect(screen.getByRole("form", { name: "Change a repository's difficulty catalog" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Overflow API token" })).toBeInTheDocument();
  });

  it("renders the GitHub registration fields and no widening sign-in for a session that can administer webhooks", async () => {
    mocks.requireMemberPageSession.mockResolvedValue(memberSession(true));

    render(await NewRepositoryPage());

    expect(within(registrationForm()).getByRole("textbox", { name: "GitHub repository" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register repository" })).toBeEnabled();
    expect(scopeNotice()).toBeNull();
    expect(authorizeButton()).toBeNull();
  });
});
