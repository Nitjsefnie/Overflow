/** @vitest-environment jsdom */

import { randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { buildDigestMessage } from "@/lib/accounts/work-mail-transport";

const mocks = vi.hoisted(() => ({
  signOutAction: vi.fn(),
  getSql: vi.fn(() => {
    throw new Error("the unsubscribe page must not reach the database");
  }),
}));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));
vi.mock("@/lib/db/client", () => ({ getSql: mocks.getSql }));

import WorkMailUnsubscribePage from "@/app/work-mail/unsubscribe/page";

// Rebind the page and shell to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const fetchMock = vi.fn();

/**
 * jsdom cannot change documents: `location.assign` or an `href` write leaves the URL as it was and only
 * reports "not-implemented" on the virtual console, so a navigation is observed there, not on `location`.
 */
function recordJsdomErrors(): string[] {
  const seen: string[] = [];
  const virtualConsole = (window as unknown as { jsdom: { virtualConsole: EventEmitter } }).jsdom.virtualConsole;
  const record = (error: Error) => seen.push(error.message);
  virtualConsole.on("jsdomError", record);
  onTestFinished(() => {
    virtualConsole.off("jsdomError", record);
  });
  return seen;
}

function mailedToken(): { path: string; token: string } {
  const token = `${randomUUID()}.${randomBytes(32).toString("base64url")}`;
  const line = buildDigestMessage({
    from: "work@mail.example.org", to: "reader@mail.example.org", origin: "https://overflow.example.org",
    count: 2, unsubscribeToken: token,
  }).content.split("\r\n").find((text) => text.startsWith("https://overflow.example.org/work-mail/"))!;
  const link = new URL(line);
  return { path: `${link.pathname}${link.search}${link.hash}`, token };
}

function liveRegion(): HTMLElement {
  const region = document.querySelector('#main-content [aria-live="polite"]');
  if (region === null) throw new Error("the page rendered no live region");
  return region as HTMLElement;
}

beforeEach(() => {
  spyOnConsoleOutput();
  fetchMock.mockReset().mockResolvedValue(Response.json({ received: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("work mail unsubscribe page", () => {
  it("is served at the path the digest links to", () => {
    const { path } = mailedToken();
    expect(existsSync(`src/app${new URL(path, "https://x.example").pathname}/page.tsx`)).toBe(true);
  });

  it("renders one button inside the public shell and sends nothing on load", async () => {
    const { path } = mailedToken();
    window.history.replaceState(null, "", path);
    await act(async () => {
      render(<WorkMailUnsubscribePage />);
    });

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeEnabled();
    expect(liveRegion()).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it("posts the mailed token once on the click and announces the result without navigating", async () => {
    const { path, token } = mailedToken();
    window.history.replaceState(null, "", path);
    const jsdomErrors = recordJsdomErrors();
    let answer!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { answer = resolve; }));
    render(<WorkMailUnsubscribePage />);

    const button = screen.getByRole("button", { name: "Unsubscribe" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await act(async () => {
      answer(Response.json({ received: true }));
    });

    await waitFor(() => expect(liveRegion().querySelector(".feedback.success")).not.toBeNull());
    expect(fetchMock.mock.calls).toEqual([[`/api/work-mail/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST" }]]);
    expect(button).toBeDisabled();
    expect(jsdomErrors).toEqual([]);
    expect(window.location.pathname).toBe("/work-mail/unsubscribe");
  });

  it.each([
    ["answers 502", () => Promise.resolve(Response.json({ error: { message: "x" } }, { status: 502 }))],
    ["rejects", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("announces a failure and lets the reader retry when the request %s", async (_case, answer) => {
    window.history.replaceState(null, "", mailedToken().path);
    fetchMock.mockImplementationOnce(answer);
    render(<WorkMailUnsubscribePage />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    });

    await waitFor(() => expect(liveRegion().querySelector(".feedback.error")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeEnabled();
  });

  it("offers no button when the link carries no token", async () => {
    window.history.replaceState(null, "", "/work-mail/unsubscribe");
    await act(async () => {
      render(<WorkMailUnsubscribePage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
