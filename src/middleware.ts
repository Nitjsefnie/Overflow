import { NextRequest, NextResponse } from "next/server";

// Script CSP (issue 1046): give every document a per-request nonce so Next's
// bootstrap scripts stay allowlisted without unsafe-inline. The header carries
// ONLY the script-src directive — no default-src (which would silently
// constrain styles, images and connects this app has not audited), no
// unsafe-inline and no unsafe-eval (the nonce plus strict-dynamic replaces
// them), and no frame-ancestors (owned by the static next.config header;
// browsers enforce both headers' intersection). Next parses the nonce out of
// the request's Content-Security-Policy header and applies it to its own
// scripts automatically, so the request and the response carry the same value.

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicyHeaderValue = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  return response;
}

// Docs' production matcher, minus the docs' api exclusion: this app's API
// routes are matched too. Static assets, the favicon and prefetches are
// skipped — a prefetched RSC payload must not receive a different nonce than
// its document, or hydration breaks. Prefetch exclusion lives in `missing`,
// never in the source pattern. (The docs' dev-only purpose: prefetch condition
// is carried unconditionally: a header-keyed skip is harmless in production
// and a static literal is what the pinned test compiles.)
export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
