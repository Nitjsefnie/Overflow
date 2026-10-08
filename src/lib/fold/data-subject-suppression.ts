import { DELETED_ACCOUNT_LOGIN } from "@/lib/accounts/deletion";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import type { TransactionClient } from "@/lib/db/types";
import type { FoldResult } from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubIssueComment, GitHubIssueHistoryEvent, GitHubPullRequest } from "@/lib/github/types";
import type { ReconciliationSynchronization } from "@/lib/fold/reconciliation-evidence";

/**
 * The tombstone login a data-subject removal writes wherever a store held the
 * person's forge login. Nonblank, so every free-form login column and every
 * fold resolution that requires a nonblank login keeps reading it; distinct
 * from the account-deletion tombstone, because the person it names never held
 * an account row at all.
 */
export const DATA_SUBJECT_TOMBSTONE_LOGIN = "(data subject removal)";

/**
 * One suppressed person: the numeric forge id the removal was keyed by, and
 * the login copies that name them.
 *
 * The id is authoritative and the logins are display copies of rows the id
 * already names — except for the issue-owner login, which is the one column
 * that names a person with no numeric id anywhere beside it. A removal
 * resolves the login set from id-keyed rows before matching, and the fold's
 * import scrub matches the same way: by id where the schema carries one, and
 * by resolved login for owner and actor login copies.
 */
export type SuppressedForgePerson = {
  forgeId: number;
  logins: ReadonlySet<string>;
};

function namesPerson(login: string | null | undefined, person: SuppressedForgePerson): boolean {
  return login !== null && login !== undefined && person.logins.has(login);
}

/** Numeric authority wins; aliases are a fallback only when the id is absent. */
export function identityNamesPerson(login: string | null | undefined, id: number | null | undefined, person: SuppressedForgePerson): boolean {
  return id == null ? namesPerson(login, person) : id === person.forgeId;
}

/**
 * Scrubs one { login, githubUserId } pair wherever the fold's data carries it.
 * The login becomes the tombstone and the numeric id drops. Idempotent — an
 * already-tombstoned pair no longer matches, so a later pass over scrubbed
 * data is a no-op.
 */
function scrubIdentityPair(
  identity: { login: string | null; githubUserId: number | null },
  person: SuppressedForgePerson,
  writeBack: (scrubbed: { login: string; githubUserId: null }) => void,
): void {
  if (identityNamesPerson(identity.login, identity.githubUserId, person)) {
    writeBack({ login: DATA_SUBJECT_TOMBSTONE_LOGIN, githubUserId: null });
  }
}

/**
 * The identity-bearing surface of an issue payload: every shape the fold
 * snapshot and the evidence cache carry satisfies it — a fresh GitHubIssue,
 * and a narrowed cached issue whose body is gone.
 */
type IssueIdentityPayload = Pick<
  GitHubIssue,
  "authorLogin" | "authorGitHubUserId" | "claimAssigneeGitHubLogin" | "claimAssigneeGitHubUserId"
> & {
  history: GitHubIssueHistoryEvent[];
  comments: GitHubIssueComment[];
  closingPullRequests: Array<Pick<GitHubPullRequest, "authorLogin" | "authorGitHubUserId">>;
};

/**
 * Scrubs every identity field of one issue payload — the shape both the fold
 * snapshot and the evidence cache carry, so the removal's in-place rewrite of
 * stored facts and the import scrub of fresh reads share this one definition.
 * Content fields (titles, labels, history text, the raw diff) are kept: the
 * cache's free text belongs to the repository's record, and the diff is
 * settlement-proof material.
 */
