import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { SessionAccountState } from "@/lib/auth/account-store";

/**
 * The absolute session lifetime (issue 1043), in seconds: the 30 days the
 * privacy notice states. Use does not extend it — every session ends 30 days
 * after the sign-in that minted it, however often the cookie was refreshed in
 * between.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * What the session refresh reads about the account row, with the epoch added
 * to the account store's snapshot: the liveness state and — for a LIVE row —
 * the `github_login` the refreshed token must carry and the `session_epoch`
 * the token's claim is compared against. The epoch is null whenever there is
 * no LIVE row to read it from.
 */
export type SessionGuardSnapshot = {
  state: SessionAccountState;
  githubLogin: string | null;
  sessionEpoch: number | null;
};

/**
 * One query for everything the jwt refresh needs from the account row: the
 * liveness state (as `findSessionAccountState` reads it), the row's login,
 * and the row's `session_epoch`. MISSING and DELETED carry nulls — there is
 * no login to rename with and no epoch to compare against.
 */
export async function readSessionGuardState(
  userId: string,
  sql: SqlClient = getSql(),
): Promise<SessionGuardSnapshot> {
  const [row] = await sql<{ deleted_at: Date | null; github_login: string; session_epoch: number }[]>`
    select deleted_at, github_login, session_epoch from users where id = ${userId}
  `;
  if (row === undefined) {
    return { state: "MISSING", githubLogin: null, sessionEpoch: null };
  }
  if (row.deleted_at !== null) {
    return { state: "DELETED", githubLogin: null, sessionEpoch: null };
  }
  return { state: "LIVE", githubLogin: row.github_login, sessionEpoch: row.session_epoch };
}

/**
 * The one bump verb: `session_epoch = session_epoch + 1`, returning the new
 * epoch. Throws when no row carries the id — reporting success about an
 * account that is not there would tell an operator the sessions are ended
 * when nothing happened.
 */
export async function bumpSessionEpoch(
  userId: string,
  sql: SqlClient = getSql(),
): Promise<number> {
  const [row] = await sql<{ session_epoch: number }[]>`
    update users set session_epoch = session_epoch + 1 where id = ${userId} returning session_epoch
  `;
  if (row === undefined) {
    throw new Error(`session epoch bump found no user ${userId}`);
  }
  return row.session_epoch;
}

/**
 * The operator verb for ending one account's sessions (deploy/incident-response.md
 * and any future operator surface share it). Bumping the epoch ends every
 * session the account holds at their next refresh, without touching any
 * other account.
 */
export async function revokeAccountSessions(
  userId: string,
  sql: SqlClient = getSql(),
): Promise<number> {
  return bumpSessionEpoch(userId, sql);
}

/**
 * The absolute-lifetime gate: expired unless `authenticatedAt` is a finite
 * number of seconds and `nowSec` is less than the maximum age past it. A
 * missing or unusable instant is expired — fail-closed, because a token
 * minted before the claim existed is exactly the unbounded cookie issue 1043
 * is about.
 */
export function isSessionExpired(authenticatedAt: unknown, nowSec: number): boolean {
  if (typeof authenticatedAt !== "number" || !Number.isFinite(authenticatedAt)) {
    return true;
  }
  return nowSec - authenticatedAt >= SESSION_MAX_AGE_SECONDS;
}

/**
 * The epoch gate: rejected unless the token proves it was minted under the
 * row's current epoch. No row epoch (MISSING) keeps today's pass-through —
 * there is nothing to compare against, and the stale-row route is the
 * deletion gate's documented scope, not this fix's; every token, however
 * malformed its epoch claim, passes a MISSING row. A token with no usable
 * epoch claim against a LIVE row is rejected: that is a pre-fix token,
 * minted before the epoch existed, and its rejection is the deploy's
 * one-time sign-out of every cookie issued before it.
 */
export function isEpochRejected(tokenEpoch: unknown, rowEpoch: number | null): boolean {
  if (rowEpoch === null) {
    return false;
  }
  return typeof tokenEpoch !== "number" || !Number.isFinite(tokenEpoch) || tokenEpoch !== rowEpoch;
}
