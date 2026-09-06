/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
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
      openingComparisonPoints: 7,
      actualLabel: "delivered/4",
      actualPoints: 4,
      pullRequestNumber: 61,
      pullRequestTitle: "Close the lock myself",
      pullRequestUrl: "https://github.com/co-op/harbour/pull/61",
      ...calibration,
    },
  });
}

/**
 * The value beside a term in the evidence list.
 *
 * Read from that one node rather than from the whole entry: an assertion over
 * the entry's text passes on a digit anywhere in it, including the timestamp,
 * so a wrong figure would go unnoticed.
 */
function evidenceValue(entry: HTMLElement, term: string): string {
  const value = within(entry).getByText(term).nextElementSibling;
  if (value === null) {
    throw new Error(`The evidence list carries no value beside “${term}”.`);
  }
  return value.textContent ?? "";
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
    expect(evidenceValue(entry, "Status")).toBe("UNSETTLED");
    expect(evidenceValue(entry, "Opening comparison")).toBe("5");
    expect(evidenceValue(entry, "Settled points")).toBe("Unsettled");
    expect(evidenceValue(entry, "Review rounds")).toBe("2");
    expect(evidenceValue(entry, "Credits moved")).toBe("0");
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
    expect(evidenceValue(entry, "Status")).toBe("SETTLED");
    expect(evidenceValue(entry, "Settled points")).toBe("delivered/2 · 2");
  });

  // A granted correction writes the settled points while the issue's label
  // stays null, so a settlement reaches this state the same way a calibration
  // does and has to read the same way.
  it("shows settled points that no label backed, in the wording the calibration uses", () => {
    render(
      <SettlementOverrideQueue
        requests={[
          queued({
            settlement: { ...queued().settlement!, status: "SETTLED", settledLabel: null, settledPoints: 2 },
          }),
        ]}
      />,
    );

    expect(evidenceValue(screen.getByRole("listitem"), "Settled points")).toBe("no label recorded · 2");
  });

  it("shows the calibration figures and the closing pull request of a self-worked closure", () => {
    render(<SettlementOverrideQueue requests={[selfWorked()]} />);

    const entry = screen.getByRole("listitem");
    expect(screen.getByRole("link", { name: "#61 Close the lock myself" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/pull/61",
    );
    expect(evidenceValue(entry, "Opening comparison")).toBe("7");
    expect(evidenceValue(entry, "Actual difficulty")).toBe("delivered/4 · 4");
    expect(evidenceValue(entry, "Self-worked by")).toBe("grace");
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

    expect(evidenceValue(screen.getByRole("listitem"), "Actual difficulty")).toBe("Never recorded");
  });

  // A granted correction writes the calibration's actual points while the
  // issue's settled label stays null, so the very state this branch produces is
  // points without a label — visible on any later request against that issue.
  it("shows corrected actual points that no label ever backed", () => {
    render(<SettlementOverrideQueue requests={[selfWorked({ actualLabel: null, actualPoints: 4 })]} />);

    expect(evidenceValue(screen.getByRole("listitem"), "Actual difficulty")).toBe("no label recorded · 4");
  });

  it("says so rather than hiding a request whose settlement and calibration are both gone", () => {
    render(<SettlementOverrideQueue requests={[queued({ settlement: null, calibration: null })]} />);

    expect(screen.getByRole("listitem")).toHaveTextContent(
      "The settled outcome for this issue is no longer materialized.",
    );
    expect(screen.getByRole("button", { name: "Grant correction" })).toBeVisible();
  });

  it("keeps the self-work note off a settlement, where credits did move", () => {
    render(<SettlementOverrideQueue requests={[queued()]} />);

    const entry = screen.getByRole("listitem");
    expect(entry).not.toHaveTextContent("The sponsor closed this issue themselves");
    expect(entry).not.toHaveTextContent("no credits moved");
    expect(entry).toHaveTextContent("Credits moved");
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
