import type { SqlClient, TransactionClient } from "@/lib/db/types";

/**
 * The tombstone login a deleted account carries: display text only, never a
 * key. Uniqueness is not required (013 dropped login uniqueness), so every
 * deleted account can share it.
 */
export const DELETED_ACCOUNT_LOGIN = "(deleted account)";

/**
 * The identity fields the scrub clears, named in the order the scrub statement
 * sets them. This is the whole of the pseudonymisation: the row, its id and its
 * github_user_id stay (the ledger attributes work by them); what a deleted
 * account must not keep is anything that lets anyone act as that person.
 */
const clearedFields = ["github_login", "avatar_url", "encrypted_oauth_token"] as const;

export type ClearedIdentityField = (typeof clearedFields)[number];

/** One live registration that blocks deletion, named by the refusal. */
export type BlockingRegistrations = {
  ownerName: string;
  provider: string;
  instanceUrl: string | null;
}[];

/**
 * One account's standing among the instance's live moderators: whether the
 * account is one, and how many OTHER live moderators exist. A live moderator
 * is `role = 'MODERATOR' and deleted_at is null` — the same reading the
 * moderation roster's listModerators uses — so a deleted moderator row is
 * never a survivor, and neither is an account whose row is already deleted.
 */
export type LiveModeratorStanding = {
  isLiveModerator: boolean;
  otherLiveModerators: number;
};

/**
 * The last-live-moderator read shared by the deletion path and the dashboard's
 * pre-confirm warning: one query, usable inside a transaction (the deletion)
 * or on its own (the dashboard). The count deliberately excludes the account
 * itself, so the scrub that follows inside the deletion cannot change the
 * answer.
 */
export async function findLiveModeratorStanding(
  sql: SqlClient | TransactionClient,
  accountId: string,
): Promise<LiveModeratorStanding> {
  const [row] = await sql<{ is_live_moderator: boolean; other_live_moderators: number }[]>`
    select
      (role = 'MODERATOR' and deleted_at is null) as is_live_moderator,
      (
        select count(*)::int from users as other
        where other.role = 'MODERATOR' and other.deleted_at is null
          and other.id <> ${accountId}
      ) as other_live_moderators
    from users
    where id = ${accountId}
  `;
  // An account row that is not there stands nowhere: the deletion path has
  // already locked its row by this point, so this guards only the dashboard's
  // read of an account that vanished mid-request.
  return row === undefined
    ? { isLiveModerator: false, otherLiveModerators: 0 }
    : { isLiveModerator: row.is_live_moderator, otherLiveModerators: row.other_live_moderators };
}

/**
 * Whether the account is the instance's LAST live moderator: it is a live
 * moderator and no other live moderator exists. This is a fact about the
 * warning and the journal, never a blocker — account deletion is the person's
 * erasure right and proceeds regardless (issue 1122).
 */
export function isLastLiveModeratorStanding(standing: LiveModeratorStanding): boolean {
  return standing.isLiveModerator && standing.otherLiveModerators === 0;
}

export type AccountDeletionOutcome =
  | { kind: "UNKNOWN_ACCOUNT"; githubUserId: number }
  | { kind: "SPONSOR_BLOCKED"; githubUserId: number; repositories: BlockingRegistrations }
  | {
      kind: "PLANNED";
      githubUserId: number;
      accountId: string;
      alreadyDeleted: boolean;
      wouldRemoveApiToken: boolean;
      wouldScrubForgeIdentities: number;
      wouldClear: typeof clearedFields;
    }
  | {
      kind: "DELETED";
      githubUserId: number;
      accountId: string;
      alreadyDeleted: boolean;
      deletedAt: string;
      removedApiTokens: number;
      scrubbedForgeIdentities: number;
      /**
       * Whether this deletion left the instance without a single live
       * moderator. The deletion itself always succeeds; the flag only feeds
       * the route's operator journal line and nothing else.
       */
      leftNoLiveModerator: boolean;
    };

