import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveHttpSurfaceShapes, shapesCompatible, type HttpShape } from "./http-surface-derive.ts";

/**
 * Records the HTTP surface snapshot and moves the server version with it
 * (issue 912). The decision ladder is compatibility-directed (the API.md
 * "Stability and versioning" policy): an unchanged surface with everything
 * aligned is in-sync; a drifted protocol version refuses with the repair
 * remedy; an ADDITIVE surface change records without a version decision
 * (adding a route or a field is not breaking, so no version move is needed);
 * an INCOMPATIBLE surface change refuses without --version
 * (surface-refuse), refuses the recorded version (same-version-refuse), and
 * otherwise records — and a versioned record moves the four version-bearing
 * artifacts together: the HTTP snapshot, SERVER_VERSION
 * (src/lib/version.ts), MCP_SERVER_VERSION (src/lib/mcp/protocol.ts), and
 * the mcpServerVersion field of scripts/mcp-surface-snapshot.json, so one
 * version keeps covering the HTTP API and the MCP endpoint
 * (tests/lib/api-version.test.ts pins the pair).
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const snapshotPath = join(root, "scripts/http-surface-snapshot.json");
const versionPath = join(root, "src/lib/version.ts");
const protocolPath = join(root, "src/lib/mcp/protocol.ts");
const mcpSnapshotPath = join(root, "scripts/mcp-surface-snapshot.json");
const usage = "Usage: update-http-surface-snapshot.ts [--version <v>]";
const remedy =
  "Surface changed without acknowledgment. Run again with --version <new> to record the snapshot and move SERVER_VERSION in src/lib/version.ts, MCP_SERVER_VERSION in src/lib/mcp/protocol.ts, and the MCP snapshot's mcpServerVersion in the same change.";

type Snapshot = { httpServerVersion: string; routes: Record<string, HttpShape> };

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

type UpdateDecision =
  | "in-sync"
  | "drift-refuse"
  | "repair"
  | "surface-refuse"
  | "same-version-refuse"
  | "record-additive"
  | "record";

/**
 * The compatibility-directed ladder: an additive change (every recorded key
 * still derived, every recorded field still served) records without a version
 * decision, because adding a route or a field is not breaking; removing or
 * retyping a recorded shape refuses without --version. An explicit --version
 * alongside an additive change is honored and moves the four artifacts.
 */
export function decideSnapshotUpdate(input: {
  surfaceChanged: boolean;
  surfaceCompatible: boolean;
  snapshotVersion?: string;
  requestedVersion?: string;
  protocolVersion?: string;
}): UpdateDecision {
  if (input.surfaceChanged) {
    if (input.surfaceCompatible) {
      return input.requestedVersion === undefined
        ? input.snapshotVersion === input.protocolVersion
          ? "record-additive"
          : "drift-refuse"
        : "record";
    }
    if (!input.requestedVersion) return "surface-refuse";
    if (input.snapshotVersion === input.requestedVersion) return "same-version-refuse";
    return "record";
  }
  if (input.requestedVersion !== undefined) {
    return input.snapshotVersion === input.requestedVersion && input.protocolVersion === input.requestedVersion
      ? "in-sync"
      : "repair";
  }
  return input.snapshotVersion === input.protocolVersion ? "in-sync" : "drift-refuse";
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--version" || !args[1] || args[1].startsWith("--"))) {
    console.error(usage);
    exit(2);
  }
  const requestedVersion = args[1];

  const routes = await deriveHttpSurfaceShapes();

  let snapshot: Snapshot | undefined;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const surfaceChanged = !equal(routes, snapshot?.routes);
  // Compatibility direction: every recorded key and field must still be
  // derived with a compatible shape; derived-only routes and fields are
  // additive. A missing snapshot file is compatible with nothing, so a first
  // record keeps demanding --version.
  const surfaceCompatible = snapshot !== undefined
    && Object.entries(snapshot.routes).every(([key, recorded]) =>
      key in routes && shapesCompatible(recorded, routes[key]!),
    );
  if (surfaceChanged) {
    const previous = new Set(Object.keys(snapshot?.routes ?? {}));
    const current = new Set(Object.keys(routes));
    const added = [...current].filter((key) => !previous.has(key));
    const removed = [...previous].filter((key) => !current.has(key));
    const changed = [...current].filter(
      (key) => previous.has(key) && !equal(routes[key], snapshot?.routes?.[key]),
    );
    if (added.length) console.log(`Added: ${added.join(", ")}`);
    if (removed.length) console.log(`Removed: ${removed.join(", ")}`);
    if (changed.length) console.log(`Changed: ${changed.join(", ")}`);
  }

  const serverVersion = readConstAssignment(readFileSync(versionPath, "utf8"), "SERVER_VERSION");
  const decision = decideSnapshotUpdate({
    surfaceChanged,
    surfaceCompatible,
    snapshotVersion: snapshot?.httpServerVersion,
    requestedVersion,
    protocolVersion: serverVersion,
  });
  if (decision === "surface-refuse") {
    console.error(remedy);
    exit(1);
  }
  if (decision === "same-version-refuse") {
    console.error("the version must move when a recorded shape is removed or retyped");
    exit(1);
  }
  if (decision === "record-additive") {
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({ httpServerVersion: snapshot!.httpServerVersion, routes }, null, 2)}\n`,
    );
    console.log(
      "Recorded the additive HTTP surface change into scripts/http-surface-snapshot.json; " +
        "the server version stands (adding a route or a field is not breaking). " +
        "Removing or retyping a recorded shape still needs --version <new>.",
    );
    exit(0);
  }
  if (decision === "drift-refuse") {
    console.error(
      `SERVER_VERSION is ${JSON.stringify(serverVersion)} but scripts/http-surface-snapshot.json records ${JSON.stringify(snapshot?.httpServerVersion)}. ` +
        "Run again with --version <snapshot-version> to repair it, or edit both to the same value.",
    );
    exit(1);
  }
  if (decision === "in-sync") {
    console.log("in sync");
    exit(0);
  }

  const version = requestedVersion!;
  const updatedVersion = replaceConstAssignment(
    readFileSync(versionPath, "utf8"),
    "SERVER_VERSION",
    version,
  );
  const updatedProtocol = replaceConstAssignment(
    readFileSync(protocolPath, "utf8"),
    "MCP_SERVER_VERSION",
    version,
  );
  writeFileSync(snapshotPath, `${JSON.stringify({ httpServerVersion: version, routes }, null, 2)}\n`);
  writeFileSync(versionPath, updatedVersion);
  writeFileSync(protocolPath, updatedProtocol);
  const mcpSnapshot = JSON.parse(readFileSync(mcpSnapshotPath, "utf8")) as { mcpServerVersion: string };
  mcpSnapshot.mcpServerVersion = version;
  writeFileSync(mcpSnapshotPath, `${JSON.stringify(mcpSnapshot, null, 2)}\n`);
  if (decision === "repair") {
    console.log(`Reconciled the HTTP snapshot and SERVER_VERSION to ${version}`);
  } else {
    console.log(`Recorded the HTTP surface and the server version ${snapshot?.httpServerVersion ?? "(none)"} -> ${version}`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) void main();
