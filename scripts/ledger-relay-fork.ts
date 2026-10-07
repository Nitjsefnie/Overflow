// The ledger relay's fork-head liveness decision (issue 1142), in its own
// module because scripts/ledger-relay.ts sits at its tooling-family line
// ceiling and this block is one cohesive unit: proving a fork head's owner
// from the run body, and deciding liveness from the base repository's open
// pulls at `head=<owner>:<branch>`. Pure functions: the relay issues the
// requests and turns a live verdict into the byte-identical throw (issue
// 1083's visibility) and a dead one into the visible exit-0 refusal.

/**
 * A fork head's owner login, as the `head=` query parameter can carry it:
 * non-empty, no "/", no whitespace, no control character. GitHub's own login
 * rules are narrower; the gate proves only what the parameter needs.
 */
export const VALID_FORK_OWNER = /^[^\s/\u0000-\u001f\u007f]+$/;

/**
 * The fork head's owner login, read from the run body's
 * `head_repository.owner.login` (issue 1142). The login must be present and
 * carry only characters the `head=` parameter can; when the same object also
 * names `head_repository.full_name`, the login must equal the name's prefix
 * before the first "/". Throws otherwise, before any request: an unprovable
 * owner fails closed, keeping the refusal visible. A missing full_name is
 * nothing to cross-check — a present, valid login proceeds on its own.
 */
export function forkOwnerLoginOf(body: Record<string, unknown>): string {
  const headRepository =
    typeof body.head_repository === "object" && body.head_repository !== null
      ? (body.head_repository as { full_name?: unknown; owner?: { login?: unknown } | undefined })
      : undefined;
  const ownerLogin =
    typeof headRepository?.owner?.login === "string" ? headRepository.owner.login : "";
  if (!VALID_FORK_OWNER.test(ownerLogin)) {
    throw new Error(
      `the run body's head_repository.owner.login (${JSON.stringify(ownerLogin)}) is missing or ` +
        "invalid; the fork head's liveness cannot be read, so the refusal stays visible",
    );
  }
  const fullName = typeof headRepository?.full_name === "string" ? headRepository.full_name : "";
  if (fullName !== "" && (fullName.split("/")[0] ?? "") !== ownerLogin) {
    throw new Error(
      `the run body's head_repository.full_name (${JSON.stringify(fullName)}) does not begin ` +
        `with the owner login (${JSON.stringify(ownerLogin)}); the fork head's liveness cannot ` +
        "be read, so the refusal stays visible",
    );
  }
  return ownerLogin;
}

/**
 * Whether the base repository's open pulls from the fork head name the run's
 * head SHA — true only when some entry's `head.sha` equals it exactly, so an
 * open pull request from the same branch whose tip has moved is a dead head.
 * A non-array listing throws (fail closed); a malformed entry is skipped, and
 * an entry whose `head.sha` is not a string cannot match.
 */
export function openPullAtForkHead(listing: unknown, headSha: string): boolean {
  if (!Array.isArray(listing)) {
    throw new Error("the fork's open-pull-request listing returned no array");
  }
  for (const entry of listing) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { head?: { sha?: unknown } | undefined };
    const prHeadSha = typeof candidate.head?.sha === "string" ? candidate.head.sha : "";
    if (prHeadSha === headSha) {
      return true;
    }
  }
  return false;
}
