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
    const { container } = render(<UnwritableClosureHistory closures={[record]} />);

    const entry = screen.getByRole("listitem");
    const list = screen.getByRole("list");
    const repository = within(entry).getByText(record.repositoryName);
    const reason = entry.querySelector(".override-reason");
    const issue = within(entry).getByRole("link", { name: `#${record.issueNumber} ${record.issueTitle}` });
    const pullRequest = record.pullRequest === null ? null : within(entry).getByRole("link", {
      name: `#${record.pullRequest.number} ${record.pullRequest.title}`,
    });
    expect(list.tagName).toBe("OL");
    expect(repository).toBeVisible();
    expect(reason).toHaveTextContent(record.reason);
    expect(issue).toHaveAttribute("href", record.issueUrl);
    if (pullRequest !== null) {
      expect(pullRequest).toHaveAttribute("href", record.pullRequest!.url);
    }
    expect(within(container).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
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
    const outcome = entry.querySelector("data");
    expect(outcome).toBeVisible();
    expect(outcome).toHaveAttribute("value", record.latestCorrection!.state);
    expect(outcome).toHaveTextContent(record.latestCorrection!.state.toLowerCase());
    expect(Array.from(container.children)).toEqual([list]);
    expect(Array.from(entry.children)).toEqual([
      repository.closest("p"),
      issue.closest("p"),
      ...(pullRequest === null ? [] : [pullRequest.closest("p")]),
      reason,
      outcome!.closest("p"),
    ]);
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
