/**
 * The advertised server version.
 *
 * ONE version covers the HTTP API and the MCP endpoint alike: the value here
 * is what `/api/version` answers and what the MCP server reports in its
 * `serverInfo`. An additive recorded change moves the MINOR component in
 * the same major; a removed or changed HTTP answer or existing MCP tool
 * entry moves the MAJOR component (policy in API.md).
 *
 * Kept equal to MCP_SERVER_VERSION (src/lib/mcp/protocol.ts) by
 * tests/lib/api-version.test.ts; the update script moves that literal and
 * scripts/mcp-surface-snapshot.json together.
 */
export const SERVER_VERSION = "1.4.0";
