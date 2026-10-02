/**
 * The revision record of every legal document this site renders.
 *
 * "Legal document" here means a rendered page a reader is held to: /terms,
 * /account-data and /rules. It is not every document the site serves —
 * /third-party-notices.txt is deliberately absent, because no dispute is
 * decided by a dependency's licence text and the file is generated from
 * node_modules, so a revision record for it would fire the rule below on every
 * dependency bump. The boundary is what a reader is held to, not what is
 * published.
 *
 * A legal document changes by being edited, and a reader in a dispute has to
 * name WHICH text governed them. The version and the effective date are what
 * they cite, so this file is the single place either value is written and the
 * pages render it — a document with no stamp cites nothing.
 *
 * The conventions the values follow. These are conventions, not enforced
 * invariants: nothing in the test suite couples an edit to a page's text to an
 * edit here, and a substantive legal change that leaves these values standing
 * passes every check in the repository. Read them as what a careful author
 * does, not as a chokepoint.
 *
 *   - Changing a document's text means changing its effective date here, in
 *     the same change that edits the text. Text that moved while its date
 *     stood still is a revision nobody can cite.
 *   - An effective date is the date a revision applies FROM. It is not
 *     necessarily when the text was written: every value here is the date the
 *     stamping change landed, and the texts it stamps predate it by days to
 *     weeks. Back-dating 1.0 to a document's first publication would assert
 *     the text was in force since a date this stamp cannot evidence, so
 *     versioning begins HERE instead: a reader citing 2026-10-02 is citing the
 *     first revision whose text they can be shown, and nothing before the
 *     stamp is citable at all.
 *   - A dispute cites the effective date. For dates on or after the stamp, the
 *     mapping from that date to the governing text is this repository's
 *     history; before the stamp there is no revision to map to.
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
