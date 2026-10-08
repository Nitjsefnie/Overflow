// The minimal permission set both Ledger-App installation-token mints request
// (issue 1051): the exact union of what every GitHub API call the two scripts
// make under the minted token needs, derived call by call:
//
// - `actions: read`        — the workflow-run, workflow-run-listing and
//                            job-listing GETs (the mirror, the heal's live-run
//                            check and the orphan sweep);
// - `checks: write`        — every check-run POST (the mirror's, the sweep's
//                            and the event-policy check's neutral run), which
//                            also covers the sweep's check-runs GET (write
//                            subsumes read);
// - `pull_requests: read`  — the commit's associated-PR listing and the fork
//                            head's open-pulls listing (the heal and the
//                            untrusted-producer refusal);
// - `metadata: read`       — GitHub grants this to every installation token
//                            regardless of the request; it is named here to
//                            document the dependency every call above has.
//
// The Actions policies GET in check-actions-event-policy.ts needs
// `administration: read`, which the App's grant LACKS — no subset of the grant
// covers it, so it is deliberately absent here and that call keeps drawing its
// documented 403 (the issue-1024 neutral path). The rerun-heal's POST needs
// `actions: write`, which the mint cannot request (the App lacks it too); the
// relay runs that call under the workflow's own RELAY_RERUN_TOKEN instead, so
// it never touches this token. The enumeration of the relay's calls is pinned
// in tests/scripts/ledger-relay-mint-permissions.test.ts, the check's mint
// body in tests/scripts/check-actions-event-policy.test.ts.

/**
 * The permissions object both mint bodies send beside `repositories`, verbatim.
 */
export const LEDGER_APP_MINT_PERMISSIONS = {
  actions: "read",
  checks: "write",
  metadata: "read",
  pull_requests: "read",
} as const;