export function scrubIssueIdentity(payload: IssueIdentityPayload, person: SuppressedForgePerson): void {
  scrubIdentityPair(
    { login: payload.authorLogin, githubUserId: payload.authorGitHubUserId },
    person,
    (scrubbed) => {
      payload.authorLogin = scrubbed.login;
      payload.authorGitHubUserId = scrubbed.githubUserId;
    },
  );
  scrubIdentityPair(
    { login: payload.claimAssigneeGitHubLogin, githubUserId: payload.claimAssigneeGitHubUserId },
    person,
    (scrubbed) => {
      payload.claimAssigneeGitHubLogin = scrubbed.login;
      payload.claimAssigneeGitHubUserId = scrubbed.githubUserId;
    },
  );
  for (const event of payload.history) {
    scrubIdentityPair(
      { login: event.actorLogin, githubUserId: event.actorGitHubUserId },
      person,
      (scrubbed) => {
        event.actorLogin = scrubbed.login;
        event.actorGitHubUserId = scrubbed.githubUserId;
      },
    );
    if ((event.kind === "ASSIGNED" || event.kind === "UNASSIGNED") && namesPerson(event.assigneeLogin, person)) {
      event.assigneeLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
    }
  }
  for (const comment of payload.comments) {
    scrubIdentityPair(
      { login: comment.authorLogin, githubUserId: comment.authorGitHubUserId },
      person,
      (scrubbed) => {
        comment.authorLogin = scrubbed.login;
        comment.authorGitHubUserId = scrubbed.githubUserId;
      },
    );
  }
  for (const pullRequest of payload.closingPullRequests) {
    scrubPullRequestIdentity(pullRequest, person);
  }
}

/**
 * Scrubs one pull request's author identity — the nested closing-pull-request
 * payloads inside an issue fact, and the fold's own pull-request rows.
 */
export function scrubPullRequestIdentity(
  payload: Pick<GitHubPullRequest, "authorLogin" | "authorGitHubUserId">,
  person: SuppressedForgePerson,
): void {
  scrubIdentityPair(
    { login: payload.authorLogin, githubUserId: payload.authorGitHubUserId },
    person,
    (scrubbed) => {
      payload.authorLogin = scrubbed.login;
      payload.authorGitHubUserId = scrubbed.githubUserId;
    },
  );
}

/**
 * Scrubs the fold's own output rows for one suppressed person. The attribution
 * keys the ledger needs stay: a pull request's `authorId` and a settlement's
 * `creditorId` name the account row the work is attributed by, and the
 * member-deletion policy keeps those untouched. The display identity copies —
 * the forge login strings and the numeric forge ids beside them — are what a
 * suppression replaces, wherever they name the person.
 */
export function scrubFoldResultForPerson(
  fold: FoldResult,
  person: SuppressedForgePerson,
  evidence: ReconciliationSynchronization["issues"] = [],
): void {
  for (const issue of fold.issues) {
    const source = evidence.find((row) => row.id === issue.githubIssueId);
    if (identityNamesPerson(issue.ownerGitHubLogin, source?.authorGitHubUserId, person)) {
      issue.ownerGitHubLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
    }
    if (identityNamesPerson(issue.claimAssigneeGitHubLogin, issue.claimAssigneeGitHubUserId, person)) {
      issue.claimAssigneeGitHubLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
      issue.claimAssigneeGitHubUserId = null;
    }
    if (identityNamesPerson(issue.openingSourceActorLogin, source?.history.find((event) => event.id === issue.openingSourceEventId)?.actorGitHubUserId, person)) {
      issue.openingSourceActorLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
    }
    if (identityNamesPerson(issue.settledLabelActorLogin, source?.history.find((event) => event.id === issue.settledLabelEventId)?.actorGitHubUserId, person)) {
      issue.settledLabelActorLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
    }
    if (identityNamesPerson(issue.settledRationaleActorLogin, source?.comments.find((comment) => comment.id === issue.settledRationaleCommentId)?.authorGitHubUserId, person)) {
      issue.settledRationaleActorLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
    }
  }
  for (const pullRequest of fold.pullRequests) {
    if (identityNamesPerson(pullRequest.authorGitHubLogin, pullRequest.authorGitHubUserId, person)) {
      pullRequest.authorGitHubLogin = DATA_SUBJECT_TOMBSTONE_LOGIN;
      pullRequest.authorGitHubUserId = null;
    }
  }
  for (const settlement of fold.settlements) {
    scrubIdentityPair(
      { login: settlement.creditorGitHubLogin, githubUserId: settlement.creditorGitHubUserId },
      person,
      (scrubbed) => {
        settlement.creditorGitHubLogin = scrubbed.login;
        settlement.creditorGitHubUserId = scrubbed.githubUserId;
      },
    );
  }
}

