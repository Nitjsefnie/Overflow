import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { decode, encode } from "next-auth/jwt";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";

/**
 * The session cookie's content, end to end against the installed @auth/core
 * (issue 678): the /account-data notice promises that sign-in reads only the
 * public GitHub identity — the numeric user id and the login — so the cookie
 * minted by the real OAuth handshake must hold exactly that, with no display
 * name, no e-mail claim, and no avatar (issue 1075). The same notice describes
 * the cookie as encrypted, which the decoded payload only fits if the real
 * `encode` produced it.
 *
 * Nothing of Auth.js is mocked. The real `GET`/`POST` handlers exported from
 * `src/auth.ts` are driven with real `Request` objects through the complete
 * handshake — `GET /api/auth/csrf`, the sign-in page's `POST
 * /api/auth/signin/github` (the CSRF-protected form the built-in page posts;
 * its `GET` renders HTML and never redirects), then the provider
 * `GET /api/auth/callback/github` redirect chain — with GitHub's token and
 * `/user` endpoints stubbed at `fetch` and the session cookie captured from
 * the responses. Only Next's request context (`next/headers`) is stubbed,
 * because there is no request outside a Next server (the way
 * tests/api/tokens-session-cookie.test.ts does it), and the account store is
 * the real one, against a disposable database.
 *
 * A test that only read the callbacks' return values could not see the
 * provider's own profile mapping or the JWE the handler actually sets.
 */

// Dynamic route imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const requestContext = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => requestContext.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const appUrl = "http://overflow.test";
const sessionCookieName = "authjs.session-token";
const authSecret = "session-cookie-content-test-secret-not-for-production";
/** 43 base64url characters — the same 32-byte shape the deployment key has. */
const tokenEncryptionKey = "session-cookie-content-test-key-AAAAAAAAAAA";
const sessionCookieSalt = sessionCookieName;
const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const githubUserId = 76_402_001;
const login = "octocat-678";
const avatarUrl = `https://avatars.githubusercontent.com/u/${githubUserId}?v=4`;

/**
 * GitHub's real /user body carries the display name, the e-mail, and the
 * avatar URL alongside the public fields; the extra fields are there to prove
 * the projection drops everything but the two it names.
 */
const githubUserBody = {
  login,
  id: githubUserId,
  name: "Display Name",
  email: "member@example.com",
  avatar_url: avatarUrl,
  type: "User",
  site_admin: false,
  url: `https://api.github.com/users/${login}`,
  created_at: "2011-01-25T18:44:36Z",
};

/** Every instant in this file is read from this pinned clock, never the wall clock. */
const now = new Date("2026-09-26T12:00:00.000Z");
const nowSeconds = now.getTime() / 1000;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthUrl = process.env.AUTH_URL;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;
let container: StartedTestContainer | undefined;
let sql: Sql | undefined;
let userId = "";
let authRoute: typeof import("@/app/api/auth/[...nextauth]/route") | undefined;
let databaseClient: typeof import("@/lib/db/client") | undefined;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "session_cookie_content",
    user: "session_cookie_content",
    password: "session_cookie_content",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl, { max: 1 });
  // The row the sign-in below upserts. Seeding it here makes the tests
  // order-independent: the handshake restores the row through the real
  // upsert either way, and the row id the cookies must carry is known.
  await sql`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login})
  `;
  const [row] = await sql<{ id: string }[]>`
    select id from users where github_user_id = ${githubUserId}
  `;
  userId = row!.id;

  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("AUTH_GITHUB_ID", "session-cookie-content-client-id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "session-cookie-content-client-secret");
  vi.stubEnv("AUTH_TRUST_HOST", "true");
  vi.stubEnv("APP_URL", appUrl);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", tokenEncryptionKey);
  // A non-matching moderator id keeps the seeded account's MEMBER role
  // deterministic.
  vi.stubEnv("MODERATOR_GITHUB_USER_IDS", "1");
  // AUTH_URL/NEXTAUTH_URL are deliberately absent: the handlers are driven
  // with plain `Request` objects, and next-auth rewrites the request origin
  // (through a NextRequest) only when one of them is set. With
  // AUTH_TRUST_HOST the request's own origin is what @auth/core uses,
  // exactly like a request that actually arrives.
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;

  // A fresh graph, so @/auth reads this environment when the route first
  // loads it and the route's database client is the one closed below.
  vi.resetModules();
  authRoute = await import("@/app/api/auth/[...nextauth]/route");
  databaseClient = await import("@/lib/db/client");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Two module graphs, two pools: the migration ran on this file's static
  // client, the route on the one loaded after the reset.
  await databaseClient?.closeSql();
  await closeSql();
  await sql?.end();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = originalAuthUrl;
  }
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
});

