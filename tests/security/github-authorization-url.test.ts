import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue 599, at the framework boundary: the authorization URL the pinned
 * Auth.js actually builds for each sign-in, from Overflow's real provider
 * configuration. Nothing of Auth.js is mocked — `signIn` with
 * `redirect: false` runs `@auth/core`'s sign-in action and returns the URL
 * it would redirect the browser to. Only Next's request context
 * (`next/headers`) is stubbed, because there is no request outside a Next
 * server; the database client is stubbed because the auth module imports
 * it and no callback here reaches it. Placeholder OAuth credentials suffice:
 * building the URL contacts nothing.
 */
const requestContext = vi.hoisted(() => {
  const cookieJar = new Map<string, { value: string; options?: unknown }>();
  return {
    cookieJar,
    headers: vi.fn(async () => new Headers({ host: "overflow.test", "x-forwarded-proto": "https" })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const entry = cookieJar.get(name);
        return entry === undefined ? undefined : { name, value: entry.value };
      },
      set: (name: string, value: string, options?: unknown) => {
        cookieJar.set(name, { value, options });
      },
    })),
  };
});

vi.mock("next/headers", () => ({ headers: requestContext.headers, cookies: requestContext.cookies }));
vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`unexpected redirect to ${target}`);
  },
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

async function authorizationUrl(
  action: (signIn: typeof import("@/auth").signIn) => Promise<unknown>,
): Promise<URL> {
  const { signIn } = await import("@/auth");
  const location = await action(signIn);
  expect(typeof location).toBe("string");
  return new URL(location as string);
}

describe("GitHub authorization URL", () => {
  beforeEach(() => {
    vi.resetModules();
    requestContext.cookieJar.clear();
    vi.stubEnv("AUTH_SECRET", "test-only-secret-that-is-long-enough-0123456789");
    vi.stubEnv("AUTH_GITHUB_ID", "placeholder-client-id");
    vi.stubEnv("AUTH_GITHUB_SECRET", "placeholder-client-secret");
    vi.stubEnv("AUTH_URL", "https://overflow.test");
    vi.stubEnv("AUTH_TRUST_HOST", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks GitHub for no scope on the contributor sign-in and returns to the dashboard", async () => {
    const url = await authorizationUrl((signIn) =>
      signIn("github", { redirect: false, redirectTo: "/dashboard" }, { scope: "" }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(GITHUB_AUTHORIZE_URL);
    expect(url.searchParams.get("scope")).toBe("");
    expect(url.searchParams.get("client_id")).toBe("placeholder-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://overflow.test/api/auth/callback/github");
    expect(requestContext.cookieJar.get("__Secure-authjs.callback-url")?.value).toBe("https://overflow.test/dashboard");
  });

  it("asks GitHub for exactly admin:repo_hook on the registration sign-in and returns to registration", async () => {
    const url = await authorizationUrl((signIn) =>
      signIn("github", { redirect: false, redirectTo: "/repositories/new" }, { scope: "admin:repo_hook" }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(GITHUB_AUTHORIZE_URL);
    expect(url.searchParams.get("scope")).toBe("admin:repo_hook");
    expect(requestContext.cookieJar.get("__Secure-authjs.callback-url")?.value).toBe(
      "https://overflow.test/repositories/new",
    );
  });

  it("asks GitHub for no scope when a sign-in names none, and never the OIDC default", async () => {
    const url = await authorizationUrl((signIn) => signIn("github", { redirect: false }));

    expect(url.searchParams.get("scope")).toBe("");
    expect(url.searchParams.get("scope")).not.toContain("openid");
  });

  // The provider's default check is PKCE (@auth/core 0.41.3 normalizeOAuth:
  // checks ?? ["pkce"]), so the callback is bound to this browser by the
  // code challenge and its cookie rather than a state parameter.
  it("binds every sign-in to the browser with a PKCE challenge and its cookie", async () => {
    const url = await authorizationUrl((signIn) => signIn("github", { redirect: false }, { scope: "admin:repo_hook" }));

    expect(url.searchParams.get("code_challenge")).toMatch(/\S/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(requestContext.cookieJar.has("__Secure-authjs.pkce.code_verifier")).toBe(true);
  });
});
