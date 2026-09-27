import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authTrustHost } from "@/lib/auth/trusted-host";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => {
  vi.resetModules();
});

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`unexpected redirect to ${target}`);
  },
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Next's global types declare NODE_ENV a required 'development' |
  // 'production' | 'test'; a record carrying any of the three satisfies it.
  // "test" is the not-production case (and vitest's own NODE_ENV), and runs
  // the same `!== "production"` branch an absent NODE_ENV would.
  return { NODE_ENV: "test", ...overrides };
}

describe("authTrustHost", () => {
  it("trusts a production deployment configured from only the documented settings", () => {
    // The issue 649 case: APP_URL present and parsable, no operator variable.
    expect(
      authTrustHost(env({ NODE_ENV: "production", APP_URL: "http://127.0.0.1:3111" })),
    ).toBe(true);
  });

  it("still trusts when NODE_ENV is not production, as @auth/core does", () => {
    expect(authTrustHost(env({ NODE_ENV: "development" }))).toBe(true);
    expect(authTrustHost(env({ NODE_ENV: "test" }))).toBe(true);
  });

  it("distrusts a production deployment configured with nothing at all", () => {
    // The pre-fix behavior this module exists to remove in the documented
    // environment — and the behavior that must stay for an empty one.
    expect(authTrustHost(env({ NODE_ENV: "production" }))).toBe(false);
  });

  it("reads a missing, blank, whitespace or malformed APP_URL as distrust", () => {
    for (const [label, appUrl] of [
      ["missing", undefined],
      ["blank", ""],
      ["whitespace", "   "],
      ["malformed", "not-a-url"],
      ["opaque origin", "data:text/html,hi"],
    ] as const) {
      expect(
        authTrustHost(env({ NODE_ENV: "production", APP_URL: appUrl })),
        label,
      ).toBe(false);
    }
  });

  it("keeps an operator's AUTH_URL decisive, exactly as @auth/core reads it", () => {
    const appUrl = { APP_URL: "http://127.0.0.1:3111" };
    // A set value trusts ...
    expect(
      authTrustHost(env({ NODE_ENV: "production", AUTH_URL: "https://overflow.test", ...appUrl })),
    ).toBe(true);
    expect(
      authTrustHost(env({ NODE_ENV: "production", AUTH_URL: "https://overflow.test" })),
    ).toBe(true);
    // ... and a set-but-blank one distrusts, APP_URL notwithstanding — the
    // same verdict @auth/core's own chain reaches for a blank first alternative.
    expect(authTrustHost(env({ NODE_ENV: "production", AUTH_URL: "", ...appUrl }))).toBe(false);
  });

  it("keeps an operator's AUTH_TRUST_HOST decisive, exactly as @auth/core reads it", () => {
    const appUrl = { APP_URL: "http://127.0.0.1:3111" };
    expect(
      authTrustHost(env({ NODE_ENV: "production", AUTH_TRUST_HOST: "true", ...appUrl })),
    ).toBe(true);
    // Any nonblank value reads as trust — @auth/core truthiness, unchanged.
    expect(authTrustHost(env({ NODE_ENV: "production", AUTH_TRUST_HOST: "false" }))).toBe(true);
    // A blank one reads as the chain's next alternative: distrust here.
    expect(
      authTrustHost(env({ NODE_ENV: "production", AUTH_TRUST_HOST: "", ...appUrl })),
    ).toBe(false);
  });

  it("keeps the platform markers decisive, as @auth/core reads them", () => {
    expect(authTrustHost(env({ NODE_ENV: "production", VERCEL: "1" }))).toBe(true);
    expect(authTrustHost(env({ NODE_ENV: "production", CF_PAGES: "1" }))).toBe(true);
    expect(authTrustHost(env({ NODE_ENV: "production", VERCEL: "" }))).toBe(false);
  });

  it("derives trust from the origin APP_URL names, ignoring any path", () => {
    expect(
      authTrustHost(env({ NODE_ENV: "production", APP_URL: "https://overflow.test/some/path" })),
    ).toBe(true);
  });
});

describe("the NextAuth configuration derives Auth.js trust from APP_URL", () => {
  beforeEach(() => {
    vi.resetModules();
    // The documented environment: NODE_ENV=production and the .env.example
    // variables, with NO AUTH_URL and NO AUTH_TRUST_HOST. The odd port keeps
    // the test's server distinct from any local one; nothing binds it.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "http://127.0.0.1:3111");
    vi.stubEnv("AUTH_SECRET", "test-only-secret-that-is-long-enough-0123456789");
    vi.stubEnv("AUTH_GITHUB_ID", "placeholder-client-id");
    vi.stubEnv("AUTH_GITHUB_SECRET", "placeholder-client-secret");
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("AUTH_TRUST_HOST", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers /api/auth/providers with 200 from the documented environment alone", async () => {
    // src/auth.ts exports the handler pair at the module's top level, the
    // shape the App Router route re-exports. NextRequest is the handler's
    // real input shape: with AUTH_URL set, next-auth's reqWithEnvURL reads
    // `req.nextUrl`.
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/auth");
    const response = await GET(new NextRequest("http://127.0.0.1:3111/api/auth/providers"));
    expect(response.status).toBe(200);
  });

  it("still answers /api/auth/providers 200 when an operator sets AUTH_URL", async () => {
    vi.stubEnv("AUTH_URL", "https://overflow.test");
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/auth");
    const response = await GET(new NextRequest("http://127.0.0.1:3111/api/auth/providers"));
    expect(response.status).toBe(200);
  });

  it("answers /api/auth/providers with 500 when the environment carries no APP_URL", async () => {
    // The other half of the wiring: production with no APP_URL and no operator
    // variable must not default to trust. A constant-true trustHost — the
    // blanket shape the derivation exists to avoid — answers 200 here, so this
    // case fails for it while every 200 case above still passes.
    vi.stubEnv("APP_URL", undefined);
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/auth");
    const response = await GET(new NextRequest("http://127.0.0.1:3111/api/auth/providers"));
    expect(response.status).toBe(500);
  });
});
