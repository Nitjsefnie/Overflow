/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { ApiTokenPanel } from "@/components/api-token-panel";
import NewRepositoryPage from "@/app/repositories/new/page";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const {
  getTokenSummary, requireMemberPageSession, redirect, refresh, signInForRepositoryRegistration, confirmSignInForApiToken,
} = vi.hoisted(() => ({
  getTokenSummary: vi.fn(),
  requireMemberPageSession: vi.fn(),
  redirect: vi.fn(),
  refresh: vi.fn(),
  signInForRepositoryRegistration: vi.fn(async () => {}),
  confirmSignInForApiToken: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh }) }));

vi.mock("@/lib/tokens/postgres-store", () => ({
  PostgresApiTokenStore: class { getTokenSummary = getTokenSummary; },
}));
vi.mock("@/lib/dashboard/session", () => ({
  requireMemberPageSession,
  isModeratorSession: () => false,
}));
vi.mock("@/lib/auth/sign-in-actions", () => ({ signInForRepositoryRegistration, confirmSignInForApiToken }));

const createdAt = "2026-09-05T10:30:00.123Z";
const expiresAt = "2026-12-04T10:30:00.123Z";
const confirmedAt = "2026-09-05T10:31:00.123Z";
const token = `ovf_${"a".repeat(43)}`;
const replacementToken = `ovf_${"b".repeat(43)}`;
// Every test reads the clock at this instant, so "expired" never depends on the day the suite runs.
const now = new Date("2026-09-10T00:00:00.000Z");

/**
 * The four token states, as the database reports them, with the dates the
 * store would really write. `confirmedAt` null is the whole distinction: an
 * unconfirmed token's expiry is its created-at plus the thirty-minute delivery
 * window, never the ninety-day lifetime, so neither unconfirmed fixture may
 * borrow the ninety-day `expiresAt` — a fixture claiming a never-used token
 * carried a ninety-day expiry would still satisfy a panel that derived "lapsed"
 * from the dates instead of from `confirmedAt`, and the suite would stay green
 * while the real lapsed state rendered wrong.
 *
 * `unconfirmed` and `lapsedSummary` are fifteen minutes either side of the
 * frozen clock, so each one's expiry is consistent with its verdict.
 */
const unconfirmed = {
  createdAt: "2026-09-09T23:45:00.000Z",
  expiresAt: "2026-09-10T00:15:00.000Z",
  confirmedAt: null,
  expired: false,
};
/** Never used, and the delivery window ran out: expired, but not at ninety days. */
const lapsedSummary = {
  createdAt: "2026-09-09T22:00:00.000Z",
  expiresAt: "2026-09-09T22:30:00.000Z",
  confirmedAt: null,
  expired: true,
};
const confirmed = { createdAt, expiresAt, confirmedAt, expired: false };
const expiredSummary = {
  createdAt: "2026-05-01T08:00:00.000Z",
  expiresAt: "2026-07-30T08:00:00.000Z",
  confirmedAt: "2026-05-01T08:05:00.000Z",
  expired: true,
};
const confirmedExpired = { ...confirmed, expired: true };

/** The node a confirmed token contributes and an unconfirmed one does not. */
const firstUseNode = () => document.getElementById("api-token-first-use-at");
const renderedTimes = () => document.querySelectorAll("time");

/**
 * The marker element each state contributes, or null when it contributes none.
 * Asserted by id and tone, never by wording: a copy change must not move these.
 */
const stateMarkers = ["api-token-unconfirmed", "api-token-window-lapsed", "api-token-expired"] as const;

function mintedToken(value = token, date = createdAt, expiry = expiresAt, confirmation: string | null = null) {
  return Response.json(
    { token: value, createdAt: date, expiresAt: expiry, confirmedAt: confirmation },
    { status: 201 },
  );
}

const reauthenticationRefusal = () => Response.json({ error: {
  code: "REAUTHENTICATION_REQUIRED", message: "Confirm your GitHub sign-in to issue an API token.",
} }, { status: 403 });

const reauthenticateForm = () => document.getElementById("api-token-reauthenticate");

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  spyOnConsoleOutput();
  vi.useFakeTimers({ toFake: ["Date"], now });
});

