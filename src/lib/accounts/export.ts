import type { SqlClient, TransactionClient } from "@/lib/db/types";

/**
 * The account data export: everything the database holds about one person,
 * keyed by the foreign keys that reference them. Rows of secret-bearing
 * tables are projected through explicit column lists with every secret
 * reduced to a presence boolean; everything else is the full row as jsonb.
 * The document never carries ciphertext, a token hash, or a webhook secret.
 */

export type AccountExportRow = Record<string, unknown>;

export type AccountExportAccount = {
  id: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  role: string;
  enforcementState: string;
  confirmedMiscalibrationCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hasStoredGitHubToken: boolean;
};

export type AccountExportApiToken = { createdAt: string; expiresAt: string };

export type AccountExportForgeIdentity = {
  id: string;
  provider: string;
  instanceUrl: string;
  forgeUserId: number;
  forgeLogin: string;
  verifiedAt: string;
  tokenFailedAt: string | null;
  createdAt: string;
  hasStoredToken: boolean;
};

export type AccountExportSponsoredRepository = {
  id: string;
  ownerName: string;
  provider: string;
  instanceUrl: string | null;
  active: boolean;
  unregisteredAt: string | null;
  createdAt: string;
};

export type AccountExport = {
  formatVersion: typeof ACCOUNT_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  account: AccountExportAccount;
  apiToken: AccountExportApiToken | null;
  forgeIdentities: AccountExportForgeIdentity[];
  sponsoredRepositories: AccountExportSponsoredRepository[];
  settlements: { asCreditor: AccountExportRow[]; asDebtor: AccountExportRow[] };
  authoredPullRequests: AccountExportRow[];
  moderationEvents: { asTarget: AccountExportRow[]; asActor: AccountExportRow[] };
  calibrationAudits: {
    asAccount: AccountExportRow[];
    asReporter: AccountExportRow[];
    asModerator: AccountExportRow[];
  };
  selfWorkCalibrations: AccountExportRow[];
  moderatorRoleChanges: { asTarget: AccountExportRow[]; asActor: AccountExportRow[] };
  settlementOverrideRequests: { asRequester: AccountExportRow[]; asDecider: AccountExportRow[] };
  reconciliationRuns: { asRequester: AccountExportRow[]; asGraphqlCostSponsor: AccountExportRow[] };
  repositoryReconciliationUsage: AccountExportRow[];
  moderationCreditAdjustments: AccountExportRow[];
  moderationCreditAdjustmentLines: AccountExportRow[];
};

export const ACCOUNT_EXPORT_FORMAT_VERSION = 1 as const;

/**
 * The declared coverage of the export: one entry per foreign key to
 * `users`, naming the referencing table, the referencing column, the export
 * path the referenced person's rows appear under, and, for jsonb sections,
 * the columns that order a section deterministically. The coverage test reads
 * the catalogue's foreign keys to `users` and pins this list to them, so a
 * new referencing table cannot ship unexported.
 *
 * The two kinds discriminate how a section is rendered, and the loader is
 * selected on that kind — never on the table name — so a future
 * secret-bearing table declared `"explicit"` without a dedicated loader fails
 * loudly instead of falling through to a full-row export.
 */
export type UserForeignKeyExportEntry =
  | {
      table: string;
      column: string;
      kind: "jsonb";
      /** Dot path into the export document where the rows are placed. */
      path: string;
      /** The columns that order a section deterministically. */
      orderBy: readonly string[];
    }
  | {
      table: string;
      column: string;
      kind: "explicit";
      /** The dedicated secret-free loader that renders this table's section. */
      loader: "apiToken" | "sponsoredRepositories" | "forgeIdentities";
    };

