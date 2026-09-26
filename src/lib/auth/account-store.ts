import { getSql } from "@/lib/db/client";
import type { SqlClient, UserRole } from "@/lib/db/types";
import type { PersistedGitHubUser } from "@/lib/auth/sign-in-decision";

/**
 * The liveness state of the GitHub account row, as the session refresh reads
 * it: a LIVE row keeps the session, a DELETED row ends it, and a MISSING row
 * was never there (or dropped out from under an old JWT) — that is today's
 * stale-session route, unchanged.
 */
export type SessionAccountState = "LIVE" | "DELETED" | "MISSING";

/**
 * What the session refresh reads about the account row: its liveness state,
 * and — for a LIVE row — the `github_login` the refreshed token must carry as
 * its name, so a token minted before the session held only the public
 * identity (a display name, an e-mail) loses both at its next refresh. The
 * login is null whenever there is no LIVE row to read it from.
 */
export type SessionAccountSnapshot = {
  state: SessionAccountState;
  githubLogin: string | null;
};

/**
 * The one writer of `users.github_login`/`avatar_url`/`encrypted_oauth_token`:
 * the sign-in upsert, moved verbatim from `src/auth.ts`. On conflict it also
 * clears `deleted_at` IN THE SAME statement that restores the avatar and the
 * OAuth token — the `users_deleted_account_scrubbed_check` admits no
 * half-restored state, and this is the exact shape it allows (a later GitHub
 * sign-in re-registers the account).
 */
export async function upsertGitHubAccount(
  input: {
    githubUserId: number;
    login: string;
    avatarUrl: string | null;
    role: UserRole;
    encryptedAccessToken: Buffer;
  },
  sql: SqlClient = getSql(),
): Promise<PersistedGitHubUser> {
  const [user] = await sql<PersistedGitHubUser[]>`
    insert into users (
      github_user_id,
      github_login,
      avatar_url,
      role,
      encrypted_oauth_token
    )
    values (
      ${input.githubUserId},
      ${input.login},
      ${input.avatarUrl},
      ${input.role},
      ${input.encryptedAccessToken}
    )
    on conflict (github_user_id) do update
    set
      github_login = excluded.github_login,
      avatar_url = excluded.avatar_url,
      -- A FLOOR, never an override. Writing excluded.role unconditionally meant
      -- a moderator granted inside the product was demoted at their next
      -- sign-in, which is what made the role ungrantable. See resolveSignInRole.
      role = case
        when excluded.role = 'MODERATOR' or users.role = 'MODERATOR' then 'MODERATOR'
        else 'MEMBER'
      end::user_role,
      encrypted_oauth_token = excluded.encrypted_oauth_token,
      deleted_at = null,
      updated_at = now()
    returning id, role
  `;
  if (user === undefined) {
    throw new Error("GitHub identity upsert returned no user.");
  }
  return user;
}

/**
 * Finds the persisted account by its public GitHub user id, moved verbatim
 * from `src/auth.ts`. Deliberately NOT filtered on `deleted_at`: the jwt
 * sign-in branch re-reads id and role, and the upsert above restores a deleted
 * row in the same sign-in.
 */
export async function findGitHubAccount(
  githubUserId: number,
  sql: SqlClient = getSql(),
): Promise<PersistedGitHubUser | null> {
  const [user] = await sql<PersistedGitHubUser[]>`
    select id, role
    from users
    where github_user_id = ${githubUserId}
    limit 1
  `;
  return user ?? null;
}

/**
 * Reads only what the session's account row contributes to a refresh: the
 * liveness stamp (LIVE for a row with no `deleted_at`, DELETED for a
 * pseudonymised one, MISSING for no row at all) and, for a LIVE row, its
 * `github_login`. One narrow select so the jwt refresh re-reads the minimum
 * it needs.
 */
export async function findSessionAccountState(
  userId: string,
  sql: SqlClient = getSql(),
): Promise<SessionAccountSnapshot> {
  const [row] = await sql<{ deleted_at: Date | null; github_login: string }[]>`
    select deleted_at, github_login from users where id = ${userId}
  `;
  if (row === undefined) {
    return { state: "MISSING", githubLogin: null };
  }
  return row.deleted_at === null
    ? { state: "LIVE", githubLogin: row.github_login }
    : { state: "DELETED", githubLogin: null };
}

/**
 * The jwt-callback refresh gate: a token whose `userId` is a string survives
 * only when its account is not DELETED, and a LIVE account names the
 * refreshed token with the row's `github_login` — a pre-fix token's display
 * name and e-mail therefore leave at its next refresh. MISSING keeps today's
 * downstream `/session?reason=stale` handling (the token passes through
 * untouched); a lookup that throws fails open (returns the token) because
 * every data route re-reads the database anyway, and failing closed would
 * sign everyone out on a database blip.
 */
export async function refreshSessionToken<T extends { userId?: unknown }>(
  token: T,
  lookup: (id: string) => Promise<SessionAccountSnapshot>,
): Promise<T | null> {
  if (typeof token.userId !== "string") {
    return token;
  }
  try {
    const snapshot = await lookup(token.userId);
    if (snapshot.state === "DELETED") {
      return null;
    }
    if (snapshot.state === "LIVE" && typeof snapshot.githubLogin === "string" && snapshot.githubLogin.length > 0) {
      return { ...token, name: snapshot.githubLogin };
    }
    return token;
  } catch {
    return token;
  }
}
