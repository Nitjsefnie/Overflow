/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModerationControls,
  RecalibrationCreditAdjustmentControl,
  RecalibrationPlanControl,
} from "@/components/moderation-controls";

const { redirect, refresh } = vi.hoisted(() => ({ redirect: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh }) }));

const auditId = "00000000-0000-4000-8000-000000000004";

afterEach(() => {
  refresh.mockClear();
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

  it("requires and submits a moderator recalibration plan before reactivation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recalibration: { targetState: "ACTIVE" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationPlanControl targetAccountId="account-7" targetLogin="mira" />);

    fireEvent.click(screen.getByRole("button", { name: "Reactivate account" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a nonblank recalibration plan");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Recalibration plan for mira"), {
      target: { value: "Review ten completed contributions before new sponsorship." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate account" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("mira was reactivated"));
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        targetAccountId: "account-7",
        plan: "Review ten completed contributions before new sponsorship.",
      }),
    }));
  });

  it("refreshes the moderation queue once after a successful dismissal and keeps the success feedback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audit: { state: "DISMISSED" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), {
      target: { value: "The paired evidence does not support this audit." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss audit" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Audit for mira was dismissed.");
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the moderation queue once after a successful substantiation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audit: { state: "SUBSTANTIATED" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), {
      target: { value: "The evidence is sufficient." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Substantiate audit" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Audit for mira was substantiated.");
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the recalibration list once after a successful reactivation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recalibration: { targetState: "ACTIVE" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationPlanControl targetAccountId="account-7" targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Recalibration plan for mira"), {
      target: { value: "Review ten completed contributions before new sponsorship." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate account" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("mira was reactivated"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the moderation queue when a decision is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "CONFLICT", message: "This audit was already resolved." } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ModerationControls auditId={auditId} targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Reason for audit decision"), {
      target: { value: "The evidence is sufficient." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Substantiate audit" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("This audit was already resolved.");
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh the recalibration list when the reactivation is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "CONFLICT", message: "This account is not recalibrating." } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationPlanControl targetAccountId="account-7" targetLogin="mira" />);

    fireEvent.change(screen.getByLabelText("Recalibration plan for mira"), {
      target: { value: "Review ten completed contributions before new sponsorship." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate account" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("This account is not recalibrating.");
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

const accountId = "00000000-0000-4000-8000-000000000007";
const previewUrl = `/api/moderation/recalibration?targetAccountId=${accountId}`;

const actionablePreview = {
  audit: { id: "00000000-0000-4000-8000-00000000000a", decidedAt: "2026-09-01T10:00:00.000Z" },
  actionability: { actionable: true, reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS" },
  totals: { selfSum: 61, selfCount: 7, outSum: -9, outCount: 12 },
  figure: { gapPerPair: 8.678571428571429, pairCount: 12, totalAmount: 104 },
  lines: [
    { settlementId: "00000000-0000-4000-8000-0000000000b1", creditorId: "creditor-a", amount: 70 },
    { settlementId: "00000000-0000-4000-8000-0000000000b2", creditorId: "creditor-a", amount: 34 },
  ],
  adjustments: [],
};

const gaplessPreview = {
  audit: { id: "00000000-0000-4000-8000-00000000000a", decidedAt: null },
  actionability: { actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" },
  totals: { selfSum: 5, selfCount: 7, outSum: 3, outCount: 12 },
  figure: null,
  lines: [],
  adjustments: [],
};

function adjustmentRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000c9",
    moderationEventId: "00000000-0000-4000-8000-0000000000ca",
    calibrationAuditId: "00000000-0000-4000-8000-00000000000a",
    targetAccountId: accountId,
    gapPerPair: 8.678571428571429,
    pairCount: 12,
    totalAmount: 104,
    reversalOf: null,
    reason: "The paired evidence shows outsiders were under-credited.",
    createdAt: "2026-09-05T09:30:00.000Z",
    lines: [],
    ...overrides,
  };
}

function previewResponse(preview: unknown, status = 200) {
  return new Response(JSON.stringify({ preview }), { status, headers: { "content-type": "application/json" } });
}

describe("recalibration credit adjustment controls", () => {
  it("renders the stored figure: both cohort counts, the gap, the proposed total and the per-creditor preview", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(previewResponse(actionablePreview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText("Self-work pairs sampled: 7")).toBeInTheDocument();
    });
    expect(screen.getByText("Outsider pairs sampled: 12")).toBeInTheDocument();
    expect(screen.getByText(/Gap per pair:/)).toHaveTextContent("+8.68");
    expect(screen.getByText(/Proposed adjustment total:/)).toHaveTextContent("104 points");
    expect(screen.getByText("creditor-a")).toBeInTheDocument();
    expect(screen.getByText("+104")).toBeInTheDocument();
    expect(screen.queryByText(/Not actionable/)).toBeNull();
    expect(screen.getByText("No credit adjustments have been applied to mira.")).toBeInTheDocument();
  });

  it("renders the refusal reason in place of the figure when the stored comparison is not actionable", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(previewResponse(gaplessPreview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Not actionable/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Not actionable/)).toHaveTextContent("there is no positive calibration gap to compensate");
    expect(screen.queryByText(/Proposed adjustment total:/)).toBeNull();
    expect(screen.queryByText(/Gap per pair:/)).toBeNull();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByText("0 points")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply credit adjustment" })).toBeDisabled();
  });

  it("sends no apply request while the verdict is not actionable, whatever the reason says", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(previewResponse(gaplessPreview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Not actionable/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Reason for crediting mira"), {
      target: { value: "The paired evidence shows outsiders were under-credited." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit adjustment" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === previewUrl)).toBe(true);
  });

  it("disables the apply button over a zero-point proposed adjustment, with the reason on its title", async () => {
    const zeroFigurePreview = {
      ...actionablePreview,
      figure: { gapPerPair: 0.04, pairCount: 12, totalAmount: 0 },
    };
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(previewResponse(zeroFigurePreview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Proposed adjustment total:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Proposed adjustment total:/)).toHaveTextContent("0 points");
    const applyButton = screen.getByRole("button", { name: "Apply credit adjustment" });
    expect(applyButton).toBeDisabled();
    expect(applyButton).toHaveAttribute("title", "The proposed adjustment total is 0 points — nothing to apply");

    fireEvent.click(applyButton);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === previewUrl)).toBe(true);
  });

  it("requires a nonblank reason before a credit adjustment is applied", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(previewResponse(actionablePreview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Proposed adjustment total:/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit adjustment" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a nonblank reason before applying a credit adjustment.");
    expect(fetchMock.mock.calls.every(([url]) => String(url) === previewUrl)).toBe(true);
  });

  it("applies the adjustment with the entered reason and reloads the figure afterwards", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/moderation/recalibration/adjustment") {
        return Promise.resolve(
          new Response(JSON.stringify({ adjustment: { id: "adj-1", totalAmount: 104 } }), { status: 201 }),
        );
      }
      return Promise.resolve(previewResponse(actionablePreview));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Proposed adjustment total:/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Reason for crediting mira"), {
      target: { value: "The paired evidence shows outsiders were under-credited." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit adjustment" }));

    await waitFor(() => {
      expect(screen.getByText("Applied a 104-point credit adjustment to mira.")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation/recalibration/adjustment", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ targetAccountId: accountId, reason: "The paired evidence shows outsiders were under-credited." }),
    }));
    expect(refresh).toHaveBeenCalled();
    const previewCalls = fetchMock.mock.calls.filter(([url]) => String(url) === previewUrl);
    expect(previewCalls).toHaveLength(2);
  });

  it("shows the structured API error and does not refresh when the apply POST is refused", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/moderation/recalibration/adjustment") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "CONFLICT", message: "The proposed figure is stale; reload the comparison." } }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(previewResponse(actionablePreview));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText(/Proposed adjustment total:/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Reason for crediting mira"), {
      target: { value: "The paired evidence shows outsiders were under-credited." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit adjustment" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("The proposed figure is stale; reload the comparison.");
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders an applied adjustment as reversed when its mirrored reversal exists", async () => {
    const reversed = {
      ...actionablePreview,
      adjustments: [
        adjustmentRecord(),
        adjustmentRecord({ id: "00000000-0000-4000-8000-0000000000d2", reversalOf: "00000000-0000-4000-8000-0000000000c9", createdAt: "2026-09-06T09:30:00.000Z" }),
      ],
    };
    const fetchMock = vi.fn(() => Promise.resolve(previewResponse(reversed)));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByText("Reversed")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Reason for reversing adjustment 00000000-0000-4000-8000-0000000000c9")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reverse adjustment" })).toBeNull();
  });

  it("reverses an applied adjustment with the entered reason and reloads the figure afterwards", async () => {
    const applied = { ...actionablePreview, adjustments: [adjustmentRecord()] };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/moderation/adjustments/reversal") {
        return Promise.resolve(
          new Response(JSON.stringify({ reversal: { id: "rev-1" } }), { status: 201 }),
        );
      }
      return Promise.resolve(previewResponse(applied));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Reason for reversing adjustment 00000000-0000-4000-8000-0000000000c9")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Reason for reversing adjustment 00000000-0000-4000-8000-0000000000c9"), {
      target: { value: "The stored evidence no longer matches the live settlements." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reverse adjustment" }));

    await waitFor(() => {
      expect(screen.getByText("The credit adjustment was reversed and its mirrored lines were withdrawn from mira.")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/moderation/adjustments/reversal", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ adjustmentId: "00000000-0000-4000-8000-0000000000c9", reason: "The stored evidence no longer matches the live settlements." }),
    }));
    const previewCalls = fetchMock.mock.calls.filter(([url]) => String(url) === previewUrl);
    expect(previewCalls).toHaveLength(2);
  });

  it("shows the structured API error and does not refresh when the reversal POST is refused", async () => {
    const applied = { ...actionablePreview, adjustments: [adjustmentRecord()] };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/moderation/adjustments/reversal") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "CONFLICT", message: "This adjustment was already reversed." } }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(previewResponse(applied));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Reason for reversing adjustment 00000000-0000-4000-8000-0000000000c9")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Reason for reversing adjustment 00000000-0000-4000-8000-0000000000c9"), {
      target: { value: "The stored evidence no longer matches the live settlements." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reverse adjustment" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("This adjustment was already reversed.");
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the structured API error when the figure cannot be read", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Unable to process moderation request." } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Unable to process moderation request.");
    });
    expect(screen.queryByRole("button", { name: "Apply credit adjustment" })).toBeNull();
  });

  it("shows the connection fallback when the figure request cannot reach Overflow", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecalibrationCreditAdjustmentControl targetAccountId={accountId} targetLogin="mira" />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("The recalibration figure could not reach Overflow. Check your connection and try again.");
    });
  });
});
