/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettlementCorrections } from "@/components/settlement-corrections";
import type { SettlementOverrideRequest } from "@/lib/overrides/service";

const settlementId = "00000000-0000-4000-8000-000000000001";

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
    render(<SettlementCorrections settlementId={settlementId} requests={[]} />);

    expect(screen.getByRole("button", { name: "Report this settlement as incorrect" })).toBeVisible();
    expect(screen.getByText(/no correction has been requested/i)).toBeVisible();
  });

  it("withholds the form while a request is awaiting a moderator, and says why", () => {
    render(<SettlementCorrections settlementId={settlementId} requests={[request()]} />);

    expect(screen.queryByRole("button", { name: "Report this settlement as incorrect" })).toBeNull();
    expect(screen.getByText("Awaiting a moderator")).toBeVisible();
    expect(screen.getByText(/The rationale comment landed fourteen hours late./)).toBeVisible();
  });

  it("shows a granted correction with its points and the moderator's reason", () => {
    render(
      <SettlementCorrections
        settlementId={settlementId}
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
        settlementId={settlementId}
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
