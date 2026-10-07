import { getSql } from "@/lib/db/client";
import type { SqlClient, UserRole } from "@/lib/db/types";
import type { PersistedGitHubUser } from "@/lib/auth/sign-in-decision";
import { grantsWebhookAdministration } from "@/lib/auth/github-oauth-scopes";

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
 * The stored OAuth-token bytes for a GitHub identity, or null when no account
 * row exists or nothing is stored for it. The continuity ruling's "is there a
 * token worth protecting" read.
 */
export async function findStoredGitHubToken(
  githubUserId: number,
  sql: SqlClient = getSql(),
): Promise<Buffer | null> {
  const [row] = await sql<{ encrypted_oauth_token: Buffer | null }[]>`
    select encrypted_oauth_token
    from users
    where github_user_id = ${githubUserId}
  `;
  return row?.encrypted_oauth_token ?? null;
}

/**
 * Whether this GitHub identity sponsors at least one ACTIVE registered
 * repository (`registered_repositories.active = true`, the state both a
 * sponsor unregistration and a moderation deactivation clear). The continuity
 * ruling's "is there something the stored token still serves" read.
 */
export async function sponsorsActiveRegisteredRepository(
  githubUserId: number,
  sql: SqlClient = getSql(),
): Promise<boolean> {
  const [row] = await sql<{ sponsored: boolean }[]>`
    select exists (
      select 1
      from registered_repositories
      join users on users.id = registered_repositories.sponsor_id
      where users.github_user_id = ${githubUserId}
        and registered_repositories.active = true
    ) as sponsored
  `;
  return row?.sponsored ?? false;
}

/**
 * The sign-in continuity ruling (issue 1154): whether the storage path keeps
 * the STORED token instead of the new sign-in's. GitHub issues a new
 * authorization carrying only the scopes the sign-in requested (an
 * already-authorized account skips the consent screen), so a contributor
 * sign-in mints a zero-scope token that would otherwise overwrite the token
 * the sponsor's registered repositories' webhook repairs still spend. Keep
 * the stored token exactly when there is one, the account sponsors an active
 * registration, and the new token is not known to administer webhooks — a
 * probe that failed leaves the new token's capability unknown, and the ruling
 * reads unknown as keep (fail-safe continuity).
 */
export type StoredTokenContinuity = {
  /** The stored token bytes, or null when nothing is stored yet. */
  existingToken: Buffer | null;
  /** The scopes GitHub grants the new token, empty when unknown. */
  newTokenGrantedScopes: readonly string[];
  /** Whether the granted-scope probe failed, leaving the scopes unknown. */
  probesFailed: boolean;
  /** Whether the account sponsors at least one active registered repository. */
  sponsorsRegisteredRepository: boolean;
};

export function shouldKeepStoredGitHubToken(input: StoredTokenContinuity): boolean {
  return input.existingToken !== null
    && input.sponsorsRegisteredRepository
    && (input.probesFailed || !grantsWebhookAdministration(input.newTokenGrantedScopes));
}

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
      -- A FLOOR, never an override — but only for a LIVE row. The stored role
      -- floors against sign-in demotion while the account is live: writing
      -- excluded.role unconditionally meant a moderator granted inside the
      -- product was demoted at their next sign-in, which is what made the role
      -- ungrantable (the sign-in flow resolves the incoming role from
      -- MODERATOR_GITHUB_USER_IDS alone, in src/auth.ts's upsertGitHubIdentity).
      -- A deleted row's stored role is not a floor — deletion resets it
      -- (src/lib/accounts/deletion.ts) and re-sign-in after deletion restores
      -- as MEMBER unless the resolved sign-in role (the
      -- MODERATOR_GITHUB_USER_IDS floor, carried in excluded.role) is
      -- MODERATOR.
      role = case
        when excluded.role = 'MODERATOR' then 'MODERATOR'
        when users.role = 'MODERATOR' and users.deleted_at is null then 'MODERATOR'
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
    // The non-empty guard is defense in depth over the schema's
    // `check (length(trim(github_login)) > 0)` on users.github_login
    // (db/migrations/001_initial.sql), not a reachable branch.
    if (snapshot.state === "LIVE" && typeof snapshot.githubLogin === "string" && snapshot.githubLogin.length > 0) {
      return { ...token, name: snapshot.githubLogin };
    }
    return token;
  } catch {
    return token;
  }
}
