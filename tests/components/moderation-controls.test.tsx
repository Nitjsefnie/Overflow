/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationControls } from "@/components/moderation-controls";

const auditId = "00000000-0000-4000-8000-000000000004";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("moderation audit controls", () => {
  it("requires a nonblank reason before a moderator decision is sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss audit" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a nonblank reason before recording an audit decision.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows pending and success feedback for a permitted dismissal", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), {
      target: { value: "The paired evidence does not support this audit." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss audit" }));

    expect(screen.getByRole("status")).toHaveTextContent("Recording dismissal for mira…");
    expect(screen.getByRole("button", { name: "Dismiss audit" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(`/api/moderation/${auditId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "dismiss", reason: "The paired evidence does not support this audit." }),
    });

    resolveResponse?.(new Response(JSON.stringify({ audit: { state: "DISMISSED" } }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Audit for mira was dismissed.");
    });
  });

  it("shows the structured API error after a substantiation is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "CONFLICT", message: "This audit was already resolved." } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), { target: { value: "The evidence is sufficient." } });
    fireEvent.click(screen.getByRole("button", { name: "Substantiate audit" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("This audit was already resolved.");
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/moderation/${auditId}`, expect.objectContaining({
      body: JSON.stringify({ action: "substantiate", reason: "The evidence is sufficient." }),
    }));
  });
});
