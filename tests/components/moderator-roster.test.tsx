/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeratorRoster } from "@/components/moderator-roster";

const moderators = [
  { accountId: "self-id", githubLogin: "ada", isConfigured: true },
  { accountId: "other-id", githubLogin: "grace", isConfigured: false },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("moderator roster", () => {
  it("lists every moderator and marks the ones the deployment configures", () => {
    render(<ModeratorRoster moderators={moderators} currentAccountId="self-id" />);

    expect(screen.getByText("ada")).toBeVisible();
    expect(screen.getByText("grace")).toBeVisible();
    expect(screen.getByText("named in the deployment configuration")).toBeVisible();
  });

  it("offers no revoke control for your own account", () => {
    render(<ModeratorRoster moderators={moderators} currentAccountId="self-id" />);

    expect(screen.queryByRole("button", { name: "Revoke ada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke grace" })).toBeVisible();
  });

  it("revokes another moderator and reports it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ change: { targetGitHubLogin: "grace", role: "MEMBER" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModeratorRoster moderators={moderators} currentAccountId="self-id" />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke grace" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      targetAccountId: "other-id",
      moderator: false,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("grace is no longer a moderator.");
  });

  it("grants moderator status to a named account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ change: { targetGitHubLogin: "hopper", role: "MODERATOR" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModeratorRoster moderators={moderators} currentAccountId="self-id" />);

    fireEvent.change(screen.getByLabelText("Account to promote"), { target: { value: "new-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant moderator" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      targetAccountId: "new-id",
      moderator: true,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("hopper is now a moderator.");
  });

  it("surfaces the reason a change was refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "The requested moderation transition is not available." } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModeratorRoster moderators={moderators} currentAccountId="self-id" />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke grace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The requested moderation transition is not available.",
    );
  });
});