export const userForeignKeyExports: readonly UserForeignKeyExportEntry[] = [
  // Secret-bearing tables: explicit column lists, secrets as booleans.
  { table: "api_tokens", column: "user_id", kind: "explicit", loader: "apiToken" },
  {
    table: "registered_repositories",
    column: "sponsor_id",
    kind: "explicit",
    loader: "sponsoredRepositories",
  },
  {
    table: "user_forge_identities",
    column: "user_id",
    kind: "explicit",
    loader: "forgeIdentities",
  },
  // Everything else: the full row as jsonb.
  { table: "settlements", column: "creditor_id", path: "settlements.asCreditor", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "settlements", column: "debtor_id", path: "settlements.asDebtor", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "pull_requests", column: "author_id", path: "authoredPullRequests", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "self_work_calibrations", column: "user_id", path: "selfWorkCalibrations", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "calibration_audits", column: "account_id", path: "calibrationAudits.asAccount", kind: "jsonb", orderBy: ["opened_at", "id"] },
  { table: "calibration_audits", column: "reporter_id", path: "calibrationAudits.asReporter", kind: "jsonb", orderBy: ["opened_at", "id"] },
  { table: "calibration_audits", column: "moderator_id", path: "calibrationAudits.asModerator", kind: "jsonb", orderBy: ["opened_at", "id"] },
  { table: "moderation_events", column: "target_user_id", path: "moderationEvents.asTarget", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "moderation_events", column: "actor_id", path: "moderationEvents.asActor", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "moderator_role_changes", column: "target_account_id", path: "moderatorRoleChanges.asTarget", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "moderator_role_changes", column: "actor_id", path: "moderatorRoleChanges.asActor", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "settlement_override_requests", column: "requester_id", path: "settlementOverrideRequests.asRequester", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "settlement_override_requests", column: "decided_by_id", path: "settlementOverrideRequests.asDecider", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "reconciliation_runs", column: "requested_by_user_id", path: "reconciliationRuns.asRequester", kind: "jsonb", orderBy: ["started_at", "id"] },
  { table: "reconciliation_runs", column: "graphql_cost_sponsor_id", path: "reconciliationRuns.asGraphqlCostSponsor", kind: "jsonb", orderBy: ["started_at", "id"] },
  {
    table: "repository_reconciliation_usage",
    column: "sponsor_id",
    path: "repositoryReconciliationUsage",
    kind: "jsonb",
    // No created_at or id here: the composite key orders deterministically.
    orderBy: ["measured_at", "repository_id"],
  },
  { table: "moderation_credit_adjustments", column: "target_account_id", path: "moderationCreditAdjustments", kind: "jsonb", orderBy: ["created_at", "id"] },
  { table: "moderation_credit_adjustment_lines", column: "creditor_id", path: "moderationCreditAdjustmentLines", kind: "jsonb", orderBy: ["adjustment_id", "settlement_id"] },
];

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Either the pooled client or the read-only transaction that snapshots one
 * export: every loader runs inside that transaction, so each accepts both.
 */
type ExportClient = SqlClient | TransactionClient;

/**
 * Full rows of one referencing table for one user. Identifiers are
 * interpolated from the module's own constant table above, never from input;
 * only the user id is a bound parameter.
 */
async function loadJsonbRows(
  sql: ExportClient,
  userId: string,
  entry: Extract<UserForeignKeyExportEntry, { kind: "jsonb" }>,
): Promise<AccountExportRow[]> {
  const orderClause = entry.orderBy.map((column) => `"${column}"`).join(", ");
  const rows = await sql.unsafe<{ row: AccountExportRow }[]>(
    `select to_jsonb(t) as row from ${entry.table} as t` +
      ` where t.${entry.column} = $1 order by ${orderClause}`,
    [userId],
  );
  return rows.map((row) => row.row);
}

async function loadSponsoredRepositories(
  sql: ExportClient,
  userId: string,
): Promise<AccountExportSponsoredRepository[]> {
  return sql<readonly {
    id: string;
    owner_name: string;
    provider: string;
    instance_url: string | null;
    active: boolean;
    unregistered_at: Date | null;
    created_at: Date;
  }[]>`
    select id, owner_name, provider, instance_url, active, unregistered_at, created_at
    from registered_repositories
    where sponsor_id = ${userId}
    order by owner_name
  `.then((rows) =>
    rows.map((row) => ({
      id: row.id,
      ownerName: row.owner_name,
      provider: row.provider,
      instanceUrl: row.instance_url,
      active: row.active,
      unregisteredAt: isoOrNull(row.unregistered_at),
      createdAt: iso(row.created_at),
    })),
  );
}

async function loadForgeIdentities(
  sql: ExportClient,
  userId: string,
): Promise<AccountExportForgeIdentity[]> {
  return sql<readonly {
    id: string;
    provider: string;
    instance_url: string;
    forge_user_id: string;
    forge_login: string;
    verified_at: Date;
    token_failed_at: Date | null;
    created_at: Date;
    has_stored_token: boolean;
  }[]>`
    select id, provider, instance_url, forge_user_id, forge_login, verified_at, token_failed_at,
           created_at, encrypted_token is not null as has_stored_token
    from user_forge_identities
    where user_id = ${userId}
    order by created_at, id
  `.then((rows) =>
    rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      instanceUrl: row.instance_url,
      forgeUserId: Number(row.forge_user_id),
      forgeLogin: row.forge_login,
      verifiedAt: iso(row.verified_at),
      tokenFailedAt: isoOrNull(row.token_failed_at),
      createdAt: iso(row.created_at),
      hasStoredToken: row.has_stored_token,
    })),
  );
}

