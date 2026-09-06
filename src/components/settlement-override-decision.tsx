"use client";

import { useState } from "react";

type Decision = "grant" | "decline";
type Feedback = { kind: "error" | "success"; message: string } | null;

type SettlementOverrideDecisionProps = {
  requestId: string;
  issueNumber: number;
};

type DecisionResponse = {
  error?: { message?: string };
};

const minimumSettledPoints = 1;
const maximumSettledPoints = 10;

/**
 * A moderator's decision on a correction request.
 *
 * Granting takes the corrected points, which the fold applies as the
 * settlement's settled points or as the calibration's actual points depending
 * on how the issue was priced. Credits are never entered here: where they move
 * at all, they are recomputed from those points and the review rounds the fold
 * counted. Both decisions require a reason, so the ledger records the argument
 * as well as the outcome.
 *
 * One control serves both outcomes, so its wording names neither: a moderator
 * deciding a sponsor's own closure would find no settled points to correct.
 */
export function SettlementOverrideDecision({ requestId, issueNumber }: SettlementOverrideDecisionProps) {
  const [settledPoints, setSettledPoints] = useState("");
  const [reason, setReason] = useState("");
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function decide(decision: Decision) {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before deciding a correction request." });
      return;
    }

    const points = Number(settledPoints.trim());
    if (
      decision === "grant" &&
      (settledPoints.trim().length === 0 ||
        !Number.isInteger(points) ||
        points < minimumSettledPoints ||
        points > maximumSettledPoints)
    ) {
      setFeedback({
        kind: "error",
        message: `Enter the corrected points, a whole number between ${minimumSettledPoints} and ${maximumSettledPoints}.`,
      });
      return;
    }

    setPendingDecision(decision);
    try {
      const response = await fetch(`/api/overrides/${requestId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          decision === "grant"
            ? { action: "grant", settledPoints: points, reason: trimmedReason }
            : { action: "decline", reason: trimmedReason },
        ),
      });
      const body = (await response.json().catch(() => null)) as DecisionResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The correction decision could not be recorded.",
        });
        return;
      }
      setFeedback({
        kind: "success",
        message:
          decision === "grant"
            ? `Issue #${issueNumber} is corrected to ${points} points.`
            : `Issue #${issueNumber} keeps the outcome the fold recorded.`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "The correction decision could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPendingDecision(null);
    }
  }

  return (
    <section className="override-decision" aria-label={`Correction decision for issue #${issueNumber}`}>
      <label className="field" htmlFor={`override-points-${requestId}`}>
        <span>Corrected points</span>
        <input
          id={`override-points-${requestId}`}
          name="settledPoints"
          type="number"
          min={minimumSettledPoints}
          max={maximumSettledPoints}
          step={1}
          value={settledPoints}
          onChange={(event) => setSettledPoints(event.target.value)}
        />
      </label>
      <label className="field" htmlFor={`override-decision-reason-${requestId}`}>
        <span>Reason for the decision</span>
        <textarea
          id={`override-decision-reason-${requestId}`}
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
        />
      </label>
      <div className="moderation-action-buttons">
        <button
          className="quiet-button"
          type="button"
          disabled={pendingDecision !== null}
          onClick={() => void decide("decline")}
        >
          Decline correction
        </button>
        <button
          className="action-button"
          type="button"
          disabled={pendingDecision !== null}
          onClick={() => void decide("grant")}
        >
          Grant correction
        </button>
      </div>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
