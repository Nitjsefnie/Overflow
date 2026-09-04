import postgres from "postgres";
import type { SqlClient, TransactionCallback } from "@/lib/db/types";

let client: SqlClient | undefined;

export function getSql(): SqlClient {
  if (client === undefined) {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error("DATABASE_URL must be configured before using the database.");
    }

    client = postgres(databaseUrl, { max: 10 });
  }

  return client;
}

export function withTransaction<T>(fn: TransactionCallback<T>): Promise<T> {
  return getSql().begin(fn) as Promise<T>;
}

export async function closeSql(): Promise<void> {
  const activeClient = client;
  client = undefined;
  await activeClient?.end();
}
