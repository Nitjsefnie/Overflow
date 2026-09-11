"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type { ClaimPathVerdict } from "@/lib/domain/claim-path";
import type { ActualDifficultyLabel, OpeningDifficultyLabel } from "@/lib/domain/difficulty-scheme";
import { plural } from "@/lib/plural";

export type RepositoryFormValues = {
  repositoryUrl: string;
  openingName: string;
  actualName: string;
  openingLabels: OpeningDifficultyLabel[];
  actualLabels: ActualDifficultyLabel[];
};

type Feedback = { kind: "error" | "success" | "warning"; message: string } | null;

type OpeningLabelRow = OpeningDifficultyLabel & { rowId: string };

type RepositoryFormState = Omit<RepositoryFormValues, "openingLabels"> & {
  openingLabels: OpeningLabelRow[];
};

type LabelsStatus = "idle" | "loading" | "ready" | "error";

type ForgeProvider = "github" | "gitlab";

/** The fields of a linked identity the form needs; never a token. */
type ForgeIdentityOption = {
  id: string;
  instanceUrl: string;
  forgeLogin: string;
};

type RepositoryFormProps = {
  initialValues?: RepositoryFormValues;
  /**
   * `registration` registers a new repository (POST); `catalog-change` submits
   * a replacement catalog for one already-registered repository (PATCH, issue
   * 180). The fields are the same because the payload is the same: the sponsor
   * edits the catalog they know, and settled work keeps its price either way.
   */
  variant?: "registration" | "catalog-change";
};

// Labels start empty: issue 258 removed label creation from registration, so a
// catalog may only pick labels the repository already has. The selectboxes are
// fed from the labels route once the repository reference is complete.
const defaultValues: RepositoryFormValues = {
  repositoryUrl: "",
  openingName: "Opening catalog",
  actualName: "Result catalog",
  openingLabels: [
    { label: "", comparisonPoints: 3, reservePoints: 3 },
    { label: "", comparisonPoints: 6, reservePoints: 6 },
    { label: "", comparisonPoints: 9, reservePoints: 9 },
  ],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({
    label: "",
    points: index + 1,
  })),
};

// One labels read per settled reference: the quiet period the repository
// reference must stay unchanged before the form reads its labels, so typing a
// reference does not fire one request per keystroke.
const labelsFetchDebounceMs = 300;

// The project reference the GitLab path accepts, mirrored from the
// registration rule (register.ts): a positive numeric id or a namespaced path.
function isGitLabProjectShape(project: string): boolean {
  const submitted = project.trim();
  return /^\d+$/.test(submitted) || submitted.includes("/");
}

const gitlabIntro = "You need a verified GitLab identity linked to the instance you register through. Its catalogs stay yours to name.";

const copy = {
  registration: {
    formLabel: "Register one repository",
    eyebrow: "Explicit registration",
    heading: "Register one repository",
    intro: "You need GitHub administrator permission for this one repository. Its catalogs stay yours to name.",
    submit: "Register repository",
    submitting: "Registering…",
    failure: "Repository registration could not be completed. Check the setup and try again.",
    unreachable: "Repository registration could not reach Overflow. Check your connection and try again.",
  },
  "catalog-change": {
    formLabel: "Change a repository's difficulty catalog",
    eyebrow: "Catalog change",
    heading: "Change a repository's difficulty catalog",
    intro: "Submit the replacement catalog for one registered repository, with GitHub administrator permission. Work already settled keeps its price; the change governs closures from now on.",
    submit: "Save catalog",
    submitting: "Saving…",
    failure: "The catalog change could not be completed. Check the setup and try again.",
    unreachable: "The catalog change could not reach Overflow. Check your connection and try again.",
  },
} as const;

