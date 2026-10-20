import type { SqlClient } from "@/lib/db/types";

export async function getAppInstallOfferRepositoryIds(sql: SqlClient, sponsorId: string): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`
    select id from registered_repositories
    where sponsor_id = ${sponsorId}
      and reconciliation_auth_path = 'sponsor-oauth-fallback'
      and registration_method = 'oauth_hook'
      and provider = 'github'
  `;
  return new Set(rows.map((row) => row.id));
}
