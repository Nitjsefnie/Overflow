import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSql, getCoordinationSql, getSql } from "@/lib/db/client";

const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
// Nothing listens here. Every client below is closed before it is asked to
// connect, and only a client that was really ended refuses a query without
// reaching for the server first.
const unreachableDatabaseUrl = "postgres://overflow:overflow@127.0.0.1:1/overflow";

describe("shared database clients", () => {
  afterEach(async () => {
    await closeSql();
    vi.unstubAllEnvs();
    if (originalDatabaseUrl === undefined) {
      delete process.env.OVERFLOW_DATABASE_URL;
    } else {
      process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("uses the prefixed database URL and statement deadline before the legacy values", () => {
    vi.stubEnv("DATABASE_URL", unreachableDatabaseUrl);
    vi.stubEnv("OVERFLOW_DATABASE_URL", unreachableDatabaseUrl.replace(":1/", ":2/"));
    vi.stubEnv("DATABASE_STATEMENT_TIMEOUT_MS", "invalid");
    vi.stubEnv("OVERFLOW_DATABASE_STATEMENT_TIMEOUT_MS", "1234");

    expect(getSql().options.port).toEqual([2]);
    expect(getSql().options.connection.statement_timeout).toBe("1234");
    expect(getCoordinationSql().options.port).toEqual([2]);
    expect(getCoordinationSql().options.connection.statement_timeout).toBe("0");
  });

  it("rejects an empty prefixed database URL instead of using the legacy URL", () => {
    vi.stubEnv("DATABASE_URL", unreachableDatabaseUrl);
    vi.stubEnv("OVERFLOW_DATABASE_URL", "");

    expect(() => getCoordinationSql()).toThrow("DATABASE_URL must be configured before using the database.");
  });

  it("rejects an empty prefixed deadline instead of using the legacy deadline", () => {
    vi.stubEnv("DATABASE_URL", unreachableDatabaseUrl);
    vi.stubEnv("DATABASE_STATEMENT_TIMEOUT_MS", "1234");
    vi.stubEnv("OVERFLOW_DATABASE_STATEMENT_TIMEOUT_MS", "");

    expect(() => getSql()).toThrow('DATABASE_STATEMENT_TIMEOUT_MS is set but invalid: "".');
  });

  it("ends the coordination client alongside the work client", async () => {
    process.env.OVERFLOW_DATABASE_URL = unreachableDatabaseUrl;
    const work = getSql();
    const coordination = getCoordinationSql();

    await closeSql();

    await expect(coordination`select 1`).rejects.toThrow("CONNECTION_ENDED");
    await expect(work`select 1`).rejects.toThrow("CONNECTION_ENDED");
  });
});
