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
