import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baseCommit,
  firstParentOfMerge,
  pickBase,
} from "../../scripts/http-surface-derive.ts";
import { readSurfaceSnapshotsAt } from "../../scripts/surface-snapshot-base.ts";
import { assertSnapshotVersions } from "../../scripts/surface-version.ts";
import type { HttpSurfaceSnapshot, McpSurfaceSnapshot } from "../../scripts/surface-change.ts";
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
) as McpSurfaceSnapshot;
const httpSnapshot = JSON.parse(
  readFileSync(new URL("../../scripts/http-surface-snapshot.json", import.meta.url), "utf8"),
) as HttpSurfaceSnapshot;

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
      `scripts/mcp-surface-snapshot.json records ${snapshot.mcpServerVersion} but MCP_SERVER_VERSION is ${MCP_SERVER_VERSION}. The snapshot and MCP_SERVER_VERSION move together: run the update script (it moves all four version sites) or edit both to the same value.`,
    ).toBe(MCP_SERVER_VERSION);
  });

  it("enforces the combined HTTP and MCP SemVer requirement", () => {
    const base = baseCommit(process.env.MCP_SNAPSHOT_BASE_COMMIT ?? process.env.HTTP_SNAPSHOT_BASE_COMMIT, "MCP");
    assertSnapshotVersions(readSurfaceSnapshotsAt(base), { http: httpSnapshot, mcp: snapshot });
  });

  it.each([
    { label: "two-parent merge", fields: ["head", "first", "second"], expected: "first" },
    { label: "octopus merge", fields: ["head", "first", "second", "third"], expected: "first" },
    { label: "single-parent commit", fields: ["head", "first"], expected: undefined },
  ])("selects the snapshot base for a $label", ({ fields, expected }) => {
    expect(firstParentOfMerge(fields)).toBe(expected);
  });

  it.each([
    {
      label: "merge commit",
      parentFields: ["head", "first", "second"],
      mergeBase: "other-base",
      headParentResolved: "head-parent",
      expected: "first",
    },
    {
      label: "PR branch with a distinct merge base",
      parentFields: ["head", "head-parent"],
      mergeBase: "branch-base",
      headParentResolved: "head-parent",
      expected: "branch-base",
    },
    {
      label: "main tip whose merge base is HEAD",
      parentFields: ["head", "head-parent"],
      mergeBase: "head",
      headParentResolved: "head-parent",
      expected: "head-parent",
    },
    {
      label: "missing merge base with a resolved HEAD parent",
      parentFields: ["head", "head-parent"],
      mergeBase: undefined,
      headParentResolved: "head-parent",
      expected: "head-parent",
    },
    {
      label: "unavailable base",
      parentFields: ["head"],
      mergeBase: undefined,
      headParentResolved: undefined,
      expected: undefined,
    },
  ])("picks the snapshot base for a $label", ({ parentFields, mergeBase, headParentResolved, expected }) => {
    expect(pickBase({ parentFields, mergeBase, headParentResolved })).toBe(expected);
  });
});
