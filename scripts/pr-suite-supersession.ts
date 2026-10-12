// Shared no-polling supersession rule for verify and its late relay publication.
// A higher-id PR suite at the same head supersedes regardless of its status.
// A rerun supersedes the attempt verify judged, or a verify created before the
// upstream's current run_started_at. Incomplete evidence fails closed.

const PATH = ".github/workflows/pr-suite.yml";
type Body = Record<string, unknown>;
type Certificate = { judgedAttempt: number } | { verifyCreatedAt: unknown };

export function suiteRunsUrl(apiRoot: string, repo: string, headSha: string): string {
  return `${apiRoot}/repos/${repo}/actions/workflows/pr-suite.yml/runs` +
    `?head_sha=${headSha}&event=pull_request&per_page=100`;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function time(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`the supersession check requires ${field}`);
  return parsed;
}

export function supersedingSuiteRunId(upstream: Body, listing: unknown, certificate: Certificate): number | undefined {
  if (!positive(upstream.id)) throw new Error("the supersession check requires an upstream run id");
  let rerun = false;
  if ("judgedAttempt" in certificate) {
    if (!positive(upstream.run_attempt) || !positive(certificate.judgedAttempt) ||
        upstream.run_attempt < certificate.judgedAttempt) {
      throw new Error("the supersession check requires a consistent upstream run_attempt");
    }
    rerun = upstream.run_attempt > certificate.judgedAttempt;
  } else {
    rerun = time(upstream.run_started_at, "upstream run_started_at") >
      time(certificate.verifyCreatedAt, "verify created_at");
  }
  const body = typeof listing === "object" && listing !== null ? listing as Body : {};
  const runs = body.workflow_runs;
  if (!Array.isArray(runs) || typeof body.total_count !== "number" ||
      !Number.isSafeInteger(body.total_count) || body.total_count !== runs.length) {
    throw new Error("the suite supersession listing is incomplete; refusing unread or malformed evidence");
  }
  let newer: number | undefined;
  for (const entry of runs) {
    if (typeof entry !== "object" || entry === null) continue;
    const run = entry as Body;
    if (run.path !== PATH || run.event !== "pull_request" || run.head_sha !== upstream.head_sha) continue;
    if (!positive(run.id)) throw new Error("the suite supersession listing has a matching run without an id");
    if (run.id > upstream.id && (newer === undefined || run.id > newer)) newer = run.id;
  }
  return newer ?? (rerun ? upstream.id : undefined);
}

export function supersessionMessage(runId: number): string {
  return `superseded by run ${runId}; that run's verify attests`;
}
