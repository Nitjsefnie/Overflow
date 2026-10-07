import { describe, expect, it } from "vitest";
import * as layout from "../../src/app/layout";

// Issue 1046: the middleware's nonce-based script CSP reaches Next's bootstrap
// scripts only when a page renders dynamically — prerendered HTML is produced
// at build time, when no request exists, so its scripts carry no nonce and
// 'strict-dynamic' blocks every one of them (measured live before the fix:
// headless Chrome reported 24 blocked scripts on /terms, 12 on /account-data,
// and the same break on every 404 served from the prerendered /_not-found,
// with hydration dead on all of them). Next's own CSP guide states the
// requirement this pin encodes: "When you use nonces in your CSP, all pages
// must be dynamically rendered."
//
// The root layout carries the segment config because it governs every route
// nested under it — the two prerendered pages AND the not-found route — so
// one declaration covers all three static surfaces. force-dynamic is the
// statically-known spelling the build reads (AppSegmentConfigSchema), the
// same spelling the third-party-notices route already uses
// (tests/scripts/third-party-notices-route.test.ts), so the route table pins
// every route ƒ and no surface renders from build-time HTML.
describe("nonce CSP requires dynamic rendering (issue 1046)", () => {
  it("renders every route dynamically: the root layout is force-dynamic", () => {
    expect(layout.dynamic).toBe("force-dynamic");
  });
});
