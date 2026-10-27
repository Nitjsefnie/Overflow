/** @vitest-environment jsdom */

import { randomBytes } from "node:crypto";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { WorkMailPanel } from "@/components/work-mail-panel";
import { buildConfirmationMessage } from "@/lib/accounts/work-mail-transport";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

type Subscription = { address: string; confirmed: boolean } | null;

const fetchMock = vi.fn();
/** The URL hash at the moment each request was made, in request order. */
let hashAtRequest: string[];

function state(enabled: boolean, subscription: Subscription) {
  return Response.json({ enabled, subscription: subscription === null ? null : {
    ...subscription, confirmedAt: null, lastNotifiedAt: null, confirmExpiresAt: null,
  } });
}

function requests(): [string, string][] {
  return fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit | undefined)?.method ?? "GET"]);
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Work mail" });
}

async function stateNode(): Promise<HTMLElement> {
  return within(panel()).findByTestId("work-mail-state");
}

beforeEach(() => {
  spyOnConsoleOutput();
  hashAtRequest = [];
  window.history.replaceState(null, "", "/dashboard");
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(state(true, null)));
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    hashAtRequest.push(window.location.hash);
    return fetchMock(...args);
  });
});

afterEach(() => {
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("work mail panel", () => {
  it.each([
    ["none", null, null],
    ["pending", { address: "pending-shape@mail.example.org", confirmed: false }, "pending-shape@mail.example.org"],
    ["confirmed", { address: "confirmed-shape@mail.example.org", confirmed: true }, "confirmed-shape@mail.example.org"],
  ] as const)("shows the %s state and the stored address", async (expected, subscription, address) => {
    fetchMock.mockImplementation(() => Promise.resolve(state(true, subscription)));
    render(<WorkMailPanel />);

    const node = await stateNode();
    expect(node).toHaveAttribute("data-work-mail-state", expected);
    if (address === null) {
      expect(within(panel()).queryByTestId("work-mail-address")).not.toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: "Remove address" })).not.toBeInTheDocument();
    } else {
      expect(within(panel()).getByTestId("work-mail-address").textContent).toBe(address);
      expect(within(panel()).getByRole("button", { name: "Remove address" })).toBeEnabled();
    }
    expect(fetchMock.mock.calls).toEqual([["/api/account/work-mail", { credentials: "same-origin" }]]);
  });

  it("labels its address field and offers the request form only while the feature is enabled", async () => {
    render(<WorkMailPanel />);
    await stateNode();
    const field = within(panel()).getByLabelText("Email address");
    expect(field).toHaveAttribute("type", "email");
    expect(field).toBeRequired();
    expect(panel()).toHaveAttribute("aria-labelledby", "work-mail-heading");
  });

  it("keeps the remove control but no request form once the feature is switched off", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(state(false, { address: "kept@mail.example.org", confirmed: true })));
    render(<WorkMailPanel />);

    expect(await stateNode()).toHaveAttribute("data-work-mail-state", "confirmed");
    expect(within(panel()).queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Remove address" })).toBeEnabled();
  });

  it("posts the typed address, announces the request and reloads the state", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(state(true, null)))
      .mockImplementationOnce(() => Promise.resolve(Response.json({ requested: true }, { status: 202 })))
      .mockImplementationOnce(() =>
        Promise.resolve(state(true, { address: "typed@mail.example.org", confirmed: false })));
    render(<WorkMailPanel />);
    await stateNode();

    fireEvent.change(within(panel()).getByLabelText("Email address"), { target: { value: "typed@mail.example.org" } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Send confirmation link" }));
    });

    expect(within(panel()).getByRole("status")).toBeVisible();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
    expect(await stateNode()).toHaveAttribute("data-work-mail-state", "pending");
    expect(fetchMock.mock.calls[1]).toEqual(["/api/account/work-mail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ address: "typed@mail.example.org" }),
    }]);
    expect(requests()).toEqual([
      ["/api/account/work-mail", "GET"],
      ["/api/account/work-mail", "POST"],
      ["/api/account/work-mail", "GET"],
    ]);
  });

  it("shows the route's refusal in an alert and reloads nothing", async () => {
    const message = `route-message-${randomBytes(4).toString("hex")}`;
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(state(true, null)))
      .mockImplementationOnce(() => Promise.resolve(Response.json(
        { error: { code: "RATE_LIMITED", message } }, { status: 429, headers: { "retry-after": "60" } })));
    render(<WorkMailPanel />);
    await stateNode();

    fireEvent.change(within(panel()).getByLabelText("Email address"), { target: { value: "typed@mail.example.org" } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Send confirmation link" }));
    });

    expect(within(panel()).getByRole("alert").textContent).toBe(message);
    expect(within(panel()).queryByRole("status")).not.toBeInTheDocument();
    expect(requests()).toEqual([["/api/account/work-mail", "GET"], ["/api/account/work-mail", "POST"]]);
  });

  it("deletes the address and shows the none state", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(state(true, { address: "gone@mail.example.org", confirmed: true })))
      .mockImplementationOnce(() => Promise.resolve(Response.json({ deleted: true })));
    render(<WorkMailPanel />);
    await stateNode();

    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Remove address" }));
    });

    expect(await stateNode()).toHaveAttribute("data-work-mail-state", "none");
    expect(within(panel()).getByRole("status")).toBeVisible();
    expect(fetchMock.mock.calls[1]).toEqual(["/api/account/work-mail", { method: "DELETE", credentials: "same-origin" }]);
  });

  it("keeps the address when the delete is refused", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(state(true, { address: "kept@mail.example.org", confirmed: true })))
      .mockImplementationOnce(() => Promise.resolve(Response.json({ error: { message: "x" } }, { status: 502 })));
    render(<WorkMailPanel />);
    await stateNode();

    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Remove address" }));
    });

    expect(within(panel()).getByRole("alert")).toBeVisible();
    expect(await stateNode()).toHaveAttribute("data-work-mail-state", "confirmed");
  });

  it("alerts when the state cannot be loaded", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({}, { status: 502 })));
    render(<WorkMailPanel />);

    expect(await within(panel()).findByRole("alert")).toBeVisible();
    expect(within(panel()).queryByTestId("work-mail-state")).not.toBeInTheDocument();
  });

  it("confirms the token the mailed link carries, clearing it from the URL before it is posted", async () => {
    const token = randomBytes(32).toString("base64url");
    const mailed = buildConfirmationMessage({
      from: "work@mail.example.org", to: "reader@mail.example.org", origin: "https://overflow.example.org", token,
    }).content.split("\r\n").find((line) => line.startsWith("https://overflow.example.org/"))!;
    const link = new URL(mailed);
    window.history.replaceState(null, "", `${link.pathname}${link.search}${link.hash}`);
    expect(window.location.pathname).toBe("/dashboard");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(init?.method === "POST"
      ? Response.json({ confirmed: true })
      : state(true, { address: "reader@mail.example.org", confirmed: hashAtRequest.length > 1 })));

    render(<WorkMailPanel />);

    expect(await within(panel()).findByRole("status")).toBeVisible();
    const confirm = fetchMock.mock.calls.findIndex(([url]) => url === "/api/account/work-mail/confirm");
    expect(fetchMock.mock.calls[confirm]).toEqual(["/api/account/work-mail/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    }]);
    expect(hashAtRequest[confirm]).toBe("");
    expect([window.location.pathname, window.location.search, window.location.hash]).toEqual(["/dashboard", "", ""]);
    // The state is read again after the confirmation lands, so it shows confirmed.
    expect(requests().filter(([url]) => url === "/api/account/work-mail")).toHaveLength(2);
    expect(await stateNode()).toHaveAttribute("data-work-mail-state", "confirmed");
  });

  it("alerts on a refused confirmation and still clears the token", async () => {
    window.history.replaceState(null, "", `/dashboard#work-mail-confirm=${randomBytes(32).toString("base64url")}`);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(init?.method === "POST"
      ? Response.json({ error: { code: "INVALID_CONFIRMATION", message: "x" } }, { status: 400 })
      : state(true, { address: "reader@mail.example.org", confirmed: false })));

    render(<WorkMailPanel />);

    expect(await within(panel()).findByRole("alert")).toBeVisible();
    expect(window.location.hash).toBe("");
    expect(requests()).toContainEqual(["/api/account/work-mail/confirm", "POST"]);
  });

  it("posts no confirmation without the confirm hash", async () => {
    window.history.replaceState(null, "", "/dashboard#unrelated=1");
    render(<WorkMailPanel />);
    await stateNode();

    expect(requests()).toEqual([["/api/account/work-mail", "GET"]]);
    expect(window.location.hash).toBe("#unrelated=1");
  });
});
