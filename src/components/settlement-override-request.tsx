"use client";

import { useState } from "react";
import type { SettlementOverrideTarget } from "@/lib/overrides/service";

type Feedback = { kind: "error" | "success"; message: string } | null;

type SettlementOverrideRequestFormProps = {
  target: SettlementOverrideTarget;
};

type OverrideResponse = {
  error?: { message?: string };
};

/**
 * A member's report that a priced outcome is wrong.
 *
 * The reason is required rather than optional: a moderator judging the request
 * sees the outcome's evidence, but not what the member believes went wrong with
 * it.
 *
 * The outcome is a settlement when someone else closed the issue and a
 * self-work calibration when its sponsor closed it themselves, so the form
 * names whichever one it was given and posts the matching identifier. The copy
 * follows: a sponsor reading "settlement" here would be looking for a row the
 * fold never wrote.
 */
export function SettlementOverrideRequestForm({ target }: SettlementOverrideRequestFormProps) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const outcome = target.kind === "settlement" ? "settlement" : "calibration";
  const fieldId = `override-reason-${target.kind === "settlement" ? target.settlementId : target.calibrationId}`;

  async function reportOutcome() {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: `Say why this ${outcome} is wrong before reporting it.` });
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          target.kind === "settlement"
            ? { settlementId: target.settlementId, reason: trimmedReason }
            : { calibrationId: target.calibrationId, reason: trimmedReason },
        ),
      });
      const body = (await response.json().catch(() => null)) as OverrideResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The report could not be recorded. Try again.",
        });
        return;
      }
      setFeedback({ kind: "success", message: `A moderator will review this ${outcome}.` });
      setReason("");
    } catch {
      setFeedback({
        kind: "error",
        message: "The report could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="override-request">
      <label className="field" htmlFor={fieldId}>
        <span>Why is this {outcome} wrong?</span>
        <textarea
          id={fieldId}
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
        />
      </label>
      <button
        className="action-button"
        type="button"
        disabled={pending}
        onClick={() => void reportOutcome()}
      >
        Report this {outcome} as incorrect
      </button>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}
