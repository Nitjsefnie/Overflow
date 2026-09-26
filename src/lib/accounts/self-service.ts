import type { SqlClient } from "@/lib/db/types";

/** Resolve a cookie-session UUID to the public identity used by account operations. */
export async function findLiveAccountIdentity(
  sql: SqlClient,
  userId: string,
): Promise<{ githubUserId: number; githubLogin: string } | null> {
  const [row] = await sql<{ github_user_id: string; github_login: string }[]>`
    select github_user_id, github_login from users
    where id = ${userId} and deleted_at is null limit 1
  `;
  return row === undefined
    ? null
    : { githubUserId: Number(row.github_user_id), githubLogin: row.github_login };
}
