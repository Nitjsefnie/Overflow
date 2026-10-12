// Shared no-polling supersession rule for verify and its late relay publication.
// A higher-id PR suite at the same head supersedes regardless of its status.
// A rerun supersedes the attempt verify judged, or a verify created before the
// upstream's current run_started_at. Incomplete evidence fails closed.

const PATH = ".github/workflows/pr-suite.yml";
type Body = Record<string, unknown>;
type Certificate = { judgedAttempt: number } | { verifyCreatedAt: unknown };

export function suiteRunsUrl(apiRoot: string, repo: string, headSha: string, page = 1): string {
  return `${apiRoot}/repos/${repo}/actions/workflows/pr-suite.yml/runs` +
    `?head_sha=${headSha}&event=pull_request&per_page=100&page=${page}`;
}

/** One complete pass over a bounded history, never a wait for it to change. */
export async function readSuiteRuns(readPage: (page: number) => Promise<unknown>): Promise<Body> {
  const runs: unknown[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const reply = await readPage(page);
    const body = typeof reply === "object" && reply !== null ? reply as Body : {};
    const count = body.total_count;
    const entries = body.workflow_runs;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(entries)) {
      throw new Error("the suite supersession page is malformed");
    }
    if (total !== undefined && count !== total) throw new Error("suite total_count changed between pages");
    total = count;
    if (total > 1000) throw new Error("suite history exceeds 10 pages / 1000 runs");
    const expected = Math.min(100, total - runs.length);
    if (entries.length !== expected) throw new Error(`suite page ${page} expected ${expected} entries; short or oversized page refused`);
    for (const entry of entries) {
      const id = typeof entry === "object" && entry !== null ? (entry as Body).id : undefined;
      if (!positive(id)) throw new Error("the suite supersession page contains no usable run id");
      if (ids.has(id)) throw new Error(`duplicate suite run id ${id} across pages`);
      ids.add(id);
      runs.push(entry);
    }
    if (runs.length === total) return { total_count: total, workflow_runs: runs };
  }
  throw new Error("suite history exceeds 10 pages / 1000 runs");
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
