/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnwritableClosureHistory } from "@/components/unwritable-closure-history";
import type { UnwritableClosureProjection } from "@/lib/dashboard/queries";

const granted: UnwritableClosureProjection = {
  id: "closure-1",
  kind: "SETTLEMENT_EVIDENCE_REJECTED",
  reason: "The settled label was applied after the evidence window.",
  recordedAt: "2026-09-05T10:00:00.000Z",
  repositoryName: "co-op/harbour",
  issueNumber: 17,
  issueTitle: "Repair the tide gate",
  issueUrl: "https://github.com/co-op/harbour/issues/17",
  pullRequest: { number: 18, title: "Repair the gate", url: "https://github.com/co-op/harbour/pull/18" },
  settlementId: "settlement-1",
  settlementParties: { creditorLogin: "mira", debtorLogin: "quinn" },
  calibrationId: null,
  calibrationOwnerLogin: null,
  latestCorrection: { state: "GRANTED", requestedAt: "2026-09-05T12:00:00.000Z" },
};

describe("unwritable closure history", () => {
  it.each([
    { outcome: "settlement", record: granted },
    {
      outcome: "calibration",
      record: {
        ...granted,
        settlementId: null,
        settlementParties: null,
        calibrationId: "calibration-1",
        calibrationOwnerLogin: "grace",
      },
    },
    {
      outcome: "without a materialized outcome or pull request",
      record: { ...granted, settlementId: null, settlementParties: null, pullRequest: null },
    },
  ])("records $outcome evidence without offering correction actions", ({ record }) => {
    render(<UnwritableClosureHistory closures={[record]} />);

    const entry = screen.getByRole("listitem");
    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(within(entry).getByText(record.repositoryName)).toBeVisible();
    expect(entry.querySelector(".override-reason")).toHaveTextContent(record.reason);
    expect(within(entry).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      record.pullRequest === null
        ? ["https://github.com/co-op/harbour/issues/17"]
        : ["https://github.com/co-op/harbour/issues/17", "https://github.com/co-op/harbour/pull/18"],
    );
    expect(Array.from(entry.querySelectorAll("time"), (time) => time.dateTime)).toEqual([
      "2026-09-05T10:00:00.000Z", "2026-09-05T12:00:00.000Z",
    ]);
    for (const time of entry.querySelectorAll("time")) {
      expect(time).toBeVisible();
      expect(time).toHaveTextContent(time.dateTime);
    }
    expect(entry.querySelectorAll("code")).toHaveLength(0);
  });

  it("renders an empty state without a list or links", () => {
    render(<UnwritableClosureHistory closures={[]} />);

    expect(screen.getByRole("paragraph")).toBeVisible();
    expect(screen.getByRole("paragraph")).not.toBeEmptyDOMElement();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
