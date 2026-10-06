"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_REASON_LENGTH } from "@/lib/validation/reason";

type Feedback = { kind: "error" | "success"; message: string } | null;

type SanctionContestDecisionControlProps = {
  requestId: string;
  accountLogin: string;
  sanctionState: string;
};

type DecisionResponse = {
  error?: { message?: string };
};

/**
 * The moderator's decision control for one OPEN sanction contest request:
 * the reason and the two outcomes. The not-the-imposing-moderator rule is not
 * this control's to police — the store refuses the imposer where another
 * moderator exists, and the route carries that refusal back as the 403 this
 * control renders.
 */
export function SanctionContestDecisionControl({
  requestId,
  accountLogin,
  sanctionState,
}: SanctionContestDecisionControlProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pendingDecision, setPendingDecision] = useState<"GRANTED" | "DENIED" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function recordDecision(decision: "GRANTED" | "DENIED") {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before recording a contest decision." });
      return;
    }

    setPendingDecision(decision);
    try {
      const response = await fetch("/api/moderation/contests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ requestId, decision, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as DecisionResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The decision could not be recorded. Try again.",
        });
        return;
      }
      setFeedback({
        kind: "success",
        message: `Contest for ${accountLogin} was ${decision === "GRANTED" ? "granted" : "denied"}.`,
      });
      router.refresh();
    } catch {
      setFeedback({
        kind: "error",
        message: "The decision could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPendingDecision(null);
    }
  }

  return (
    <section className="moderation-controls" aria-label={`Contest decision for ${accountLogin}`}>
      <p className="mono-meta">
        Filed against the account’s {sanctionState} sanction — the filing and this decision are both moderation
        events; recording a decision does not itself change the sanction.
      </p>
      <label className="field" htmlFor={`sanction-contest-decision-${requestId}`}>
        <span>Reason for the contest decision</span>
        <textarea
          id={`sanction-contest-decision-${requestId}`}
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={MAX_REASON_LENGTH}
          required
        />
      </label>
      <div className="moderation-action-buttons">
        <button
          className="quiet-button"
          type="button"
          disabled={pendingDecision !== null}
          onClick={() => void recordDecision("GRANTED")}
        >
          Grant the contest
        </button>
        <button
          className="action-button"
          type="button"
          disabled={pendingDecision !== null}
          onClick={() => void recordDecision("DENIED")}
        >
          Deny the contest
        </button>
      </div>
      {pendingDecision !== null ? (
        <p className="feedback pending" role="status">Recording the {pendingDecision === "GRANTED" ? "grant" : "denial"} for {accountLogin}…</p>
      ) : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
