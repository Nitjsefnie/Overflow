import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppRegistration } from "@/lib/github/app-registration";
import { GitHubApiError } from "@/lib/github/errors";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = { appId: "202", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const now = () => new Date("2026-10-15T12:00:00Z");

function setup(response: () => Response | Promise<Response>, apiUrl?: string) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return response();
  };
  return { registration: createAppRegistration({ config, fetch, now, apiUrl }), requests };
}

describe("registration App installation lookup", () => {
  it("returns the installation id using a verifiable JWT for the supplied App without minting a token", async () => {
    const { registration, requests } = setup(() => Response.json({ id: 123 }));
    await expect(registration.lookupInstallation("octo/overflow")).resolves.toEqual({ installationId: 123 });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.github.com/repos/octo/overflow/installation");
    expect(request.method).toBe("GET");
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
    const [header, payload, signature] = request.headers.get("authorization")!.slice("Bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iss: "202", iat: 1792065540, exp: 1792065720,
    });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("returns null only for a 404", async () => {
    const { registration } = setup(() => new Response("not installed", { status: 404 }));
    await expect(registration.lookupInstallation("octo/overflow")).resolves.toBeNull();
  });

  it.each([
    [401, {}, false, null],
    [403, {}, false, null],
    [403, { "x-ratelimit-remaining": "0", "retry-after": "30" }, true, 30],
    [429, { "retry-after": "15" }, true, 15],
    [500, {}, false, null],
    [201, {}, false, null],
  ])("classifies status %i without treating it as absence", async (status, headers, rateLimited, retryAfterSeconds) => {
    const { registration } = setup(() => new Response("lookup failed", { status, headers: headers as HeadersInit }));
    const error = await registration.lookupInstallation("octo/overflow").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status, rateLimited, retryAfterSeconds });
  });

  it("validates the full name before making a network call", async () => {
    const { registration, requests } = setup(() => Response.json({ id: 123 }));
    for (const ownerName of ["", "overflow", "/overflow", "octo/", "octo/overflow/extra"]) {
      await expect(registration.lookupInstallation(ownerName)).rejects.toThrow(Error);
    }
    expect(requests).toHaveLength(0);
  });

  it("encodes path segments and honors the supplied API URL", async () => {
    const { registration, requests } = setup(() => Response.json({ id: 123 }), "https://github.example/api/v3/");
    await registration.lookupInstallation("a b/c?d");
    expect(requests[0]!.url).toBe("https://github.example/api/v3/repos/a%20b/c%3Fd/installation");
  });

  it.each([{}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: "123" }, { id: Number.MAX_SAFE_INTEGER + 1 }])(
    "rejects a malformed lookup response %j", async (payload) => {
      const { registration } = setup(() => Response.json(payload));
      await expect(registration.lookupInstallation("octo/overflow")).rejects.toThrow(Error);
    },
  );

  it("propagates a network failure with its cause", async () => {
    const cause = new Error("offline");
    const { registration } = setup(() => Promise.reject(cause));
    await expect(registration.lookupInstallation("octo/overflow")).rejects.toMatchObject({ cause });
  });
});
