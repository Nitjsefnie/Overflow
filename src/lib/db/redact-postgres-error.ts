import postgres from "postgres";

/**
 * Drop server diagnostics (detail, where, hint, position, schema/table/column/
 * constraint names, query, parameters, and others). Keep name, message, code,
 * severity, routine, and the client-side stack. For forge text/jsonb writes,
 * PostgreSQL's NUL message says "invalid byte sequence for encoding \"UTF8\":
 * 0x00" or "unsupported Unicode escape sequence"; constraint violations put
 * values in detail. A failed cast into a typed column (integer or enum) can
 * quote the value in message, which this function deliberately retains.
 *
 * A server error is recognised by its shape as well as its class: the serving
 * build minifies the class name and bundles more than one copy of the client,
 * so neither `name` nor a single `instanceof` identifies it there. postgres.js
 * copies every ErrorResponse field onto the error, and the server always sends
 * code, severity and routine.
 */
export function redactPostgresError(error: unknown): unknown {
  if (!(error instanceof Error)
    || (!(error instanceof postgres.PostgresError) && !hasServerErrorShape(error))) return error;

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

function hasServerErrorShape(error: Error): boolean {
  const fields = error as Error & { code?: unknown; severity?: unknown; routine?: unknown };
  return typeof fields.code === "string"
    && typeof fields.severity === "string"
    && typeof fields.routine === "string";
}
