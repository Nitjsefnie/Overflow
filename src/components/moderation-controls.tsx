"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatSigned } from "@/lib/format-signed";
import { plural } from "@/lib/plural";

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
  const router = useRouter();
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
      router.refresh();
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

export function RecalibrationPlanControl({
  targetAccountId,
  targetLogin,
}: {
  targetAccountId: string;
  targetLogin: string;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function reactivate() {
    const normalizedPlan = plan.trim();
    setFeedback(null);
    if (normalizedPlan.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank recalibration plan before reactivation." });
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/moderation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ targetAccountId, plan: normalizedPlan }),
      });
      const body = (await response.json().catch(() => null)) as ModerationResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The recalibration could not be closed. Check the account state and try again.",
        });
        return;
      }
      setFeedback({ kind: "success", message: `${targetLogin} was reactivated with the recorded plan.` });
      router.refresh();
    } catch {
      setFeedback({ kind: "error", message: "The recalibration control could not reach Overflow. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="moderation-controls" aria-label={`Reactivation controls for ${targetLogin}`}>
      <label className="field">
        <span>Recalibration plan for {targetLogin}</span>
        <textarea value={plan} onChange={(event) => setPlan(event.target.value)} rows={3} />
      </label>
      <button className="action-button" type="button" disabled={pending} onClick={() => void reactivate()}>
        Reactivate account
      </button>
      {pending ? <p className="feedback pending" role="status">Recording recalibration plan…</p> : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}

/** One sampled pair's compensating line, keyed by settlement. */
type CreditAdjustmentLine = {
  settlementId: string;
  creditorId: string;
  amount: number;
};

/**
 * The moderator-facing recalibration figure and its controls, exactly as the
 * recalibration GET serves them (issue 330): the two cohorts' counts, the gap
 * and proposed integer total when the stored comparison is actionable, the
 * per-creditor line preview, and every credit adjustment already applied to
 * the account.
 */
type RecalibrationPreviewBody = {
  audit: { id: string; decidedAt: string | null };
  actionability: { actionable: boolean; reason: string };
  totals: { selfSum: number; selfCount: number; outSum: number; outCount: number };
  /** Null when the stored comparison is not actionable: there is no figure to act on. */
  figure: { gapPerPair: number; pairCount: number; totalAmount: number } | null;
  lines: readonly CreditAdjustmentLine[];
  adjustments: readonly {
    id: string;
    gapPerPair: number;
    pairCount: number;
    totalAmount: number;
    reversalOf: string | null;
    reason: string;
    createdAt: string;
    lines: readonly CreditAdjustmentLine[];
  }[];
};

type RecalibrationGetResponse = { preview?: RecalibrationPreviewBody; error?: { message?: string } };

type AdjustmentPostResponse = { adjustment?: { totalAmount?: number }; error?: { message?: string } };

type ReversalPostResponse = { error?: { message?: string } };

/**
 * Why the stored comparison is or is not actionable, in the moderator's
 * words. The verdict is the decision surface: only the last reason opens the
 * apply control, and every other one states what stands in the way.
 */
const actionabilityReasons: Record<string, string> = {
  SELF_COHORT_BELOW_MINIMUM_SAMPLE_SIZE: "the self-work cohort is below the minimum sample size",
  OUTSIDER_COHORT_BELOW_MINIMUM_SAMPLE_SIZE: "the outsider cohort is below the minimum sample size",
  NO_POSITIVE_CALIBRATION_GAP: "there is no positive calibration gap to compensate",
  SELF_WORK_UNDERCREDITED_OUTSIDERS:
    "outsiders settle systematically lower above their offers than the sponsor’s own work does",
};

function actionabilityText(reason: string): string {
  return actionabilityReasons[reason] ?? reason;
}

/**
 * The per-creditor view of the line preview: one row per creditor, its sampled
 * pairs' compensations summed. The served lines are per settlement; a creditor
 * compensated across several settlements reads one figure here.
 */
function groupLinesByCreditor(lines: readonly CreditAdjustmentLine[]): { creditorId: string; amount: number }[] {
  const amounts = new Map<string, number>();
  for (const line of lines) {
    amounts.set(line.creditorId, (amounts.get(line.creditorId) ?? 0) + line.amount);
  }
  return [...amounts.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([creditorId, amount]) => ({ creditorId, amount }));
}

/**
 * The credit half of the recalibration control (issue 330): it shows the
 * figure the latest SUBSTANTIATED audit's stored snapshot supports, and it is
 * the only place a moderator turns that figure into credit. The apply is its
 * own button — never the close control, and never a pre-checked box — so the
 * first moderator action that writes credit stays a deliberate click, and
 * every applied adjustment carries a reversal affordance under a reason.
 */
export function RecalibrationCreditAdjustmentControl({
  targetAccountId,
  targetLogin,
}: {
  targetAccountId: string;
  targetLogin: string;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<RecalibrationPreviewBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFeedback, setLoadFeedback] = useState<Feedback>(null);
  const [applyReason, setApplyReason] = useState("");
  const [applyPending, setApplyPending] = useState(false);
  const [reversePendingId, setReversePendingId] = useState<string | null>(null);
  const [reverseReasons, setReverseReasons] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadFeedback(null);
    try {
      const response = await fetch(`/api/moderation/recalibration?targetAccountId=${encodeURIComponent(targetAccountId)}`, {
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as RecalibrationGetResponse | null;
      if (!response.ok || body === null || typeof body.preview !== "object" || body.preview === null) {
        setLoadFeedback({
          kind: "error",
          message: body?.error?.message ?? "The recalibration figure could not be loaded. Check the account state and try again.",
        });
        return;
      }
      setPreview(body.preview);
    } catch {
      setLoadFeedback({
        kind: "error",
        message: "The recalibration figure could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setLoading(false);
    }
  }, [targetAccountId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function applyAdjustment() {
    const trimmedReason = applyReason.trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before applying a credit adjustment." });
      return;
    }

    setApplyPending(true);
    try {
      const response = await fetch("/api/moderation/recalibration/adjustment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ targetAccountId, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as AdjustmentPostResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The credit adjustment could not be applied. Check the account state and try again.",
        });
        return;
      }
      const appliedTotal = body?.adjustment?.totalAmount;
      setFeedback({
        kind: "success",
        message:
          typeof appliedTotal === "number"
            ? `Applied a ${appliedTotal}-point credit adjustment to ${targetLogin}.`
            : `The credit adjustment was applied to ${targetLogin}.`,
      });
      setApplyReason("");
      router.refresh();
      await loadPreview();
    } catch {
      setFeedback({ kind: "error", message: "The credit adjustment could not reach Overflow. Check your connection and try again." });
    } finally {
      setApplyPending(false);
    }
  }

  async function reverseAdjustment(adjustmentId: string) {
    const trimmedReason = (reverseReasons[adjustmentId] ?? "").trim();
    setFeedback(null);
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before reversing a credit adjustment." });
      return;
    }

    setReversePendingId(adjustmentId);
    try {
      const response = await fetch("/api/moderation/adjustments/reversal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ adjustmentId, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as ReversalPostResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The credit adjustment could not be reversed. Check the adjustment state and try again.",
        });
        return;
      }
      setFeedback({
        kind: "success",
        message: `The credit adjustment was reversed and its mirrored lines were withdrawn from ${targetLogin}.`,
      });
      router.refresh();
      await loadPreview();
    } catch {
      setFeedback({ kind: "error", message: "The reversal could not reach Overflow. Check your connection and try again." });
    } finally {
      setReversePendingId(null);
    }
  }

  if (loading && preview === null) {
    return (
      <section className="moderation-controls" aria-label={`Recalibration credit adjustment for ${targetLogin}`}>
        <p className="feedback pending" role="status">Reading the recalibration figure…</p>
      </section>
    );
  }

  if (loadFeedback?.kind === "error") {
    return (
      <section className="moderation-controls" aria-label={`Recalibration credit adjustment for ${targetLogin}`}>
        <p className="feedback error" role="alert">{loadFeedback.message}</p>
      </section>
    );
  }

  if (preview === null) {
    return null;
  }

  const actionable = preview.actionability.actionable;
  const appliedAdjustments = preview.adjustments.filter((adjustment) => adjustment.reversalOf === null);
  const reversedIds = new Set(
    preview.adjustments.flatMap((adjustment) => (adjustment.reversalOf === null ? [] : [adjustment.reversalOf])),
  );

  return (
    <section className="moderation-controls" aria-label={`Recalibration credit adjustment for ${targetLogin}`}>
      <p>Self-work pairs sampled: {preview.totals.selfCount}</p>
      <p>Outsider pairs sampled: {preview.totals.outCount}</p>
      {preview.figure === null ? (
        <p>Not actionable — {actionabilityText(preview.actionability.reason)}.</p>
      ) : (
        <>
          <p>Gap per pair: {formatSigned(preview.figure.gapPerPair)}</p>
          <p>
            Proposed adjustment total: {preview.figure.totalAmount} {plural(preview.figure.totalAmount, "point")}
          </p>
          {preview.lines.length === 0 ? null : (
            <div>
              <p>Per-creditor preview:</p>
              <ul>
                {groupLinesByCreditor(preview.lines).map(({ creditorId, amount }) => (
                  <li key={creditorId}>
                    <span>{creditorId}</span> <span>{formatSigned(amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <label className="field">
        <span>Reason for crediting {targetLogin}</span>
        <textarea value={applyReason} onChange={(event) => setApplyReason(event.target.value)} rows={3} />
      </label>
      <button
        className="action-button"
        type="button"
        disabled={!actionable || applyPending}
        title={actionable ? undefined : `Not actionable — ${actionabilityText(preview.actionability.reason)}`}
        onClick={() => void applyAdjustment()}
      >
        Apply credit adjustment
      </button>
      <p>Applied credit adjustments</p>
      {appliedAdjustments.length === 0 ? (
        <p>No credit adjustments have been applied to {targetLogin}.</p>
      ) : (
        <ul>
          {appliedAdjustments.map((adjustment) => (
            <li key={adjustment.id}>
              <p>
                {adjustment.totalAmount} {plural(adjustment.totalAmount, "point")} · {adjustment.createdAt} · {adjustment.reason}
              </p>
              {reversedIds.has(adjustment.id) ? (
                <p>Reversed</p>
              ) : (
                <>
                  <label className="field">
                    <span>Reason for reversing adjustment {adjustment.id}</span>
                    <textarea
                      value={reverseReasons[adjustment.id] ?? ""}
                      onChange={(event) =>
                        setReverseReasons((current) => ({ ...current, [adjustment.id]: event.target.value }))
                      }
                      rows={2}
                    />
                  </label>
                  <button
                    className="quiet-button"
                    type="button"
                    disabled={reversePendingId !== null}
                    onClick={() => void reverseAdjustment(adjustment.id)}
                  >
                    Reverse adjustment
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {applyPending || reversePendingId !== null ? (
        <p className="feedback pending" role="status">Recording the credit decision…</p>
      ) : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
