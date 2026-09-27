import postgres from "postgres";
import type { SqlClient, TransactionCallback } from "@/lib/db/types";

/** Connections available for ordinary application work. */
const WORK_POOL_MAX = 10;

/**
 * Connections reserved for reconciliation coordination.
 *
 * A session advisory lock lives on the connection that took it, so a
 * coordinator has to hold one for its whole critical section — which spans
 * every GitHub call the reconciliation makes. Taking that connection from the
 * work pool starves the work it is protecting: enough concurrent coordinators
 * and no connection is left for the queries they exist to serialize. Keeping
 * coordination on its own bounded client makes lock holding cost the work pool
 * nothing, and the bound keeps coordination from monopolizing the server.
 *
 * The bound is the work pool's own capacity because that is the coordinator
 * concurrency the shared pool already served: a coordinator that could once
 * have taken a work connection must still get a coordination connection, or
 * isolating coordination would trade starvation for a refusal at lower load.
 */
export const RECONCILIATION_COORDINATION_POOL_MAX = WORK_POOL_MAX;

/**
 * Seconds a connection attempt may take, counting from the socket connecting
 * to the server's first response. A database on the same host answers or it
 * is down, so anything above a few seconds is only the client waiting to
 * report a failure it already knows (issue 661): the library default is 30 s,
 * which is how long every caller queued behind a dead database hangs.
 */
const CONNECT_TIMEOUT_SECONDS = 5;

/**
 * Seconds a pooled connection may sit fully idle before the client closes it.
 * The library default keeps every connection forever; 5 minutes retires the
 * ones a burst left behind without touching the steady-state set (issue 661).
 */
const IDLE_TIMEOUT_SECONDS = 300;

/**
 * Seconds a pooled connection is kept before the client recycles it, bounded
 * so no connection outlives a bounded amount of server-side state. The
 * library default is a random 30-60 minutes (issue 661).
 */
const MAX_LIFETIME_SECONDS = 1800;

/**
 * The statement deadline, in milliseconds, that every connection of the work
 * pool advertises through its startup packet, so the server — not a
 * client-side race — bounds a statement that runs too long (issue 661).
 *
 * The bound this default exists for is not outage detection: a down database
 * is caught by connect_timeout (5 s) and an unreachable one fails every queued
 * caller anyway. It is a ceiling on a single statement's lifetime — lock waits
 * included — that still tolerates legitimate contention: the longest measured
 * lock-holding transaction is a fold publication at ~93 s (seeded 6,000 rows),
 * and production reconciliation runs reach p95 207 s, so 600 s sits well
 * above every observed legitimate hold (~6.5x) while still ending a
 * pathologically stuck statement or wait. Long legitimate statements opt out
 * where they run: the migration runner and the prune script lift the deadline
 * on their own connections/transactions (see those call sites).
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = "600000";

/**
 * The coordination pool advertises NO statement deadline (issue 661, task 5):
 * its statements are coordination primitives — advisory try-locks, unlock and
 * session-identity checks, the webhook-upgrade transaction lock — each fast on
 * an uncontended server, and the one blocking wait it can queue on (the
 * webhook-upgrade lock behind a slow holder) is a wait, not work. A deadline
 * there could only cancel a legitimate wait, so it is absent outright.
 */
const COORDINATION_STATEMENT_TIMEOUT_MS = "0";

type PostgresNotice = {
  severity?: string;
  severity_local?: string;
  message?: string;
};

/** Keeps PostgreSQL notices readable and separate from structured stdout. */
function reportPostgresNotice(notice: PostgresNotice): void {
  const severity = notice.severity_local ?? notice.severity ?? "NOTICE";
  const message = (notice.message ?? "PostgreSQL notice").replace(/[\r\n]+/g, " ");
  process.stderr.write(`${severity}: ${message}\n`);
}

/**
 * Reads the statement deadline the environment names, falling back to the
 * default only when the variable is UNSET. A set-but-invalid value — empty,
 * non-numeric, negative, or zero — throws at client construction, naming the
 * variable and the problem (issue 661): the value rides the startup packet of
 * every connection this client opens, and an empty string in particular
 * silently disabled the deadline the default exists to guarantee.
 */
function statementTimeoutMs(): string {
  const raw = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }
  if (!/^[0-9]+$/.test(raw) || Number.parseInt(raw, 10) === 0) {
    throw new Error(
      `DATABASE_STATEMENT_TIMEOUT_MS is set but invalid: "${raw}". ` +
        "It must be a positive whole number of milliseconds, the statement " +
        "deadline every connection of the work pool advertises to the server.",
    );
  }
  return raw;
}

/**
 * Builds one of the shared pools with the deadlines the pools carry (D4/D3 of
 * issue 661): a bounded connect phase, an idle cap, a bounded lifetime, and a
 * server-enforced statement deadline delivered as a startup parameter — the
 * server applies it session-wide, so it reaches every statement the pool
 * serves, including ones queued behind a stuck lock.
 */
function openPool(max: number, statementTimeout: string): SqlClient {
  return postgres(requireDatabaseUrl(), {
    max,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    max_lifetime: MAX_LIFETIME_SECONDS,
    onnotice: reportPostgresNotice,
    connection: {
      // The startup packet carries every parameter as text (the library
      // renders each one with `k + N + v`), so the value stays the string the
      // environment names; the library's ConnectionParameters type declares
      // number for this key, hence the widening assertion.
      statement_timeout: statementTimeout,
    } as unknown as postgres.ConnectionParameters,
  });
}

let client: SqlClient | undefined;
let coordinationClient: SqlClient | undefined;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL must be configured before using the database.");
  }
  return databaseUrl;
}

export function getSql(): SqlClient {
  if (client === undefined) {
    client = openPool(WORK_POOL_MAX, statementTimeoutMs());
  }

  return client;
}

export function getCoordinationSql(): SqlClient {
  if (coordinationClient === undefined) {
    coordinationClient = openPool(RECONCILIATION_COORDINATION_POOL_MAX, COORDINATION_STATEMENT_TIMEOUT_MS);
  }

  return coordinationClient;
}

export function withTransaction<T>(fn: TransactionCallback<T>): Promise<T> {
  return getSql().begin(fn) as Promise<T>;
}

export async function closeSql(): Promise<void> {
  const activeClient = client;
  const activeCoordinationClient = coordinationClient;
  client = undefined;
  coordinationClient = undefined;
  await Promise.all([activeClient?.end(), activeCoordinationClient?.end()]);
}
