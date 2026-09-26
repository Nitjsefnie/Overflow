import postgres from "postgres";

/** Drop server fields that can quote the row or query being written. */
export function redactPostgresError(error: unknown): unknown {
  if (!(error instanceof postgres.PostgresError)) return error;

  const redacted = new Error(error.message);
  redacted.name = error.name;
  return Object.assign(redacted, {
    code: error.code,
    severity: error.severity,
    routine: error.routine,
  });
}