afterEach(() => {
  refresh.mockClear();
  vi.useRealTimers();
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("API token panel", () => {
  it("offers generation for a null summary", () => {
    render(<ApiTokenPanel summary={null} />);

    expect(screen.getByRole("button", { name: "Generate token" })).toBeEnabled();
    expect(screen.getByText(/no API token/i)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the generation date and warns about immediate revocation before regeneration", () => {
    render(<ApiTokenPanel summary={confirmed} />);

    expect(screen.getByRole("button", { name: "Regenerate token" })).toBeEnabled();
    expect(screen.getByText("2026-09-05 10:30 UTC")).toHaveAttribute("dateTime", createdAt);
    expect(screen.getByText(/existing token stops working immediately/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Generate token" })).not.toBeInTheDocument();
  });

  it("shows the expiry as a time element and no expired state for a live token", () => {
    render(<ApiTokenPanel summary={confirmed} />);

    expect(screen.getByText("2026-12-04 10:30 UTC")).toHaveAttribute("dateTime", expiresAt);
    expect(document.getElementById("api-token-expired")).toBeNull();
    expect(describedBy(screen.getByRole("button", { name: "Regenerate token" }))).toEqual(["api-token-revocation"]);
  });

  it("marks an expired token and ties the expired state to regeneration", () => {
    render(<ApiTokenPanel summary={expiredSummary} />);

    const expiry = screen.getByText("2026-07-30 08:00 UTC");
    expect(expiry).toHaveAttribute("dateTime", expiredSummary.expiresAt);
    const button = screen.getByRole("button", { name: "Regenerate token" });
    expect(button).toBeEnabled();
    expect(describedBy(button)).toContain("api-token-expired");
    expect(document.getElementById("api-token-expired")).toBeVisible();
  });

  // The expired state is the database's verdict, passed down by the page; the
  // panel reading its own clock could disagree with it, and between the
  // server render and hydration at the expiry instant.
  it("shows no expired state for a live verdict even when the browser clock is past the expiry", () => {
    render(<ApiTokenPanel summary={{ ...expiredSummary, expired: false }} />);

    expect(Date.now()).toBeGreaterThan(Date.parse(expiredSummary.expiresAt));
    expect(document.getElementById("api-token-expired")).toBeNull();
  });

  it("shows the expired state for an expired verdict even when the browser clock is before the expiry", () => {
    render(<ApiTokenPanel summary={confirmedExpired} />);

    expect(Date.now()).toBeLessThan(Date.parse(expiresAt));
    expect(document.getElementById("api-token-expired")).toBeVisible();
  });

  // Issue 847. An unconfirmed token that failed its 30-minute delivery window
  // reads `expired: true`, exactly like a confirmed one that reached ninety
  // days. Those are different facts — same remedy, different reason — so the
  // member must be able to tell them apart. Pinned by element id and tone, NOT
  // by wording: a faithful paraphrase of the copy must not turn this red, and
  // negating a sentence must not turn it green.
  it("gives every token state a marker the member can tell apart without reading the copy", () => {
    const cases = [
      { state: "never used, inside the delivery window", summary: unconfirmed, marker: "api-token-unconfirmed", tone: "pending" },
      { state: "never used, delivery window lapsed", summary: lapsedSummary, marker: "api-token-window-lapsed", tone: "error" },
      { state: "used, inside the ninety-day lifetime", summary: confirmed, marker: null, tone: null },
      { state: "used, lifetime reached", summary: expiredSummary, marker: "api-token-expired", tone: "error" },
    ] as const;

    const observed: Record<string, string> = {};
    for (const { state, summary, marker, tone } of cases) {
      const { unmount } = render(<ApiTokenPanel summary={summary} />);
      const button = screen.getByRole("button", { name: "Regenerate token" });

      // Exactly this state's marker, and no other state's, is present and linked.
      expect(describedBy(button).filter((id) => (stateMarkers as readonly string[]).includes(id))).toEqual(
        marker === null ? [] : [marker],
      );
      for (const other of stateMarkers) {
        expect(document.getElementById(other) === null).toBe(other !== marker);
      }
      if (marker !== null) {
        const node = document.getElementById(marker)!;
        expect(node).toBeVisible();
        expect(node.className.split(/\s+/)).toContain(tone);
      }
      // What the member can actually see: the state marker they are pointed at,
      // and whether the token shows a first-use instant at all. Two dead
      // states share a colour, so for that pair the first-use node is the whole
      // observable difference — a line that is there for one and missing for
      // the other, not a sentence that has to be read.
      observed[state] = `${describedBy(button).join(" ")} | first-used:${firstUseNode() !== null}`;
      unmount();
    }

    // Four states, four distinct observations: a member who never reads a word
    // still cannot confuse a lapsed window with a reached lifetime.
    expect(Object.values(observed)).toEqual([
      "api-token-unconfirmed api-token-revocation | first-used:false",
      "api-token-window-lapsed api-token-revocation | first-used:false",
      "api-token-revocation | first-used:true",
      "api-token-expired api-token-revocation | first-used:true",
    ]);
    expect(new Set(Object.values(observed)).size).toBe(cases.length);
  });

  it("renders an unconfirmed token's marker from the summary the server sent", () => {
    render(<ApiTokenPanel summary={unconfirmed} />);

    expect(document.getElementById("api-token-unconfirmed")).toBeVisible();
    expect(document.getElementById("api-token-window-lapsed")).toBeNull();
    expect(describedBy(screen.getByRole("button", { name: "Regenerate token" })))
      .toContain("api-token-unconfirmed");
  });

  it("separates a lapsed delivery window from a reached lifetime by marker and tone", () => {
    const lapsed = render(<ApiTokenPanel summary={lapsedSummary} />);
    const lapsedNode = document.getElementById("api-token-window-lapsed")!;
    const lapsedTone = lapsedNode.className;
    expect(lapsedNode).toBeVisible();
    expect(document.getElementById("api-token-expired")).toBeNull();
    lapsed.unmount();

    render(<ApiTokenPanel summary={expiredSummary} />);

    const expiredNode = document.getElementById("api-token-expired")!;
    expect(expiredNode).toBeVisible();
    expect(document.getElementById("api-token-window-lapsed")).toBeNull();
    // Both read as a dead credential, and both are marked "error"; the tone is
    // not the discriminator, the marker is. Both carry it, differently.
    expect(expiredNode.className).toBe(lapsedTone);
  });

  // The pair above is the one whose colour deliberately does not discriminate,
  // and a marker id is a DOM handle rather than something a member sees. So the
  // observable difference is a NODE: a token that has been confirmed shows when
  // it was first used, and a never-used one shows nothing there. A member can
  // see that line missing; no sentence has to be read for the distinction to
  // land, which is what makes the prose above it decoration rather than the
  // carrier.
  it("shows a first-use instant for a confirmed token and nothing at all for an unconfirmed one", () => {
    const insideWindow = render(<ApiTokenPanel summary={unconfirmed} />);
    expect(firstUseNode()).toBeNull();
    // Two timestamps on screen — generated and expiry — and nothing claiming use.
    expect(renderedTimes()).toHaveLength(2);
    insideWindow.unmount();

    const lapsed = render(<ApiTokenPanel summary={lapsedSummary} />);
    expect(firstUseNode()).toBeNull();
    lapsed.unmount();

    const live = render(<ApiTokenPanel summary={confirmed} />);
    const firstUse = firstUseNode();
    expect(firstUse).toBeVisible();
    expect(firstUse!.tagName).toBe("TIME");
    expect(firstUse).toHaveAttribute("dateTime", confirmedAt);
    expect(renderedTimes()).toHaveLength(3);
    live.unmount();

    render(<ApiTokenPanel summary={expiredSummary} />);
    expect(firstUseNode()).toHaveAttribute("dateTime", expiredSummary.confirmedAt);
  });

  it("reads the confirmation out of the mint response instead of assuming it", async () => {
    // A real mint is never confirmed. This body claims otherwise, so the panel
    // can only reach the unconfirmed state by reading `confirmedAt` off the
    // response rather than stamping a null onto it.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintedToken(token, createdAt, expiresAt, confirmedAt)));
    render(<ApiTokenPanel summary={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByText(token)).toBeVisible();
    expect(document.getElementById("api-token-unconfirmed")).toBeNull();
    expect(describedBy(screen.getByRole("button", { name: "Regenerate token" })))
      .not.toContain("api-token-unconfirmed");
  });

  it("shows a just-minted token as unconfirmed, pending its first use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintedToken()));
    render(<ApiTokenPanel summary={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByText(token)).toBeVisible();
    const marker = document.getElementById("api-token-unconfirmed");
    expect(marker).toBeVisible();
    expect(marker!.className.split(/\s+/)).toContain("pending");
    expect(describedBy(screen.getByRole("button", { name: "Regenerate token" }))).toContain("api-token-unconfirmed");
  });

  it("clears the expired state and shows the new expiry after regeneration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintedToken()));
    render(<ApiTokenPanel summary={expiredSummary} />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    expect(await screen.findByText(token)).toBeVisible();
    expect(screen.getByText("2026-12-04 10:30 UTC")).toHaveAttribute("dateTime", expiresAt);
    expect(document.getElementById("api-token-expired")).toBeNull();
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
    expect(screen.getByText("2026-09-05 10:30 UTC")).toBeVisible();
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
    rerender(<ApiTokenPanel summary={confirmed} />);
    expect(screen.getByText(token)).toBeVisible();
    unmount();
    render(<ApiTokenPanel summary={confirmed} />);

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
    expect(screen.getByText("2026-09-06 12:00 UTC")).toBeVisible();
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

  it("offers the supplied re-authentication action as its own form when minting needs a fresh sign-in", async () => {
    const reauthenticate = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reauthenticationRefusal()));
    render(<ApiTokenPanel summary={confirmed} reauthenticateAction={reauthenticate} />);
    expect(reauthenticateForm()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));

    const alert = await screen.findByRole("alert");
    const form = reauthenticateForm();
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect(screen.getByRole("region", { name: "Overflow API token" })).toContainElement(form);
    expect(form).not.toContainElement(alert);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const submit = within(form!).getByRole("button");
    expect(submit).toHaveAttribute("type", "submit");
    fireEvent.click(submit);
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledTimes(1));
  });

  it.each([
    [401, "UNAUTHENTICATED", "Sign in is required."],
    [403, "FORBIDDEN", "The request origin is not allowed."],
    [502, "UPSTREAM_FAILURE", "Unable to issue an API token."],
  ])("offers no re-authentication form for a %s %s refusal", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message } }, { status })));
    render(<ApiTokenPanel summary={null} reauthenticateAction={vi.fn(async () => {})} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    await screen.findByRole("alert");
    expect(reauthenticateForm()).toBeNull();
  });

  it("drops the re-authentication form once a later attempt mints", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reauthenticationRefusal())
      .mockResolvedValueOnce(mintedToken()));
    render(<ApiTokenPanel summary={null} reauthenticateAction={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    await screen.findByRole("alert");
    expect(reauthenticateForm()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByText(token)).toBeVisible();
    expect(reauthenticateForm()).toBeNull();
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
    expect(screen.getByText("2026-09-05 10:30 UTC")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));
    expect(await screen.findByText(replacementToken)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not redisplay a hidden token after a failed regenerate from a summary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to issue an API token.",
    } }, { status: 502 })));
    render(<ApiTokenPanel summary={confirmed} />);
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

  it("refreshes the server projection once after the token is minted and keeps the shown-once warning", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintedToken());
    vi.stubGlobal("fetch", fetchMock);
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/will not be shown again/i);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the server projection when minting is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: { code: "UPSTREAM_FAILURE", message: "Unable to issue an API token." } }, { status: 502 }),
    ));
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to issue an API token.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh the server projection when the request cannot reach Overflow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<ApiTokenPanel summary={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach Overflow/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["generation", null],
    ["regeneration", confirmed],
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

  // The confirmation requests no scope; the registration sign-in would widen the grant.
  it("wires the scope-free sign-in confirmation as the panel's re-authentication action", async () => {
    requireMemberPageSession.mockReset().mockResolvedValue({
      user: { id: "member-id", name: "Ada", role: "MEMBER", canAdministerWebhooks: true },
    });
    getTokenSummary.mockReset().mockResolvedValue(null);
    signInForRepositoryRegistration.mockClear();
    confirmSignInForApiToken.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/tokens" ? reauthenticationRefusal() : Response.json({ labels: [], identities: [] }),
    ));
    render(await NewRepositoryPage());
    const panel = screen.getByRole("region", { name: "Overflow API token" });

    fireEvent.click(within(panel).getByRole("button", { name: "Generate token" }));
    await within(panel).findByRole("alert");
    fireEvent.click(within(reauthenticateForm()!).getByRole("button"));

    await waitFor(() => expect(confirmSignInForApiToken).toHaveBeenCalledTimes(1));
    expect(signInForRepositoryRegistration).not.toHaveBeenCalled();
  });

  it.each([
    { memberId: "member-without-token", summary: null },
    { memberId: "member-with-token", summary: { createdAt: new Date(createdAt), expiresAt: new Date(expiresAt), confirmedAt: new Date(confirmedAt), expired: false } },
    { memberId: "member-with-expired-token", summary: { createdAt: new Date(createdAt), expiresAt: new Date(expiresAt), confirmedAt: new Date(confirmedAt), expired: true } },
  ])("passes the member summary for $memberId to the panel below the form", async ({ memberId, summary }) => {
    requireMemberPageSession.mockReset().mockResolvedValue({
      user: { id: memberId, name: "Ada", role: "MEMBER", canAdministerWebhooks: true },
    });
    getTokenSummary.mockReset().mockResolvedValue(summary);
    render(await NewRepositoryPage());

    const panel = screen.getByRole("region", { name: "Overflow API token" });
    const form = screen.getByRole("form", { name: "Register one repository" });
    expect(form.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getTokenSummary).toHaveBeenCalledExactlyOnceWith(memberId);
    expect(screen.getByRole("button", { name: summary ? "Regenerate token" : "Generate token" })).toBeEnabled();
    if (summary) {
      expect(screen.getByText("2026-09-05 10:30 UTC")).toHaveAttribute("dateTime", createdAt);
      expect(screen.getByText("2026-12-04 10:30 UTC")).toHaveAttribute("dateTime", expiresAt);
      // The store's verdict, not the page's or the browser's clock.
      expect(document.getElementById("api-token-expired") !== null).toBe(summary.expired);
    }
  });
});
