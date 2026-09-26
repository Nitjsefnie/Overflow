import postgres from "postgres";
import { startPostgresContainer } from "./postgres-container";

export const RECORD_MARKER = "forge-record-marker-721";

/** Execute the failing write from a store method and retain its original error for comparison. */
export async function withRecordBearingPostgresWrite<T>(
  work: (write: () => Promise<never>, originalError: () => postgres.PostgresError) => Promise<T>,
): Promise<T> {
  const started = await startPostgresContainer({ database: "error_redaction", user: "error_redaction", password: "error_redaction" });
  const sql = postgres(started.databaseUrl);
  try {
    await sql.unsafe(`create function "${RECORD_MARKER}"() returns void language plpgsql as $$
      begin raise exception using message = 'test write failed', detail = '${RECORD_MARKER}'; end $$`);
    let failure: unknown;
    const write = async (): Promise<never> => {
      try {
        await sql.unsafe(`select "${RECORD_MARKER}"()`);
        throw new Error("Expected the test database write to fail.");
      } catch (error) {
        if (error instanceof postgres.PostgresError) failure = error;
        throw error;
      }
    };
    const originalError = (): postgres.PostgresError => {
      if (!(failure instanceof postgres.PostgresError)) throw new Error("Expected a real PostgresError from the test database.");
      return failure;
    };
    return await work(write, originalError);
  } finally {
    await sql.end();
    await started.container.stop();
  }
}
