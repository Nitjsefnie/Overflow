import postgres from "postgres";

/**
 * Drop server diagnostics (detail, where, hint, position, schema/table/column/
 * constraint names, query, parameters, and others). Keep name, message, code,
 * severity, routine, and the client-side stack. For forge text/jsonb writes,
 * PostgreSQL's NUL message says "invalid byte sequence for encoding \"UTF8\":
 * 0x00" or "unsupported Unicode escape sequence"; constraint violations put
 * values in detail. A failed cast into a typed column (integer or enum) can
 * quote the value in message, which this function deliberately retains.
 */
export function redactPostgresError(error: unknown): unknown {
  if (!(error instanceof Error)
    || (error.name !== "PostgresError" && !(error instanceof postgres.PostgresError))) return error;

  const serverError = error as Error & { code?: string; severity?: string; routine?: string };
  const redacted = new Error(error.message);
  redacted.name = error.name;
  redacted.stack = error.stack;
  return Object.assign(redacted, {
    code: serverError.code,
    severity: serverError.severity,
    routine: serverError.routine,
  });
}
