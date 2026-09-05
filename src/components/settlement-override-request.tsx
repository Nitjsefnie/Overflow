"use client";

import { useState } from "react";

type Feedback = { kind: "error" | "success"; message: string } | null;

type SettlementOverrideRequestFormProps = {
  settlementId: string;
};

type OverrideResponse = {
  error?: { message?: string };
};

/**
 * A member's report that a settlement is wrong.
 *
 * The reason is required rather than optional: a moderator judging the request
 * sees the settlement's evidence, but not what the member believes went wrong
 * with it.
 */
export function SettlementOverrideRequestForm({ settlementId }: SettlementOverrideRequestFormProps) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function reportSettlement() {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Say why this settlement is wrong before reporting it." });
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ settlementId, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as OverrideResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The report could not be recorded. Try again.",
        });
        return;
      }
      setFeedback({ kind: "success", message: "A moderator will review this settlement." });
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
      <label className="field" htmlFor={`override-reason-${settlementId}`}>
        <span>Why is this settlement wrong?</span>
        <textarea
          id={`override-reason-${settlementId}`}
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
        onClick={() => void reportSettlement()}
      >
        Report this settlement as incorrect
      </button>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}
