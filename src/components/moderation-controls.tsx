"use client";

import { useState } from "react";

type AuditAction = "dismiss" | "substantiate";
type Feedback = { kind: "error" | "success"; message: string } | null;

type ModerationControlsProps = {
  auditId: string;
  targetLogin: string;
};

type ModerationResponse = {
  error?: { message?: string };
};

export function ModerationControls({ auditId, targetLogin }: ModerationControlsProps) {
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<AuditAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function recordDecision(action: AuditAction) {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before recording an audit decision." });
      return;
    }

    setPendingAction(action);
    try {
      const response = await fetch(`/api/moderation/${auditId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as ModerationResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The audit decision could not be recorded. Check the audit state and try again.",
        });
        return;
      }
      setFeedback({
        kind: "success",
        message: `Audit for ${targetLogin} was ${action === "dismiss" ? "dismissed" : "substantiated"}.`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "The audit decision could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPendingAction(null);
    }
  }

  const pendingLabel = pendingAction === "dismiss" ? "dismissal" : "substantiation";

  return (
    <section className="moderation-controls" aria-label={`Audit actions for ${targetLogin}`}>
      <label className="field" htmlFor={`audit-reason-${auditId}`}>
        <span>Reason for audit decision</span>
        <textarea
          id={`audit-reason-${auditId}`}
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
          disabled={pendingAction !== null}
          onClick={() => void recordDecision("dismiss")}
        >
          Dismiss audit
        </button>
        <button
          className="action-button"
          type="button"
          disabled={pendingAction !== null}
          onClick={() => void recordDecision("substantiate")}
        >
          Substantiate audit
        </button>
      </div>
      {pendingAction !== null ? <p className="feedback pending" role="status">Recording {pendingLabel} for {targetLogin}…</p> : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
