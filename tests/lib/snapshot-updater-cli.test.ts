import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/http-surface-derive.ts";
import type { HttpSurfaceSnapshot, McpSurfaceSnapshot } from "../../scripts/surface-change.ts";

const versionSites = ["src/lib/version.ts", "src/lib/mcp/protocol.ts",
  "scripts/http-surface-snapshot.json", "scripts/mcp-surface-snapshot.json"];

/** Parent node_modules resolves normally; no copied or linked dependencies. */
function fixture(changed: boolean = true): string {
  const root = mkdtempSync(join(repoRoot, ".next-release-snapshot-fixture-"));
  for (const path of ["src", "scripts", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  if (!changed) return root;
  const route = join(root, "src/app/api/version/route.ts");
  writeFileSync(route, readFileSync(route, "utf8").replace("{ version: SERVER_VERSION }", "{ version: SERVER_VERSION, added: true }"));
  const path = join(root, "scripts/mcp-surface-snapshot.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as McpSurfaceSnapshot;
  snapshot.tools.pop();
  writeFileSync(path, JSON.stringify(snapshot));
  return root;
}

function run(root: string, script: string, version?: string) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, ["--experimental-transform-types", "--import",
    join(root, "scripts/register-path-aliases.ts"), join(root, "scripts", script),
    ...(version === undefined ? [] : ["--version", version]),
  ], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}

describe("surface updater CLIs", () => {
  it.each(["update-http-surface-snapshot.ts", "update-mcp-surface-snapshot.ts"])(
    "%s refuses a missing peer snapshot version instead of certifying sync", (script) => {
      const root = fixture(false);
      const http = script.startsWith("update-http");
      const path = join(root, versionSites[http ? 3 : 2]!);
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      delete snapshot[http ? "mcpServerVersion" : "httpServerVersion"];
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
      const before = versionSites.map((site) => readFileSync(join(root, site), "utf8"));
      const result = run(root, script);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("MAJOR.MINOR.PATCH");
      expect(versionSites.map((site) => readFileSync(join(root, site), "utf8"))).toEqual(before);
    },
  );


  it.each(["update-http-surface-snapshot.ts", "update-mcp-surface-snapshot.ts"])(
    "%s keeps fixture audit output out of successful and refused diagnostics", (script) => {
      const clean = run(fixture(false), script);
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout.trim()).toBe("in sync");
      const refused = run(fixture(), script);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stdout.trim().split("\n")).toHaveLength(1);
      expect(refused.stderr).toContain("needs at least 1.2.0");
    },
  );


  it.each(["update-http-surface-snapshot.ts", "update-mcp-surface-snapshot.ts"].flatMap((script) =>
    ["source", "snapshot"].flatMap((site) => [false, true].map((explicit) => ({ script, site, explicit }))),
  ))("$script checks peer $site drift (explicit repair: $explicit)", ({ script, site, explicit }) => {
    const root = fixture(false);
    const http = script.startsWith("update-http");
    const peerName = site === "source" ? (http ? "MCP_SERVER_VERSION" : "SERVER_VERSION")
      : (http ? "mcpServerVersion" : "httpServerVersion");
    const path = join(root, versionSites[site === "source" ? (http ? 1 : 0) : (http ? 3 : 2)]!);
    if (site === "source") {
      writeFileSync(path, readFileSync(path, "utf8").replace(`export const ${peerName} = "1.1.0";`, `export const ${peerName} = "1.2.0";`));
    } else {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      snapshot[peerName] = "1.0.0";
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
    }
    const before = versionSites.map((site) => readFileSync(join(root, site), "utf8"));
    const result = run(root, script, explicit ? "1.1.0" : undefined);
    if (explicit) {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, versionSites[0]!), "utf8")).toMatch(/export const SERVER_VERSION = "1\.1\.0";/);
      expect(readFileSync(join(root, versionSites[1]!), "utf8")).toMatch(/export const MCP_SERVER_VERSION = "1\.1\.0";/);
      expect(JSON.parse(readFileSync(join(root, versionSites[2]!), "utf8")).httpServerVersion).toBe("1.1.0");
      expect(JSON.parse(readFileSync(join(root, versionSites[3]!), "utf8")).mcpServerVersion).toBe("1.1.0");
    } else {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(peerName);
      expect(versionSites.map((site) => readFileSync(join(root, site), "utf8"))).toEqual(before);
    }
  });


  it.each(["update-http-surface-snapshot.ts", "update-mcp-surface-snapshot.ts"])(
    "%s refuses insufficient moves without writes and records both surfaces in one minor move", (script) => {
      const root = fixture();
      const before = versionSites.map((path) => readFileSync(join(root, path), "utf8"));
      for (const version of [undefined, "1.1.1"]) {
        const result = run(root, script, version);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("needs at least 1.2.0");
        expect(result.stderr).toContain(script);
        expect(versionSites.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
      }
      const result = run(root, script, "1.2.0");
      expect(result.status, result.stderr).toBe(0);
      const http = JSON.parse(readFileSync(join(root, versionSites[2]!), "utf8")) as HttpSurfaceSnapshot;
      const mcp = JSON.parse(readFileSync(join(root, versionSites[3]!), "utf8")) as McpSurfaceSnapshot;
      expect(http.routes["GET /api/version"]).toEqual({ added: "boolean", version: "string" });
      const originalTools = JSON.parse(readFileSync(join(repoRoot, versionSites[3]!), "utf8")) as McpSurfaceSnapshot;
      expect(mcp.tools).toEqual(originalTools.tools);
      expect(http.httpServerVersion).toBe("1.2.0");
      expect(mcp.mcpServerVersion).toBe("1.2.0");
      expect(readFileSync(join(root, versionSites[0]!), "utf8")).toMatch(/export const SERVER_VERSION = "1\.2\.0";/);
      expect(readFileSync(join(root, versionSites[1]!), "utf8")).toMatch(/export const MCP_SERVER_VERSION = "1\.2\.0";/);
      const rerun = run(root, script);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.stdout).toContain("in sync");
    },
  );
});
