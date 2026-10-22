"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_REASON_LENGTH } from "@/lib/validation/reason";

export function ClosedPrDisputeDecisionControl({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [figure, setFigure] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  async function recordDecision(decision: "GRANTED" | "DENIED") {
    setFeedback(null);
    const grantFigure = Number(figure);
    if (!reason.trim()) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before recording a dispute decision." });
      return;
    }
    if (decision === "GRANTED" && (!Number.isInteger(grantFigure) || grantFigure < 1 || grantFigure > 10)) {
      setFeedback({ kind: "error", message: "Choose a whole-number figure from 1 to 10 to grant the dispute." });
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/moderation/disputes", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ requestId, decision, reason: reason.trim(), ...(decision === "GRANTED" ? { figure: grantFigure } : {}) }),
      });
      const body = await response.json().catch(() => null) as { error?: { message?: string }; request?: { awardedPoints: number | null } } | null;
      if (!response.ok) {
        setFeedback({ kind: "error", message: body?.error?.message ?? "The decision could not be recorded. Try again." });
        return;
      }
      setFeedback({ kind: "success", message: decision === "GRANTED"
        ? `Dispute granted. Awarded points: ${body?.request?.awardedPoints ?? "unknown"}.` : "Dispute denied." });
      router.refresh();
    } catch {
      setFeedback({ kind: "error", message: "The decision could not reach Overflow. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="moderation-controls" aria-label={`Dispute decision for ${requestId}`}>
      <label className="field" htmlFor={`dispute-figure-${requestId}`}>
        <span>Figure (1–10)</span>
        <input id={`dispute-figure-${requestId}`} name="figure" className="field-input" type="number" min={1} max={10} step={1}
          value={figure} onChange={(event) => setFigure(event.target.value)} />
      </label>
      <label className="field" htmlFor={`dispute-decision-${requestId}`}>
        <span>Reason for the dispute decision</span>
        <textarea id={`dispute-decision-${requestId}`} name="reason" value={reason} onChange={(event) => setReason(event.target.value)}
          rows={3} maxLength={MAX_REASON_LENGTH} required />
      </label>
      <div className="moderation-action-buttons">
        <button className="quiet-button" type="button" disabled={pending} onClick={() => void recordDecision("GRANTED")}>Grant the dispute</button>
        <button className="action-button" type="button" disabled={pending} onClick={() => void recordDecision("DENIED")}>Deny the dispute</button>
      </div>
      {pending ? <p className="feedback pending" role="status">Recording the decision…</p> : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
