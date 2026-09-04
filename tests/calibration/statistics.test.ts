import { describe, expect, it } from "vitest";
import {
  CalibrationStatisticsError,
  compareCalibration,
  summarizeCalibration,
  type CalibrationPair,
} from "@/lib/calibration/statistics";

describe("calibration statistics", () => {
  it("summarizes offered-to-settled deltas with hand-derived mean and median", () => {
    const summary = summarizeCalibration([
      calibrationPair({ githubIssueId: 801, githubPullRequestId: 901, offeredDifficulty: 2, settledDifficulty: 5 }),
      calibrationPair({ githubIssueId: 802, githubPullRequestId: 902, offeredDifficulty: 8, settledDifficulty: 4 }),
      calibrationPair({ githubIssueId: 803, githubPullRequestId: 903, offeredDifficulty: 5, settledDifficulty: 5 }),
    ]);

    expect(summary).toEqual({
      count: 3,
      meanDelta: -1 / 3,
      medianDelta: 0,
    });
  });

  it("compares the self-work cohort against the outsider-settlement cohort", () => {
    const comparison = compareCalibration(
      [
        calibrationPair({ githubIssueId: 811, githubPullRequestId: 911, offeredDifficulty: 2, settledDifficulty: 5 }),
        calibrationPair({ githubIssueId: 812, githubPullRequestId: 912, offeredDifficulty: 4, settledDifficulty: 8 }),
      ],
      [
        calibrationPair({ githubIssueId: 821, githubPullRequestId: 921, offeredDifficulty: 8, settledDifficulty: 3 }),
        calibrationPair({ githubIssueId: 822, githubPullRequestId: 922, offeredDifficulty: 6, settledDifficulty: 5 }),
      ],
    );

    expect(comparison).toEqual({
      selfWork: { count: 2, meanDelta: 3.5, medianDelta: 3.5 },
      outsider: { count: 2, meanDelta: -3, medianDelta: -3 },
      differenceBetweenMeans: 6.5,
    });
  });

  it.each([
    [0, 5],
    [11, 5],
    [2.5, 5],
    [5, 0],
    [5, 11],
    [5, 2.5],
  ])("rejects an invalid offered-to-settled difficulty pair (%s to %s)", (offeredDifficulty, settledDifficulty) => {
    expect(() =>
      summarizeCalibration([
        calibrationPair({
          offeredDifficulty,
          settledDifficulty,
        }),
      ]),
    ).toThrow(CalibrationStatisticsError);
  });

  it("rejects a cohort pair without a Task 3 GitHub proof fingerprint", () => {
    const pair = {
      ...calibrationPair(),
      proofSha256: "proof-must-be-a-64-character-lowercase-sha256-hex-string",
    } as CalibrationPair;

    expect(() => summarizeCalibration([pair])).toThrow(CalibrationStatisticsError);
  });
});

function calibrationPair(overrides: Partial<CalibrationPair> = {}): CalibrationPair {
  return {
    githubRepositoryId: 701,
    githubIssueId: 801,
    githubPullRequestId: 901,
    mergedAt: "2026-01-01T00:00:00.000Z",
    proofSha256: "a".repeat(64),
    offeredDifficulty: 5,
    settledDifficulty: 5,
    ...overrides,
  };
}
