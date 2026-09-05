/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { ApiTokenPanel } from "@/components/api-token-panel";
import NewRepositoryPage from "@/app/repositories/new/page";

const { getTokenSummary, requireMemberPageSession } = vi.hoisted(() => ({
  getTokenSummary: vi.fn(),
  requireMemberPageSession: vi.fn(),
}));

vi.mock("@/lib/tokens/postgres-store", () => ({
  PostgresApiTokenStore: class { getTokenSummary = getTokenSummary; },
}));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession,
  isModeratorSession: () => false,
}));

const createdAt = "2026-09-05T10:30:00.123Z";
const token = `ovf_${"a".repeat(43)}`;
const replacementToken = `ovf_${"b".repeat(43)}`;

function mintedToken(value = token, date = createdAt) {
  return Response.json({ token: value, createdAt: date }, { status: 201 });
}

beforeEach(() => {
  spyOnConsoleOutput();
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("API token panel", () => {
  it("explains programmatic registration and offers generation for a null summary", () => {
    render(<ApiTokenPanel summary={null} />);

    expect(screen.getByRole("button", { name: "Generate token" })).toBeEnabled();
    expect(screen.getByText(/register repositories programmatically/i)).toBeVisible();
    expect(screen.getByText(/no API token/i)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the generation date and warns about immediate revocation before regeneration", () => {
    render(<ApiTokenPanel summary={{ createdAt }} />);

    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
    expect(screen.getByText("2026-09-05 10:30:00 UTC")).toHaveAttribute("dateTime", createdAt);
    expect(screen.getByText(/existing token stops working immediately/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Generate token" })).not.toBeInTheDocument();
  });

  it("posts with the member cookie and shows the selectable token with a shown-once warning without logging", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintedToken());
    vi.stubGlobal("fetch", fetchMock);
    render(<ApiTokenPanel summary={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByText(token)).toBeVisible();
    expect(screen.getByText(token)).toHaveStyle({ display: "block", userSelect: "all", overflowWrap: "anywhere" });
    expect(screen.getByRole("status")).toHaveTextContent(/will not be shown again/i);
    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
    expect(screen.getByText("2026-09-05 10:30:00 UTC")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/tokens", {
      method: "POST", credentials: "same-origin",
    });
  });

  it("keeps plaintext through a rerender but loses it on remount without writing browser storage", async () => {
    // Both storage objects use this prototype, so either setItem call is recorded.
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const originalUrl = location.href;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintedToken()));
    const { rerender, unmount } = render(<ApiTokenPanel summary={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByText(token)).toBeVisible();
    rerender(<ApiTokenPanel summary={{ createdAt }} />);
    expect(screen.getByText(token)).toBeVisible();
    unmount();
    render(<ApiTokenPanel summary={{ createdAt }} />);

    expect(screen.queryByText(token)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.href).toBe(originalUrl);
  });

  it("replaces the displayed token and generation date only after successful regeneration", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintedToken())
      .mockResolvedValueOnce(mintedToken(replacementToken, "2026-09-06T12:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByText(token)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    expect(await screen.findByText(replacementToken)).toBeVisible();
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    expect(screen.getByText("2026-09-06 12:00:00 UTC")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "UNAUTHENTICATED", "Sign in is required."],
    [502, "UPSTREAM_FAILURE", "Unable to issue an API token."],
  ])("reports a %s refusal without displaying a token", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: { code, message } }, { status }),
    ));
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate token" })).toBeEnabled();
  });

  it("leaves the displayed token and date alone after a failed regenerate, then allows retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintedToken())
      .mockResolvedValueOnce(Response.json({ error: {
        code: "UPSTREAM_FAILURE", message: "Unable to issue an API token.",
      } }, { status: 502 }))
      .mockResolvedValueOnce(mintedToken(replacementToken));
    vi.stubGlobal("fetch", fetchMock);
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    const displayedToken = await screen.findByText(token);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to issue an API token.");
    expect(screen.getAllByText(token)).toEqual([displayedToken]);
    expect(displayedToken).toBeVisible();
    expect(screen.getByText("2026-09-05 10:30:00 UTC")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));
    expect(await screen.findByText(replacementToken)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not redisplay a hidden token after a failed regenerate from a summary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to issue an API token.",
    } }, { status: 502 })));
    render(<ApiTokenPanel summary={{ createdAt }} />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to issue an API token.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/ovf_/)).not.toBeInTheDocument();
  });

  it("reports network failure without echoing exception details or losing the displayed token", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mintedToken())
      .mockRejectedValueOnce(new Error(`private network details ${token}`)));
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByText(token)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach Overflow/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(token);
    expect(screen.getByText(token)).toBeVisible();
    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
  });

  it.each([
    ["generation", null],
    ["regeneration", { createdAt }],
  ] as const)("allows only one in-flight request during %s", async (_name, summary) => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);
    render(<ApiTokenPanel summary={summary} />);
    const button = screen.getByRole("button", { name: summary ? "Regenerate token" : "Generate token" });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { resolveRequest(mintedToken()); });
    expect(await screen.findByText(token)).toBeVisible();
    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("repository registration page token panel", () => {
  it("has card padding from the shipped stylesheet", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync("src/app/globals.css", "utf8");
    document.head.append(stylesheet);
    try {
      render(<ApiTokenPanel summary={null} />);
      const panel = screen.getByRole("region", { name: "Overflow API token" });
      expect(Number.parseFloat(getComputedStyle(panel).paddingTop)).toBeGreaterThan(0);
      expect(Number.parseFloat(getComputedStyle(panel).paddingLeft)).toBeGreaterThan(0);
    } finally {
      stylesheet.remove();
    }
  });

  it.each([
    { memberId: "member-without-token", summary: null },
    { memberId: "member-with-token", summary: { createdAt: new Date(createdAt) } },
  ])("passes the member summary for $memberId to the panel below the form", async ({ memberId, summary }) => {
    requireMemberPageSession.mockReset().mockResolvedValue({
      user: { id: memberId, name: "Ada", role: "MEMBER" },
    });
    getTokenSummary.mockReset().mockResolvedValue(summary);
    render(await NewRepositoryPage());

    const panel = screen.getByRole("region", { name: "Overflow API token" });
    const form = screen.getByRole("form", { name: "Register one repository" });
    expect(form.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getTokenSummary).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(screen.getByRole("button", { name: summary ? "Regenerate token" : "Generate token" })).toBeEnabled();
    if (summary) {
      expect(screen.getByText("2026-09-05 10:30:00 UTC")).toHaveAttribute("dateTime", createdAt);
    }
  });
});
