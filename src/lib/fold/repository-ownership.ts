/**
 * Whether a closing pull request lives in the repository Overflow was registered
 * for. Reconciliation and the fold both have to decide this, and they have to
 * decide it identically — this is the one place either of them asks.
 *
 * A divergence is not a cosmetic inconsistency. Reconciliation skipping the
 * evidence fetch while the fold still selects the pull request leaves the
 * snapshot carrying no reviews and an empty diff, and the fold then hashes the
 * empty string into `proofSha256` and counts zero review rounds: a settlement
 * whose proof is fabricated.
 *
 * The decision is keyed on GitHub's numeric repository id, never on
 * `owner/name`. A repository can be renamed or transferred, after which GitHub
 * keeps answering for the old name while reporting the new one — so a name
 * comparison would turn every pull request in the repository's own tracker
 * foreign the moment it is renamed, unsettling work already credited. The freed
 * name can also be taken by anyone, so a name that matches proves nothing
 * either. The id survives both.
 */
export function belongsToRegisteredRepository(
  registered: { githubRepositoryId: number },
  pullRequest: { repositoryGitHubId: number },
): boolean {
  return registered.githubRepositoryId === pullRequest.repositoryGitHubId;
}
