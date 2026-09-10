/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnregisterRepositoryControl } from "@/components/unregister-repository-control";

const { redirect, refresh } = vi.hoisted(() => ({ redirect: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh }) }));

afterEach(() => {
  refresh.mockClear();
  vi.unstubAllGlobals();
});

describe("unregister repository control", () => {
  it("renders an Unregister button naming the repository it would remove", () => {
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    // The visible label is the plain Unregister; the accessible name carries
    // the repository, so a page of these buttons stays distinguishable.
    const button = screen.getByRole("button", { name: "Unregister co-op/harbour" });
    expect(button).toBeVisible();
    expect(button.textContent).toBe("Unregister");
  });

  it("shows a confirm step before anything is sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));

    expect(screen.getByRole("button", { name: "Confirm unregister" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep registered" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns to the plain Unregister button when the confirm step is declined", () => {
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep registered" }));

    expect(screen.getByRole("button", { name: "Unregister co-op/harbour" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm unregister" })).toBeNull();
  });

  it("moves focus onto Keep registered when the confirm step opens", () => {
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));

    // The swap happens under the focused control, so the focus position is
    // the announcement: it must land on the non-destructive choice (WAI-ARIA
    // practice) rather than fall back to <body> in front of a destructive
    // confirmation.
    expect(screen.getByRole("button", { name: "Keep registered" })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("returns focus to the Unregister trigger when the confirm step is declined", () => {
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep registered" }));

    expect(screen.getByRole("button", { name: "Unregister co-op/harbour" })).toHaveFocus();
  });

  it("fires DELETE /api/repositories with the repository reference on confirm", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { repository: { ownerName: "co-op/harbour" }, webhookDeleted: true, alreadyUnregistered: false },
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/repositories");
    expect(init?.method).toBe("DELETE");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ repositoryUrl: "co-op/harbour" });
  });

  it("announces the departure and refreshes the ledger after a success", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { repository: { ownerName: "co-op/harbour" }, webhookDeleted: true, alreadyUnregistered: false },
      { status: 200 },
    )));
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "co-op/harbour is no longer registered.",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    // The control persists on the refreshed row (the DELETE is idempotent), so
    // the done state hands back the plain button rather than removing itself.
    expect(screen.getByRole("button", { name: "Unregister co-op/harbour" })).toBeVisible();
  });

  it.each([403, 404, 502])("shows an HTTP %s response's error message verbatim", async (status) => {
    const message = "No registration holds the GitHub path co-op/harbour, so there is nothing to unregister.";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: { code: "NOT_FOUND", message } },
      { status },
    )));
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to its own sentence when the failure carries no readable envelope", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { unexpected: "shape" },
      { status: 500 },
    )));
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The repository could not be unregistered. Try again.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says the request could not reach Overflow when fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The unregister request could not reach Overflow. Check your connection and try again.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("guards against a double submit while the deletion is in flight", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => {
      release = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<UnregisterRepositoryControl ownerName="co-op/harbour" />);

    fireEvent.click(screen.getByRole("button", { name: "Unregister co-op/harbour" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unregister" }));

    // The confirm pair steps down while the request is in flight and the only
    // control left is disabled, so a second press can neither double-fire the
    // DELETE nor re-enter the confirm step.
    const button = screen.getByRole("button", { name: "Unregister co-op/harbour" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(Response.json(
      { repository: { ownerName: "co-op/harbour" }, webhookDeleted: true, alreadyUnregistered: false },
      { status: 200 },
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Unregister co-op/harbour" })).toBeEnabled();
  });
});
