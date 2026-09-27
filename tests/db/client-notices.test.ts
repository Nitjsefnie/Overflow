import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postgresHarness = vi.hoisted(() => {
  const client = { end: vi.fn(() => Promise.resolve()) };
  const factory = vi.fn<(url: string, options: Record<string, unknown>) => typeof client>(() => client);
  return { client, factory };
});

vi.mock("postgres", () => ({ default: postgresHarness.factory }));

import { closeSql, getCoordinationSql, getSql } from "../../src/lib/db/client";

describe("shared database client notices", () => {
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://overflow:overflow@127.0.0.1:1/overflow");
    postgresHarness.factory.mockClear();
    postgresHarness.client.end.mockClear();
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await closeSql();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("routes notices from both shared pools as readable one-line stderr messages", () => {
    getSql();
    getCoordinationSql();

    const onnoticeHandlers = postgresHarness.factory.mock.calls.map(([, options]) =>
      (options as { onnotice?: (notice: unknown) => void }).onnotice,
    );

    expect(onnoticeHandlers).toHaveLength(2);
    expect(onnoticeHandlers.every((handler) => typeof handler === "function")).toBe(true);

    const notice = {
      severity_local: "NOTICE",
      severity: "NOTICE",
      code: "42P07",
      message: "relation already exists,\nskipping",
      detail: "",
      hint: "",
      position: "",
      internal_position: "",
      internal_query: "",
      where: "",
      schema_name: "",
      table_name: "",
      column_name: "",
      data_type_name: "",
      constraint_name: "",
      file: "",
      line: "",
      routine: "",
    };

    for (const onnotice of onnoticeHandlers) {
      if (typeof onnotice !== "function") {
        throw new Error("Expected every database pool to have an onnotice handler");
      }
      onnotice(notice);
    }

    expect(stderrWrite.mock.calls).toEqual([
      ["NOTICE: relation already exists, skipping\n"],
      ["NOTICE: relation already exists, skipping\n"],
    ]);
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
