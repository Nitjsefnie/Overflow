import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_VERSION } from "@/lib/mcp/protocol";
import { defineMcpTools, type McpToolDependencies } from "@/lib/mcp/tools";

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

const snapshot = JSON.parse(
  readFileSync(new URL("../../scripts/mcp-surface-snapshot.json", import.meta.url), "utf8"),
) as { mcpServerVersion: string; tools: unknown[] };
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const snapshotPath = "scripts/mcp-surface-snapshot.json";

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function firstParentOfMerge(fields: string[]): string | undefined {
  // CI merge refs and rebase merges use first parent; ordinary local HEADs fall through to merge-base.
  return fields.length >= 3 ? fields[1] : undefined;
}

function baseCommit(): string {
  const override = process.env.MCP_SNAPSHOT_BASE_COMMIT;
  if (override !== undefined) {
    return git(["rev-parse", "--verify", "--end-of-options", `${override}^{commit}`]);
  }

  const headAndParents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
  const firstParent = firstParentOfMerge(headAndParents);
  if (firstParent !== undefined) return firstParent;

  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "The MCP snapshot base could not be resolved reliably from shallow history; " +
        "git fetch origin main and fetch full history with git fetch --unshallow.",
    );
  }

  const result = spawnSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const base = result.stdout.trim();
  if (result.status !== 0 || base === "") {
    throw new Error("The MCP snapshot base could not be resolved; git fetch origin main and rerun the test.");
  }
  return base;
}

describe("MCP tool surface snapshot", () => {
  it("records the served names, descriptions, and input schemas", () => {
    const derived = defineMcpTools(dependencies, new Headers()).map(
      ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
    );
    expect(
      derived,
      "The MCP tool surface changed. Acknowledge it in the same change: node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/update-mcp-surface-snapshot.ts --version <new> — it rewrites scripts/mcp-surface-snapshot.json and moves MCP_SERVER_VERSION in src/lib/mcp/protocol.ts together.",
    ).toEqual(snapshot.tools);
  });

  it("records the same version as the MCP server", () => {
    expect(
      snapshot.mcpServerVersion,
      `scripts/mcp-surface-snapshot.json records ${snapshot.mcpServerVersion} but MCP_SERVER_VERSION is ${MCP_SERVER_VERSION}. The snapshot and MCP_SERVER_VERSION move together: run the update script (it moves both) or edit both to the same value.`,
    ).toBe(MCP_SERVER_VERSION);
  });

  it("never changes the recorded surface without moving the server version", () => {
    const base = baseCommit();
    const listing = git(["--literal-pathspecs", "ls-tree", "-z", base, "--", snapshotPath])
      .split("\0")[0]!;
    if (listing === "") {
      // This branch introduces the snapshot, so the base has no surface to compare.
      return;
    }
    const [entry, path] = listing.split("\t", 2);
    if (path !== snapshotPath || !entry?.startsWith("100644 blob ")) {
      throw new Error(`${snapshotPath} at ${base} is not a regular file`);
    }

    let previous: { mcpServerVersion: string; tools: unknown[] };
    try {
      previous = JSON.parse(git(["show", `${base}:${snapshotPath}`])) as typeof previous;
    } catch (error) {
      throw new Error(`${snapshotPath} at ${base} could not be parsed: ${error}`);
    }
    if (isDeepStrictEqual(previous.tools, snapshot.tools)) return;

    expect(
      snapshot.mcpServerVersion,
      `The recorded MCP tool surface changed relative to ${base.slice(0, 8)} but the version did not move (${previous.mcpServerVersion}). Bump MCP_SERVER_VERSION in src/lib/mcp/protocol.ts and record it in scripts/mcp-surface-snapshot.json in the same change.`,
    ).not.toBe(previous.mcpServerVersion);
  });

  it.each([
    { label: "two-parent merge", fields: ["head", "first", "second"], expected: "first" },
    { label: "octopus merge", fields: ["head", "first", "second", "third"], expected: "first" },
    { label: "single-parent commit", fields: ["head", "first"], expected: undefined },
  ])("selects the snapshot base for a $label", ({ fields, expected }) => {
    expect(firstParentOfMerge(fields)).toBe(expected);
  });
});
