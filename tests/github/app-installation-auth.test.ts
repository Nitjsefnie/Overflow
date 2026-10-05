import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appInstallationTokenResolverFromEnv,
  createAppInstallationTokenResolver,
  readGitHubAppAuthConfig,
} from "@/lib/github/app-installation-auth";
import { GitHubApiError, isGitHubRateLimitError } from "@/lib/github/errors";

const appId = "5118623";
const fixedClockMs = Date.parse("2026-09-29T12:00:00Z");
const tokenLifetimeMs = 3_600_000;
const refreshMarginMs = 300_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

type RecordedRequest = {
  url: string;
  method: string;
  authorization: string | null;
  accept: string | null;
  apiVersion: string | null;
  contentType: string | null;
  body: string | null;
};

function appConfig(): { appId: string; privateKey: string } {
  return { appId, privateKey: privateKeyPem };
}

function recordingFetch(handlers: {
  lookup: () => Response | Promise<Response>;
  mint?: () => Response | Promise<Response>;
}): { fetch: typeof fetch; requests: Array<Promise<RecordedRequest>> } {
  const requests: Array<Promise<RecordedRequest>> = [];
  const fetchImplementation: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(record(request));
    const respond = request.method === "GET"
      ? handlers.lookup
      : handlers.mint ?? (() => new Response("unexpected mint call", { status: 500 }));
    return Promise.resolve(respond());
  };
  return { fetch: fetchImplementation, requests };
}

async function record(request: Request): Promise<RecordedRequest> {
  return {
    url: request.url,
    method: request.method,
    authorization: request.headers.get("authorization"),
    accept: request.headers.get("accept"),
    apiVersion: request.headers.get("x-github-api-version"),
    contentType: request.headers.get("content-type"),
    body: request.method === "GET" ? null : await request.text(),
  };
}

function clockAt(offsetMs: number = 0): () => Date {
  return () => new Date(fixedClockMs + offsetMs);
}

function mutableClock(startMs: number = fixedClockMs): { now: () => Date; advance: (ms: number) => void } {
  let currentMs = startMs;
  return { now: () => new Date(currentMs), advance: (ms: number) => { currentMs += ms; } };
}

