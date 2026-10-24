import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppInstallationLookup } from "@/lib/github/app-installation-auth";
import { GitHubApiError, isGitHubRateLimitError } from "@/lib/github/errors";

const appId = "5118623";
const fixedClockMs = Date.parse("2026-09-29T12:00:00Z");

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
}): { fetch: typeof fetch; requests: Array<Promise<RecordedRequest>> } {
  const requests: Array<Promise<RecordedRequest>> = [];
  const fetchImplementation: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(record(request));
    return Promise.resolve(handlers.lookup());
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

function decodeJwtSegment(jwt: string, index: 0 | 1): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[index]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createAppInstallationLookup", () => {
  it("looks an installation up with a verifiable RS256 JWT and returns its id", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
    });
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    await expect(lookup("Nitjsefnie/Overflow")).resolves.toEqual({ installationId: 166057493 });

    const [request] = await Promise.all(requests);
    expect(request?.url).toBe("https://api.github.com/repos/Nitjsefnie/Overflow/installation");
    expect(request?.method).toBe("GET");
    expect(request?.authorization).toMatch(/^Bearer ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(request?.accept).toBe("application/vnd.github+json");
    expect(request?.apiVersion).toBe("2022-11-28");
    expect(request?.body).toBeNull();

    expect(decodeJwtSegment(request!.authorization!.slice("Bearer ".length), 0)).toEqual({ alg: "RS256", typ: "JWT" });
    const issuedAtSeconds = Math.floor(fixedClockMs / 1000);
    expect(decodeJwtSegment(request!.authorization!.slice("Bearer ".length), 1)).toEqual({
      iat: issuedAtSeconds - 60,
      exp: issuedAtSeconds + 120,
      iss: appId,
    });

    const [header, payload, signature] = request!.authorization!.slice("Bearer ".length).split(".");
    const signatureVerified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKeyPem, Buffer.from(signature!, "base64url"));
    expect(signatureVerified).toBe(true);
  });

  it("returns null on a 404 installation lookup", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => new Response("no installation here", { status: 404 }),
    });
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    await expect(lookup("octo/overflow")).resolves.toBeNull();

    expect(requests).toHaveLength(1);
    const [request] = await Promise.all(requests);
    expect(request?.method).toBe("GET");
  });

  it("throws GitHubApiError on a 500 installation lookup", async () => {
    const { fetch } = recordingFetch({ lookup: () => new Response("upstream broken", { status: 500 }) });
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    await expect(lookup("octo/overflow")).rejects.toThrow(GitHubApiError);
    await expect(lookup("octo/overflow")).rejects.toMatchObject({
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
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    const error = await lookup("octo/overflow").then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(isGitHubRateLimitError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, retryAfterSeconds: 30 });
  });

  it("rejects an ownerName without exactly two non-empty segments before any network call", async () => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json({ id: 166057493 }, { status: 200 }),
    });
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    for (const ownerName of ["", "overflow", "/overflow", "octo/", "octo/overflow/extra"]) {
      await expect(lookup(ownerName)).rejects.toThrow(Error);
    }
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["missing id", {}],
    ["zero id", { id: 0 }],
    ["negative id", { id: -1 }],
    ["non-integer id", { id: 1.5 }],
    ["string id", { id: "166057493" }],
  ])("rejects a lookup response with a %s", async (_label, payload) => {
    const { fetch, requests } = recordingFetch({
      lookup: () => Response.json(payload, { status: 200 }),
    });
    const lookup = createAppInstallationLookup({ config: appConfig(), now: clockAt(), fetch });

    const error = await lookup("octo/overflow").then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubApiError);
    expect(String((error as Error).message)).toContain("installation lookup response was invalid");
  });
});
