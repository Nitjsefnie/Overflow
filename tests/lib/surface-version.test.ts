import { describe, expect, it } from "vitest";
import { type RecordedMcpSurface, type RecordedHttpSurface } from "../../scripts/surface-change.ts";
import { classifySurfaces, assertSurfaceVersion, requiredVersion, assertSnapshotVersions } from "../../scripts/surface-version.ts";

const tool = { name: "read", description: "Read", inputSchema: { type: "object" } };
const mcp: RecordedMcpSurface = { tools: [tool] };
const emptyHttp: RecordedHttpSurface = { routes: {} };
const http = { routes: { "GET /a": { id: "string" as const } } };

describe("one version for both surfaces", () => {
  it.each([
    { httpNow: http, mcpNow: mcp, kind: "none" },
    { httpNow: { routes: { "GET /a": { id: "string" as const, added: "number" as const } } }, mcpNow: mcp, kind: "additive" },
    { httpNow: http, mcpNow: { tools: [...mcp.tools, { ...tool, name: "new" }] }, kind: "additive" },
    { httpNow: emptyHttp, mcpNow: { tools: [...mcp.tools, { ...tool, name: "new" }] }, kind: "breaking" },
    { httpNow: { routes: { "GET /a": { id: "string" as const, added: "number" as const } } }, mcpNow: { tools: [] }, kind: "breaking" },
  ])("uses the stronger classification: $kind", ({ httpNow, mcpNow, kind }) => {
    expect(classifySurfaces({ http, mcp }, { http: httpNow, mcp: mcpNow }).kind).toBe(kind);
  });

  it.each([
    { kind: "none" as const, minimum: "1.1.0" },
    { kind: "additive" as const, minimum: "1.2.0" },
    { kind: "breaking" as const, minimum: "2.0.0" },
  ])("computes $minimum for $kind", ({ kind, minimum }) => {
    expect(requiredVersion("1.1.0", kind)).toBe(minimum);
  });

  it.each([
    { kind: "none" as const, version: "1.1.0", passes: true },
    { kind: "none" as const, version: "1.0.9", passes: false },
    { kind: "none" as const, version: "1.1.1", passes: true },
    { kind: "none" as const, version: "2.0.0", passes: true },
    { kind: "additive" as const, version: "1.1.0", passes: false },
    { kind: "additive" as const, version: "1.1.1", passes: false },
    { kind: "additive" as const, version: "1.2.0", passes: true },
    { kind: "additive" as const, version: "1.10.0", passes: true },
    { kind: "additive" as const, version: "2.0.0", passes: false },
    { kind: "breaking" as const, version: "1.2.0", passes: false },
    { kind: "breaking" as const, version: "2.0.0", passes: true },
    { kind: "breaking" as const, version: "3.0.0", passes: true },
  ])("enforces $kind for $version: $passes", ({ kind, version, passes }) => {
    const check = () => assertSurfaceVersion("1.1.0", version, { kind, reasons: [] }, "update-script.ts");
    if (passes) expect(check).not.toThrow();
    else expect(check).toThrow(/needs (?:at least )?(?:1\.1\.0|1\.2\.0|2\.0\.0).*update-script\.ts/);
  });

  it.each(["1.2.0-alpha", "1.2.0+build", "01.2.0", "1.2", "v1.2.0", "1.2.0\n", "$$"])(
    "rejects unsupported version %s on either side", (version) => {
      expect(() => assertSurfaceVersion("1.1.0", version, { kind: "none", reasons: [] }, "update")).toThrow(/MAJOR.MINOR.PATCH/);
      expect(() => requiredVersion(version, "none")).toThrow(/MAJOR.MINOR.PATCH/);
    },
  );
});

describe("combined snapshot version enforcement", () => {
  const previous = { http: { ...http, httpServerVersion: "1.1.0" }, mcp: { ...mcp, mcpServerVersion: "1.1.0" } };
  it.each([
    { httpNow: http, mcpNow: { tools: [] }, version: "1.2.0", passes: false, minimum: "2.0.0" },
    { httpNow: emptyHttp, mcpNow: mcp, version: "1.2.0", passes: false, minimum: "2.0.0" },
    { httpNow: http, mcpNow: { tools: [...mcp.tools, { ...tool, name: "new" }] }, version: "1.1.1", passes: false, minimum: "1.2.0" },
    { httpNow: http, mcpNow: { tools: [] }, version: "2.0.0", passes: true, minimum: "2.0.0" },
    { httpNow: http, mcpNow: mcp, version: "1.1.0", passes: true, minimum: "1.1.0" },
  ])("enforces both surfaces at $version", ({ httpNow, mcpNow, version, passes, minimum }) => {
    const check = () => assertSnapshotVersions(previous, {
      http: { ...httpNow, httpServerVersion: version }, mcp: { ...mcpNow, mcpServerVersion: version },
    });
    if (passes) expect(check).not.toThrow();
    else expect(check).toThrow(minimum);
  });

  it("refuses different current snapshot versions", () => {
    expect(() => assertSnapshotVersions(previous, {
      http: previous.http, mcp: { ...mcp, mcpServerVersion: "1.2.0" },
    })).toThrow(/same version/);
  });
});
