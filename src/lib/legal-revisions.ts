/**
 * The revision record of every legal document this site publishes.
 *
 * A legal document changes by being edited, and a reader in a dispute has to
 * name WHICH text governed them. The version and the effective date are what
 * they cite, so this file is the single place either value is written and the
 * pages render it — a document with no stamp cites nothing.
 *
 * The rules the values follow:
 *
 *   - Changing a document's text means changing its effective date here, in
 *     the same change that edits the text. Text that moved while its date
 *     stood still is a revision nobody can cite.
 *   - The effective date is the date the revision applies FROM, not the date
 *     it was drafted.
 *   - A dispute cites the effective date; the mapping from that date to the
 *     governing text is this repository's history.
 *
 * Nothing here moves on a build. A build-injected value fails silently — a
 * deploy that cannot resolve it would emit a placeholder that reinstates
 * exactly the defect these markers close — and the value a reader needs is a
 * fact about the document, not about the artifact.
 *
 * Distinct from SERVER_VERSION (src/lib/version.ts), which versions the HTTP
 * API and the MCP schema and moves only on a documented surface change.
 * Editing a document is not an API change, and an API bump is not a document
 * revision: the two must be free to move on their own schedules.
 */
export interface LegalRevision {
  /** Stable identity of the document; matches the marker on its page. */
  readonly document: string;
  /** The revision a reader cites alongside the effective date. */
  readonly version: string;
  /** ISO 8601 date the revision applies from. */
  readonly effectiveDate: string;
}

export const TERMS_REVISION: LegalRevision = {
  document: "terms",
  version: "1.0",
  effectiveDate: "2026-10-02",
};

export const ACCOUNT_DATA_REVISION: LegalRevision = {
  document: "account-data",
  version: "1.0",
  effectiveDate: "2026-10-02",
};

// The rules page is a legal document too, and a stronger one for disputes: the
// terms page sends a reader here, and names the Disputes section of THIS page
// as the source of truth. The stamp that makes that text citable belongs on the
// page, not only on the notice that points at it.
export const RULES_REVISION: LegalRevision = {
  document: "rules",
  version: "1.0",
  effectiveDate: "2026-10-02",
};
