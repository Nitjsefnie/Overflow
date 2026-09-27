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
 * The statement deadline, in milliseconds, that every connection of both
 * pools advertises through its startup packet, so the server — not a
 * client-side race — cancels a statement that runs too long (issue 661).
 *
 * Long legitimate statements opt out where they run: the migration runner and
 * the prune script lift the deadline on their own connections/transactions
 * (see those call sites).
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = "30000";

function statementTimeoutMs(): string {
  return process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS;
}

/**
 * Builds one of the shared pools with the deadlines both pools carry (D4/D3
 * of issue 661): a bounded connect phase, an idle cap, a bounded lifetime,
 * and a server-enforced statement deadline delivered as a startup parameter —
 * the server applies it session-wide, so it reaches every statement the pool
 * serves, including ones queued behind a stuck lock.
 */
function openPool(max: number): SqlClient {
  return postgres(requireDatabaseUrl(), {
    max,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    max_lifetime: MAX_LIFETIME_SECONDS,
    connection: {
      // The startup packet carries every parameter as text (the library
      // renders each one with `k + N + v`), so the value stays the string the
      // environment names; the library's ConnectionParameters type declares
      // number for this key, hence the widening assertion.
      statement_timeout: statementTimeoutMs(),
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
    client = openPool(WORK_POOL_MAX);
  }

  return client;
}

export function getCoordinationSql(): SqlClient {
  if (coordinationClient === undefined) {
    coordinationClient = openPool(RECONCILIATION_COORDINATION_POOL_MAX);
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