export function RepositoryForm({ initialValues = defaultValues, variant = "registration" }: RepositoryFormProps) {
  const nextOpeningRowId = useRef(initialValues.openingLabels.length);
  const [values, setValues] = useState<RepositoryFormState>(() => createFormState(initialValues));
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isCatalogChange = variant === "catalog-change";
  const text = isCatalogChange ? copy["catalog-change"] : copy.registration;
  const [provider, setProvider] = useState<ForgeProvider>("github");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [project, setProject] = useState("");
  const [gitlabIdentities, setGitlabIdentities] = useState<ForgeIdentityOption[]>([]);
  const identitiesSequence = useRef(0);
  const identitiesRequested = useRef(false);
  const reference = parseSingleRepository(values.repositoryUrl);
  const referenceKey = reference === null ? null : `${reference.owner}/${reference.name}`;
  const referenceOwner = reference?.owner;
  const referenceName = reference?.name;
  const [catalogLabels, setCatalogLabels] = useState<string[]>([]);
  const [labelsStatus, setLabelsStatus] = useState<LabelsStatus>("idle");
  const labelsSequence = useRef(0);
  const lastReferenceKey = useRef<string | null | undefined>(undefined);

  /**
   * The reference the labels read is about, whichever forge it names: one
   * settled key and one URL for the effect below. Changing the forge changes
   * the vocabulary too, so a switch clears the catalog selections exactly as
   * an edited reference does.
   */
  const labelsRequest = useMemo<{ key: string; url: string } | null>(() => {
    if (provider === "gitlab") {
      if (instanceUrl === "" || !isGitLabProjectShape(project)) {
        return null;
      }
      const submitted = project.trim();
      return {
        key: `gitlab ${instanceUrl} ${submitted}`,
        url: `/api/repositories/labels?provider=gitlab&instance=${encodeURIComponent(instanceUrl)}&project=${encodeURIComponent(submitted)}`,
      };
    }
    if (referenceOwner === undefined || referenceName === undefined) {
      return null;
    }
    return {
      key: referenceKey!,
      url: `/api/repositories/labels?owner=${encodeURIComponent(referenceOwner)}&name=${encodeURIComponent(referenceName)}`,
    };
  }, [provider, instanceUrl, project, referenceKey, referenceOwner, referenceName]);

  // The linked identities feed the Instance select. The read is spent once,
  // on the first GitLab selection and never on the GitHub path the catalog
  // change stays on; a failed or misunderstood answer leaves the select empty,
  // and the submit refusal names the remedy.
  useEffect(() => {
    if (provider !== "gitlab" || identitiesRequested.current) {
      return;
    }
    identitiesRequested.current = true;
    const sequence = ++identitiesSequence.current;
    (async () => {
      try {
        const response = await fetch("/api/forge-identities", { credentials: "same-origin" });
        if (!response.ok) {
          throw new Error(`The forge identities request failed with HTTP ${response.status}.`);
        }
        const body = (await response.json().catch(() => null)) as { identities?: unknown } | null;
        const identities = Array.isArray(body?.identities) ? body.identities : [];
        if (identitiesSequence.current !== sequence) {
          return;
        }
        setGitlabIdentities(
          identities.filter((entry): entry is ForgeIdentityOption & { provider: string } =>
            typeof entry === "object" && entry !== null
            && typeof (entry as { id?: unknown }).id === "string"
            && typeof (entry as { instanceUrl?: unknown }).instanceUrl === "string"
            && typeof (entry as { forgeLogin?: unknown }).forgeLogin === "string"
            && typeof (entry as { provider?: unknown }).provider === "string",
          ).filter((entry) => entry.provider === "gitlab")
            .map(({ id, instanceUrl: url, forgeLogin }) => ({ id, instanceUrl: url, forgeLogin })),
        );
      } catch {
        if (identitiesSequence.current === sequence) {
          setGitlabIdentities([]);
        }
      }
    })();
  }, [provider]);

  // The selectboxes can only offer labels the referenced repository has, so
  // they read them from the labels route once the reference is complete — one
  // read for the reference that has settled, never one per keystroke. A
  // changed reference changes the vocabulary: earlier selections are cleared
  // immediately and the pending read is cancelled, so only the newest
  // reference is ever requested. The sequence counter discards any stale
  // response from a reference that has since been edited. The selections
  // survive the initial mount, so initialValues keeps working. The GitLab
  // path plugs its instance/project reference into the same discipline.
  useEffect(() => {
    if (lastReferenceKey.current !== undefined && lastReferenceKey.current !== labelsRequest?.key) {
      setValues(clearLabelSelections);
      setCatalogLabels([]);
    }
    lastReferenceKey.current = labelsRequest?.key;

    const sequence = ++labelsSequence.current;
    if (labelsRequest === null) {
      setCatalogLabels([]);
      setLabelsStatus("idle");
      return;
    }

    setLabelsStatus("loading");
    const timer = setTimeout(() => {
      fetch(labelsRequest.url, {
        credentials: "same-origin",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`The labels request failed with HTTP ${response.status}.`);
          }
          const body = (await response.json().catch(() => null)) as { labels?: unknown } | null;
          if (body === null || !Array.isArray(body.labels) || body.labels.some((label) => typeof label !== "string")) {
            throw new Error("The labels response was not understood.");
          }
          return body.labels as string[];
        })
        .then((labels) => {
          if (labelsSequence.current !== sequence) {
            return;
          }
          setCatalogLabels(labels);
          setLabelsStatus("ready");
        })
        .catch(() => {
          if (labelsSequence.current !== sequence) {
            return;
          }
          setCatalogLabels([]);
          setLabelsStatus("error");
        });
    }, labelsFetchDebounceMs);
    return () => clearTimeout(timer);
  }, [labelsRequest]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (provider === "gitlab") {
      // Client-side refusals mirror the registration rule (register.ts); the
      // server stays the backstop.
      if (gitlabIdentities.length === 0) {
        setFeedback({
          kind: "error",
          message: "No linked GitLab identity is available. Link one on the dashboard's Forge identities page, then retry.",
        });
        return;
      }
      if (instanceUrl === "") {
        setFeedback({ kind: "error", message: "Choose the GitLab instance to register through." });
        return;
      }
      if (!isGitLabProjectShape(project)) {
        setFeedback({
          kind: "error",
          message: "Submit the GitLab project as a positive numeric id or a path with namespace.",
        });
        return;
      }
    } else if (reference === null) {
      setFeedback({ kind: "error", message: "Enter one owner/name or one GitHub repository URL." });
      return;
    }
    if (!hasCompleteCatalog(values)) {
      setFeedback({ kind: "error", message: "Give every catalog entry a label and a points mapping." });
      return;
    }

    setIsSubmitting(true);
    try {
      const body = provider === "gitlab"
        ? {
            provider: "gitlab",
            instanceUrl,
            project: project.trim(),
            ...toCatalogInput(values),
          }
        : toRegistrationInput(values);
      const response = await fetch("/api/repositories", {
        method: isCatalogChange ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const responseBody = (await response.json().catch(() => null)) as RegistrationResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: responseBody?.error?.message ?? text.failure,
        });
        return;
      }

      const ownerName = responseBody?.repository?.ownerName
        ?? (provider === "gitlab" ? project.trim() : values.repositoryUrl.trim());
      if (isCatalogChange) {
        setFeedback({ kind: "success", message: catalogChangeMessage(ownerName, responseBody?.changed, responseBody?.versionNumber) });
        return;
      }
      setFeedback({
        kind: responseBody?.claimPath === "NO_EVIDENCE_FOUND" || responseBody?.claimPath === "NOT_CHECKED" ? "warning" : "success",
        message: registrationMessage(ownerName, responseBody?.initialImportScheduled, responseBody?.claimPath),
      });
    } catch {
      setFeedback({
        kind: "error",
        message: text.unreachable,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="repository-form surface shadow-offset" aria-label={text.formLabel} onSubmit={submit} noValidate>
      <div className="form-intro">
        <p className="eyebrow">{text.eyebrow}</p>
        <h1>{text.heading}</h1>
        <p>{!isCatalogChange && provider === "gitlab" ? gitlabIntro : text.intro}</p>
      </div>

      {!isCatalogChange ? (
        <label className="field">
          <span>Forge</span>
          <select
            name="forge"
            value={provider}
            onChange={(event) => setProvider(event.target.value === "gitlab" ? "gitlab" : "github")}
            required
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
      ) : null}

      {provider === "gitlab" ? (
        <>
          <div className="form-grid">
            <label className="field">
              <span>Instance</span>
              <select
                name="instanceUrl"
                value={instanceUrl}
                onChange={(event) => setInstanceUrl(event.target.value)}
                required
              >
                <option value="" disabled>Select an instance</option>
                {gitlabIdentities.map((identity) => (
                  <option key={identity.id} value={identity.instanceUrl}>
                    {identity.instanceUrl} ({identity.forgeLogin})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Project</span>
              <input
                name="project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
                placeholder="Project id or group/project"
                required
              />
            </label>
          </div>
          {project.trim() !== "" && !isGitLabProjectShape(project) ? (
            <p className="field-help">Submit the GitLab project as a positive numeric id or a path with namespace.</p>
          ) : null}
        </>
      ) : (
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
      )}

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

      {labelsStatus === "error" && provider === "github" && reference !== null ? (
        <p className="labels-fetch-error">
          Overflow could not read the labels of {reference.owner}/{reference.name}. Check that the repository is
          public and that the owner and name are correct, then edit the GitHub repository field to try again.
        </p>
      ) : null}
      {labelsStatus === "error" && provider === "gitlab" && instanceUrl !== "" ? (
        <p className="labels-fetch-error">
          Overflow could not read the labels of {project.trim()} on {instanceUrl}. Check that the project id or path
          is correct and that your linked GitLab identity still has access, then edit the Project field to try again.
        </p>
      ) : null}

      <fieldset className="catalog-fieldset">
        <legend>Opening catalog</legend>
        <p className="field-help">Set any labels and their comparison and reservation points.</p>
        <div className="catalog-rows">
          {values.openingLabels.map((openingLabel, index) => (
            <div className="catalog-row" key={openingLabel.rowId}>
              <label className="field">
                <span>Opening label {index + 1}</span>
                <select
                  value={openingLabel.label}
                  onChange={(event) => updateOpeningLabel(setValues, index, "label", event.target.value)}
                  disabled={labelsStatus !== "ready"}
                  required
                >
                  <option value="" disabled>Select a label</option>
                  {labelOptions(catalogLabels, values.openingLabels, index).map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
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
          {values.actualLabels.map((actualLabel, index) => (
            <div className="catalog-row actual-row" key={actualLabel.points}>
              <label className="field">
                <span>Actual label for {actualLabel.points} point{actualLabel.points === 1 ? "" : "s"}</span>
                <select
                  value={actualLabel.label}
                  onChange={(event) => updateActualLabel(setValues, actualLabel.points, event.target.value)}
                  disabled={labelsStatus !== "ready"}
                  required
                >
                  <option value="" disabled>Select a label</option>
                  {labelOptions(catalogLabels, values.actualLabels, index).map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
              </label>
              <p className="points-stamp">{actualLabel.points} {plural(actualLabel.points, "point")}</p>
            </div>
          ))}
        </div>
      </fieldset>

      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
      {feedback?.kind === "warning" ? <p className="feedback warning" role="status">{feedback.message}</p> : null}
      <button className="action-button" type="submit" disabled={isSubmitting}>
        {isSubmitting ? text.submitting : text.submit}
      </button>
    </form>
  );
}

type RegistrationResponse = {
  repository?: { ownerName?: string };
  initialImportScheduled?: boolean;
  claimPath?: ClaimPathVerdict;
  changed?: boolean;
  versionNumber?: number | null;
  error?: { message?: string };
};

// Registration only queues the import of the issues that already exist in the
// repository, so `true` promises that the import is coming and not that it has
// happened, and `false` means the queueing itself failed: nothing is waiting to run,
// and only the periodic repair sweep will pick the repository up. Either way the
// registration stands, so the sponsor is told which happened rather than being left
// to wonder why an empty issue list is empty.
/**
 * The one success sentence for a catalog change. A change that stored a new
 * version says which one; a submission that repeated the current catalog says
 * so, because an unchanged catalog the sponsor did not ask about reads like a
 * change that silently failed. Both promise the same invariant: nothing
 * already settled is re-priced by the change.
 */
function catalogChangeMessage(ownerName: string, changed: boolean | undefined, versionNumber: number | null | undefined): string {
  if (changed === false) {
    return `That catalog already governs ${ownerName}; nothing needed to change.`;
  }
  const version = typeof versionNumber === "number" ? ` Catalog version ${versionNumber} now governs` : "The new catalog now governs";
  return `${ownerName}'s difficulty catalog was changed.${version} work whose evidence window closes after the change; work already settled keeps its price.`;
}

function registrationMessage(
  ownerName: string,
  initialImportScheduled: boolean | undefined,
  claimPath: RegistrationResponse["claimPath"],
): string {
  let message = `${ownerName} is registered.`;
  if (initialImportScheduled === true) {
    message = `${ownerName} is registered. Its existing issues are being imported and will appear shortly.`;
  } else if (initialImportScheduled === false) {
    message = `${ownerName} is registered, but its initial import could not be scheduled. It will be picked up by the next repair sweep.`;
  }

  if (claimPath === "NO_EVIDENCE_FOUND") {
    return `${message} No workflow assigning the author of an issue comment was found in this repository. Without such a workflow, contributors cannot claim issues themselves by commenting; someone with write access must assign them before any credit is reserved. Add a workflow triggered by issue_comment that assigns the commenter; Overflow's own .github/workflows/claim.yml is a working example.`;
  }
  if (claimPath === "NOT_CHECKED") {
    return `${message} Overflow could not read this repository's workflows, so it does not know whether comment-based claiming is set up. Check the workflows yourself for one triggered by issue_comment that assigns the comment author.`;
  }
  return message;
}

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
    ...toCatalogInput(values),
  };
}

/** The catalog half of a submission, serialized identically for both forges. */
function toCatalogInput(values: RepositoryFormState) {
  return {
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
        label: "",
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

/**
 * The single repository a submission or a labels read is about, or null. The
 * same rules the server's parseGitHubRepository applies, so the labels the
 * form reads are read from exactly the repository a registration would verify.
 */
function parseSingleRepository(value: string): { owner: string; name: string } | null {
  const submitted = value.trim();
  const shorthand = submitted.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand !== null) {
    return toRepositoryReference(shorthand[1]!, shorthand[2]!);
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
      path.length === 2
    ) ? toRepositoryReference(path[0]!, path[1]!) : null;
  } catch {
    return null;
  }
}

function toRepositoryReference(owner: string, repositoryName: string): { owner: string; name: string } | null {
  const name = repositoryName.replace(/\.git$/i, "");
  if (!isGitHubRepositorySegment(owner) || !isGitHubRepositorySegment(name)) {
    return null;
  }
  return { owner, name };
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

/**
 * The labels one catalog row may offer: the fetched labels minus the ones the
 * row's siblings in the SAME catalog have already picked, so a catalog cannot
 * bind one label twice. The row's own selection always stays available.
 */
function labelOptions(labels: string[], rows: Array<{ label: string }>, ownRow: number): string[] {
  const picked = new Set(rows.flatMap((row, index): string[] => (index === ownRow ? [] : [row.label])));
  return labels.filter((label) => !picked.has(label));
}

function clearLabelSelections(current: RepositoryFormState): RepositoryFormState {
  return {
    ...current,
    openingLabels: current.openingLabels.map((label) => ({ ...label, label: "" })),
    actualLabels: current.actualLabels.map((label) => ({ ...label, label: "" })),
  };
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