// Workers are reused across files (isolate: false): the pinned clock and any global
// stub belong to this file alone — a stub left installed would leak into every later
// file this worker runs (issue 753).
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(
    vi.isMockFunction(globalThis.fetch),
    "a fetch stub survived afterEach — unstubAllGlobals did not restore it (issue 753)",
  ).toBe(false);
});

/**
 * Routes the fetches the handshake makes to their stub answers and fails
 * loudly on anything else.
 */
function stubGitHubEndpoints(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GITHUB_TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: "gho_session_cookie_content_access_token", token_type: "bearer", scope: "" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === GITHUB_USER_URL) {
      return new Response(JSON.stringify(githubUserBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch during the sign-in handshake: ${url}`);
  }));
}

/** Folds every Set-Cookie a response sent into the jar, newest value wins. */
function mergeSetCookies(jar: Map<string, string>, response: Response): void {
  for (const rawCookie of response.headers.getSetCookie()) {
    const pair = rawCookie.split(";")[0]!;
    const equals = pair.indexOf("=");
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Drives the real handler with the jar's cookies, as the browser would send them. */
async function driveAuthHandler(
  method: "GET" | "POST",
  url: string,
  jar: Map<string, string>,
  body?: URLSearchParams,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: cookieHeader(jar) };
  if (body !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
  requestContext.headers = new Headers(request.headers);
  // next-auth's handler types name a NextRequest; @auth/core itself reads a
  // standard Request, and the runtime contract is the standard one.
  return method === "POST" ? authRoute!.POST(request as never) : authRoute!.GET(request as never);
}

async function sessionCookieValue(jar: Map<string, string>): Promise<string> {
  const value = jar.get(sessionCookieName);
  expect(value, "the handshake never set the session cookie").toBeDefined();
  return value!;
}

describe("the session cookie the real sign-in handshake mints", () => {
  it("holds the login and no e-mail — not the profile's display name or address, and not the avatar (issue 1075)", async () => {
    stubGitHubEndpoints();
    const jar = new Map<string, string>();

    // Sign-in initiation: the CSRF endpoint, then the form post the built-in
    // sign-in page makes, which answers with the GitHub authorization URL.
    const csrfResponse = await driveAuthHandler("GET", `${appUrl}/api/auth/csrf`, jar);
    expect(csrfResponse.status).toBe(200);
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
    expect(csrfToken).toMatch(/\S/);
    mergeSetCookies(jar, csrfResponse);

    const signInResponse = await driveAuthHandler(
      "POST",
      `${appUrl}/api/auth/signin/github`,
      jar,
      new URLSearchParams({ csrfToken }),
    );
    expect(signInResponse.status).toBe(302);
    const authorizeUrl = new URL(signInResponse.headers.get("Location")!);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe("https://github.com/login/oauth/authorize");
    mergeSetCookies(jar, signInResponse);

    // The provider redirect comes back with the code, and the handler
    // completes the handshake: token exchange, /user, the callbacks, and the
    // session cookie. The pinned @auth/core binds the callback to this
    // browser by PKCE — the authorize URL carries a code challenge and the
    // jar its code-verifier cookie — and no state parameter exists (pinned
    // by tests/security/github-authorization-url.test.ts).
    const callbackResponse = await driveAuthHandler(
      "GET",
      `${appUrl}/api/auth/callback/github?code=real-handshake-code`,
      jar,
    );
    expect(callbackResponse.status).toBe(302);

    mergeSetCookies(jar, callbackResponse);
    const cookieValue = await sessionCookieValue(jar);
    const payload = (await decode({ token: cookieValue, secret: authSecret, salt: sessionCookieSalt }))!;

    // The public identity only: the login is the name, never the display
    // name; the e-mail claim is gone entirely, not merely empty, and the
    // avatar the /user body carries never enters the cookie (issue 1075).
    expect(payload.name).toBe(login);
    expect(payload.name).not.toBe("Display Name");
    expect(Object.hasOwn(payload, "email")).toBe(false);
    expect(Object.hasOwn(payload, "picture")).toBe(false);

    // The Overflow claims ride along.
    expect(payload.userId).toBe(userId);
    expect(payload.role).toBe("MEMBER");
    expect(payload.canAdministerWebhooks).toBe(false);
    expect(payload.authenticatedAt).toBe(nowSeconds);

    // Encrypted with a 30-day life, as the notice describes the cookie.
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
    expect(payload.exp! - payload.iat!).toBe(thirtyDaysInSeconds);

    // The session the cookie resolves to matches what the notice states.
    const sessionResponse = await driveAuthHandler("GET", `${appUrl}/api/auth/session`, jar);
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      user: { name?: string; email?: string; image?: string; id?: string; role?: string };
    };
    expect(session.user.name).toBe(login);
    expect(session.user.email).toBeUndefined();
    expect(Object.hasOwn(session.user, "email")).toBe(false);
    expect(Object.hasOwn(session.user, "image")).toBe(false);
    expect(session.user.id).toBe(userId);
    expect(session.user.role).toBe("MEMBER");

    // The storage path ran inside the same handshake, against an avatar-bearing
    // /user body: the account row's avatar column reads null (issue 1075).
    const [row] = await sql!<({ avatar_url: string | null }[])>`
      select avatar_url from users where id = ${userId}
    `;
    expect(row!.avatar_url).toBeNull();
  });
});

describe("a session cookie minted before the epoch existed, refreshed", () => {
  it("loses the display name and the e-mail at the next session read, and the stripped token is what persists", async () => {
    // A token minted after the issue-678 projection but before the issue-1043
    // epoch: the profile's display name as the name, the e-mail claim
    // present, and the epoch claim stamped at its sign-in. (An epoch-less
    // token dies at this refresh instead — tests/auth/session-revocation.test.ts
    // pins that leg.) The sub is a UUID literal because that is what
    // @auth/core puts there — a per-sign-in random UUID, never the numeric
    // GitHub id.
    const preFixToken = {
      name: "Display Name",
      email: "member@example.com",
      sub: "0189d1a6-1c2e-7f3b-9f4a-2f6b8f1c9e55",
      userId,
      role: "MEMBER",
      picture: avatarUrl,
      canAdministerWebhooks: true,
      authenticatedAt: nowSeconds - 3600,
      sessionEpoch: 0,
    };
    const preFixCookieValue = await encode({ token: preFixToken, secret: authSecret, salt: sessionCookieSalt });

    stubGitHubEndpoints();
    const jar = new Map<string, string>([[sessionCookieName, preFixCookieValue]]);

    const sessionResponse = await driveAuthHandler("GET", `${appUrl}/api/auth/session`, jar);
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      user: { name?: string; email?: string; image?: string; id?: string; role?: string; canAdministerWebhooks?: boolean; authenticatedAt?: number };
    };

    // The refreshed session resolves against the account row: the row's
    // login as the name, no e-mail, and the pre-fix claims carried forward.
    expect(session.user.name).toBe(login);
    expect(session.user.name).not.toBe("Display Name");
    expect(Object.hasOwn(session.user, "email")).toBe(false);
    expect(session.user.id).toBe(userId);
    expect(session.user.role).toBe("MEMBER");
    expect(session.user.canAdministerWebhooks).toBe(true);
    expect(session.user.authenticatedAt).toBe(nowSeconds - 3600);

    // The refresh re-issues the cookie on every successful session read —
    // that re-issued cookie IS what persists, so its decoded payload is the
    // stripped token: no e-mail claim, no avatar, the login as the name.
    mergeSetCookies(jar, sessionResponse);
    const refreshedCookieValue = await sessionCookieValue(jar);
    const refreshedPayload = (await decode({ token: refreshedCookieValue, secret: authSecret, salt: sessionCookieSalt }))!;

    expect(Object.hasOwn(refreshedPayload, "email")).toBe(false);
    expect(refreshedPayload.name).toBe(login);
    expect(Object.hasOwn(refreshedPayload, "picture")).toBe(false);
    expect(refreshedPayload.userId).toBe(userId);
    expect(refreshedPayload.role).toBe("MEMBER");
    expect(refreshedPayload.canAdministerWebhooks).toBe(true);
    expect(refreshedPayload.authenticatedAt).toBe(nowSeconds - 3600);
  });
});
