/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { pinnedRule, rem } from "../support/stylesheet-rules";
import { ForgeIdentitiesPanel } from "@/components/forge-identities-panel";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
const existingIdentity = {
  id: "identity-1",
  provider: "gitlab",
  instanceUrl: "https://gitlab.com",
  forgeLogin: "ada",
  verifiedAt: "2026-09-10T00:00:00.000Z",
  tokenFailedAt: null,
};

function fillLinkForm() {
  fireEvent.change(screen.getByLabelText(/instance url/i), { target: { value: "https://gitlab.com" } });
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: "test-token" } });
}

async function submitLinkForm() {
  fillLinkForm();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Link identity" }));
  });
}

beforeEach(() => {
  spyOnConsoleOutput();
  fetchMock.mockReset().mockResolvedValue(Response.json({ identities: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  refresh.mockClear();
  try {
    expectNoConsoleOutput();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("Forge identities panel", () => {
  it.each([
    ["rejects", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["returns non-2xx", () => Promise.resolve(Response.json({ error: { message: "Unavailable" } }, { status: 503 }))],
    ["returns malformed JSON", () => Promise.resolve(new Response("{"))],
  ])("keeps the confirmed link success when the follow-up list request %s", async (_failure, listResponse) => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ identities: [existingIdentity] }))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockImplementationOnce(listResponse);
    render(<ForgeIdentitiesPanel />);
    await screen.findByText("ada");
    await submitLinkForm();

    expect(screen.getByRole("status")).toHaveTextContent("Forge identity linked.");
    expect(screen.getByRole("alert")).toHaveTextContent(/list could not be refreshed.*may be out of date/i);
    expect(screen.queryByText(/link request could not reach/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/instance url/i)).toHaveValue("");
    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("");
    expect(screen.getByRole("list")).toHaveTextContent("ada");
    expect(screen.getByRole("button", { name: /unlink ada/i })).toBeEnabled();
    fillLinkForm();
    expect(screen.getByRole("button", { name: "Link identity" })).toBeEnabled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls).toEqual([
      ["/api/forge-identities", { credentials: "same-origin" }],
      ["/api/forge-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ instanceUrl: "https://gitlab.com", token: "test-token" }),
      }],
      ["/api/forge-identities", { credentials: "same-origin" }],
    ]);
  });

  it("shows link success while refreshing and renders the refreshed list before releasing busy", async () => {
    let resolveList!: (response: Response) => void;
    const listResponse = new Promise<Response>((resolve) => { resolveList = resolve; });
    fetchMock
      .mockResolvedValueOnce(Response.json({ identities: [] }))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockReturnValueOnce(listResponse);
    render(<ForgeIdentitiesPanel />);
    await screen.findByText(/no forge identity is linked/i);
    await submitLinkForm();

    expect(screen.getByRole("status")).toHaveTextContent("Forge identity linked.");
    expect(screen.getByLabelText(/instance url/i)).toHaveValue("");
    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("");
    fillLinkForm();
    expect(screen.getByRole("button", { name: "Link identity" })).toBeDisabled();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveList(Response.json({ identities: [existingIdentity] }));
    });

    expect(screen.getByRole("status")).toHaveTextContent("Forge identity linked.");
    expect(screen.getByRole("list")).toHaveTextContent("ada");
    expect(screen.queryByText(/no forge identity is linked/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link identity" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears a prior refresh warning on a later successful submission", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ identities: [] }))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ identities: [existingIdentity] }));
    render(<ForgeIdentitiesPanel />);
    await screen.findByText(/no forge identity is linked/i);
    await submitLinkForm();
    expect(screen.getByRole("alert")).toHaveTextContent(/list could not be refreshed/i);

    await submitLinkForm();

    expect(screen.getByRole("status")).toHaveTextContent("Forge identity linked.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveTextContent("ada");
    expect(screen.getByLabelText(/instance url/i)).toHaveValue("");
    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["rejects", () => Promise.reject(new TypeError("Failed to fetch")), /link request could not reach Overflow/i],
    ["returns non-2xx", () => Promise.resolve(Response.json({ error: { message: "Token rejected by GitLab." } }, { status: 422 })), /token rejected by GitLab/i],
    ["returns non-2xx without JSON", () => Promise.resolve(new Response("Unavailable", { status: 503 })), /identity could not be linked/i],
  ])("keeps mutation failure behavior when the POST %s", async (_failure, postResponse, message) => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ identities: [existingIdentity] }))
      .mockImplementationOnce(postResponse);
    render(<ForgeIdentitiesPanel />);
    await screen.findByText("ada");
    await submitLinkForm();

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/instance url/i)).toHaveValue("https://gitlab.com");
    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("test-token");
    expect(screen.getByRole("button", { name: "Link identity" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /unlink ada/i })).toBeEnabled();
    expect(screen.getByRole("list")).toHaveTextContent("ada");
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names the read_api scope where the token is asked for", async () => {
    render(<ForgeIdentitiesPanel />);

    // The scope token is what a member copies into GitLab's scope checklist,
    // so the field's own accessible name-or-description must carry it; the
    // sentence around it is not asserted.
    const tokenField = screen.getByLabelText(/personal access token/i);
    expect(tokenField).toHaveAccessibleDescription(/read_api/);

    // Settle the mount-time list request structurally (not on page copy) so
    // the state update it produces lands inside the test, not after cleanup.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/forge-identities", { credentials: "same-origin" }));
    await act(async () => {});
  });

  it("lays the link form out with the app's field, help and form-gap classes", async () => {
    render(<ForgeIdentitiesPanel />);

    // jsdom performs no layout, so what is pinned is the markup: each label is
    // a `.field` (label-to-input gap and input styling), the scope note is a
    // `.field-help`, and the form carries the class that separates its
    // children. Without them the controls stack with no spacing at all.
    const urlField = screen.getByLabelText(/instance url/i);
    const tokenField = screen.getByLabelText(/personal access token/i);
    expect(urlField.closest("label")).toHaveClass("field");
    expect(tokenField.closest("label")).toHaveClass("field");
    expect(document.getElementById("forge-token-scope")).toHaveClass("field-help");
    expect(urlField.closest("form")).toHaveClass("forge-link-form");
    expect(tokenField).toHaveAttribute("aria-describedby", "forge-token-scope");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/forge-identities", { credentials: "same-origin" }));
    await act(async () => {});
  });

  it("lists linked identities as a facts list, with no browser marker beside each grid", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json({
      identities: [{
        id: "identity-1",
        provider: "gitlab",
        instanceUrl: "https://gitlab.com",
        forgeLogin: "ada",
        verifiedAt: "2026-09-10T00:00:00.000Z",
      }],
    }));
    render(<ForgeIdentitiesPanel />);

    // Each row is an `.issue-facts` grid; the list itself carries the class
    // that drops the default disc, as the dashboard's own facts lists do.
    const list = await screen.findByRole("list");
    expect(list).toHaveClass("facts-list");
    expect(list.querySelectorAll("li > dl.issue-facts")).toHaveLength(1);
    await act(async () => {});
  });

  it("shows the needs-re-verification state beside a failed identity and not beside a healthy one", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json({
      identities: [
        {
          id: "identity-failed",
          provider: "gitlab",
          instanceUrl: "https://gitlab.com",
          forgeLogin: "ada",
          verifiedAt: "2026-09-10T00:00:00.000Z",
          tokenFailedAt: "2026-09-11T09:30:00.000Z",
        },
        {
          id: "identity-healthy",
          provider: "gitlab",
          instanceUrl: "https://gitlab.example.com",
          forgeLogin: "bob",
          verifiedAt: "2026-09-10T00:00:00.000Z",
          tokenFailedAt: null,
        },
      ],
    }));
    render(<ForgeIdentitiesPanel />);

    const list = await screen.findByRole("list");
    const failed = list.querySelector("li[data-forge-identity-state='needs-re-verification']");
    const healthy = list.querySelector("li[data-forge-identity-state='verified']");
    expect(failed).not.toBeNull();
    expect(healthy).not.toBeNull();
    // The marker rides on the failed row and is absent from the healthy one.
    expect(within(failed as HTMLElement).getByTestId("forge-identity-needs-re-verification")).toBeInTheDocument();
    expect(within(healthy as HTMLElement).queryByTestId("forge-identity-needs-re-verification")).not.toBeInTheDocument();
    // A failed identity keeps its last successful verification date: the
    // marker is beside it, not a replacement for it.
    expect(within(failed as HTMLElement).getByText("2026-09-10")).toBeInTheDocument();
    await act(async () => {});
  });

  it("ships a forge-link-form rule that separates the form's children", () => {
    const rule = pinnedRule(".forge-link-form");
    expect(rule.declarations.display).toBe("grid");
    // The boundary between two fields has to read as at least as wide as the
    // one a field puts between its own label and input.
    expect(rem(rule.declarations.gap, "the gap between the form's children")).toBeGreaterThanOrEqual(
      rem(pinnedRule(".field").declarations.gap, "the label-to-input gap"),
    );
    // The grid would stretch the submit to the form's full width otherwise.
    expect(pinnedRule(".forge-link-form > .quiet-button").declarations["justify-self"]).toBe("start");
  });
});
