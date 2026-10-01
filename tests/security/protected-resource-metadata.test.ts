import { describe, expect, it, vi } from "vitest";
import { protectedResourceMetadata } from "@/lib/security/protected-resource-metadata";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

/**
 * The protected-resource metadata document itself, at the boundary the two
 * `.well-known` routes call it from: what a deployment with no trusted origin
 * hands back, and exactly which resource and bearer methods it names when it
 * does. The routes pin the same document over the wire; this file pins it at
 * the module boundary, where `null` is the answer and a 500 is not — a
 * degenerate document instead of `null` would serialize as a 200 and tell a
 * discovery client the deployment's resource was named by nothing.
 *
 * `readTrustedOrigin` reads `APP_URL` at call time, so the environment is the
 * seam here and the module needs no mock.
 */

useTrustedOrigin();

describe("the protected-resource metadata document", () => {
  it("names this deployment's MCP endpoint at the trusted origin", () => {
    // The top-level useTrustedOrigin() stubs APP_URL for every test in this
    // file; the override here wins for this test and afterEach unstubs it.
    vi.stubEnv("APP_URL", trustedOrigin);

    expect(protectedResourceMetadata()).toEqual({
      resource: `${trustedOrigin}/api/mcp`,
      bearer_methods_supported: ["header"],
    });
  });

  it("names the origin APP_URL carries, not the APP_URL itself", () => {
    // A deployment configured with a path and a query still serves one origin,
    // so the resource a client is told to fetch is that origin's MCP endpoint.
    vi.stubEnv("APP_URL", "https://overflow.example/mcp?tenant=1");

    expect(protectedResourceMetadata()).toEqual({
      resource: `${trustedOrigin}/api/mcp`,
      bearer_methods_supported: ["header"],
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["unparsable", "not a url"],
    ["an opaque origin", "data:text/plain,hello"],
  ])("is null when APP_URL is %s", (_name, appUrl) => {
    vi.stubEnv("APP_URL", appUrl);

    // Null rather than a document: there is no resource to name, and a
    // document naming one would be a lie the caller would serve at 200.
    expect(protectedResourceMetadata()).toBeNull();
  });
});