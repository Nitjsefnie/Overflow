/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalibrationPanel } from "@/components/calibration-panel";

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
