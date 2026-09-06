/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CalibrationProofPage from "@/app/calibration/[id]/page";
import CalibrationPage from "@/app/calibration/page";
import { CalibrationPanel, SelfWorkCalibrationList } from "@/components/calibration-panel";
import { SettlementOverrideQueue } from "@/components/settlement-override-queue";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";
import { UNLABELLED_POINTS } from "@/lib/overrides/unlabelled-points";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getSql: () => sql }));
vi.mock("@/lib/dashboard/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard/session")>(),
  requireMemberPageSession: async () => ({
    user: { id: "sponsor-1", role: "MEMBER", name: "Sponsor" },
  }),
}));

const proof = "a".repeat(64);

/** The calibration row the sponsor owns, with a distinct number per source. */
const calibrationRow = {
  id: "calibration-1",
  repository_name: "co-op/harbour",
  opening_name: "Offer band",
  actual_name: "Delivered band",
  issue_number: 17,
  issue_title: "Repair the tide gate",
  issue_url: "https://github.com/co-op/harbour/issues/17",
  opening_label: "shoal",
  actual_label: "landed/4",
  pull_request_number: 18,
  pull_request_title: "Repair the gate myself",
  pull_request_url: "https://github.com/co-op/harbour/pull/18",
  merge_commit_oid: "0123456789abcdef0123456789abcdef01234567",
  merged_at: "2026-09-05T11:00:00.000Z",
  proof_sha256: proof,
  opening_comparison_points: 7,
  actual_points: 4,
};

/**
 * The value beside a term in the proof grid.
 *
 * Read from that one node rather than from the whole card: an assertion over
 * the card's text passes on a digit anywhere in it, including the merge SHA and
 * the merge timestamp, so a wrong figure would go unnoticed.
 */
function proofValue(term: string): string {
  const value = screen.getByText(term).nextElementSibling;
  if (value === null) {
    throw new Error(`The proof grid carries no value beside “${term}”.`);
  }
  return value.textContent ?? "";
}

/** Answers the calibration proof query, and whatever the corrections list does next. */
function respondWith(options: { calibration?: unknown[]; corrections?: unknown[] | Error } = {}) {
  sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("from settlement_override_requests")) {
      if (options.corrections instanceof Error) {
        throw options.corrections;
      }
      return options.corrections ?? [];
    }
    if (text.includes("from self_work_calibrations")) {
      return options.calibration ?? [calibrationRow];
    }
    throw new Error(`Unexpected query: ${text}`);
  });
}

const calibrationParams = { params: Promise.resolve({ id: "calibration-1" }) };

