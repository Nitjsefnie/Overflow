import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "../../src/middleware";

// Issue 1046: the middleware serves a per-request, nonce-based script CSP so
// Next's bootstrap scripts stay allowlisted without unsafe-inline. These tests
// drive the real middleware with a NextRequest and read back the headers Next's
// own adapter reads (x-middleware-override-headers plus one
// x-middleware-request-<name> per propagated header), and evaluate
// config.matcher with Next's own build-time compiler and runtime route matcher
// rather than a re-derivation of either.

// The full CSP template: only the nonce varies, and nothing else is in the
// value. A nonce is base64 (from a UUID string), so its characters are
// unreserved plus '+' and '/'.
const cspPattern = /^script-src 'self' 'nonce-([A-Za-z0-9+/]+=*)' 'strict-dynamic'$/;

function cspOf(response: Response) {
  const csp = response.headers.get("content-security-policy");
  expect(csp, "middleware must set a Content-Security-Policy header").toBeTypeOf("string");
  return csp as string;
}

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://overflow.test${path}`, { headers });
}

function nonceOf(response: Response) {
  const match = cspPattern.exec(cspOf(response));
  expect(match, `CSP must match the script-src template, got: ${cspOf(response)}`).not.toBeNull();
  return match![1];
}

describe("middleware script CSP", () => {
  it("serves a nonce-based script-src CSP on the response", () => {
    const response = middleware(request("/some-page"));

    const csp = cspOf(response);
    expect(csp.startsWith("script-src 'self' 'nonce-")).toBe(true);
    expect(csp).toContain("'strict-dynamic'");
    expect(cspPattern.test(csp)).toBe(true);
  });

  it("generates a fresh nonce for every request", () => {
    const first = nonceOf(middleware(request("/some-page")));
    const second = nonceOf(middleware(request("/some-page")));

    expect(first).not.toBe(second);
  });

  it("carries no unsafe-inline, unsafe-eval, default-src or frame-ancestors", () => {
    const csp = cspOf(middleware(request("/some-page")));

    for (const forbidden of ["unsafe-inline", "unsafe-eval", "default-src", "frame-ancestors"]) {
      expect(csp.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("propagates the nonce and the CSP to the request the renderer receives", () => {
    const response = middleware(request("/some-page"));
    const csp = cspOf(response);

    // NextResponse.next({ request: { headers } }) records the propagated
    // request headers on the response: the comma-joined name list, then one
    // value header per name. Next's adapter applies exactly these to the
    // request downstream rendering sees, and its nonce support parses the CSP
    // from that request header, so both must carry the same values.
    const names = response.headers.get("x-middleware-override-headers")?.split(",");
    expect(names).toContain("x-nonce");
    expect(names).toContain("content-security-policy");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(response));
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("exports only the handler and its matcher config", async () => {
    const middlewareModule = await import("../../src/middleware");

    expect(Object.keys(middlewareModule).sort()).toEqual(["config", "middleware"]);
  });
});

describe("middleware matcher config", () => {
  // The docs' production shape, minus the docs' api exclusion: this app's API
  // routes are matched (the brief rules /api/x must match), so only the static
  // assets, the favicon and prefetches are skipped. Prefetch exclusion lives in
  // `missing`, never in the source pattern — the source is pinned as an exact
  // literal below.
  const pinnedMatcher = [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ];

  it("is pinned to the exact matcher literal", () => {
    expect(config.matcher).toEqual(pinnedMatcher);
  });

  // Compile the matcher the way Next's build does and evaluate it the way
  // next-server does per request: getMiddlewareMatchers wraps the source with
  // the middleware data-route prefix and suffix and parses it with
  // tryToParsePath; getMiddlewareRouteMatcher then runs the compiled regexp and
  // the has/missing conditions. getMiddlewareMatchers is a JS-only export
  // (absent from next's .d.ts), hence the narrow module shape; the route
  // matcher's request parameter is typed as a BaseNextRequest but its missing
  // conditions read only req.headers.
  async function matcherFor(matcher: typeof pinnedMatcher) {
    const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
      getMiddlewareMatchers: (
        matcherOrMatchers: unknown,
        nextConfig: { basePath?: string; i18n?: unknown },
      ) => Parameters<typeof import("next/dist/shared/lib/router/utils/middleware-route-matcher").getMiddlewareRouteMatcher>[0];
    };
    const compiled = getMiddlewareMatchers(matcher, {});
    const { getMiddlewareRouteMatcher } = await import(
      "next/dist/shared/lib/router/utils/middleware-route-matcher"
    );
    return (pathname: string, headers: Record<string, string> = {}) =>
      getMiddlewareRouteMatcher(compiled)(pathname, { headers } as Parameters<ReturnType<typeof getMiddlewareRouteMatcher>>[1], {});
  }

  it("matches pages and API routes", async () => {
    const matches = await matcherFor(config.matcher as typeof pinnedMatcher);

    expect(matches("/some-page")).toBe(true);
    expect(matches("/api/x")).toBe(true);
  });

  it("skips static assets and the favicon", async () => {
    const matches = await matcherFor(config.matcher as typeof pinnedMatcher);

    expect(matches("/_next/static/chunks/x.js")).toBe(false);
    // The query string is not part of the pathname Next matches, so /_next/image
    // with any query is excluded by the same source clause.
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });

  it("skips prefetched requests so a prefetch never carries a different nonce", async () => {
    const matches = await matcherFor(config.matcher as typeof pinnedMatcher);

    expect(matches("/some-page", { "next-router-prefetch": "1" })).toBe(false);
    expect(matches("/some-page", { purpose: "prefetch" })).toBe(false);
  });
});
