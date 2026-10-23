/** Deterministic suite ids keep URL-keyed and queue-based relay HTTP fakes coherent. */
export function appChecksUrl(root: string, sha: string): string {
  return `${root}/check-suites/${(BigInt(`0x${sha}`) + 1n)}/check-runs?filter=latest&per_page=100`;
}

export function appSuitesUrl(root: string, sha: string, appId = "5118623"): string {
  return `${root}/commits/${sha}/check-suites?app_id=${appId}&per_page=100`;
}

/** One App suite per head; its checks are supplied by each test's existing check store. */
export function appSuiteListing(url: string): { total_count: number; check_suites: unknown[] } | undefined {
  const match = /\/commits\/([a-f0-9]+)\/check-suites\?/.exec(url);
  if (match === null) return;
  return { total_count: 1, check_suites: [{ id: String(BigInt(`0x${match[1]}`) + 1n),
    app: { id: new URL(url).searchParams.get("app_id") } }] };
}

/**
 * The relay's own run: every start reads its job's started_at through the
 * workflow token before any write (issue 1195), so every harness carries
 * these env values and answers that read with a job that has just started.
 */
export const RELAY_OWN_RUN_ENV = {
  GITHUB_RUN_ID: "7700", GITHUB_RUN_ATTEMPT: "1", OVERFLOW_RELAY_RERUN_TOKEN: ["rerun", "token"].join("-"),
};

export function relayJobStartUrl(root = "https://api.github.com/repos/Nitjsefnie/Overflow"): string {
  return `${root}/actions/runs/${RELAY_OWN_RUN_ENV.GITHUB_RUN_ID}/attempts/${RELAY_OWN_RUN_ENV.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
}

/** The job-start listing for the relay's own run, or undefined for any other URL. */
export function relayJobStartListing(url: string): { total_count: number; jobs: unknown[] } | undefined {
  if (!url.endsWith(`/actions/runs/${RELAY_OWN_RUN_ENV.GITHUB_RUN_ID}/attempts/${RELAY_OWN_RUN_ENV.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`)) return;
  return { total_count: 1, jobs: [{ name: "relay-required-checks", status: "in_progress", started_at: new Date().toISOString() }] };
}
