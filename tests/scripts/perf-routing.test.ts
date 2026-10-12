import { describe, expect, it } from "vitest";
import { scratchDatabaseUrl } from "../../scripts/perf-workloads.ts";

const parent = "postgresql://fixture:fixture@127.0.0.1/parent";

describe("scratch database routing", () => {
  it("reconstructs an explicit scratch target while retaining safe connection diagnostics", () => {
    const scratch = scratchDatabaseUrl(`${parent}?client_min_messages=warning`, "overflow_perf_example");
    expect({ host: scratch.hostname, port: scratch.port, user: scratch.username, database: scratch.pathname,
      messageLevel: scratch.searchParams.get("client_min_messages") }).toEqual({
      host: "127.0.0.1", port: "5432", user: "fixture", database: "/overflow_perf_example", messageLevel: "warning",
    });
  });

  it.each(["database", "dbname", "db", "host", "hostaddr", "port", "user", "username", "password", "path", "options", "service", "target_session_attrs"])(
    "refuses query routing field %s", (field) => {
      expect(() => scratchDatabaseUrl(`${parent}?${field}=parent`, "overflow_perf_example"))
        .toThrow(/routing query parameter/);
    },
  );

  it.each(["application_name", "client_min_messages"])("refuses startup routing injection inside %s", (field) => {
    const url = new URL(parent);
    url.searchParams.set(field, ["fixture", "database", "parent"].join(String.fromCharCode(0)));
    expect(() => scratchDatabaseUrl(url.href, "overflow_perf_example")).toThrow(/routing query parameter/);
  });
});
