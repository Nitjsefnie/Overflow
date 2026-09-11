/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
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