function decodeJwtSegment(jwt: string, index: 0 | 1): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[index]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("readGitHubAppAuthConfig", () => {
  it("builds the config from both vars and reads the key file at the configured path", () => {
    const readPaths: string[] = [];
    const config = readGitHubAppAuthConfig(
      { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem" },
      (path) => {
        readPaths.push(path);
        return privateKeyPem;
      },
    );

    expect(config).toEqual({ appId, privateKey: privateKeyPem });
    expect(readPaths).toEqual(["/keys/app.pem"]);
  });

  it("returns null when either var is unset or empty, without reading the key file", () => {
    const refuseToRead = (): string => {
      throw new Error("the key file must not be read while unconfigured");
    };

    expect(readGitHubAppAuthConfig({}, refuseToRead)).toBeNull();
    expect(readGitHubAppAuthConfig({ GITHUB_APP_ID: "" }, refuseToRead)).toBeNull();
    expect(readGitHubAppAuthConfig({ GITHUB_APP_PRIVATE_KEY_PATH: "" }, refuseToRead)).toBeNull();
    expect(readGitHubAppAuthConfig(
      { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY_PATH: "" },
      refuseToRead,
    )).toBeNull();
    expect(readGitHubAppAuthConfig(
      { GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem" },
      refuseToRead,
    )).toBeNull();
  });

  it("throws when configured but the key file is unreadable", () => {
    expect(() => readGitHubAppAuthConfig(
      { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY_PATH: "/keys/missing.pem" },
      () => {
        throw new Error("EACCES: permission denied, open '/keys/missing.pem'");
      },
    )).toThrow("EACCES: permission denied, open '/keys/missing.pem'");
  });
});

describe("createAppInstallationTokenResolver", () => {
  it("mints a verifiable RS256 JWT, requests only reconciliation's read permissions, and returns the installation token", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => Response.json(
        { token: "ghs_installation_token", expires_at: new Date(fixedClockMs + tokenLifetimeMs).toISOString() },
        { status: 201 },
      ),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({
      token: "ghs_installation_token",
      installationId: 166057493,
    });

    const [lookup, mint] = await Promise.all(requests);
    expect(lookup?.url).toBe("https://api.github.com/repos/Nitjsefnie/Overflow/installation");
    expect(mint?.url).toBe("https://api.github.com/app/installations/166057493/access_tokens");
    for (const request of [lookup, mint]) {
      expect(request?.authorization).toMatch(/^Bearer ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(request?.accept).toBe("application/vnd.github+json");
      expect(request?.apiVersion).toBe("2022-11-28");
    }
    expect(mint?.contentType).toBe("application/json");
    expect(JSON.parse(mint?.body ?? "null")).toEqual({
      permissions: { metadata: "read", issues: "read", pull_requests: "read" },
    });

    expect(decodeJwtSegment(lookup!.authorization!.slice("Bearer ".length), 0)).toEqual({ alg: "RS256", typ: "JWT" });
    const issuedAtSeconds = Math.floor(fixedClockMs / 1000);
    expect(decodeJwtSegment(lookup!.authorization!.slice("Bearer ".length), 1)).toEqual({
      iat: issuedAtSeconds - 60,
      exp: issuedAtSeconds + 120,
      iss: appId,
    });
    // The mint call reuses the lookup's still-valid JWT.
    expect(mint?.authorization).toBe(lookup?.authorization);

    const [header, payload, signature] = lookup!.authorization!.slice("Bearer ".length).split(".");
    const signatureVerified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKeyPem, Buffer.from(signature!, "base64url"));
    expect(signatureVerified).toBe(true);
  });

  it("returns null on a 404 installation lookup without calling the mint endpoint", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => new Response("no installation here", { status: 404 }),
      mint: () => Response.json({ token: "ghs_unused", expires_at: new Date().toISOString() }, { status: 201 }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    await expect(resolver("octo/overflow")).resolves.toBeNull();

    expect(requests).toHaveLength(1);
    const [lookup] = await Promise.all(requests);
    expect(lookup?.method).toBe("GET");
  });

  it("throws GitHubApiError on a 500 installation lookup", async () => {
    const { fetch } = recordingFetch({ lookup: () => new Response("upstream broken", { status: 500 }) });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    await expect(resolver("octo/overflow")).rejects.toThrow(GitHubApiError);
    await expect(resolver("octo/overflow")).rejects.toMatchObject({
      status: 500,
      rateLimited: false,
      retryAfterSeconds: null,
    });
  });

  it("classifies a rate-limited lookup shape as rate-limited", async () => {
    const { fetch } = recordingFetch({
      lookup: () => new Response("secondary rate limit", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
      }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    const error = await resolver("octo/overflow").then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(isGitHubRateLimitError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, retryAfterSeconds: 30 });
  });

  it("surfaces a failed mint call as GitHubApiError", async () => {
    const { fetch } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => new Response("upstream broken", { status: 500 }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    await expect(resolver("octo/overflow")).rejects.toThrow(GitHubApiError);
    await expect(resolver("octo/overflow")).rejects.toMatchObject({ status: 500, rateLimited: false });
  });

  it("reuses the cached token inside the validity window and remints once the refresh margin passes", async () => {
    let mintCount = 0;
    const clock = mutableClock();
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => {
        mintCount += 1;
        return Response.json(
          { token: `ghs_mint_${mintCount}`, expires_at: new Date(clock.now().getTime() + tokenLifetimeMs).toISOString() },
          { status: 201 },
        );
      },
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clock.now, fetch });

    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_1", installationId: 166057493 });
    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_1", installationId: 166057493 });
    expect(mintCount).toBe(1);

    // Exactly the refresh margin before expiry is no longer "valid beyond the margin".
    clock.advance(tokenLifetimeMs - refreshMarginMs);
    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_2", installationId: 166057493 });
    expect(mintCount).toBe(2);

    const mints = await Promise.all(requests);
    expect(mints.filter((request) => request.method === "GET")).toHaveLength(3);
    expect(mints.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("serves the cached token one millisecond before the refresh margin opens, without a second mint", async () => {
    let mintCount = 0;
    const clock = mutableClock();
    const { fetch } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => {
        mintCount += 1;
        return Response.json(
          { token: `ghs_mint_${mintCount}`, expires_at: new Date(clock.now().getTime() + tokenLifetimeMs).toISOString() },
          { status: 201 },
        );
      },
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clock.now, fetch });

    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_1", installationId: 166057493 });
    // One millisecond short of `expiresAt - margin`: still valid beyond the margin.
    clock.advance(tokenLifetimeMs - refreshMarginMs - 1);
    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_1", installationId: 166057493 });
    expect(mintCount).toBe(1);
  });

  it("remints one millisecond after the refresh margin opens", async () => {
    let mintCount = 0;
    const clock = mutableClock();
    const { fetch } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => {
        mintCount += 1;
        return Response.json(
          { token: `ghs_mint_${mintCount}`, expires_at: new Date(clock.now().getTime() + tokenLifetimeMs).toISOString() },
          { status: 201 },
        );
      },
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clock.now, fetch });

    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_1", installationId: 166057493 });
    // One millisecond past `expiresAt - margin`: no longer valid beyond the margin.
    clock.advance(tokenLifetimeMs - refreshMarginMs + 1);
    await expect(resolver("Nitjsefnie/Overflow")).resolves.toEqual({ token: "ghs_mint_2", installationId: 166057493 });
    expect(mintCount).toBe(2);
  });

  it("coalesces concurrent resolves of one installation into a single mint", async () => {
    const clock = mutableClock();
    const mintGates: Array<(response: Response) => void> = [];
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
      mint: () => new Promise((resolve) => {
        mintGates.push(resolve);
      }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clock.now, fetch });

    const first = resolver("Nitjsefnie/Overflow");
    const second = resolver("Nitjsefnie/Overflow");
    // Drain the lookups so both callers sit on the mint leg together.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mintGates).toHaveLength(1);
    mintGates[0]!(Response.json(
      { token: "ghs_coalesced", expires_at: new Date(clock.now().getTime() + tokenLifetimeMs).toISOString() },
      { status: 201 },
    ));

    await expect(first).resolves.toEqual({ token: "ghs_coalesced", installationId: 166057493 });
    await expect(second).resolves.toEqual({ token: "ghs_coalesced", installationId: 166057493 });

    const recorded = await Promise.all(requests);
    expect(recorded.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("rejects a mint response whose token is missing, empty, or whose expires_at is missing or unparseable", async () => {
    const invalidPayloads: Array<Record<string, unknown>> = [
      { token: "ghs_no_expiry" },
      { token: "ghs_bad_expiry", expires_at: "not-a-timestamp" },
      { token: "", expires_at: new Date(fixedClockMs + tokenLifetimeMs).toISOString() },
      // Regex-valid but calendar-invalid: only the real-Date.parse layer rejects it.
      { token: "ghs_calendar_invalid_expiry", expires_at: "9999-99-99T99:99:99Z" },
    ];
    for (const payload of invalidPayloads) {
      const { fetch } = recordingFetch({
        lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
        mint: () => Response.json(payload, { status: 201 }),
      });
      const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

      await expect(resolver("octo/overflow")).rejects.toThrow(
        "GitHub App installation token response was invalid.",
      );
    }
  });

  it("rejects an ownerName without exactly two non-empty segments before any network call", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    for (const ownerName of ["", "overflow", "/overflow", "octo/", "octo/overflow/extra"]) {
      await expect(resolver(ownerName)).rejects.toThrow(Error);
    }
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["missing id", {}],
    ["zero id", { id: 0 }],
    ["negative id", { id: -1 }],
    ["non-integer id", { id: 1.5 }],
    ["string id", { id: "166057493" }],
  ])("rejects a lookup response with a %s before any mint call", async (_label, payload) => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json(payload, { status: 200 }),
    });
    const resolver = createAppInstallationTokenResolver({ config: appConfig(), now: clockAt(), fetch });

    const error = await resolver("octo/overflow").then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubApiError);
    expect(String((error as Error).message)).toContain("installation lookup response was invalid");

    const recorded = await Promise.all(requests);
    expect(recorded.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});

describe("appInstallationTokenResolverFromEnv", () => {
  it("accepts process.env directly, as the production wiring passes it", () => {
    const acceptsProcessEnv: Parameters<typeof appInstallationTokenResolverFromEnv>[0] = process.env;
    void acceptsProcessEnv;
  });

  it("returns null when unconfigured, without reading the key file", () => {
    const refuseToRead = (): string => {
      throw new Error("the key file must not be read while unconfigured");
    };

    expect(appInstallationTokenResolverFromEnv({}, refuseToRead)).toBeNull();
  });

  it("returns a resolver when configured with a readable key file", () => {
    const resolver = appInstallationTokenResolverFromEnv(
      { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem" },
      () => privateKeyPem,
    );

    expect(resolver).toBeTypeOf("function");
  });

  it("throws when configured but the key file is unreadable", () => {
    expect(() => appInstallationTokenResolverFromEnv(
      { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY_PATH: "/keys/missing.pem" },
      () => {
        throw new Error("ENOENT: no such file, open '/keys/missing.pem'");
      },
    )).toThrow("ENOENT: no such file, open '/keys/missing.pem'");
  });
});
