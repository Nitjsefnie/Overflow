/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettlementOverrideRequestForm } from "@/components/settlement-override-request";

const settlementId = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settlement correction request form", () => {
  it("asks for a reason before letting a member report a settlement", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideRequestForm settlementId={settlementId} />);

    fireEvent.click(screen.getByRole("button", { name: "Report this settlement as incorrect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Say why this settlement is wrong before reporting it.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the settlement identifier and the trimmed reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ request: { id: "request-id", state: "OPEN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideRequestForm settlementId={settlementId} />);

    fireEvent.change(screen.getByLabelText("Why is this settlement wrong?"), {
      target: { value: "  The rationale comment landed after the window closed.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Report this settlement as incorrect" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/overrides");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      settlementId,
      reason: "The rationale comment landed after the window closed.",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A moderator will review this settlement.",
    );
  });

  it("shows the server's refusal rather than claiming success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "CONFLICT", message: "This issue already has a correction request awaiting a moderator." } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideRequestForm settlementId={settlementId} />);

    fireEvent.change(screen.getByLabelText("Why is this settlement wrong?"), {
      target: { value: "The settled points are wrong." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Report this settlement as incorrect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This issue already has a correction request awaiting a moderator.",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a network failure instead of leaving the button silent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<SettlementOverrideRequestForm settlementId={settlementId} />);

    fireEvent.change(screen.getByLabelText("Why is this settlement wrong?"), {
      target: { value: "The settled points are wrong." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Report this settlement as incorrect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not reach Overflow");
  });
});
