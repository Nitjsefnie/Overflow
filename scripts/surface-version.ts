import {
  classifyHttpChange,
  classifyMcpChange,
  type HttpChange,
  type HttpChangeKind,
  type RecordedHttpSurface,
  type RecordedMcpSurface,
  type HttpSurfaceSnapshot,
  type McpSurfaceSnapshot,
} from "./surface-change.ts";

type Surfaces = { http?: RecordedHttpSurface; mcp?: RecordedMcpSurface };

/** One version covers both surfaces; a missing base records no prior contract. */
export function classifySurfaces(base: Surfaces, current: Required<Surfaces>): HttpChange {
  const changes = [
    base.http ? classifyHttpChange(base.http, current.http) : { kind: "none" as const, reasons: [] },
    base.mcp ? classifyMcpChange(base.mcp, current.mcp) : { kind: "none" as const, reasons: [] },
  ];
  const kind = changes.some((change) => change.kind === "breaking") ? "breaking"
    : changes.some((change) => change.kind === "additive") ? "additive" : "none";
  return { kind, reasons: changes.flatMap((change, index) =>
    change.kind === kind ? change.reasons.map((reason) => `${index === 0 ? "HTTP" : "MCP"}: ${reason}`) : []) };
}

export type SurfaceSnapshots = { http?: HttpSurfaceSnapshot; mcp?: McpSurfaceSnapshot };

/** Enforce the strongest change against every recorded base version. */
export function assertSnapshotVersions(base: SurfaceSnapshots, current: Required<SurfaceSnapshots>): void {
  requiredVersion(current.http.httpServerVersion, "none");
  requiredVersion(current.mcp.mcpServerVersion, "none");
  if (current.http.httpServerVersion !== current.mcp.mcpServerVersion) {
    throw new Error("HTTP and MCP snapshots must record the same version.");
  }
  const change = classifySurfaces(base, current);
  const remedy = "scripts/update-http-surface-snapshot.ts and scripts/update-mcp-surface-snapshot.ts --version <new>";
  for (const version of [base.http?.httpServerVersion, base.mcp?.mcpServerVersion]) {
    if (version !== undefined) assertSurfaceVersion(version, current.http.httpServerVersion, change, remedy);
  }
}

/** SemVer precedence without prerelease/build components; no numeric rounding. */
function parseVersion(version: string): [bigint, bigint, bigint] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.trim() !== version) {
    throw new Error(`Invalid version ${JSON.stringify(version)}; expected MAJOR.MINOR.PATCH without prerelease or build parts.`);
  }
  return version.split(".").map(BigInt) as [bigint, bigint, bigint];
}

export function requiredVersion(baseVersion: string, kind: HttpChangeKind): string {
  const [major, minor] = parseVersion(baseVersion);
  if (kind === "breaking") return `${major + 1n}.0.0`;
  if (kind === "additive") return `${major}.${minor + 1n}.0`;
  return baseVersion;
}

export function assertSurfaceVersion(
  baseVersion: string,
  currentVersion: string,
  change: HttpChange,
  remedy: string,
): void {
  const before = parseVersion(baseVersion);
  const now = parseVersion(currentVersion);
  const greaterOrEqual = now[0] > before[0] || (now[0] === before[0] &&
    (now[1] > before[1] || (now[1] === before[1] && now[2] >= before[2])));
  const valid = change.kind === "breaking" ? now[0] > before[0]
    : change.kind === "additive" ? now[0] === before[0] && now[1] > before[1] : greaterOrEqual;
  if (!valid) {
    const minimum = requiredVersion(baseVersion, change.kind);
    const move = change.kind === "breaking" ? `needs ${minimum} (a greater major)`
      : change.kind === "additive" ? `needs at least ${minimum} (a greater minor in the same major)`
        : `needs at least ${minimum} (versions cannot move backwards)`;
    throw new Error(`The recorded surface ${change.kind} change ${move}; got ${currentVersion}. ` +
      `${change.reasons.join("; ")}${change.reasons.length ? ". " : ""}Run ${remedy}.`);
  }
}
