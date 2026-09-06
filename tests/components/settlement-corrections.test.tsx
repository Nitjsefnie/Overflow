/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettlementCorrections } from "@/components/settlement-corrections";
import type { SettlementOverrideRequest } from "@/lib/overrides/service";

const settlementId = "00000000-0000-4000-8000-000000000001";
const calibrationId = "00000000-0000-4000-8000-000000000005";

const settlementTarget = { kind: "settlement", settlementId } as const;
const calibrationTarget = { kind: "calibration", calibrationId } as const;

it.each([settlementTarget, calibrationTarget])("names unreadable $kind history and keeps recourse offered", (target) => {
  render(<SettlementCorrections target={target} requests={null} />);

  expect.soft(screen.queryByText(`The correction history for this ${target.kind} could not be loaded.`)).toBeVisible();
  expect.soft(screen.queryByText(`No correction has been requested for this ${target.kind}.`)).toBeNull();
  expect.soft(screen.queryByRole("button", { name: `Report this ${target.kind} as incorrect` })).toBeVisible();
});

function request(overrides: Partial<SettlementOverrideRequest> = {}): SettlementOverrideRequest {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    issueId: "00000000-0000-4000-8000-000000000003",
    requesterId: "00000000-0000-4000-8000-000000000004",
    reason: "The rationale comment landed fourteen hours late.",
    state: "OPEN",
    settledPoints: null,
    decidedById: null,
    decisionReason: null,
    createdAt: "2026-09-05T10:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

describe("settlement corrections section", () => {
  it("offers the report form when nothing is open", () => {
    render(<SettlementCorrections target={settlementTarget} requests={[]} />);

    expect(screen.getByRole("button", { name: "Report this settlement as incorrect" })).toBeVisible();
    expect(screen.getByText("No correction has been requested for this settlement.")).toBeVisible();
  });

  it("keeps saying that a settlement's credits are recomputed from the corrected figure", () => {
    render(<SettlementCorrections target={settlementTarget} requests={[]} />);

    expect(screen.getByRole("heading", { name: "Is this settlement wrong?" })).toBeVisible();
    expect(screen.getByText(/credits are recomputed from it and the review rounds already counted/)).toBeVisible();
  });

  it("withholds the form while a request is awaiting a moderator, and says why", () => {
    render(<SettlementCorrections target={settlementTarget} requests={[request()]} />);

    expect(screen.queryByRole("button", { name: "Report this settlement as incorrect" })).toBeNull();
    expect(screen.getByText("Awaiting a moderator")).toBeVisible();
    expect(screen.getByText(/The rationale comment landed fourteen hours late./)).toBeVisible();
  });

  it("shows a granted correction with its points and the moderator's reason", () => {
    render(
      <SettlementCorrections
        target={settlementTarget}
        requests={[
          request({
            state: "GRANTED",
            settledPoints: 6,
            decisionReason: "The merged work matches six delivered points.",
            decidedAt: "2026-09-05T12:00:00.000Z",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Granted at 6 settled points")).toBeVisible();
    expect(screen.getByText(/The merged work matches six delivered points./)).toBeVisible();
    expect(screen.getByRole("button", { name: "Report this settlement as incorrect" })).toBeVisible();
  });

  it("shows a declined correction with the moderator's reason", () => {
    render(
      <SettlementCorrections
        target={settlementTarget}
        requests={[
          request({
            state: "DECLINED",
            decisionReason: "The evidence window closed before the label was applied.",
            decidedAt: "2026-09-05T12:00:00.000Z",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Declined")).toBeVisible();
    expect(screen.getByText(/The evidence window closed before the label was applied./)).toBeVisible();
  });
});

describe("self-work calibration corrections section", () => {
  it("asks about the calibration and says no credits move", () => {
    render(<SettlementCorrections target={calibrationTarget} requests={[]} />);

    expect(screen.getByRole("heading", { name: "Is this calibration wrong?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Report this calibration as incorrect" })).toBeVisible();
    expect(screen.getByText("No correction has been requested for this calibration.")).toBeVisible();
    const explanation = screen.getByText(/A calibration is rebuilt from GitHub history/);
    expect(explanation).toHaveTextContent(
      "A moderator can record a corrected actual figure instead; no credits move, because you closed your own "
      + "issue, and the corrected figure is what your calibration comparison is drawn from.",
    );
    expect(screen.queryByText(/credits are recomputed/i)).toBeNull();
    expect(screen.queryByText(/settled points/i)).toBeNull();
  });

  it("reports a granted correction as the calibration's actual points", () => {
    render(
      <SettlementCorrections
        target={calibrationTarget}
        requests={[
          request({
            state: "GRANTED",
            settledPoints: 6,
            decisionReason: "The merged work matches six delivered points.",
            decidedAt: "2026-09-05T12:00:00.000Z",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Granted at 6 actual points")).toBeVisible();
    expect(screen.queryByText(/Granted at 6 settled points/)).toBeNull();
  });
});
