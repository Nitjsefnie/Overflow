"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MINIMUM_CALIBRATION_SAMPLE_SIZE, type CalibrationComparison } from "@/lib/calibration/statistics";
import type { AuditCandidateProjection, ModerationRepositoryProjection } from "@/lib/dashboard/queries";

type Feedback = { kind: "error" | "success"; message: string } | null;
type PendingRequest = "preview" | "open";

type CohortPreview = {
  comparison: CalibrationComparison;
  meetsMinimumSampleSize: boolean;
};

type OpenAuditFormProps = {
  candidates: AuditCandidateProjection[];
  repositories: ModerationRepositoryProjection[];
};

type CohortPreviewResponse = {
  preview?: CohortPreview;
  error?: { message?: string };
};

type OpenAuditResponse = {
  error?: { message?: string };
};

export function OpenAuditForm({ candidates, repositories }: OpenAuditFormProps) {
  const router = useRouter();
  const [targetAccountId, setTargetAccountId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [sampleStartedAt, setSampleStartedAt] = useState("");
  const [sampleEndedAt, setSampleEndedAt] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<CohortPreview | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const target = candidates.find((candidate) => candidate.id === targetAccountId) ?? null;
  const hasCohortSelection = target !== null && sampleStartedAt.length > 0 && sampleEndedAt.length > 0;

  async function previewCohort() {
    setFeedback(null);
    if (!hasCohortSelection) {
      setFeedback({ kind: "error", message: "Choose an audit target and both sample window bounds." });
      return;
    }

    setPending("preview");
    try {
      // The cohort query is strict: a misspelled parameter is a 422 rather than a
      // silently account-wide cohort, so an omitted repository is the only way to
      // ask for one.
      const parameters = new URLSearchParams({ targetAccountId });
      if (repositoryId.length > 0) {
        parameters.set("repositoryId", repositoryId);
      }
      parameters.set("sampleStartedAt", sampleStartedAt);
      parameters.set("sampleEndedAt", sampleEndedAt);

      const response = await fetch(`/api/moderation/cohort?${parameters.toString()}`, {
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as CohortPreviewResponse | null;
      if (!response.ok || body?.preview === undefined) {
        setPreview(null);
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The cohort preview could not be loaded. Check the sample window and try again.",
        });
        return;
      }
      setPreview(body.preview);
    } catch {
      setPreview(null);
      setFeedback({
        kind: "error",
        message: "The cohort preview could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPending(null);
    }
  }

  // A preview is an inspection aid, not a precondition: the server decides whether
  // the cohort qualifies, and it answers with INSUFFICIENT_SAMPLES when it does not.
  async function openAudit() {
    setFeedback(null);
    if (!hasCohortSelection) {
      setFeedback({ kind: "error", message: "Choose an audit target and both sample window bounds." });
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Enter a nonblank reason before opening an audit." });
      return;
    }

    setPending("open");
    try {
      const response = await fetch("/api/moderation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          targetAccountId: target.id,
          ...(repositoryId.length > 0 ? { repositoryId } : {}),
          sampleStartedAt,
          sampleEndedAt,
          reason: trimmedReason,
        }),
      });
      const body = (await response.json().catch(() => null)) as OpenAuditResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The audit could not be opened. Check the cohort and try again.",
        });
        return;
      }
      setFeedback({ kind: "success", message: `An audit is open for ${target.githubLogin}.` });
      router.refresh();
    } catch {
      setFeedback({
        kind: "error",
        message: "The audit could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="open-audit-form">
      <div className="form-grid">
        <label className="field" htmlFor="open-audit-target">
          <span>Audit target</span>
          <select
            id="open-audit-target"
            name="targetAccountId"
            value={targetAccountId}
            onChange={(event) => setTargetAccountId(event.target.value)}
            required
          >
            <option value="">Choose an account</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {describeCandidate(candidate)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="open-audit-repository">
          <span>Repository scope</span>
          <select
            id="open-audit-repository"
            name="repositoryId"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            <option value="">All repositories</option>
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.ownerName}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="open-audit-sample-start">
          <span>Sample window start</span>
          <input
            id="open-audit-sample-start"
            name="sampleStartedAt"
            type="datetime-local"
            value={sampleStartedAt}
            onChange={(event) => setSampleStartedAt(event.target.value)}
            required
          />
        </label>
        <label className="field" htmlFor="open-audit-sample-end">
          <span>Sample window end</span>
          <input
            id="open-audit-sample-end"
            name="sampleEndedAt"
            type="datetime-local"
            value={sampleEndedAt}
            onChange={(event) => setSampleEndedAt(event.target.value)}
            required
          />
        </label>
      </div>
      <p className="field-help">
        The pair counts beside each account are lifetime totals, so preview the cohort to see what the chosen
        window and repository actually hold.
      </p>
      <button className="quiet-button" type="button" disabled={pending !== null} onClick={() => void previewCohort()}>
        Preview cohort
      </button>
      {preview === null ? null : (
        <section className="cohort-preview" aria-labelledby="cohort-preview-heading">
          <h3 id="cohort-preview-heading">Cohort preview</h3>
          <p>
            Self-work sample · {preview.comparison.selfWork.count} pairs · mean delta{" "}
            {formatSigned(preview.comparison.selfWork.meanDelta)}
          </p>
          <p>
            Outsider settlement sample · {preview.comparison.outsider.count} pairs · mean delta{" "}
            {formatSigned(preview.comparison.outsider.meanDelta)}
          </p>
          <p>Difference between means {formatSigned(preview.comparison.differenceBetweenMeans)}</p>
          <p>
            {preview.meetsMinimumSampleSize
              ? `Both samples meet the ${MINIMUM_CALIBRATION_SAMPLE_SIZE}-pair minimum.`
              : `This cohort is below the ${MINIMUM_CALIBRATION_SAMPLE_SIZE}-pair minimum, so opening the audit will be refused.`}
          </p>
        </section>
      )}
      <label className="field" htmlFor="open-audit-reason">
        <span>Reason for opening the audit</span>
        <textarea
          id="open-audit-reason"
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
        />
      </label>
      {target === null || target.openAuditId === null ? null : (
        <p className="field-help">An audit is already open for {target.githubLogin}. Resolve it before opening another.</p>
      )}
      <button
        className="action-button"
        type="button"
        disabled={pending !== null || (target !== null && target.openAuditId !== null)}
        onClick={() => void openAudit()}
      >
        Open audit
      </button>
      {pending === "preview" ? <p className="feedback pending" role="status">Loading the cohort preview…</p> : null}
      {pending === "open" ? (
        <p className="feedback pending" role="status">Opening the audit for {target?.githubLogin}…</p>
      ) : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}

function describeCandidate(candidate: AuditCandidateProjection): string {
  const summary = `${candidate.githubLogin} · ${candidate.selfWorkPairCount} self-work · ${candidate.outsiderPairCount} outsider settlements`;
  return candidate.openAuditId === null ? summary : `${summary} · audit already open`;
}

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  if (value < 0) {
    return `−${Math.abs(value)}`;
  }
  return "0";
}
