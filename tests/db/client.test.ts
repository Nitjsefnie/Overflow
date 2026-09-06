import { afterEach, describe, expect, it } from "vitest";
import { closeSql, getCoordinationSql, getSql } from "@/lib/db/client";

const originalDatabaseUrl = process.env.DATABASE_URL;
// Nothing listens here. Every client below is closed before it is asked to
// connect, and only a client that was really ended refuses a query without
// reaching for the server first.
const unreachableDatabaseUrl = "postgres://overflow:overflow@127.0.0.1:1/overflow";

describe("shared database clients", () => {
  afterEach(async () => {
    await closeSql();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("ends the coordination client alongside the work client", async () => {
    process.env.DATABASE_URL = unreachableDatabaseUrl;
    const work = getSql();
    const coordination = getCoordinationSql();

    await closeSql();

    await expect(coordination`select 1`).rejects.toThrow("CONNECTION_ENDED");
    await expect(work`select 1`).rejects.toThrow("CONNECTION_ENDED");
  });
});