async function loadApiToken(sql: ExportClient, userId: string): Promise<AccountExportApiToken | null> {
  const [row] = await sql<{ created_at: Date; expires_at: Date }[]>`
    select created_at, expires_at from api_tokens where user_id = ${userId}
  `;
  return row === undefined
    ? null
    : { createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) };
}

function setSection(document: AccountExport, path: string, rows: AccountExportRow[]): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let target: unknown = document;
  for (const key of keys) {
    target = (target as Record<string, unknown>)[key]!;
  }
  (target as Record<string, unknown>)[last] = rows;
}

/**
 * Everything the database holds about one person, or null for an unknown
 * GitHub user id. The whole document is read inside ONE read-only
 * repeatable-read transaction, so it is a single consistent snapshot and the
 * database itself enforces that nothing writes. Works identically on a
 * deleted account — the row survives pseudonymisation, so its export does too.
 */
export async function exportAccount(
  sql: SqlClient,
  githubUserId: number,
): Promise<AccountExport | null> {
  return sql.begin(
    "isolation level repeatable read read only",
    async (tx): Promise<AccountExport | null> => {
      const [account] = await tx<{
        id: string;
        github_user_id: string;
        github_login: string;
        avatar_url: string | null;
        role: string;
        enforcement_state: string;
        confirmed_miscalibration_count: number;
        created_at: Date;
        updated_at: Date;
        deleted_at: Date | null;
        has_stored_github_token: boolean;
      }[]>`
        select id, github_user_id, github_login, avatar_url, role, enforcement_state,
               confirmed_miscalibration_count, created_at, updated_at, deleted_at,
               encrypted_oauth_token is not null as has_stored_github_token
        from users
        where github_user_id = ${githubUserId}
      `;
      if (account === undefined) {
        return null;
      }

      const document: AccountExport = {
        formatVersion: ACCOUNT_EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        account: {
          id: account.id,
          githubUserId: Number(account.github_user_id),
          githubLogin: account.github_login,
          avatarUrl: account.avatar_url,
          role: account.role,
          enforcementState: account.enforcement_state,
          confirmedMiscalibrationCount: account.confirmed_miscalibration_count,
          createdAt: iso(account.created_at),
          updatedAt: iso(account.updated_at),
          deletedAt: isoOrNull(account.deleted_at),
          hasStoredGitHubToken: account.has_stored_github_token,
        },
        apiToken: null,
        forgeIdentities: [],
        sponsoredRepositories: [],
        settlements: { asCreditor: [], asDebtor: [] },
        authoredPullRequests: [],
        moderationEvents: { asTarget: [], asActor: [] },
        calibrationAudits: { asAccount: [], asReporter: [], asModerator: [] },
        selfWorkCalibrations: [],
        moderatorRoleChanges: { asTarget: [], asActor: [] },
        settlementOverrideRequests: { asRequester: [], asDecider: [] },
        reconciliationRuns: { asRequester: [], asGraphqlCostSponsor: [] },
        repositoryReconciliationUsage: [],
        moderationCreditAdjustments: [],
        moderationCreditAdjustmentLines: [],
      };

      // The loader is selected on the entry's declared kind. An explicit-kind
      // entry whose dedicated loader is missing throws here instead of
      // falling through to a full-row export of a secret-bearing table.
      for (const entry of userForeignKeyExports) {
        switch (entry.kind) {
          case "explicit":
            switch (entry.loader) {
              case "apiToken":
                document.apiToken = await loadApiToken(tx, account.id);
                break;
              case "sponsoredRepositories":
                document.sponsoredRepositories = await loadSponsoredRepositories(tx, account.id);
                break;
              case "forgeIdentities":
                document.forgeIdentities = await loadForgeIdentities(tx, account.id);
                break;
              default: {
                throw new Error(`no dedicated export loader for ${entry.table}.${entry.column}`);
              }
            }
            break;
          case "jsonb":
            setSection(document, entry.path, await loadJsonbRows(tx, account.id, entry));
            break;
        }
      }
      return document;
    },
  );
}
