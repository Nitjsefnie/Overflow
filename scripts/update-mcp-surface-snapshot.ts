import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineMcpTools, type McpToolDependencies } from "../src/lib/mcp/tools.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const snapshotPath = join(root, "scripts/mcp-surface-snapshot.json");
const protocolPath = join(root, "src/lib/mcp/protocol.ts");
const usage = "Usage: update-mcp-surface-snapshot.ts [--version <v>]";
const remedy =
  "Surface changed without acknowledgment. Run again with --version <new> to record the surface and move MCP_SERVER_VERSION in src/lib/mcp/protocol.ts in the same change.";

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

type UpdateDecision = "in-sync" | "drift-refuse" | "repair" | "surface-refuse" | "same-version-refuse" | "record";

export function decideSnapshotUpdate(input: {
  surfaceChanged: boolean;
  snapshotVersion?: string;
  requestedVersion?: string;
  protocolVersion?: string;
}): UpdateDecision {
  if (input.surfaceChanged) {
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

function main(): void {
  const args = argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--version" || !args[1] || args[1].startsWith("--"))) {
    console.error(usage);
    exit(2);
  }
  const requestedVersion = args[1];

  const stub = async () => Response.json({});
  const dependencies: McpToolDependencies = {
    issuesBoard: stub,
    settlementsList: stub,
    settlementGet: stub,
    calibrationCompare: stub,
    dashboardSummary: stub,
    moderationQueue: stub,
    unwritableClosures: stub,
    auditOpen: stub,
    auditDecide: stub,
    correctionOpen: stub,
    correctionList: stub,
    correctionDecide: stub,
  };
  const surface = defineMcpTools(dependencies, new Headers()).map(
    ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
  );

  type Surface = typeof surface;
  type Snapshot = { mcpServerVersion: string; tools: Surface };
  let snapshot: Snapshot | undefined;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  const surfaceChanged = !equal(surface, snapshot?.tools);
  if (surfaceChanged) {
    const previous = new Map(snapshot?.tools.map((tool) => [tool.name, tool]) ?? []);
    const current = new Map(surface.map((tool) => [tool.name, tool]));
    const added = surface.filter((tool) => !previous.has(tool.name)).map((tool) => tool.name);
    const removed = (snapshot?.tools ?? []).filter((tool) => !current.has(tool.name)).map((tool) => tool.name);
    const changed = surface.filter((tool) => previous.has(tool.name) && !equal(tool, previous.get(tool.name)))
      .map((tool) => tool.name);
    if (added.length) console.log(`Added: ${added.join(", ")}`);
    if (removed.length) console.log(`Removed: ${removed.join(", ")}`);
    if (changed.length) console.log(`Changed: ${changed.join(", ")}`);

  }

  const protocol = readFileSync(protocolPath, "utf8");
  const protocolVersion = readVersionAssignment(protocol);
  const decision = decideSnapshotUpdate({
    surfaceChanged,
    snapshotVersion: snapshot?.mcpServerVersion,
    requestedVersion,
    protocolVersion,
  });
  if (decision === "surface-refuse") {
    console.error(remedy);
    exit(1);
  }
  if (decision === "same-version-refuse") {
    console.error("the version must move when the surface changes");
    exit(1);
  }
  if (decision === "drift-refuse") {
    console.error(
      `MCP_SERVER_VERSION is ${JSON.stringify(protocolVersion)} but scripts/mcp-surface-snapshot.json records ${JSON.stringify(snapshot?.mcpServerVersion)}. ` +
        "Run again with --version <snapshot-version> to repair it, or edit both to the same value.",
    );
    exit(1);
  }
  if (decision === "in-sync") {
    console.log("in sync");
    exit(0);
  }

  const version = requestedVersion!;
  const updatedProtocol = replaceVersionAssignment(protocol, version);
  writeFileSync(snapshotPath, `${JSON.stringify({ mcpServerVersion: version, tools: surface }, null, 2)}\n`);
  writeFileSync(protocolPath, updatedProtocol);
  if (decision === "repair") {
    console.log(`Reconciled MCP tool snapshot and MCP_SERVER_VERSION to ${version}`);
  } else {
    console.log(`Recorded MCP tool surface and MCP_SERVER_VERSION ${snapshot?.mcpServerVersion ?? "(none)"} -> ${version}`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
