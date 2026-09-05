/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettlementOverrideDecision } from "@/components/settlement-override-decision";

const requestId = "00000000-0000-4000-8000-000000000009";

function okResponse(): Response {
  return new Response(JSON.stringify({ request: { id: requestId, state: "GRANTED" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settlement correction decision controls", () => {
  it("grants a correction with the settled points and the reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideDecision requestId={requestId} issueNumber={44} />);

    fireEvent.change(screen.getByLabelText("Corrected settled points"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Reason for the decision"), {
      target: { value: "The delivered label was applied by the issue owner." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant correction" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/overrides/${requestId}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "grant",
      settledPoints: 6,
      reason: "The delivered label was applied by the issue owner.",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Issue #44 is corrected to 6 settled points.",
    );
  });

  it("declines a correction with a reason and no points", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideDecision requestId={requestId} issueNumber={44} />);

    fireEvent.change(screen.getByLabelText("Reason for the decision"), {
      target: { value: "The evidence window closed before the label was applied." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Decline correction" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "decline",
      reason: "The evidence window closed before the label was applied.",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Issue #44 keeps its settlement.");
  });

  it("requires a reason for either decision", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideDecision requestId={requestId} issueNumber={44} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a nonblank reason before deciding a correction request.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires settled points within the catalog before granting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SettlementOverrideDecision requestId={requestId} issueNumber={44} />);

    fireEvent.change(screen.getByLabelText("Reason for the decision"), {
      target: { value: "The work was delivered." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the corrected settled points, a whole number between 1 and 10.",
    );

    fireEvent.change(screen.getByLabelText("Corrected settled points"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the corrected settled points, a whole number between 1 and 10.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's refusal rather than claiming the correction landed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "No settlement, calibration or correction request was found under that identifier." } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<SettlementOverrideDecision requestId={requestId} issueNumber={44} />);

    fireEvent.change(screen.getByLabelText("Reason for the decision"), { target: { value: "Handled." } });
    fireEvent.click(screen.getByRole("button", { name: "Decline correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No settlement, calibration or correction request was found under that identifier.",
    );
  });
});
