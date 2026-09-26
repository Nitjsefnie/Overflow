import type { SqlClient } from "@/lib/db/types";

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

export type DeletedAccountRepositories = {
  ownerName: string;
  provider: string;
  instanceUrl: string | null;
}[];

export type AccountDeletionOutcome =
  | { kind: "UNKNOWN_ACCOUNT"; githubUserId: number }
  | { kind: "SPONSOR_BLOCKED"; githubUserId: number; repositories: DeletedAccountRepositories }
  | {
      kind: "PLANNED";
      githubUserId: number;
      accountId: string;
      alreadyDeleted: boolean;
      wouldRemoveApiToken: boolean;
      wouldScrubForgeIdentities: number;
      wouldClear: readonly ClearedIdentityField[];
    }
  | {
      kind: "DELETED";
      githubUserId: number;
      accountId: string;
      alreadyDeleted: boolean;
      deletedAt: string;
      removedApiTokens: number;
      scrubbedForgeIdentities: number;
    };

/**
 * Pseudonymise one account, identified by its public GitHub user id, inside
 * ONE transaction. Every outcome writes nothing but its own documented effect:
 *
 * - the account row keeps its id and github_user_id but loses login, avatar
 *   and OAuth token, and gains a deleted_at stamp (kept original on re-run, so
 *   the statement is idempotent);
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

    const removedApiTokens = await tx<{ id: string }[]>`
      delete from api_tokens where user_id = ${account.id} returning id
    `;
    const scrubbedForgeIdentities = await tx<{ id: string }[]>`
      update user_forge_identities
      set encrypted_token = null,
          forge_login = ${DELETED_ACCOUNT_LOGIN},
          token_failed_at = coalesce(token_failed_at, now())
      where user_id = ${account.id}
      returning id
    `;
    // One statement clears avatar, token and sets the stamp together: the
    // users_deleted_account_scrubbed_check admits no half-scrubbed state.
    const [scrubbed] = await tx<{ deleted_at: Date }[]>`
      update users
      set github_login = ${DELETED_ACCOUNT_LOGIN},
          avatar_url = null,
          encrypted_oauth_token = null,
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where id = ${account.id}
      returning deleted_at
    `;

    return {
      kind: "DELETED",
      githubUserId,
      accountId: account.id,
      alreadyDeleted,
      deletedAt: scrubbed!.deleted_at.toISOString(),
      removedApiTokens: removedApiTokens.length,
      scrubbedForgeIdentities: scrubbedForgeIdentities.length,
    };
  });
}
