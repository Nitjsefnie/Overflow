import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { closeSql } from "@/lib/db/client";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "registration_counts", user: "registration_counts" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl);
});

afterAll(async () => {
  await closeSql();
  await sql?.end();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
  vi.resetModules();
});

it("stores only UTC day, kind and count regardless of the session timezone", async () => {
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'registration_attempt_counts' order by ordinal_position
  `;
  expect(columns.map(({ column_name }) => column_name)).toEqual(["utc_day", "kind", "attempts"]);

  const { incrementRegistrationAttempt } = await vi.importActual<typeof import("@/lib/stats/registration-attempts")>(
    "@/lib/stats/registration-attempts",
  );
  await sql.begin(async (transaction) => {
    await transaction`select set_config('TimeZone', case when extract(hour from now() at time zone 'UTC') < 10
      then 'Pacific/Honolulu' else 'Pacific/Kiritimati' end, true)`;
    const [today] = await transaction<{ utc_day: string; local_day: string }[]>`
      select (now() at time zone 'UTC')::date::text as utc_day, current_date::text as local_day
    `;
    expect(today!.local_day).not.toBe(today!.utc_day);
    for (const kind of ["MISSING_CATALOG_LABELS", "WEBHOOK_SCOPE_MISSING", "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED",
      "NOT_PUBLIC", "ALREADY_REGISTERED", "OTHER"] as const) {
      await incrementRegistrationAttempt(kind, transaction as unknown as Sql);
    }
    const rows = await transaction<{ utc_day: string; kind: string; attempts: number }[]>`
      select utc_day::text, kind, attempts from registration_attempt_counts order by kind
    `;
    expect(rows).toEqual([
      { utc_day: today!.utc_day, kind: "ALREADY_REGISTERED", attempts: 1 },
      { utc_day: today!.utc_day, kind: "MISSING_CATALOG_LABELS", attempts: 1 },
      { utc_day: today!.utc_day, kind: "NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED", attempts: 1 },
      { utc_day: today!.utc_day, kind: "NOT_PUBLIC", attempts: 1 },
      { utc_day: today!.utc_day, kind: "OTHER", attempts: 1 },
      { utc_day: today!.utc_day, kind: "WEBHOOK_SCOPE_MISSING", attempts: 1 },
    ]);
  });
  await expect(sql`insert into registration_attempt_counts values ('2000-01-02', 'OTHER', 0)`).rejects.toThrow();
  await expect(sql`insert into registration_attempt_counts values ('2000-01-02', 'UNKNOWN', 1)`).rejects.toThrow();
});

it("uses the default client and atomically sums concurrent increments", async () => {
  const { incrementRegistrationAttempt } = await vi.importActual<typeof import("@/lib/stats/registration-attempts")>(
    "@/lib/stats/registration-attempts",
  );
  await incrementRegistrationAttempt("REGISTRATION_START");
  const [initial] = await sql<{ total: number }[]>`
    select coalesce(sum(attempts), 0)::int as total from registration_attempt_counts where kind = 'REGISTRATION_START'
  `;
  expect(initial!.total).toBe(1);
  await Promise.all(Array.from({ length: 8 }, () => incrementRegistrationAttempt("REGISTRATION_START", sql)));
  const [total] = await sql<{ total: number }[]>`
    select sum(attempts)::int as total from registration_attempt_counts where kind = 'REGISTRATION_START'
  `;
  expect(total!.total).toBe(9);
});