/** Shared credential cleanup for account deletion and forge-person removal. */
export async function scrubLinkedForgeIdentities(sql: TransactionClient, userIds: readonly string[], login: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update user_forge_identities set encrypted_token = null, forge_login = ${login},
      token_failed_at = coalesce(token_failed_at, now())
    where user_id = any(${sql.array([...userIds])}::uuid[]) returning id
  `;
  return rows.length;
}

/**
 * Pseudonymise one account, identified by its public GitHub user id, inside
 * ONE transaction. Every outcome writes nothing but its own documented effect:
 *
 * - the account row keeps its id and github_user_id but loses login, avatar
 *   and OAuth token, and gains a deleted_at stamp (kept original on re-run, so
 *   the statement is idempotent) — and its role resets to MEMBER, because
 *   moderator authority does not survive deletion (the MODERATOR_GITHUB_USER_IDS
 *   floor re-applies at next sign-in);
 * - its API token rows are removed — the hash stops authenticating at once;
 * - its forge identities keep their (provider, instance_url, forge_user_id)
 *   triple — GitLab authorship resolves through it — but lose the token, and
 *   carry the tombstone login and a failure stamp;
 * - settlements, moderation events and every other referencing row are
 *   untouched.
 *
 * Deletion is refused while the account sponsors any registration that has
 * not been unregistered (`unregistered_at is null` — active OR
 * moderation-deactivated, since a moderation deactivation can be reversed).
 * The refusal and the dry run are read-only.
 */
export async function deleteAccount(
  sql: SqlClient,
  githubUserId: number,
  options: { confirm: boolean },
): Promise<AccountDeletionOutcome> {
  return sql.begin(async (tx) => {
    const [account] = await tx<{ id: string; deleted_at: Date | null }[]>`
      select id, deleted_at from users where github_user_id = ${githubUserId} for update
    `;
    if (account === undefined) {
      return { kind: "UNKNOWN_ACCOUNT", githubUserId };
    }

    const blockers = await tx<{ owner_name: string; provider: string; instance_url: string | null }[]>`
      select owner_name, provider, instance_url
      from registered_repositories
      where sponsor_id = ${account.id} and unregistered_at is null
      order by owner_name
    `;
    if (blockers.length > 0) {
      return {
        kind: "SPONSOR_BLOCKED",
        githubUserId,
        repositories: blockers.map((row) => ({
          ownerName: row.owner_name,
          provider: row.provider,
          instanceUrl: row.instance_url,
        })),
      };
    }

    const alreadyDeleted = account.deleted_at !== null;

    if (!options.confirm) {
      const [apiTokenCount] = await tx<{ count: number }[]>`
        select count(*)::int as count from api_tokens where user_id = ${account.id}
      `;
      const [forgeIdentityCount] = await tx<{ count: number }[]>`
        select count(*)::int as count from user_forge_identities where user_id = ${account.id}
      `;
      return {
        kind: "PLANNED",
        githubUserId,
        accountId: account.id,
        alreadyDeleted,
        wouldRemoveApiToken: apiTokenCount!.count > 0,
        wouldScrubForgeIdentities: forgeIdentityCount!.count,
        wouldClear: clearedFields,
      };
    }

    // Read inside the deletion's own transaction, BEFORE the scrub: the read
    // includes the account's own row, whose role the scrub resets, so after it
    // the answer would always be false. The other-moderator count excludes the
    // account itself, so the scrub cannot change the rest of the answer.
    // Accepted race: two moderators deleting concurrently can each still see
    // the other as live, so both deletions succeed while the journal line is
    // skipped on both sides — the outcomes stay correct either way.
    const standing = await findLiveModeratorStanding(tx, account.id);

    const removedApiTokens = await tx<{ id: string }[]>`
      delete from api_tokens where user_id = ${account.id} returning id
    `;
    const scrubbedForgeIdentities = await scrubLinkedForgeIdentities(tx, [account.id], DELETED_ACCOUNT_LOGIN);
    // One statement clears avatar, token, resets the role and sets the stamp
    // together: the users_deleted_account_scrubbed_check admits no
    // half-scrubbed state. The role resets to MEMBER — moderator authority
    // does not survive deletion; the MODERATOR_GITHUB_USER_IDS floor
    // re-applies at next sign-in.
    const [scrubbed] = await tx<{ deleted_at: Date }[]>`
      update users
      set github_login = ${DELETED_ACCOUNT_LOGIN},
          avatar_url = null,
          encrypted_oauth_token = null,
          role = 'MEMBER',
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where id = ${account.id}
      returning deleted_at
    `;

    // The journal flag rides on the outcome, so the route journals without a
    // second query.
    return {
      kind: "DELETED",
      githubUserId,
      accountId: account.id,
      alreadyDeleted,
      deletedAt: scrubbed!.deleted_at.toISOString(),
      removedApiTokens: removedApiTokens.length,
      scrubbedForgeIdentities,
      leftNoLiveModerator: isLastLiveModeratorStanding(standing),
    };
  });
}
