import { describe, expect, it, vi } from "vitest";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";
import { GET as getProtectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as getApiMcpProtectedResource } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";

useTrustedOrigin();

describe("GET /.well-known/oauth-protected-resource", () => {
  it.each([
    ["the well-known root", getProtectedResource],
    ["the /api/mcp location", getApiMcpProtectedResource],
  ])("answers %s with the RFC 9728 document at 200", async (_name, handler) => {
    const response = await handler();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      resource: `${trustedOrigin}/api/mcp`,
      bearer_methods_supported: ["header"],
    });
  });

  it("serves byte-identical documents from the two locations", async () => {
    const [rootResponse, apiMcpResponse] = [await getProtectedResource(), await getApiMcpProtectedResource()];

    expect(await rootResponse.text()).toBe(await apiMcpResponse.text());
  });

  it.each([
    ["unset", ""],
    ["unparsable", "not a url"],
  ])("answers both locations with the misconfiguration refusal when APP_URL is %s", async (_name, appUrl) => {
    // The top-level useTrustedOrigin() stubs APP_URL first; this override wins
    // for the body of this test and afterEach unstubs it.
    vi.stubEnv("APP_URL", appUrl);

    const responses = [await getProtectedResource(), await getApiMcpProtectedResource()];

    for (const response of responses) {
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "MISCONFIGURED",
          message: "The server is not configured to accept this request.",
        },
      });
    }
  });

  it("exports no POST handler, leaving Next to answer other methods with 405", async () => {
    for (const route of [
      await import("@/app/.well-known/oauth-protected-resource/route"),
      await import("@/app/.well-known/oauth-protected-resource/api/mcp/route"),
    ]) {
      const exports: Record<string, unknown> = route;
      expect(exports.POST).toBeUndefined();
      expect(exports.GET).toBeTypeOf("function");
    }
  });
});
