import type { ParameterOrJSON } from "postgres";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { DELETED_ACCOUNT_LOGIN } from "@/lib/accounts/deletion";
import { repositoryLockNamespace } from "@/lib/fold/postgres-store";
import { waitForRepositoryLockRetry } from "@/lib/fold/repository-lock-retry";
import {
  DATA_SUBJECT_TOMBSTONE_LOGIN,
  scrubIssueIdentity,
  type SuppressedForgePerson,
} from "@/lib/fold/data-subject-suppression";

export { DATA_SUBJECT_TOMBSTONE_LOGIN };

/**
 * The data-subject request procedure for a person keyed by forge provider and
 * instance origin and numeric forge id (issue 1071): an operator export of every row naming the
 * person, and a removal that applies one documented decision per store and
 * records a suppression the reconciliation import checks on every later pass.
 *
 * Both operations work for a person who never signed in — no users row is
 * required. The numeric id is authoritative; logins are display copies
 * resolved from id-keyed rows (and the operator can add one with `--login` for
 * rows that carry only a login column). Where a table carries no provider
 * column, matching is scoped by the row's repository's provider and origin, so a GitHub
 * request never exports a GitLab person's rows.
 */

export type ForgePersonKey = {
  provider: string;
  forgeId: number;
  /** GitLab requires an explicit origin; GitHub defaults to github.com. */
  instanceUrl?: string;
};

export type ForgePersonRequest = ForgePersonKey & {
  /** An operator-supplied login token, widening login-only matching. */
  login?: string | null;
};

export type ForgePersonExportSection = {
  table: string;
  count: number;
  rows: Array<Record<string, unknown>>;
};

export type ForgePersonExport = {
  formatVersion: typeof FORGE_PERSON_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  requested: { provider: string; instanceUrl: string; forgeId: number; login: string | null };
  logins: string[];
  stores: ForgePersonExportSection[];
};

/**
 * The document shape a reader pins itself against: additive keys only under
 * an unchanged version, exactly as the account export's version rule reads.
 */
export const FORGE_PERSON_EXPORT_FORMAT_VERSION = 1 as const;

/**
 * The per-store removal decisions, in the order the removal applies them.
 * This table is the operator's whole policy in one place, and the runbook
 * renders the same list. `kept` entries carry the stated reason the brief and
 * the notice require.
 */
export const forgePersonRemovalDecisions: readonly {
  store: string;
  decision: "removed" | "pseudonymised" | "kept";
  reason: string;
}[] = [
  {
    store: "users",
    decision: "pseudonymised",
    reason:
      "the row, its id and its numeric id stay — the ledger attributes work by them — while the login is tombstoned, " +
      "avatar and OAuth token cleared, the role reset to MEMBER and deleted_at stamped; refused while the person " +
      "sponsors a live registration",
  },
  {
    store: "api_tokens",
    decision: "removed",
    reason: "the hash stops authenticating at once",
  },
  {
    store: "user_forge_identities",
    decision: "pseudonymised",
    reason:
      "the (provider, instance_url, forge_user_id) triple stays so authorship still resolves to the pseudonymised " +
      "account row; the token is cleared, the login tombstoned and a failure stamped",
  },
  {
    store: "registered_repositories",
    decision: "kept",
    reason: "the registration belongs to its sponsor; unregistering is the separate objection lever",
  },
  {
    store: "issues",
    decision: "pseudonymised",
    reason:
      "rows the person authored lose their body and their owner login; claim-assignee and actor-login copies naming " +
      "the person are tombstoned and their numeric ids dropped; free text other people wrote is kept",
  },
  {
    store: "pull_requests",
    decision: "pseudonymised",
    reason:
      "rows the person authored lose their body; the author login and numeric-id copies are tombstoned and dropped " +
      "while the author_id attribution key stays",
  },
  {
    store: "settlements",
    decision: "pseudonymised",
    reason:
      "creditor login and numeric-id copies are tombstoned and dropped while the creditor_id attribution key and " +
      "the settlement's own economics stay",
  },
  {
    store: "repository_reconciliation_evidence_facts",
    decision: "pseudonymised",
    reason:
      "payload identity fields — issue authors, comment authors, history actors and assignees, nested closing-PR " +
      "authors — are tombstoned in place; titles, reviews and the raw diff are kept (proof material, no reviewer identity)",
  },
  {
    store: "moderation_events",
    decision: "kept",
    reason:
      "the moderation audit trail is immutable by trigger, so its rows, states and reasons stay exactly as written; " +
      "the export lists the notes naming the person so the operator can answer the request about them by hand",
  },
  {
    store: "reconciliation_changes",
    decision: "kept",
    reason:
      "the append-only reconciliation journal is not rewritten; new entries no longer name the person because the " +
      "import scrub precedes every write, and retention prunes old entries with their run after 90 days",
  },
  {
    store: "webhook_deliveries",
    decision: "kept",
    reason:
      "not keyed by a person: receipts carry a delivery id, event name, processing state and error text, and no " +
      "column names a person",
  },
  {
    store: "the account-keyed stores",
    decision: "kept",
    reason:
      "calibration audits, self-work calibrations, moderator role changes, override and contest requests, " +
      "reconciliation runs and usage, and credit adjustments are keyed by users foreign keys — the account-side " +
      "deletion and the account export govern those when the person has an account",
  },
];

