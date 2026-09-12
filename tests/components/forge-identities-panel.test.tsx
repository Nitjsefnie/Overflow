/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoConsoleOutput, spyOnConsoleOutput } from "../support/console-guard";
import { pinnedRule, rem } from "../support/stylesheet-rules";
import { ForgeIdentitiesPanel } from "@/components/forge-identities-panel";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();

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

  it("replaces loading with an actionable retry after an initial HTTP failure", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json(
      { error: { code: "UPSTREAM_FAILURE", message: "The identity list is unavailable." } },
      { status: 503 },
    ));
    render(<ForgeIdentitiesPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByText("Loading linked identities…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry loading identities" })).toBeEnabled();
  });

  it("replaces loading with an actionable retry when the response cannot be parsed", async () => {
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("malformed response")),
    });
    render(<ForgeIdentitiesPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByText("Loading linked identities…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry loading identities" })).toBeEnabled();
  });

  it("retries a network-failed list request and renders the returned identity", async () => {
    let resolveRetry!: (response: Response) => void;
    const retryRequest = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    fetchMock.mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(retryRequest);
    render(<ForgeIdentitiesPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading identities" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]).toEqual(["/api/forge-identities", { credentials: "same-origin" }]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/forge-identities", { credentials: "same-origin" }]);
    expect(screen.getByRole("button", { name: "Retry loading identities" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading linked identities…");

    await act(async () => {
      resolveRetry(Response.json({
        identities: [{
          id: "identity-retried",
          provider: "gitlab",
          instanceUrl: "https://gitlab.com",
          forgeLogin: "ada-retried",
          verifiedAt: "2026-09-10T00:00:00.000Z",
          tokenFailedAt: null,
        }],
      }));
    });

    expect(await screen.findByText("ada-retried")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry loading identities" })).not.toBeInTheDocument();
  });

  it("keeps a failed retry actionable for another attempt", async () => {
    fetchMock.mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(Response.json({
        identities: [{
          id: "identity-recovered",
          provider: "gitlab",
          instanceUrl: "https://gitlab.example.com",
          forgeLogin: "bob-recovered",
          verifiedAt: "2026-09-10T00:00:00.000Z",
          tokenFailedAt: null,
        }],
      }));
    render(<ForgeIdentitiesPanel />);

    expect(await screen.findByRole("alert")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry loading identities" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(retry);
    expect(await screen.findByText("bob-recovered")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains the existing empty state after an empty successful load", async () => {
    render(<ForgeIdentitiesPanel />);

    expect(await screen.findByText("No forge identity is linked to this account yet.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry loading identities" })).not.toBeInTheDocument();
  });

  it("does not update state when an in-flight list request settles after unmount", async () => {
    let resolveInitial!: (response: Response) => void;
    const initialRequest = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    fetchMock.mockReset().mockReturnValue(initialRequest);
    const { unmount } = render(<ForgeIdentitiesPanel />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/forge-identities",
      { credentials: "same-origin" },
    ));
    unmount();
    await act(async () => {
      resolveInitial(Response.json({ identities: [] }));
    });

    // The console guard would surface an update from the unmounted panel; the
    // empty body confirms there is no remounted view for the stale response.
    expect(document.body).toHaveTextContent("");
  });

  it("ignores a stale rejection from the canceled StrictMode effect", async () => {
    let rejectStaleRequest!: (reason?: unknown) => void;
    const staleRequest = new Promise<Response>((_resolve, reject) => {
      rejectStaleRequest = reject;
    });
    fetchMock.mockReset()
      .mockReturnValueOnce(staleRequest)
      .mockResolvedValueOnce(Response.json({
        identities: [{
          id: "identity-strict-mode",
          provider: "gitlab",
          instanceUrl: "https://gitlab.com",
          forgeLogin: "strict-mode-login",
          verifiedAt: "2026-09-10T00:00:00.000Z",
          tokenFailedAt: null,
        }],
      }));
    render(
      <StrictMode>
        <ForgeIdentitiesPanel />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("strict-mode-login")).toBeVisible();
    await act(async () => {
      rejectStaleRequest(new Error("stale network failure"));
    });

    expect(screen.getByText("strict-mode-login")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
