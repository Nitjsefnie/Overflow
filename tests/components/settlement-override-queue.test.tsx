/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettlementOverrideQueue } from "@/components/settlement-override-queue";
import type { OpenSettlementOverrideRequest } from "@/lib/overrides/service";

function queued(overrides: Partial<OpenSettlementOverrideRequest> = {}): OpenSettlementOverrideRequest {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    reason: "The rationale comment landed fourteen hours late.",
    requestedAt: "2026-09-05T10:00:00.000Z",
    requesterLogin: "ada",
    repositoryName: "co-op/harbour",
    issueNumber: 44,
    issueTitle: "Close the lock",
    issueUrl: "https://github.com/co-op/harbour/issues/44",
    settlement: {
      settlementId: "00000000-0000-4000-8000-000000000002",
      status: "UNSETTLED",
      openingComparisonPoints: 5,
      settledLabel: null,
      settledPoints: null,
      reviewRounds: 2,
      credits: 0,
      pullRequestNumber: 51,
      pullRequestTitle: "Seal the lock",
      pullRequestUrl: "https://github.com/co-op/harbour/pull/51",
    },
    calibration: null,
    ...overrides,
  };
}

/**
 * A request against a self-worked closure: the fold recorded a calibration in
 * place of a settlement, so there is no settlement row behind it.
 */
function selfWorked(
  calibration: Partial<NonNullable<OpenSettlementOverrideRequest["calibration"]>> = {},
): OpenSettlementOverrideRequest {
  return queued({
    settlement: null,
    calibration: {
      calibrationId: "00000000-0000-4000-8000-000000000004",
      ownerLogin: "grace",
      openingComparisonPoints: 5,
      actualLabel: "delivered/4",
      actualPoints: 4,
      pullRequestNumber: 61,
      pullRequestTitle: "Close the lock myself",
      pullRequestUrl: "https://github.com/co-op/harbour/pull/61",
      ...calibration,
    },
  });
}

describe("moderator settlement correction queue", () => {
  it("says when nothing is waiting", () => {
    render(<SettlementOverrideQueue requests={[]} />);

    expect(screen.getByText("No settlement corrections are waiting.")).toBeVisible();
  });

  it("shows the issue, the closing pull request, the settled points and the review rounds", () => {
    render(<SettlementOverrideQueue requests={[queued()]} />);

    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent("ada");
    expect(entry).toHaveTextContent("co-op/harbour");
    expect(entry).toHaveTextContent("The rationale comment landed fourteen hours late.");
    expect(screen.getByRole("link", { name: "#44 Close the lock" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/issues/44",
    );
    expect(screen.getByRole("link", { name: "#51 Seal the lock" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/pull/51",
    );
    expect(entry).toHaveTextContent("Settled points");
    expect(entry).toHaveTextContent("Unsettled");
    expect(entry).toHaveTextContent("Review rounds");
    expect(entry).toHaveTextContent("2");
    expect(entry).toHaveTextContent("Credits moved");
  });

  it("shows the settled label and points of a settlement that did settle, at the wrong figure", () => {
    render(
      <SettlementOverrideQueue
        requests={[
          queued({
            settlement: {
              ...queued().settlement!,
              status: "SETTLED",
              settledLabel: "delivered/2",
              settledPoints: 2,
              credits: 0,
            },
          }),
        ]}
      />,
    );

    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent("delivered/2");
    expect(entry).toHaveTextContent("SETTLED");
  });

  it("shows the calibration figures and the closing pull request of a self-worked closure", () => {
    render(<SettlementOverrideQueue requests={[selfWorked()]} />);

    const entry = screen.getByRole("listitem");
    expect(screen.getByRole("link", { name: "#61 Close the lock myself" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/pull/61",
    );
    expect(entry).toHaveTextContent("Opening comparison");
    expect(entry).toHaveTextContent("5");
    expect(entry).toHaveTextContent("Actual difficulty");
    expect(entry).toHaveTextContent("delivered/4 · 4");
    expect(entry).toHaveTextContent("Self-worked by");
    expect(entry).toHaveTextContent("grace");
    expect(entry).not.toHaveTextContent("The settled outcome for this issue is no longer materialized.");
  });

  it("says a self-worked closure moved no credits and that a correction changes the calibration", () => {
    render(<SettlementOverrideQueue requests={[selfWorked()]} />);

    expect(screen.getByRole("listitem")).toHaveTextContent(
      "The sponsor closed this issue themselves, so the fold recorded a calibration and no credits moved. " +
        "Granting a correction changes the calibration figure, not a balance.",
    );
    expect(screen.getByRole("button", { name: "Grant correction" })).toBeVisible();
  });

  it("says the actual difficulty is unrecorded when the closure's settled evidence was rejected", () => {
    render(<SettlementOverrideQueue requests={[selfWorked({ actualLabel: null, actualPoints: null })]} />);

    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent("Actual difficulty");
    expect(entry).toHaveTextContent("Never recorded");
  });

  it("says so rather than hiding a request whose settlement and calibration are both gone", () => {
    render(<SettlementOverrideQueue requests={[queued({ settlement: null, calibration: null })]} />);

    expect(screen.getByRole("listitem")).toHaveTextContent(
      "The settled outcome for this issue is no longer materialized.",
    );
    expect(screen.getByRole("button", { name: "Grant correction" })).toBeVisible();
  });

  it("offers a decision for every queued request", () => {
    render(
      <SettlementOverrideQueue
        requests={[queued(), queued({ id: "00000000-0000-4000-8000-000000000003", issueNumber: 46 })]}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Grant correction" })).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Correction decision for issue #46" })).toBeVisible();
  });
});
