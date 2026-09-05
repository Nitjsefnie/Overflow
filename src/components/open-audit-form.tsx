"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MINIMUM_CALIBRATION_SAMPLE_SIZE, type CalibrationSummary } from "@/lib/calibration/statistics";
import type { AuditCandidateProjection, ModerationRepositoryProjection } from "@/lib/dashboard/queries";

type Feedback = { kind: "error" | "success"; message: string } | null;
type PendingRequest = "preview" | "open";

/** The selections a preview was fetched for, as the moderator entered them. */
type CohortSelection = {
  targetAccountId: string;
  repositoryId: string;
  sampleStartedAt: string;
  sampleEndedAt: string;
};

/** The sample window as unambiguous instants, resolved in the moderator's timezone. */
type SampleWindow = {
  startedAt: string;
  endedAt: string;
};

type CohortSummary = Pick<CalibrationSummary, "count" | "meanDelta">;

type CohortComparison = {
  selfWork: CohortSummary;
  outsider: CohortSummary;
  differenceBetweenMeans: number;
};

type CohortPreview = {
  comparison: CohortComparison;
  meetsMinimumSampleSize: boolean;
};

type LoadedCohortPreview = CohortPreview & {
  selection: CohortSelection;
};

type OpenAuditFormProps = {
  candidates: AuditCandidateProjection[];
  repositories: ModerationRepositoryProjection[];
};

type CohortPreviewResponse = {
  preview?: unknown;
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
  const [preview, setPreview] = useState<LoadedCohortPreview | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const target = candidates.find((candidate) => candidate.id === targetAccountId) ?? null;
  const selection: CohortSelection = { targetAccountId, repositoryId, sampleStartedAt, sampleEndedAt };
  // Both inputs are wall-clock strings with no offset. Reading them here resolves them in
  // the moderator's timezone; sending them raw would let the server's timezone decide which
  // merged pairs the window admits.
  const sampleWindow = readSampleWindow(selection.sampleStartedAt, selection.sampleEndedAt);
  const hasCohortSelection = target !== null && sampleWindow !== null;
  // A preview describes the selections it was fetched for, so it stops being an answer about
  // this form the moment any of them changes.
  const currentPreview = preview !== null && isSameSelection(preview.selection, selection) ? preview : null;

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
      const parameters = new URLSearchParams(selection);
      if (selection.repositoryId.length === 0) {
        parameters.delete("repositoryId");
      }
      parameters.set("sampleStartedAt", sampleWindow.startedAt);
      parameters.set("sampleEndedAt", sampleWindow.endedAt);

      const response = await fetch(`/api/moderation/cohort?${parameters.toString()}`, {
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as CohortPreviewResponse | null;
      if (!response.ok) {
        setPreview(null);
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The cohort preview could not be loaded. Check the sample window and try again.",
        });
        return;
      }
      const loaded = readCohortPreview(body?.preview);
      if (loaded === null) {
        setPreview(null);
        setFeedback({
          kind: "error",
          message: "The cohort preview could not be read. Check the sample window and try again.",
        });
        return;
      }
      setPreview({ ...loaded, selection });
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
          sampleStartedAt: sampleWindow.startedAt,
          sampleEndedAt: sampleWindow.endedAt,
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
            disabled={pending === "preview"}
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
            disabled={pending === "preview"}
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
            disabled={pending === "preview"}
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
            disabled={pending === "preview"}
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
      {currentPreview === null ? null : (
        <section className="cohort-preview" aria-labelledby="cohort-preview-heading">
          <h3 id="cohort-preview-heading">Cohort preview</h3>
          <p>Previewed {describeSelection(currentPreview.selection, candidates, repositories)}</p>
          <p>
            Self-work sample · {currentPreview.comparison.selfWork.count} pairs · mean delta{" "}
            {formatSigned(currentPreview.comparison.selfWork.meanDelta)}
          </p>
          <p>
            Outsider settlement sample · {currentPreview.comparison.outsider.count} pairs · mean delta{" "}
            {formatSigned(currentPreview.comparison.outsider.meanDelta)}
          </p>
          <p>Difference between means {formatSigned(currentPreview.comparison.differenceBetweenMeans)}</p>
          <p>
            {currentPreview.meetsMinimumSampleSize
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

function readSampleWindow(sampleStartedAt: string, sampleEndedAt: string): SampleWindow | null {
  const startedAt = new Date(sampleStartedAt);
  const endedAt = new Date(sampleEndedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }
  return { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
}

function isSameSelection(left: CohortSelection, right: CohortSelection): boolean {
  return (
    left.targetAccountId === right.targetAccountId &&
    left.repositoryId === right.repositoryId &&
    left.sampleStartedAt === right.sampleStartedAt &&
    left.sampleEndedAt === right.sampleEndedAt
  );
}

/** Reads exactly the fields the preview block renders, so a partial 200 is a message and not a crash. */
function readCohortPreview(value: unknown): CohortPreview | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { comparison, meetsMinimumSampleSize } = value as Record<string, unknown>;
  if (typeof meetsMinimumSampleSize !== "boolean" || typeof comparison !== "object" || comparison === null) {
    return null;
  }
  const { selfWork, outsider, differenceBetweenMeans } = comparison as Record<string, unknown>;
  const selfWorkSummary = readCohortSummary(selfWork);
  const outsiderSummary = readCohortSummary(outsider);
  if (selfWorkSummary === null || outsiderSummary === null || typeof differenceBetweenMeans !== "number") {
    return null;
  }
  return {
    comparison: { selfWork: selfWorkSummary, outsider: outsiderSummary, differenceBetweenMeans },
    meetsMinimumSampleSize,
  };
}

function readCohortSummary(value: unknown): CohortSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { count, meanDelta } = value as Record<string, unknown>;
  if (typeof count !== "number" || typeof meanDelta !== "number") {
    return null;
  }
  return { count, meanDelta };
}

function describeSelection(
  selection: CohortSelection,
  candidates: AuditCandidateProjection[],
  repositories: ModerationRepositoryProjection[],
): string {
  const login =
    candidates.find((candidate) => candidate.id === selection.targetAccountId)?.githubLogin ?? "the chosen account";
  const scope =
    selection.repositoryId.length === 0
      ? "all repositories"
      : repositories.find((repository) => repository.id === selection.repositoryId)?.ownerName ?? "the chosen repository";
  return `${login} · ${scope} · ${selection.sampleStartedAt} to ${selection.sampleEndedAt}`;
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