describe("calibration comparison", () => {
  it("compares self-work samples against outsider settlements", () => {
    render(
      <CalibrationPanel
        comparison={{
          selfWork: { count: 12, meanDelta: -0.5, medianDelta: -1 },
          outsider: { count: 14, meanDelta: 1, medianDelta: 1 },
          differenceBetweenMeans: -1.5,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Calibration comparison" })).toBeVisible();
    expect(screen.getByText("Self-work sample · 12 pairs")).toBeVisible();
    expect(screen.getByText("Outsider settlement sample · 14 pairs")).toBeVisible();
    expect(screen.getByText("Mean delta −0.5")).toBeVisible();
    expect(screen.getByText("Difference between means −1.5")).toBeVisible();
    expect(screen.queryByText(/churn/i)).not.toBeInTheDocument();
  });

  it("names the next action when no paired samples exist", () => {
    render(
      <CalibrationPanel
        comparison={{
          selfWork: { count: 0, meanDelta: 0, medianDelta: 0 },
          outsider: { count: 0, meanDelta: 0, medianDelta: 0 },
          differenceBetweenMeans: 0,
        }}
      />,
    );

    expect(screen.getByText("Complete paired work to establish calibration.")).toBeVisible();
  });
});

describe("self-work calibration proof page", () => {
  it("shows the sponsor's own evidence and offers the calibration correction", async () => {
    respondWith();

    render(await CalibrationProofPage(calibrationParams));

    expect(screen.getByRole("heading", { name: "co-op/harbour calibration", level: 1 })).toBeVisible();
    expect(screen.getByRole("link", { name: "#" + "17 Repair the tide gate" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/issues/17",
    );
    expect(screen.getByRole("link", { name: "#" + "18 Repair the gate myself" })).toHaveAttribute(
      "href",
      "https://github.com/co-op/harbour/pull/18",
    );
    expect(proofValue("Offer band")).toBe("shoal · 7");
    expect(proofValue("Delivered band")).toBe("landed/4 · 4");
    expect(proofValue("Merged")).toBe("2026-09-05T11:00:00.000Z");
    expect(proofValue("Merge commit")).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(within(screen.getByText(/GitHub closing-link proof/)).getByText(proof)).toBeVisible();
    expect(screen.getByText(/no credits moved/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Report this calibration as incorrect" })).toBeVisible();
  });

  it("names the missing actual figure as the thing a correction repairs", async () => {
    respondWith({
      calibration: [{ ...calibrationRow, actual_label: null, actual_points: null, proof_sha256: null }],
    });

    render(await CalibrationProofPage(calibrationParams));

    expect(proofValue("Delivered band")).toBe("Never recorded");
    expect(proofValue("Offer band")).toBe("shoal · 7");
    expect(screen.getByText(/The settled evidence for this closure was rejected/)).toBeVisible();
    expect(within(screen.getByText(/GitHub closing-link proof/)).getByText("Unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Report this calibration as incorrect" })).toBeVisible();
  });

  it("reads a granted correction back as the calibration's actual points", async () => {
    respondWith({
      corrections: [{
        id: "request-1",
        issue_id: "issue-1",
        requester_id: "sponsor-1",
        reason: "The label landed nine minutes after the window.",
        state: "GRANTED",
        settled_points: 6,
        decided_by_id: "moderator-1",
        decision_reason: "The merged work matches six delivered points.",
        created_at: "2026-09-05T12:00:00.000Z",
        decided_at: "2026-09-05T13:00:00.000Z",
      }],
    });

    render(await CalibrationProofPage(calibrationParams));

    expect(screen.getByText("Granted at 6 actual points")).toBeVisible();
    expect(screen.getByText(/The label landed nine minutes after the window./)).toBeVisible();
  });

  it("shows a corrected figure that no GitHub label backs", async () => {
    respondWith({ calibration: [{ ...calibrationRow, actual_label: null, actual_points: 6 }] });

    render(await CalibrationProofPage(calibrationParams));

    expect(proofValue("Delivered band")).toBe("no label recorded · 6");
  });

  // The sponsor and the moderator deciding their request read the same state on
  // two different surfaces, so the two are compared against each other rather
  // than each against its own copy of the words: pinning them separately is what
  // lets a rename pass green twice while the product says two things.
  it("reads a corrected figure exactly as the moderator's queue reads it", async () => {
    respondWith({ calibration: [{ ...calibrationRow, actual_label: null, actual_points: 6 }] });

    render(await CalibrationProofPage(calibrationParams));
    const sponsorReads = proofValue("Delivered band");

    cleanup();
    render(
      <SettlementOverrideQueue
        requests={[{
          id: "request-1",
          reason: "The rationale comment never landed.",
          requestedAt: "2026-09-05T10:00:00.000Z",
          requesterLogin: "grace",
          repositoryName: "co-op/harbour",
          issueNumber: 17,
          issueTitle: "Repair the tide gate",
          issueUrl: "https://github.com/co-op/harbour/issues/17",
          settlement: null,
          calibration: {
            calibrationId: "calibration-1",
            ownerLogin: "grace",
            openingComparisonPoints: 7,
            actualLabel: null,
            actualPoints: 6,
            pullRequestNumber: 18,
            pullRequestTitle: "Repair the gate myself",
            pullRequestUrl: "https://github.com/co-op/harbour/pull/18",
          },
        }]}
      />,
    );
    const moderatorReads = screen.getByText("Actual difficulty").nextElementSibling?.textContent;

    expect(sponsorReads).toBe(moderatorReads);
    expect(sponsorReads).toBe(`${UNLABELLED_POINTS} · 6`);
  });

  it("withholds a calibration recorded against another account", async () => {
    respondWith({ calibration: [] });

    render(await CalibrationProofPage(calibrationParams));

    expect(screen.getByRole("heading", { name: "Calibration proof is not available." })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Report this calibration as incorrect" })).toBeNull();
  });

  it("distinguishes declined, empty, and unreadable correction history while keeping the proof and recourse", async () => {
    respondWith({ corrections: [{
      id: "request-1",
      issue_id: "issue-1",
      requester_id: "sponsor-1",
      reason: "The actual label was recorded late.",
      state: "DECLINED",
      settled_points: null,
      decided_by_id: "moderator-1",
      decision_reason: "The recorded evidence stands.",
      created_at: "2026-09-05T12:00:00.000Z",
      decided_at: "2026-09-05T13:00:00.000Z",
    }] });
    render(await CalibrationProofPage(calibrationParams));
    expect(screen.getByText("Declined")).toBeVisible();
    expect(screen.getByRole("article", { name: "co-op/harbour calibration" })).toBeVisible();

    cleanup();
    respondWith({ corrections: [] });
    render(await CalibrationProofPage(calibrationParams));
    const emptyRecourse = screen.getByRole("region", { name: "Is this calibration wrong?" }).textContent;
    expect(screen.getByText("No correction has been requested for this calibration.")).toBeVisible();
    expect(screen.getByRole("article", { name: "co-op/harbour calibration" })).toBeVisible();

    cleanup();
    respondWith({ corrections: new Error("Correction history unavailable") });
    render(await CalibrationProofPage(calibrationParams));

    const failedRecourse = screen.getByRole("region", { name: "Is this calibration wrong?" });
    expect.soft(failedRecourse.textContent).not.toBe(emptyRecourse);
    expect.soft(within(failedRecourse).queryByText(/correction history.*calibration.*could not be loaded/i)).toBeVisible();
    expect.soft(within(failedRecourse).queryByText(/No correction has been requested/)).toBeNull();
    expect(screen.getByRole("article", { name: "co-op/harbour calibration" })).toBeVisible();
    expect(proofValue("Delivered band")).toBe("landed/4 · 4");
    expect(screen.getByRole("button", { name: "Report this calibration as incorrect" })).toBeVisible();
  });

  it("falls back to the ledger when the calibration cannot be read", async () => {
    sql.mockImplementation(async () => {
      throw new Error("Calibration query unavailable");
    });

    render(await CalibrationProofPage(calibrationParams));

    expect(screen.getByRole("heading", { name: "Calibration proof could not be loaded." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to the ledger" })).toHaveAttribute("href", "/dashboard");
  });
});

/** A calibration with no actual figure: the closure this whole path exists for. */
const uncalibrated: SelfWorkCalibrationProjection = {
  id: "calibration-1",
  repositoryName: "co-op/harbour",
  issueNumber: 17,
  issueTitle: "Repair the tide gate",
  openingComparisonPoints: 7,
  actualPoints: null,
  mergedAt: "2026-09-05T11:00:00.000Z",
};

const calibrated: SelfWorkCalibrationProjection = {
  id: "calibration-2",
  repositoryName: "co-op/quay",
  issueNumber: 12,
  issueTitle: "Dredge the channel",
  openingComparisonPoints: 3,
  actualPoints: 5,
  mergedAt: "2026-09-01T11:00:00.000Z",
};

describe("self-work calibration list", () => {
  it("links each closure to its proof page in the order it was given", () => {
    render(<SelfWorkCalibrationList calibrations={[uncalibrated, calibrated]} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "View proof for issue #" + "17" })).toHaveAttribute(
      "href",
      "/calibration/calibration-1",
    );
    expect(within(rows[1]).getByRole("link", { name: "View proof for issue #" + "12" })).toHaveAttribute(
      "href",
      "/calibration/calibration-2",
    );
    expect(within(rows[0]).getByText("co-op/harbour · 2026-09-05")).toBeVisible();
    expect(within(rows[1]).getByText("Issue #" + "12: Dredge the channel")).toBeVisible();
    expect(within(rows[1]).getByText("Opening comparison 3 · actual 5")).toBeVisible();
  });

  it("says an uncalibrated closure was rejected and can be corrected", () => {
    render(<SelfWorkCalibrationList calibrations={[uncalibrated]} />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Opening comparison 7 · actual never recorded")).toBeVisible();
    expect(within(row).getByText(
      "The settled evidence for this closure was rejected, so no actual figure was recorded. Open the proof "
      + "to request a correction.",
    )).toBeVisible();
  });

  it("leaves a calibrated closure without the rejection note", () => {
    render(<SelfWorkCalibrationList calibrations={[calibrated]} />);

    expect(screen.queryByText(/was rejected/)).toBeNull();
  });

  it("names what produces a calibration when the account has none", () => {
    render(<SelfWorkCalibrationList calibrations={[]} />);

    expect(screen.getByRole("heading", { name: "No closure of your own has been calibrated yet." })).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("calibration page", () => {
  function respondToCalibrationPage(options: { calibrations?: unknown[] | Error } = {}) {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("as offered_difficulty")) {
        return [];
      }
      if (options.calibrations instanceof Error) {
        throw options.calibrations;
      }
      return options.calibrations ?? [];
    });
  }

  it("lists the account's calibrations beneath the comparison", async () => {
    respondToCalibrationPage({
      calibrations: [{
        id: "calibration-1",
        repository_name: "co-op/harbour",
        issue_number: 17,
        issue_title: "Repair the tide gate",
        opening_comparison_points: 7,
        actual_points: null,
        merged_at: "2026-09-05T11:00:00.000Z",
      }],
    });

    render(await CalibrationPage());

    expect(screen.getByRole("heading", { name: "Calibration comparison", level: 1 })).toBeVisible();
    expect(screen.getByText("Self-work sample · 0 pairs")).toBeVisible();
    expect(screen.getByRole("link", { name: "View proof for issue #" + "17" })).toHaveAttribute(
      "href",
      "/calibration/calibration-1",
    );
  });

  it("keeps the comparison when the calibration list cannot be read", async () => {
    respondToCalibrationPage({ calibrations: new Error("Calibration list unavailable") });

    render(await CalibrationPage());

    expect(screen.getByRole("heading", { name: "Calibration comparison", level: 1 })).toBeVisible();
    expect(screen.getByText("Your calibrated closures could not be loaded.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /View proof for issue/ })).toBeNull();
  });
});