/** Validate before any transaction; a GitLab id has no authority without its instance. */
export function forgePersonInstance(request: ForgePersonKey): string {
  if (!["github", "gitlab"].includes(request.provider) || !Number.isSafeInteger(request.forgeId) || request.forgeId <= 0) {
    throw new Error("Invalid forge person.");
  }
  if (request.provider === "gitlab" && !request.instanceUrl) throw new Error("GitLab requires an instance URL.");
  const origin = normalizeInstanceUrl(request.instanceUrl ?? "https://github.com");
  if (request.provider === "github" && origin !== "https://github.com") throw new Error("Unsupported GitHub instance.");
  return origin;
}

async function personRepositoryIds(sql: SqlClient | TransactionClient, provider: string, instanceUrl: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from registered_repositories where provider = ${provider}
      and coalesce(instance_url, 'https://github.com') = ${instanceUrl}
  `;
  return rows.map((row) => row.id);
}

/** Escapes a login for a Postgres regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The word-boundary token pattern a text store matches the person's logins
 * and numeric id by. Word boundaries keep a longer identifier containing the
 * token from matching.
 */
function forgeTokenPattern(tokens: readonly string[]): string {
  return `\\m(${tokens.map((token) => escapeRegExp(token)).join("|")})\\M`;
}

/**
 * Resolves the login copies that name the person, from every id-keyed row:
 * the account row, the linked identities, authored pull requests, credited
 * settlements, and the evidence cache's issue, comment and nested
 * closing-pull-request authors.
 */
async function resolveForgePersonLogins(
  sql: SqlClient | TransactionClient,
  forgeId: number,
  provider: string,
  instanceUrl: string,
): Promise<string[]> {
  const rows = await sql.unsafe<{ login: string }[]>(`
    select distinct login from (
      select github_login as login from users
        where ${provider === "github" ? "true" : "false"} and github_user_id = $1
      union
      select forge_login from user_forge_identities where provider = $2 and instance_url = $4 and forge_user_id = $1
      union
      select pr.author_github_login from pull_requests as pr
        join registered_repositories as repositories on repositories.id = pr.repository_id
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4 and pr.author_github_user_id = $1
      union
      select settlements.creditor_github_login from settlements
        join pull_requests as pr on pr.id = settlements.pull_request_id
        join registered_repositories as repositories on repositories.id = pr.repository_id
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4 and settlements.creditor_github_user_id = $1
      union
      select unnest(logins) from data_subject_suppressions where provider = $2 and instance_url = $4 and forge_id = $1
      union
      select i.claim_assignee_github_login from issues as i
        join registered_repositories as repositories on repositories.id = i.repository_id
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4
          and i.claim_assignee_github_user_id = $1
      union
      select facts.payload->>'authorLogin' from repository_reconciliation_evidence_facts as facts
        join registered_repositories as repositories on repositories.id = facts.repository_id
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4 and facts.kind = 'issue'
          and facts.payload->>'authorGitHubUserId' = $3
      union
      select comment->>'authorLogin' from repository_reconciliation_evidence_facts as facts
        join registered_repositories as repositories on repositories.id = facts.repository_id,
        jsonb_array_elements(facts.payload->'comments') as comment
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4 and facts.kind = 'issue'
          and comment->>'authorGitHubUserId' = $3
      union
      select nested->>'authorLogin' from repository_reconciliation_evidence_facts as facts
        join registered_repositories as repositories on repositories.id = facts.repository_id,
        jsonb_array_elements(facts.payload->'closingPullRequests') as nested
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4 and facts.kind = 'issue'
          and nested->>'authorGitHubUserId' = $3
      union
      select facts.payload->>'claimAssigneeGitHubLogin' from repository_reconciliation_evidence_facts as facts
        join registered_repositories as repositories on repositories.id = facts.repository_id
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4
          and facts.kind = 'issue' and facts.payload->>'claimAssigneeGitHubUserId' = $3
      union
      select event->>'actorLogin' from repository_reconciliation_evidence_facts as facts
        join registered_repositories as repositories on repositories.id = facts.repository_id,
        jsonb_array_elements(facts.payload->'history') as event
        where repositories.provider = $2 and coalesce(repositories.instance_url, 'https://github.com') = $4
          and facts.kind = 'issue' and event->>'actorGitHubUserId' = $3
    ) as candidates
    where login is not null and length(trim(login)) > 0
  `, [forgeId, provider, String(forgeId), instanceUrl]);
  return rows.map((row) => row.login).filter((login) => login !== DATA_SUBJECT_TOMBSTONE_LOGIN && login !== DELETED_ACCOUNT_LOGIN);
}

/**
 * The users rows the request resolves to: by numeric id for GitHub, and
 * through the linked identities for every other provider. Empty for a person
 * who never signed in.
 */
async function matchedUserIds(
  sql: SqlClient | TransactionClient,
  forgeId: number,
  provider: string,
  instanceUrl: string,
): Promise<string[]> {
  if (provider === "github") {
    const rows = await sql<{ id: string }[]>`
      select id from users where github_user_id = ${forgeId}
    `;
    return rows.map((row) => row.id);
  }
  const rows = await sql<{ user_id: string }[]>`
    select identities.user_id from user_forge_identities as identities
    where identities.provider = ${provider} and identities.instance_url = ${instanceUrl} and identities.forge_user_id = ${forgeId}
  `;
  return [...new Set(rows.map((row) => row.user_id))];
}

/**
 * The access copy: every row naming the person, one section per store, each
 * with its table, its rows and its count. Section rows carry no secret
 * material — the account row's OAuth ciphertext and the identities' tokens
 * appear only as presence booleans, exactly as the account export's own
 * discipline reads. The whole document is read inside one read-only
 * repeatable-read transaction, so it is a single consistent snapshot.
 *
 * Every section query binds its own consecutive $1..$n placeholders.
 */
export async function exportForgePerson(
  sql: SqlClient,
  request: ForgePersonRequest,
): Promise<ForgePersonExport> {
  const instanceUrl = forgePersonInstance(request);
  return sql.begin(
    "isolation level repeatable read read only",
    async (tx): Promise<ForgePersonExport> => {
      const logins = await resolveForgePersonLogins(tx, request.forgeId, request.provider, instanceUrl);
      if (request.login !== null && request.login !== undefined && request.login.trim().length > 0 &&
        ![DATA_SUBJECT_TOMBSTONE_LOGIN, DELETED_ACCOUNT_LOGIN].includes(request.login.trim())) {
        logins.push(request.login.trim());
      }
      const uniqueLogins = [...new Set(logins)].sort();
      const tokenPattern = forgeTokenPattern([...uniqueLogins, String(request.forgeId)]);
      const userIds = await matchedUserIds(tx, request.forgeId, request.provider, instanceUrl);
      const repositoryIds = tx.array(await personRepositoryIds(tx, request.provider, instanceUrl));
      // One bound-parameter pair per section: a query's placeholders run $1..$n
      // consecutively, and its array carries exactly those n values — Postgres
      // rejects both a spare parameter and a spare value.
      const section = async (
        table: string,
        query: string,
        values: ParameterOrJSON<never>[],
      ): Promise<ForgePersonExportSection> => {
        const rows = await tx.unsafe<Array<{ row: Record<string, unknown> }>>(query, values);
        return { table, count: rows.length, rows: rows.map((entry) => entry.row) };
      };
      const usersProjection =
        "select to_jsonb(t.*) - 'encrypted_oauth_token' || " +
        "jsonb_build_object('hasStoredGitHubToken', t.encrypted_oauth_token is not null) as row from users as t";
      const identityProjection =
        "select to_jsonb(t.*) - 'encrypted_token' || " +
        "jsonb_build_object('hasStoredToken', t.encrypted_token is not null) as row from user_forge_identities as t";
      const stores = [
        await section("users", request.provider === "github"
          ? `${usersProjection} where t.github_user_id = $1`
          : `${usersProjection} where t.id::text = any($1::text[])`,
          request.provider === "github" ? [request.forgeId] : [sql.array(userIds)]),
        await section("user_forge_identities",
          `${identityProjection} where t.provider = $1 and t.forge_user_id = $2 and t.instance_url = $3`,
          [request.provider, request.forgeId, instanceUrl]),
        await section("issues",
          `select to_jsonb(t.*) as row from issues as t
             join registered_repositories as repositories on repositories.id = t.repository_id
             where repositories.id::text = any($1::text[]) and (
               t.owner_github_login = any($2) or t.claim_assignee_github_user_id = $3
               or (t.claim_assignee_github_user_id is null and t.claim_assignee_github_login = any($2))
               or t.opening_source_actor_login = any($2)
               or t.settled_label_actor_login = any($2)
               or t.settled_rationale_actor_login = any($2))`,
          [repositoryIds, sql.array(uniqueLogins), request.forgeId]),
        await section("pull_requests",
          `select to_jsonb(t.*) as row from pull_requests as t
             join registered_repositories as repositories on repositories.id = t.repository_id
             where repositories.id::text = any($1::text[]) and (
               t.author_github_user_id = $3 or (t.author_github_user_id is null and t.author_github_login = any($2)))`,
          [repositoryIds, sql.array(uniqueLogins), request.forgeId]),
        await section("settlements",
          `select to_jsonb(t.*) as row from settlements as t
             join pull_requests as pr on pr.id = t.pull_request_id
             join registered_repositories as repositories on repositories.id = pr.repository_id
             where repositories.id::text = any($1::text[]) and (
               t.creditor_github_user_id = $3 or (t.creditor_github_user_id is null and t.creditor_github_login = any($2)))`,
          [repositoryIds, sql.array(uniqueLogins), request.forgeId]),
        await section("repository_reconciliation_evidence_facts",
          `select to_jsonb(t.*) as row from repository_reconciliation_evidence_facts as t
             join registered_repositories as repositories on repositories.id = t.repository_id
             where repositories.id::text = any($1::text[]) and t.payload::text ~ $2`,
          [repositoryIds, tokenPattern]),
        await section("reconciliation_changes",
          `select to_jsonb(t.*) as row from reconciliation_changes as t
             join reconciliation_runs as run on run.id = t.reconciliation_run_id
             join registered_repositories as repositories on repositories.id = run.repository_id
             where ((t.before_state::text ~ $1 or t.after_state::text ~ $1)
               and repositories.id::text = any($2::text[]))`,
          [tokenPattern, repositoryIds]),
        await section("moderation_events",
          `select to_jsonb(t.*) as row from moderation_events as t
             where t.reason ~ $1
               or t.target_user_id::text = any($2)
               or t.actor_id::text = any($2)`,
          [tokenPattern, sql.array(userIds)]),
      ];
      return {
        formatVersion: FORGE_PERSON_EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        requested: { provider: request.provider, instanceUrl, forgeId: request.forgeId, login: request.login ?? null },
        logins: uniqueLogins,
        stores,
      };
    },
  );
}
/** What the removal changed, per store. */
export type ForgePersonRemovalPerStore = {
  users: number;
  apiTokens: number;
  forgeIdentities: number;
  issues: number;
  pullRequests: number;
  settlements: number;
  evidenceFacts: number;
};

/** One live registration that blocks removal, named by the refusal. */
export type ForgePersonBlockedRegistration = {
  ownerName: string;
  provider: string;
  instanceUrl: string | null;
};

export type ForgePersonRemovalOutcome =
  | { kind: "SPONSOR_BLOCKED"; provider: string; instanceUrl: string; forgeId: number; repositories: ForgePersonBlockedRegistration[] }
  | { kind: "PLANNED"; provider: string; instanceUrl: string; forgeId: number; login: string | null; perStore: ForgePersonRemovalPerStore }
  | {
      kind: "REMOVED";
      provider: string;
      instanceUrl: string;
      forgeId: number;
      login: string | null;
      suppressedAt: string;
      perStore: ForgePersonRemovalPerStore;
    };

/**
 * The per-person removal (issue 1071): one documented decision per store,
 * applied inside one transaction that takes the fold's own repository
 * advisory locks for every registered repository of the provider, so a
 * concurrent reconciliation pass either commits before the removal (and is
 * scrubbed by it) or starts after it (and sees the suppression at the import
 * check) — the pass and the removal serialize, and the window where a pass
 * that read the suppressions early could re-write the person's identifiers
 * after the removal committed is closed. The dry run writes nothing, exactly
 * as the account deletion's does. Every store query binds its own
 * consecutive $1..$n placeholders.
 */
export async function removeForgePerson(
  sql: SqlClient,
  request: ForgePersonRequest,
  options: { confirm: boolean; lockWaitMs?: number },
): Promise<ForgePersonRemovalOutcome> {
  const instanceUrl = forgePersonInstance(request);
  return sql.begin(async (tx) => {
    // The fold pass holds session-level advisory locks on the repository it
    // folds; this transaction takes the transaction-scoped form of the same
    // keys over every repository of the provider, which is exactly the set
    // whose fold passes can write this person's identifiers. Held locks make
    // the take wait with the fold's own retry shape and refuse closed when
    // the budget runs out — never race.
    const lockWaitMs = options.lockWaitMs ?? 60_000;
    const lockDeadline = Date.now() + lockWaitMs;
    let lockAttempt = 0;
    for (;;) {
      const [gate] = await tx<{ repositories: number; locked: number }[]>`
        select count(*)::int as repositories,
               count(*) filter (
                 where pg_try_advisory_xact_lock(hashtextextended(id::text, ${repositoryLockNamespace}))
               )::int as locked
        from registered_repositories where provider = ${request.provider}
          and coalesce(instance_url, 'https://github.com') = ${instanceUrl}
      `;
      if (gate!.locked === gate!.repositories) {
        break;
      }
      const remainingMs = lockDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Unable to coordinate the data-subject removal.");
      }
      await waitForRepositoryLockRetry(lockAttempt, remainingMs);
      lockAttempt += 1;
    }

    const userIds = await matchedUserIds(tx, request.forgeId, request.provider, instanceUrl);
      const repositoryIds = tx.array(await personRepositoryIds(tx, request.provider, instanceUrl));
    const blockers = userIds.length === 0
      ? []
      : await tx<{ owner_name: string; provider: string; instance_url: string | null }[]>`
        select owner_name, provider, instance_url from registered_repositories
        where sponsor_id = any(${tx.array(userIds)}::uuid[]) and unregistered_at is null
        order by owner_name
      `;
    if (blockers.length > 0) {
      return {
        kind: "SPONSOR_BLOCKED",
        provider: request.provider,
        instanceUrl,
        forgeId: request.forgeId,
        repositories: blockers.map((row) => ({
          ownerName: row.owner_name, provider: row.provider, instanceUrl: row.instance_url,
        })),
      };
    }

    const logins = await resolveForgePersonLogins(tx, request.forgeId, request.provider, instanceUrl);
    if (request.login !== null && request.login !== undefined && request.login.trim().length > 0 &&
        ![DATA_SUBJECT_TOMBSTONE_LOGIN, DELETED_ACCOUNT_LOGIN].includes(request.login.trim())) {
      logins.push(request.login.trim());
    }
    const uniqueLogins = [...new Set(logins)].sort();
    const tokenPattern = forgeTokenPattern([...uniqueLogins, String(request.forgeId)]);
    const recordedLogin = uniqueLogins[0] ?? null;

    // Each entry: the parameters the store's queries use, the UPDATE applied
    // on confirm, and the COUNT the dry run reads instead. A store whose rows
    // are rewritten in JavaScript (the evidence cache) handles both arms in
    // its own block below.
    const storeOperations: Array<{
      key: keyof ForgePersonRemovalPerStore;
      update: string;
      count: string;
      parameters: ParameterOrJSON<never>[];
    }> = [
      {
        key: "users",
        update: `update users set
            github_login = $2,
            avatar_url = null,
            encrypted_oauth_token = null,
            role = 'MEMBER',
            deleted_at = coalesce(deleted_at, now()),
            updated_at = now()
          where id::text = any($1::text[]) returning id`,
        count: `select count(*)::int as count from users where id::text = any($1::text[])`,
        parameters: [],
      },
      {
        key: "apiTokens",
        update: `delete from api_tokens where user_id::text = any($1::text[]) returning id`,
        count: `select count(*)::int as count from api_tokens where user_id::text = any($1::text[])`,
        parameters: [],
      },
      {
        key: "forgeIdentities",
        update: `update user_forge_identities set
            encrypted_token = null,
            forge_login = $4,
            token_failed_at = coalesce(token_failed_at, now())
          where provider = $2 and forge_user_id = $1 and instance_url = $3 returning id`,
        count: `select count(*)::int as count from user_forge_identities
          where provider = $2 and forge_user_id = $1 and instance_url = $3`,
        parameters: [request.forgeId, request.provider, instanceUrl],
      },
      {
        key: "pullRequests",
        update: `update pull_requests set
            body = null,
            author_github_login = $4,
            author_github_user_id = null
          where repository_id in (select id from registered_repositories where id::text = any($2::text[]))
            and (author_github_user_id = $1 or (author_github_user_id is null and author_github_login = any($3))) returning id`,
        count: `select count(*)::int as count from pull_requests
          where repository_id in (select id from registered_repositories where id::text = any($2::text[]))
            and (author_github_user_id = $1 or (author_github_user_id is null and author_github_login = any($3)))`,
        parameters: [request.forgeId, repositoryIds, tx.array(uniqueLogins)],
      },
      {
        key: "settlements",
        update: `update settlements set
            creditor_github_login = $4,
            creditor_github_user_id = null
          where pull_request_id in (
              select pr.id from pull_requests as pr
                join registered_repositories as repositories on repositories.id = pr.repository_id
                where repositories.id::text = any($2::text[]))
            and (creditor_github_user_id = $1 or (creditor_github_user_id is null and creditor_github_login = any($3))) returning id`,
        count: `select count(*)::int as count from settlements
          where pull_request_id in (
              select pr.id from pull_requests as pr
                join registered_repositories as repositories on repositories.id = pr.repository_id
                where repositories.id::text = any($2::text[]))
            and (creditor_github_user_id = $1 or (creditor_github_user_id is null and creditor_github_login = any($3)))`,
        parameters: [request.forgeId, repositoryIds, tx.array(uniqueLogins)],
      },
    ];

    // issues: three decisions whose touched rows are counted once each — a
    // row can carry the person as both author and claim assignee, so the
    // touched set is unioned, never added.
    const countOf = async (query: string, parameters: ParameterOrJSON<never>[]): Promise<number> => {
      const [row] = await tx.unsafe<{ count: number }[]>(query, parameters);
      return row?.count ?? 0;
    };
    const issuesOfProvider = "repository_id in (select id from registered_repositories where id::text = any($1::text[]))";
    const issuesOperations: Array<{ update: string; count: string; parameters: ParameterOrJSON<never>[] }> = [
      {
        update: `update issues set body = null, owner_github_login = $3
          where ${issuesOfProvider} and owner_github_login = any($2) returning id`,
        count: `select count(*)::int as count from issues
          where ${issuesOfProvider} and owner_github_login = any($2)`,
        parameters: [repositoryIds, sql.array(uniqueLogins)],
      },
      {
        update: `update issues set
            claim_assignee_github_login = $4,
            claim_assignee_github_user_id = null
          where ${issuesOfProvider}
            and (claim_assignee_github_user_id = $3 or (claim_assignee_github_user_id is null and claim_assignee_github_login = any($2))) returning id`,
        count: `select count(*)::int as count from issues
          where ${issuesOfProvider}
            and (claim_assignee_github_user_id = $3 or (claim_assignee_github_user_id is null and claim_assignee_github_login = any($2)))`,
        parameters: [repositoryIds, sql.array(uniqueLogins), request.forgeId],
      },
      {
        update: `update issues set
            opening_source_actor_login = case when opening_source_actor_login = any($2)
              then $3 else opening_source_actor_login end,
            settled_label_actor_login = case when settled_label_actor_login = any($2)
              then $3 else settled_label_actor_login end,
            settled_rationale_actor_login = case when settled_rationale_actor_login = any($2)
              then $3 else settled_rationale_actor_login end
          where ${issuesOfProvider} and (
            opening_source_actor_login = any($2)
            or settled_label_actor_login = any($2)
            or settled_rationale_actor_login = any($2)) returning id`,
        count: `select count(*)::int as count from issues
          where ${issuesOfProvider} and (
            opening_source_actor_login = any($2)
            or settled_label_actor_login = any($2)
            or settled_rationale_actor_login = any($2))`,
        parameters: [repositoryIds, sql.array(uniqueLogins)],
      },
    ];
    const issueIds = new Set<string>();
    let issuesCount = 0;
    if (options.confirm) {
      for (const operation of issuesOperations) {
        const rows = await tx.unsafe<{ id: string }[]>(
          operation.update,
          [...operation.parameters, DATA_SUBJECT_TOMBSTONE_LOGIN],
        );
        for (const row of rows) issueIds.add(row.id);
      }
      issuesCount = issueIds.size;
    } else {
      issuesCount = await countOf(`select count(*)::int as count from (
        select id from issues where ${issuesOfProvider} and owner_github_login = any($2)
        union
        select id from issues where ${issuesOfProvider}
          and (claim_assignee_github_user_id = $3 or (claim_assignee_github_user_id is null and claim_assignee_github_login = any($2)))
        union
        select id from issues where ${issuesOfProvider} and (
          opening_source_actor_login = any($2) or settled_label_actor_login = any($2)
          or settled_rationale_actor_login = any($2))
      ) as touched`, [repositoryIds, sql.array(uniqueLogins), request.forgeId]);
    }

    const perStore: ForgePersonRemovalPerStore = {
      users: 0,
      apiTokens: 0,
      forgeIdentities: 0,
      issues: issuesCount,
      pullRequests: 0,
      settlements: 0,
      evidenceFacts: 0,
    };
    const userIdsParameter = tx.array(userIds);
    for (const operation of storeOperations) {
      const operationParameters = [...operation.parameters];
      if (operation.key === "users" || operation.key === "apiTokens") {
        operationParameters.push(userIdsParameter);
      }
      if (options.confirm) {
        // The tombstone-writing updates bind it as their last placeholder; the
        // api_tokens deletion removes rows and writes nothing, and the counts
        // match rows only and never write it.
        if (operation.key !== "apiTokens") {
          operationParameters.push(DATA_SUBJECT_TOMBSTONE_LOGIN);
        }
        const rows = await tx.unsafe<{ id: string }[]>(operation.update, operationParameters);
        perStore[operation.key] = rows.length;
      } else {
        perStore[operation.key] = await countOf(operation.count, operationParameters);
      }
    }

    // Evidence cache: the payload identity fields are scrubbed in JavaScript
    // with the same definition the import path uses, and only facts that
    // actually changed are written back.
    const facts = await tx.unsafe<{
      repository_id: string; kind: string; subject_key: string; payload: unknown;
    }[]>(
      `select t.repository_id, t.kind, t.subject_key, t.payload
         from repository_reconciliation_evidence_facts as t
         join registered_repositories as repositories on repositories.id = t.repository_id
         where repositories.id::text = any($1::text[]) and t.payload::text ~ $2`,
      [repositoryIds, tokenPattern],
    );
    const person: SuppressedForgePerson = {
      forgeId: request.forgeId,
      logins: new Set(uniqueLogins),
    };
    let scrubbedFacts = 0;
    for (const fact of facts) {
      if (fact.kind !== "issue") continue;
      const payload = fact.payload as Parameters<typeof scrubIssueIdentity>[0];
      const before = JSON.stringify(payload);
      scrubIssueIdentity(payload, person);
      const after = JSON.stringify(payload);
      if (before === after) continue;
      if (!options.confirm) {
        scrubbedFacts += 1;
        continue;
      }
      const updated = await tx.unsafe<{ repository_id: string }[]>(
        `update repository_reconciliation_evidence_facts set payload = $4
           where repository_id = $1 and kind = $2 and subject_key = $3
             and payload is distinct from $4 returning repository_id`,
        [fact.repository_id, fact.kind, fact.subject_key, tx.json(payload)],
      );
      scrubbedFacts += updated.length;
    }
    perStore.evidenceFacts = scrubbedFacts;

    if (!options.confirm) {
      return {
        kind: "PLANNED",
        provider: request.provider,
        instanceUrl,
        forgeId: request.forgeId,
        login: recordedLogin,
        perStore,
      };
    }

    await tx`
      insert into data_subject_suppressions (provider, instance_url, forge_id, login, logins)
      values (${request.provider}, ${instanceUrl}, ${request.forgeId}, ${recordedLogin}, ${tx.array(uniqueLogins)}::text[])
      on conflict (provider, instance_url, forge_id) do update set
        logins = array(select distinct unnest(data_subject_suppressions.logins || excluded.logins)),
        login = coalesce(excluded.login, data_subject_suppressions.login), decided_at = now()
    `;

    return {
      kind: "REMOVED",
      provider: request.provider,
        instanceUrl,
      forgeId: request.forgeId,
      login: recordedLogin,
      suppressedAt: new Date().toISOString(),
      perStore,
    };
  });
}
