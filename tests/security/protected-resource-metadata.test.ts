import { describe, expect, it, vi } from "vitest";
import { protectedResourceMetadata } from "@/lib/security/protected-resource-metadata";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

/**
 * The one boundary of the protected-resource metadata document that no other
 * suite sees (issue 905): the resource is built from the origin
 * `readTrustedOrigin` derives, not from `APP_URL` itself. A deployment that
 * configures a path or a query serves one origin, and a client told to fetch
 * the configured URL would fetch something that is not this MCP endpoint. Both
 * routes already pin the document over the wire and `request-origin.test.ts`
 * pins every way `APP_URL` fails to name an origin, so this file holds that
 * single case and the module-level null it propagates is left to them.
 *
 * `readTrustedOrigin` reads `APP_URL` at call time, so the environment is the
 * seam here and the module needs no mock.
 */

useTrustedOrigin();

describe("the protected-resource metadata document", () => {
  it("names the origin APP_URL carries at the MCP endpoint, not APP_URL itself", () => {
    // The top-level useTrustedOrigin() stubs APP_URL for every test in this
    // file; the override here wins for this test and afterEach unstubs it. The
    // whole document is compared, so the header bearer method is pinned with
    // the resource, and a method added beside it dies on the same assertion.
    vi.stubEnv("APP_URL", "https://overflow.example/mcp?tenant=1");

    expect(protectedResourceMetadata()).toEqual({
      resource: `${trustedOrigin}/api/mcp`,
      bearer_methods_supported: ["header"],
    });
  });
});
