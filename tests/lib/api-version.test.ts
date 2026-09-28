import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/version/route";
import { MCP_SERVER_VERSION } from "@/lib/mcp/protocol";
import { SERVER_VERSION } from "@/lib/version";

describe("server version", () => {
  it("GET /api/version answers 200 with the exact body and no-store", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: SERVER_VERSION });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps SERVER_VERSION equal to MCP_SERVER_VERSION", () => {
    expect(
      SERVER_VERSION,
      `src/lib/version.ts SERVER_VERSION ${JSON.stringify(SERVER_VERSION)} does not equal ` +
        `src/lib/mcp/protocol.ts MCP_SERVER_VERSION ${JSON.stringify(MCP_SERVER_VERSION)}. ` +
        "One version covers the HTTP API and the MCP endpoint (policy in API.md); move both together by running " +
        "`node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/update-mcp-surface-snapshot.ts --version <next>` " +
        "and setting SERVER_VERSION in src/lib/version.ts to the same value in the same change.",
    ).toBe(MCP_SERVER_VERSION);
  });
});
