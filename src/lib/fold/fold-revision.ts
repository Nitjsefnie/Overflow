/**
 * Issue 197: identifies the fold logic that produced a derived row.
 * Bump when a change alters what the fold would write for input that did not
 * change; do not bump for refactors, comments, or unrelated edits. This is a
 * deliberately bumped integer rather than a hash of the fold source, because
 * a hash churns on every unrelated edit.
 */
export const FOLD_REVISION = 3;
