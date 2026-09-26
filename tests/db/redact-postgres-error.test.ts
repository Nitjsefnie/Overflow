import { inspect } from "node:util";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { redactPostgresError } from "@/lib/db/redact-postgres-error";

describe("redactPostgresError", () => {
  it("redacts a server error from a minified copy of the PostgresError class", () => {
    // The production build minifies class names and ships more than one copy
    // of the client, so neither the name nor instanceof identifies the error.
    const original = Object.assign(new Error("write failed"), {
      name: "u", code: "P0001", severity: "ERROR", routine: "exec_stmt_raise",
      detail: "detail-record-marker-721", where: "where-record-marker-721",
    });
    expect(original).not.toBeInstanceOf(postgres.PostgresError);

    const redacted = redactPostgresError(original) as Error;
    const rendered = inspect(redacted, { depth: null });
    expect(redacted).not.toBe(original);
    expect(rendered).not.toContain("detail-record-marker-721");
    expect(rendered).not.toContain("where-record-marker-721");
    expect(Object.keys(redacted).sort()).toEqual(["code", "name", "routine", "severity"]);
    expect(redacted.name).toBe("u");
  });

  it("returns an error that carries only a code unchanged", () => {
    const original = Object.assign(new Error("GitHub request failed"), {
      name: "GitHubApiError", code: "SECONDARY_RATE_LIMIT", status: 403,
    });

    expect(redactPostgresError(original)).toBe(original);
  });

  it("preserves the original client-side stack on a redacted PostgresError", () => {
    const original = Object.assign(new Error("write failed"), {
      name: "PostgresError", code: "P0001", severity: "ERROR", routine: "exec_stmt_raise",
      detail: "detail-record-marker-721",
    });
    Object.setPrototypeOf(original, postgres.PostgresError.prototype);
    original.stack = "PostgresError: write failed\n    at writeRow (/app/store.ts:42:7)";
    expect(original).toBeInstanceOf(postgres.PostgresError);

    const redacted = redactPostgresError(original) as Error;
    expect(redacted).not.toBe(original);
    expect(redacted.stack).toBe(original.stack);
    expect(inspect(redacted, { depth: null })).not.toContain("detail-record-marker-721");
  });
});
