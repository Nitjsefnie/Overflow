import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";

export type RegistrationAttemptKind =
  | "REGISTRATION_START"
  | "MISSING_CATALOG_LABELS"
  | "WEBHOOK_SCOPE_MISSING"
  | "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED"
  | "NOT_PUBLIC"
  | "ALREADY_REGISTERED"
  | "OTHER";

export type RegistrationRefusalKind = Exclude<RegistrationAttemptKind, "REGISTRATION_START">;

export async function incrementRegistrationAttempt(kind: RegistrationAttemptKind, sql: SqlClient = getSql()): Promise<void> {
  await sql`
    insert into registration_attempt_counts (utc_day, kind, attempts)
    values ((now() at time zone 'UTC')::date, ${kind}, 1)
    on conflict (utc_day, kind) do update set attempts = registration_attempt_counts.attempts + 1
  `;
}

export async function recordRegistrationAttempt(
  kind: RegistrationAttemptKind,
  increment: (kind: RegistrationAttemptKind) => Promise<void> = incrementRegistrationAttempt,
): Promise<void> {
  try {
    await increment(kind);
  } catch {
    console.error("Registration attempt counter write failed.");
  }
}
