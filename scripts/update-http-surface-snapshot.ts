import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveHttpSurfaceRecord } from "./http-surface-record.ts";
import {
  classifyHttpChange,
  recordedSurface,
  type DerivedHttpSurface,
  type HttpSurfaceSnapshot,
  type RecordedHttpSurface,
  type HttpChangeKind,
  type McpSurfaceSnapshot,
} from "./surface-change.ts";
import { deriveMcpSurfaceRecord } from "./mcp-surface-record.ts";
import { assertSnapshotVersions, assertSurfaceVersion, classifySurfaces } from "./surface-version.ts";
import { decideSnapshotUpdate } from "./snapshot-update.ts";
export { decideSnapshotUpdate } from "./snapshot-update.ts";

/**
 * Record the HTTP surface using the shared SemVer ladder: additive requires
 * a greater minor in the same major; breaking requires a greater major.
 * Both live surfaces are classified against their current recordings, and
 * the stronger requirement governs. A format-1 recording upgrade is none.
 * Either updater records both surfaces; an explicit version moves both
 * snapshots and both server constants.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const snapshotPath = join(root, "scripts/http-surface-snapshot.json");
const versionPath = join(root, "src/lib/version.ts");
const protocolPath = join(root, "src/lib/mcp/protocol.ts");
const mcpSnapshotPath = join(root, "scripts/mcp-surface-snapshot.json");
const usage = "Usage: update-http-surface-snapshot.ts [--version <v>]";

function assignmentPattern(name: string): RegExp {
  return new RegExp(`export const ${name} = ("(?:[^"\\\\]|\\\\.)*");`, "g");
}

export function buildConstAssignment(name: string, version: string): string {
  return `export const ${name} = ${JSON.stringify(version)};`;
}

export function readConstAssignment(source: string, name: string): string {
  const matches = [...source.matchAll(assignmentPattern(name))];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${name} assignment`);
  }
  return JSON.parse(matches[0]![1]!) as string;
}

export function replaceConstAssignment(source: string, name: string, version: string): string {
  if ([...source.matchAll(assignmentPattern(name))].length !== 1) {
    throw new Error(`Expected exactly one ${name} assignment`);
  }
  return source.replace(assignmentPattern(name), () => buildConstAssignment(name, version));
}

/** Exact recording drift and the HTTP classification against the current snapshot. */
export function surfaceUpdateInputs(
  snapshot: HttpSurfaceSnapshot | undefined,
  derived: RecordedHttpSurface,
): { surfaceChanged: boolean; changeKind: HttpChangeKind } {
  if (snapshot === undefined) return { surfaceChanged: true, changeKind: "breaking" };
  return {
    surfaceChanged: !isDeepStrictEqual(derived, recordedSurface(snapshot)),
    changeKind: classifyHttpChange(snapshot, derived).kind,
  };
}

/** The snapshot file's text: the format marker and version first, then the recorded sections. */
export function serializedSnapshot(version: string, derived: DerivedHttpSurface): string {
  const snapshot: HttpSurfaceSnapshot = {
    snapshotFormat: derived.snapshotFormat,
    httpServerVersion: version,
    errorEnvelope: derived.errorEnvelope,
    routes: derived.routes,
    successStatus: derived.successStatus,
    failures: derived.failures,
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--version" || !args[1] || args[1].startsWith("--"))) {
    console.error(usage);
    exit(2);
  }
  const requestedVersion = args[1];
  const derived = await deriveHttpSurfaceRecord();
  const mcpDerived = deriveMcpSurfaceRecord();
  let snapshot: HttpSurfaceSnapshot | undefined;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as HttpSurfaceSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const mcpSnapshot = JSON.parse(readFileSync(mcpSnapshotPath, "utf8")) as McpSurfaceSnapshot;
  const change = classifySurfaces({ http: snapshot, mcp: mcpSnapshot }, { http: derived, mcp: mcpDerived });
  const surfaceChanged = surfaceUpdateInputs(snapshot, derived).surfaceChanged || change.kind !== "none";
  if (surfaceChanged) console.log(`Classified ${change.kind}: ${change.reasons.join("; ")}`);
  const serverSource = readFileSync(versionPath, "utf8");
  const protocolSource = readFileSync(protocolPath, "utf8");
  const serverVersion = readConstAssignment(serverSource, "SERVER_VERSION");
  const decision = decideSnapshotUpdate({ surfaceChanged, changeKind: change.kind,
    snapshotVersion: snapshot?.httpServerVersion, requestedVersion, protocolVersion: serverVersion });
  if (decision === "surface-refuse") {
    if (snapshot) assertSurfaceVersion(snapshot.httpServerVersion, snapshot.httpServerVersion, change,
      "scripts/update-http-surface-snapshot.ts --version <new>");
    throw new Error("Recording a new HTTP snapshot needs an explicit --version <v>.");
  }
  if (decision === "drift-refuse") {
    throw new Error(`SERVER_VERSION is ${serverVersion} but the snapshot records ${snapshot?.httpServerVersion}. ` +
      "Run scripts/update-http-surface-snapshot.ts --version <snapshot-version> to repair it.");
  }
  const version = requestedVersion ?? snapshot!.httpServerVersion;
  assertSnapshotVersions({ http: snapshot, mcp: mcpSnapshot }, {
    http: { ...derived, httpServerVersion: version }, mcp: { ...mcpDerived, mcpServerVersion: version },
  });
  if (decision === "in-sync") {
    console.log("in sync");
    return;
  }
  // Prepare all four artifacts before writing any, so malformed assignments refuse cleanly.
  const updatedVersion = replaceConstAssignment(serverSource, "SERVER_VERSION", version);
  const updatedProtocol = replaceConstAssignment(protocolSource, "MCP_SERVER_VERSION", version);
  writeFileSync(snapshotPath, serializedSnapshot(version, derived));
  writeFileSync(versionPath, updatedVersion);
  writeFileSync(protocolPath, updatedProtocol);
  writeFileSync(mcpSnapshotPath, `${JSON.stringify({ mcpServerVersion: version, ...mcpDerived }, null, 2)}\n`);
  console.log(`Recorded the HTTP surface and synchronized all four version sites at ${version}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); exit(1); });
}
