import { readFileSync } from "node:fs";
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
  auditOpen: stub,
  auditDecide: stub,
  correctionOpen: stub,
  correctionDecide: stub,
};

const snapshot = JSON.parse(
  readFileSync(new URL("../../scripts/mcp-surface-snapshot.json", import.meta.url), "utf8"),
) as { mcpServerVersion: string; tools: unknown[] };

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
});
