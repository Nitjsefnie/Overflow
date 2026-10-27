/**
 * The reserved forge label marking an issue whose text asks a contributor's
 * agent to act outside the repository (run a setup script, read files in the
 * contributor's home directory). Issue text is a prompt for a stranger's
 * agent, so the board shows the mark for the contributor to decline or
 * sandbox the issue first. The mark is opt-in: its absence vouches for nothing.
 *
 * Whoever holds label rights on the forge sets it, and it is read from the
 * labels standing on the issue when it is folded, so an edit to the issue
 * keeps it and only removing the label clears it.
 */
export const OUTSIDE_REPOSITORY_MARK_LABEL = "overflow: asks outside repository";

export function asksOutsideRepository(labels: readonly string[]): boolean {
  return labels.includes(OUTSIDE_REPOSITORY_MARK_LABEL);
}
