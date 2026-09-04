"use client";

import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type { ActualDifficultyLabel, OpeningDifficultyLabel } from "@/lib/domain/difficulty-scheme";

export type RepositoryFormValues = {
  repositoryUrl: string;
  openingName: string;
  actualName: string;
  openingLabels: OpeningDifficultyLabel[];
  actualLabels: ActualDifficultyLabel[];
};

type Feedback = { kind: "error" | "success"; message: string } | null;

type OpeningLabelRow = OpeningDifficultyLabel & { rowId: string };

type RepositoryFormState = Omit<RepositoryFormValues, "openingLabels"> & {
  openingLabels: OpeningLabelRow[];
};

type RepositoryFormProps = {
  initialValues?: RepositoryFormValues;
};

const defaultValues: RepositoryFormValues = {
  repositoryUrl: "",
  openingName: "Opening catalog",
  actualName: "Result catalog",
  openingLabels: [
    { label: "Opening label A", comparisonPoints: 3, reservePoints: 3 },
    { label: "Opening label B", comparisonPoints: 6, reservePoints: 6 },
    { label: "Opening label C", comparisonPoints: 9, reservePoints: 9 },
  ],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({
    label: `Result label ${index + 1}`,
    points: index + 1,
  })),
};

export function RepositoryForm({ initialValues = defaultValues }: RepositoryFormProps) {
  const nextOpeningRowId = useRef(initialValues.openingLabels.length);
  const [values, setValues] = useState<RepositoryFormState>(() => createFormState(initialValues));
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!isSingleRepository(values.repositoryUrl)) {
      setFeedback({ kind: "error", message: "Enter one owner/name or one GitHub repository URL." });
      return;
    }
    if (!hasCompleteCatalog(values)) {
      setFeedback({ kind: "error", message: "Give every catalog entry a label and a points mapping." });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(toRegistrationInput(values)),
      });
      const body = (await response.json().catch(() => null)) as RegistrationResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "Repository registration could not be completed. Check the setup and try again.",
        });
        return;
      }

      const ownerName = body?.repository?.ownerName ?? values.repositoryUrl.trim();
      setFeedback({ kind: "success", message: `${ownerName} is registered.` });
    } catch {
      setFeedback({
        kind: "error",
        message: "Repository registration could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="repository-form surface shadow-offset" aria-label="Register one repository" onSubmit={submit} noValidate>
      <div className="form-intro">
        <p className="eyebrow">Explicit registration</p>
        <h1>Register one repository</h1>
        <p>You need GitHub administrator permission for this one repository. Its catalogs stay yours to name.</p>
      </div>

      <label className="field">
        <span>GitHub repository</span>
        <input
          name="repositoryUrl"
          value={values.repositoryUrl}
          onChange={(event) => setValues((current) => ({ ...current, repositoryUrl: event.target.value }))}
          placeholder="owner/repository or https://github.com/owner/repository"
          autoComplete="url"
          required
        />
      </label>

      <div className="form-grid">
        <label className="field">
          <span>Opening catalog display name</span>
          <input
            value={values.openingName}
            onChange={(event) => setValues((current) => ({ ...current, openingName: event.target.value }))}
            required
          />
        </label>
        <label className="field">
          <span>Actual catalog display name</span>
          <input
            value={values.actualName}
            onChange={(event) => setValues((current) => ({ ...current, actualName: event.target.value }))}
            required
          />
        </label>
      </div>

      <fieldset className="catalog-fieldset">
        <legend>Opening catalog</legend>
        <p className="field-help">Set any labels and their comparison and reservation points.</p>
        <div className="catalog-rows">
          {values.openingLabels.map((openingLabel, index) => (
            <div className="catalog-row" key={openingLabel.rowId}>
              <label className="field">
                <span>Opening label {index + 1}</span>
                <input
                  value={openingLabel.label}
                  onChange={(event) => updateOpeningLabel(setValues, index, "label", event.target.value)}
                  required
                />
              </label>
              <label className="field compact-field">
                <span>Comparison points for opening label {index + 1}</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={openingLabel.comparisonPoints}
                  onChange={(event) =>
                    updateOpeningLabel(setValues, index, "comparisonPoints", Number(event.target.value))
                  }
                  required
                />
              </label>
              <label className="field compact-field">
                <span>Reserve points for opening label {index + 1}</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={openingLabel.reservePoints}
                  onChange={(event) => updateOpeningLabel(setValues, index, "reservePoints", Number(event.target.value))}
                  required
                />
              </label>
              <button
                className="quiet-button"
                type="button"
                onClick={() => removeOpeningLabel(setValues, index)}
                disabled={values.openingLabels.length === 1}
              >
                Remove label {index + 1}
              </button>
            </div>
          ))}
        </div>
        <button className="quiet-button" type="button" onClick={() => addOpeningLabel(setValues, nextOpeningRowId)}>
          Add opening label
        </button>
      </fieldset>

      <fieldset className="catalog-fieldset">
        <legend>Actual catalog</legend>
        <p className="field-help">Every point from 1 through 10 must have exactly one editable label.</p>
        <div className="catalog-rows actual-catalog">
          {values.actualLabels.map((actualLabel) => (
            <div className="catalog-row actual-row" key={actualLabel.points}>
              <label className="field">
                <span>Actual label for {actualLabel.points} point{actualLabel.points === 1 ? "" : "s"}</span>
                <input
                  value={actualLabel.label}
                  onChange={(event) => updateActualLabel(setValues, actualLabel.points, event.target.value)}
                  required
                />
              </label>
              <p className="points-stamp">{actualLabel.points} points</p>
            </div>
          ))}
        </div>
      </fieldset>

      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
      <button className="action-button" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Registering…" : "Register repository"}
      </button>
    </form>
  );
}

type RegistrationResponse = {
  repository?: { ownerName?: string };
  error?: { message?: string };
};

function createFormState(values: RepositoryFormValues): RepositoryFormState {
  return {
    ...values,
    openingLabels: values.openingLabels.map((label, index) => ({ ...label, rowId: `opening-label-${index}` })),
    actualLabels: values.actualLabels.map((label) => ({ ...label })),
  };
}

function toRegistrationInput(values: RepositoryFormState): RepositoryFormValues {
  return {
    repositoryUrl: values.repositoryUrl,
    openingName: values.openingName,
    actualName: values.actualName,
    openingLabels: values.openingLabels.map((label) => ({
      label: label.label,
      comparisonPoints: label.comparisonPoints,
      reservePoints: label.reservePoints,
    })),
    actualLabels: values.actualLabels.map((label) => ({ ...label })),
  };
}

function updateOpeningLabel(
  setValues: Dispatch<SetStateAction<RepositoryFormState>>,
  index: number,
  field: "label" | "comparisonPoints" | "reservePoints",
  value: string | number,
) {
  setValues((current) => ({
    ...current,
    openingLabels: current.openingLabels.map((label, labelIndex) => {
      if (labelIndex !== index) {
        return label;
      }
      if (field === "label") {
        return { ...label, label: value as string };
      }
      if (field === "comparisonPoints") {
        return { ...label, comparisonPoints: value as number };
      }
      return { ...label, reservePoints: value as number };
    }),
  }));
}

function updateActualLabel(
  setValues: Dispatch<SetStateAction<RepositoryFormState>>,
  points: number,
  label: string,
) {
  setValues((current) => ({
    ...current,
    actualLabels: current.actualLabels.map((actualLabel) =>
      actualLabel.points === points ? { ...actualLabel, label } : actualLabel,
    ),
  }));
}

function addOpeningLabel(
  setValues: Dispatch<SetStateAction<RepositoryFormState>>,
  nextOpeningRowId: { current: number },
) {
  setValues((current) => ({
    ...current,
    openingLabels: [
      ...current.openingLabels,
      {
        rowId: `opening-label-${nextOpeningRowId.current++}`,
        label: `Opening label ${current.openingLabels.length + 1}`,
        comparisonPoints: 1,
        reservePoints: 1,
      },
    ],
  }));
}

function removeOpeningLabel(
  setValues: Dispatch<SetStateAction<RepositoryFormState>>,
  index: number,
) {
  setValues((current) => ({
    ...current,
    openingLabels: current.openingLabels.filter((_, labelIndex) => labelIndex !== index),
  }));
}

function isSingleRepository(value: string): boolean {
  const submitted = value.trim();
  const shorthand = submitted.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand !== null) {
    return isRepositoryReference(shorthand[1]!, shorthand[2]!);
  }
  try {
    const url = new URL(submitted);
    const path = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      path.length === 2 &&
      isRepositoryReference(path[0]!, path[1]!)
    );
  } catch {
    return false;
  }
}

function isRepositoryReference(owner: string, repositoryName: string): boolean {
  return isGitHubRepositorySegment(owner) && isGitHubRepositorySegment(repositoryName.replace(/\.git$/i, ""));
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function hasCompleteCatalog(values: RepositoryFormState): boolean {
  if (values.openingName.trim().length === 0 || values.actualName.trim().length === 0) {
    return false;
  }
  if (values.openingLabels.length === 0 || values.actualLabels.length !== 10) {
    return false;
  }
  const actualPoints = new Set(values.actualLabels.map((label) => label.points));
  if (actualPoints.size !== 10 || [...actualPoints].some((points) => points < 1 || points > 10)) {
    return false;
  }
  return [
    ...values.openingLabels.map((label) => label.label.trim().length > 0 && isPointValue(label.comparisonPoints) && isPointValue(label.reservePoints)),
    ...values.actualLabels.map((label) => label.label.trim().length > 0 && isPointValue(label.points)),
  ].every(Boolean);
}

function isPointValue(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}
