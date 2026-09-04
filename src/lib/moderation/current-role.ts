import { getSql } from "@/lib/db/client";
import type { SqlClient, UserRole } from "@/lib/db/types";

export async function getCurrentUserRole(
  userId: string,
  sql: SqlClient = getSql(),
): Promise<UserRole | null> {
  const [row] = await sql<{ role: UserRole }[]>`
    select role from users where id = ${userId} limit 1
  `;
  return row?.role ?? null;
}
