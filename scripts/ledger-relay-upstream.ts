// API-backed provenance and commit resolution for workflow_run verify.
// Neither an event environment nor head_branch == main establishes trust:
// a fork PR can name its branch main. Mirror and sweep use this same gate
// before any check-run or attestation lookup can target a commit.

import { PIN_SHAPE } from "./ledger-relay-decisions.ts";
import { assertShape, normalizedAttempt, SHA_40, type TriggeringRun } from "./ledger-relay-trigger.ts";

const VERIFY_RUN_TITLE = /^verify for pr suite run ([1-9][0-9]*)$/;

/** getRun reads the run by id from this repository's Actions API. */
export async function resolveWorkflowRunHead(
  runId: string,
  repositoryId: string | undefined,
  getRun: (id: string) => Promise<unknown>,
  // Only the dispatch path supplies this, reusing its already-fetched API body.
  fetchedProducer?: unknown,
): Promise<{ run: TriggeringRun; headSha: string }> {
  assertShape(repositoryId ?? "", /^[1-9][0-9]*$/, "GITHUB_REPOSITORY_ID must be the repository's numeric id");
  const body = runBody(fetchedProducer ?? (await getRun(runId)), "producer");
  if (body.path !== ".github/workflows/ci-pr.yml") {
    throw new Error("the workflow_run producer's path must be .github/workflows/ci-pr.yml");
  }
  if (body.event !== "workflow_run") {
    throw new Error("the workflow_run producer's event must be workflow_run");
  }
  const repository = body.repository as { id?: unknown } | null | undefined;
  if (typeof repository?.id !== "number" || String(repository.id) !== repositoryId) {
    throw new Error("the workflow_run producer's repository.id must match GITHUB_REPOSITORY_ID");
  }
  // An extra refusal, never sufficient evidence of trust on its own.
  if (body.head_branch !== "main") {
    throw new Error("the workflow_run producer's head branch must be main");
  }
  const title = typeof body.display_title === "string" ? body.display_title : "";
  const match = VERIFY_RUN_TITLE.exec(title);
  // JS's $ also matches before a final newline: require the whole input.
  if (match === null || match[0] !== title) {
    throw new Error("the workflow_run producer's display_title must name exactly one pr suite run id");
  }
  const run = triggeringRunFromApi(body);
  if (run.runId !== runId) {
    throw new Error("the workflow_run producer's id must match the fetched run id");
  }
  const upstream = runBody(await getRun(match[1]), "upstream");
  if (upstream.path !== ".github/workflows/pr-suite.yml") {
    throw new Error("the upstream run's path must be .github/workflows/pr-suite.yml");
  }
  if (upstream.event !== "pull_request") {
    throw new Error("the upstream run's event must be pull_request");
  }
  if (upstream.status !== "completed") {
    throw new Error("the upstream run must be completed");
  }
  const headSha = typeof upstream.head_sha === "string" ? upstream.head_sha : "";
  assertShape(headSha, SHA_40, "the upstream run's head_sha must be a 40-hex SHA");
  return { run, headSha };
}

function runBody(value: unknown, which: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the ${which} run body must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The relay's existing run-body parser, shared with upstream resolution. */
export function triggeringRunFromApi(body: Record<string, unknown>): TriggeringRun {
  const headSha = typeof body.head_sha === "string" ? body.head_sha : "";
  assertShape(headSha, SHA_40, "the fetched run's head_sha must be a 40-hex SHA");
  const path = typeof body.path === "string" ? body.path : "";
  assertShape(path, PIN_SHAPE, "the fetched run's path must be a workflow path");
  const htmlUrl = typeof body.html_url === "string" ? body.html_url : "";
  if (htmlUrl === "") {
    throw new Error("the fetched run's html_url is empty; cannot set the check-run's details_url");
  }
  return {
    runId: typeof body.id === "number" ? String(body.id) : "",
    headSha,
    path,
    conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
    htmlUrl,
    event: typeof body.event === "string" ? body.event : "",
    headBranch: typeof body.head_branch === "string" ? body.head_branch : "",
    runAttempt: normalizedAttempt(
      typeof body.run_attempt === "number" || typeof body.run_attempt === "string"
        ? body.run_attempt
        : undefined,
    ),
    // Issue 1037's primary never-started signal: the time the run began
    // executing, or null when the body names none — absent, null and empty all
    // read as absent, and the job-listing fallback decides in their place.
    runStartedAt:
      typeof body.run_started_at === "string" && body.run_started_at !== ""
        ? body.run_started_at
        : null,
    headRepository: headRepositoryFullNameOf(body),
  };
}

/** Missing head repository means unknown, never same-repository. */
export function headRepositoryFullNameOf(body: Record<string, unknown>): string {
  const headRepository =
    typeof body.head_repository === "object" && body.head_repository !== null
      ? (body.head_repository as { full_name?: unknown })
      : undefined;
  return typeof headRepository?.full_name === "string" ? headRepository.full_name : "";
}