/** Learn new aliases only from numeric evidence, before any identity is scrubbed. */
function publicationAliases(publication: { fold: FoldResult; synchronization?: ReconciliationSynchronization }, person: SuppressedForgePerson): SuppressedForgePerson {
  const logins = new Set(person.logins);
  const learn = (login: string | null, id: number | null) => {
    if (id === person.forgeId && login?.trim() && login !== DATA_SUBJECT_TOMBSTONE_LOGIN && login !== DELETED_ACCOUNT_LOGIN) logins.add(login);
  };
  for (const issue of publication.synchronization?.issues ?? []) {
    learn(issue.authorLogin, issue.authorGitHubUserId);
    learn(issue.claimAssigneeGitHubLogin, issue.claimAssigneeGitHubUserId);
    for (const event of issue.history) learn(event.actorLogin, event.actorGitHubUserId);
    for (const comment of issue.comments) learn(comment.authorLogin, comment.authorGitHubUserId);
    for (const pr of issue.closingPullRequests) learn(pr.authorLogin, pr.authorGitHubUserId);
  }
  for (const pr of publication.fold.pullRequests) learn(pr.authorGitHubLogin, pr.authorGitHubUserId);
  for (const settlement of publication.fold.settlements) learn(settlement.creditorGitHubLogin, settlement.creditorGitHubUserId);
  return { ...person, logins };
}

/**
 * Scrubs one fold publication — the fold's output rows and the synchronization
 * payloads the evidence cache is written from — in place, for every suppressed
 * person. Returns the same publication.
 */
export function scrubPublicationForSuppressions(publication: {
  fold: FoldResult;
  synchronization?: ReconciliationSynchronization;
}, persons: readonly SuppressedForgePerson[]): { fold: FoldResult; synchronization?: ReconciliationSynchronization } {
  for (const storedPerson of persons) {
    const person = publicationAliases(publication, storedPerson);
    scrubFoldResultForPerson(publication.fold, person, publication.synchronization?.issues);
    if (publication.synchronization !== undefined) {
      for (const issue of publication.synchronization.issues) {
        scrubIssueIdentity(issue, person);
      }
      for (const pullRequest of publication.synchronization.pullRequests) {
        // A pull-request fact carries reviews and the raw diff only — no
        // identity fields to scrub.
        void pullRequest;
      }
    }
  }
  return publication;
}

/**
 * The import-path check (issue 1071): inside the publication transaction,
 * before any derived row or evidence fact is written, every suppressed
 * person's identity is scrubbed from what this pass is about to write.
 *
 * Sitting here — not at the read side — is what makes the removal hold: the
 * fold still reads the forge exactly as before (forward-only semantics
 * unchanged), but a pass that commits after a removal can never re-write the
 * person's identifiers, because the write path replaces them first.
 *
 * Suppressions apply only within the repository's provider and normalized origin.
 */
export async function scrubSuppressedForgeData<Publication extends {
  fold: FoldResult;
  synchronization?: ReconciliationSynchronization;
}>(
  sql: TransactionClient,
  repositoryId: string,
  publication: Publication,
): Promise<Publication> {
  const [repository] = await sql<{ provider: string; instance_url: string | null }[]>`
    select provider, instance_url from registered_repositories where id = ${repositoryId}
  `;
  if (repository === undefined) {
    return publication;
  }
  const rows = await sql<{ forge_id: number | string; logins: string[] }[]>`
    select forge_id, logins from data_subject_suppressions where provider = ${repository.provider}
      and instance_url = ${normalizeInstanceUrl(repository.instance_url ?? 'https://github.com')}
  `;
  if (rows.length === 0) {
    return publication;
  }
  const persons: SuppressedForgePerson[] = rows.map((row) => ({
    forgeId: Number(row.forge_id),
    logins: new Set(row.logins),
  })).map((person) => publicationAliases(publication, person));
  for (const person of persons) {
    await sql`
      update data_subject_suppressions set
        logins = array(select distinct unnest(logins || ${sql.array([...person.logins])}::text[]))
      where provider = ${repository.provider}
        and instance_url = ${normalizeInstanceUrl(repository.instance_url ?? "https://github.com")}
        and forge_id = ${person.forgeId}
        and not logins @> ${sql.array([...person.logins])}::text[]
    `;
  }
  scrubPublicationForSuppressions(publication, persons);
  return publication;
}
