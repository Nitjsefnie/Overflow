import postgres from "postgres";
import type { SqlClient, TransactionCallback } from "@/lib/db/types";

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
 */
export const RECONCILIATION_COORDINATION_POOL_MAX = 5;

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
    client = postgres(requireDatabaseUrl(), { max: 10 });
  }

  return client;
}

export function getCoordinationSql(): SqlClient {
  if (coordinationClient === undefined) {
    coordinationClient = postgres(requireDatabaseUrl(), {
      max: RECONCILIATION_COORDINATION_POOL_MAX,
    });
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
