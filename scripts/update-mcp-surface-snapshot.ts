import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deriveMcpSurfaceRecord } from "./mcp-surface-record.ts";
import { deriveHttpSurfaceRecord } from "./http-surface-record.ts";
import { readConstAssignment, replaceConstAssignment, serializedSnapshot } from "./update-http-surface-snapshot.ts";
import { assertSnapshotVersions, assertSurfaceVersion, classifySurfaces } from "./surface-version.ts";
import { decideSnapshotUpdate } from "./snapshot-update.ts";
import type { HttpSurfaceSnapshot, McpSurfaceSnapshot } from "./surface-change.ts";
export { decideSnapshotUpdate } from "./snapshot-update.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const snapshotPath = join(root, "scripts/mcp-surface-snapshot.json");
const protocolPath = join(root, "src/lib/mcp/protocol.ts");
const versionPath = join(root, "src/lib/version.ts");
const httpSnapshotPath = join(root, "scripts/http-surface-snapshot.json");
const usage = "Usage: update-mcp-surface-snapshot.ts [--version <v>]";

export function buildVersionAssignment(version: string): string {
  return `export const MCP_SERVER_VERSION = ${JSON.stringify(version)};`;
}

const assignment = /export const MCP_SERVER_VERSION = ("(?:[^"\\]|\\.)*");/g;

function readVersionAssignment(source: string): string {
  const matches = [...source.matchAll(assignment)];
  if (matches.length !== 1) {
    throw new Error("Expected exactly one MCP_SERVER_VERSION assignment in src/lib/mcp/protocol.ts");
  }
  return JSON.parse(matches[0]![1]!) as string;
}

export function replaceVersionAssignment(source: string, version: string): string {
  if ([...source.matchAll(assignment)].length !== 1) {
    throw new Error("Expected exactly one MCP_SERVER_VERSION assignment in src/lib/mcp/protocol.ts");
  }
  return source.replace(assignment, () => buildVersionAssignment(version));
}

/** MCP uses the same combined requirement and four-site version synchronization as HTTP. */
async function main(): Promise<void> {
  const args = argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--version" || !args[1] || args[1].startsWith("--"))) {
    console.error(usage);
    exit(2);
  }
  const requestedVersion = args[1];
  const derived = deriveMcpSurfaceRecord();
  const httpDerived = await deriveHttpSurfaceRecord();
  let snapshot: McpSurfaceSnapshot | undefined;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as McpSurfaceSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const httpSnapshot = JSON.parse(readFileSync(httpSnapshotPath, "utf8")) as HttpSurfaceSnapshot;
  const change = classifySurfaces({ http: httpSnapshot, mcp: snapshot }, { http: httpDerived, mcp: derived });
  const surfaceChanged = !isDeepStrictEqual(derived.tools, snapshot?.tools) || change.kind !== "none";
  if (surfaceChanged) console.log(`Classified ${change.kind}: ${change.reasons.join("; ")}`);
  const protocol = readFileSync(protocolPath, "utf8");
  const serverSource = readFileSync(versionPath, "utf8");
  const protocolVersion = readVersionAssignment(protocol);
  const serverVersion = readConstAssignment(serverSource, "SERVER_VERSION");
  const decision = decideSnapshotUpdate({ surfaceChanged, changeKind: change.kind,
    snapshotVersion: snapshot?.mcpServerVersion, requestedVersion, protocolVersion,
    peerProtocolVersion: serverVersion, peerSnapshotVersion: httpSnapshot.httpServerVersion });
  if (decision === "surface-refuse") {
    if (snapshot) assertSurfaceVersion(snapshot.mcpServerVersion, snapshot.mcpServerVersion, change,
      "scripts/update-mcp-surface-snapshot.ts --version <new>");
    throw new Error("Recording a new MCP snapshot needs an explicit --version <v>.");
  }
  if (decision === "drift-refuse") {
    throw new Error(`The four version sites disagree: SERVER_VERSION=${serverVersion}, MCP_SERVER_VERSION=${protocolVersion}, ` +
      `httpServerVersion=${httpSnapshot.httpServerVersion}, mcpServerVersion=${snapshot?.mcpServerVersion}. ` +
      "Run scripts/update-mcp-surface-snapshot.ts --version <snapshot-version> to repair it.");
  }
  const version = requestedVersion ?? snapshot!.mcpServerVersion;
  assertSnapshotVersions({ http: httpSnapshot, mcp: snapshot }, {
    http: { ...httpDerived, httpServerVersion: version }, mcp: { ...derived, mcpServerVersion: version },
  });
  if (decision === "in-sync") {
    console.log("in sync");
    return;
  }
  const updatedProtocol = replaceVersionAssignment(protocol, version);
  const updatedServer = replaceConstAssignment(serverSource, "SERVER_VERSION", version);
  writeFileSync(snapshotPath, `${JSON.stringify({ mcpServerVersion: version, ...derived }, null, 2)}\n`);
  writeFileSync(protocolPath, updatedProtocol);
  writeFileSync(versionPath, updatedServer);
  writeFileSync(httpSnapshotPath, serializedSnapshot(version, httpDerived));
  console.log(`Recorded the MCP surface and synchronized all four version sites at ${version}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); exit(1); });
}
