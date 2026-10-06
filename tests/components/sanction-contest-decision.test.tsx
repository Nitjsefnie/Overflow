/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { SanctionContestDecisionControl } from "@/components/sanction-contest-decision";
import { MAX_REASON_LENGTH } from "@/lib/validation/reason";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh }) }));

const requestId = "00000000-0000-4000-8000-000000000004";

afterEach(() => {
  refresh.mockClear();
  vi.unstubAllGlobals();
});

function renderControl() {
  return render(
    <SanctionContestDecisionControl
      requestId={requestId}
      accountLogin="mira"
      sanctionState="BANNED"
    />,
  );
}

describe("sanction contest decision control", () => {
  it("labels the reason field for the named account and offers both outcomes", () => {
    renderControl();

    expect(screen.getByLabelText("Reason for the contest decision")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant the contest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny the contest" })).toBeInTheDocument();
  });

  it("caps the decision reason at the length the API accepts", () => {
    renderControl();

    expect(screen.getByLabelText("Reason for the contest decision")).toHaveProperty("maxLength", MAX_REASON_LENGTH);
  });

  it("requires a nonblank reason before a decision is sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderControl();

    fireEvent.change(screen.getByLabelText("Reason for the contest decision"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Grant the contest" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a nonblank reason before recording a contest decision.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the grant with the request id and the reason, then refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ request: { id: requestId, state: "DECIDED" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderControl();

    fireEvent.change(screen.getByLabelText("Reason for the contest decision"), {
      target: { value: "The audit overcounted the review rounds." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant the contest" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/moderation/contests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        requestId,
        decision: "GRANTED",
        reason: "The audit overcounted the review rounds.",
      }),
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Contest for mira was granted.");
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("sends DENIED on the denial button", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ request: { id: requestId, state: "DECIDED" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderControl();

    fireEvent.change(screen.getByLabelText("Reason for the contest decision"), {
      target: { value: "The confirmed patterns persist." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny the contest" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Contest for mira was denied.");
    });
    const call = fetchMock.mock.calls[0]?.[1] as { body: string } | undefined;
    expect(JSON.parse(call!.body)).toMatchObject({ requestId, decision: "DENIED" });
  });

  it("surfaces the route's error message, including the imposer refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "The moderator who imposed the sanction may not decide its contest while another moderator can.",
          },
        }),
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderControl();

    fireEvent.change(screen.getByLabelText("Reason for the contest decision"), {
      target: { value: "The sanction stands." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny the contest" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The moderator who imposed the sanction may not decide its contest while another moderator can.",
      );
    });
  });

  it("falls back to a generic message when the route is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    renderControl();

    fireEvent.change(screen.getByLabelText("Reason for the contest decision"), {
      target: { value: "The sanction stands." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny the contest" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The decision could not reach Overflow. Check your connection and try again.",
      );
    });
  });
});
