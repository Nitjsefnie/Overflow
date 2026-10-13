import { defineMcpTools, type McpToolDependencies } from "../src/lib/mcp/tools.ts";
import type { RecordedMcpSurface } from "./surface-change.ts";

/** Record the client-visible names, descriptions and schemas without invoking a tool. */
export function deriveMcpSurfaceRecord(): RecordedMcpSurface {
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
  return { tools: defineMcpTools(dependencies, new Headers()).map(
    ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
  ) };
}
