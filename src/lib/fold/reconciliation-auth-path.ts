import type { SqlClient } from "@/lib/db/types";

export type ReconciliationAuthPath = "github-app-installation" | "registration-app-installation" | "sponsor-oauth-fallback";

export async function recordReconciliationAuthPath(
  sql: SqlClient,
  repositoryId: string,
  authPath: ReconciliationAuthPath,
  at: Date,
): Promise<void> {
  await sql`
    update registered_repositories
    set reconciliation_auth_path = ${authPath}, reconciliation_auth_path_at = ${at}
    where id = ${repositoryId}
  `;
}
