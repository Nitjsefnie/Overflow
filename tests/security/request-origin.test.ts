import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readTrustedOrigin,
  rejectUnsupportedMediaType,
  rejectUntrustedRequest,
} from "@/lib/security/request-origin";

afterEach(() => {
  vi.unstubAllEnvs();
});

const trustedOrigin = "https://overflow.example";

function environment(appUrl?: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...(appUrl === undefined ? {} : { APP_URL: appUrl }) };
}

const trustedEnv = environment(trustedOrigin);

function mutationRequest(headers: Record<string, string>): Request {
  return new Request("https://overflow.example/api/tokens", {
    method: "POST",
    headers,
  });
}

async function expectErrorResponse(
  response: Response | null,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  expect(response).not.toBeNull();
  expect(response?.status).toBe(status);
  await expect(response?.json()).resolves.toEqual({ error: { code, message } });
}

describe("reading the trusted origin from APP_URL", () => {
  it("returns the origin of an APP_URL that is already bare", () => {
    expect(readTrustedOrigin(environment("https://overflow.example"))).toBe(
      "https://overflow.example",
    );
  });

  it("drops a path from APP_URL", () => {
    expect(readTrustedOrigin(environment("https://overflow.example/sub/path"))).toBe(
      "https://overflow.example",
    );
  });

  it("drops a trailing slash from APP_URL", () => {
    expect(readTrustedOrigin(environment("https://overflow.example/"))).toBe(
      "https://overflow.example",
    );
  });

  it("normalizes an explicit default port away", () => {
    expect(readTrustedOrigin(environment("https://overflow.example:443"))).toBe(
      "https://overflow.example",
    );
  });

  it("keeps a non-default port", () => {
    expect(readTrustedOrigin(environment("https://overflow.example:8443"))).toBe(
      "https://overflow.example:8443",
    );
  });

  it("returns null when APP_URL is undefined", () => {
    expect(readTrustedOrigin(environment())).toBeNull();
  });

  it("returns null when APP_URL is empty", () => {
    expect(readTrustedOrigin(environment(""))).toBeNull();
  });

  it("returns null when APP_URL is whitespace only", () => {
    expect(readTrustedOrigin(environment("   "))).toBeNull();
  });

  it("returns null when APP_URL is not a parsable absolute URL", () => {
    expect(readTrustedOrigin(environment("not-a-url"))).toBeNull();
  });

  it("returns null when APP_URL parses to the opaque origin", () => {
    expect(readTrustedOrigin(environment("data:text/plain,overflow"))).toBeNull();
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("APP_URL", "https://stubbed.example/dashboard");

    expect(readTrustedOrigin()).toBe("https://stubbed.example");
  });
});

describe("accepting a request from the trusted origin", () => {
  it("accepts a JSON request from the trusted origin", () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    expect(rejectUntrustedRequest(request, trustedEnv)).toBeNull();
  });

  it("accepts a content type whose case differs", () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "Application/JSON",
    });

    expect(rejectUntrustedRequest(request, trustedEnv)).toBeNull();
  });

  it("accepts a content type carrying a charset parameter", () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json; charset=utf-8",
    });

    expect(rejectUntrustedRequest(request, trustedEnv)).toBeNull();
  });

  it("accepts a content type padded before its parameter separator", () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json ; charset=utf-8",
    });

    expect(rejectUntrustedRequest(request, trustedEnv)).toBeNull();
  });

  it("accepts a request carrying no content type at all", () => {
    const request = mutationRequest({ origin: trustedOrigin });

    expect(rejectUntrustedRequest(request, trustedEnv)).toBeNull();
  });

  it("accepts the trusted origin when APP_URL carries a path", () => {
    const request = mutationRequest({ origin: trustedOrigin });

    expect(
      rejectUntrustedRequest(request, environment("https://overflow.example/sub/path")),
    ).toBeNull();
  });

  it("accepts the trusted origin when APP_URL carries a trailing slash", () => {
    const request = mutationRequest({ origin: trustedOrigin });

    expect(
      rejectUntrustedRequest(request, environment("https://overflow.example/")),
    ).toBeNull();
  });

  it("accepts the trusted origin when APP_URL carries an explicit default port", () => {
    const request = mutationRequest({ origin: trustedOrigin });

    expect(
      rejectUntrustedRequest(request, environment("https://overflow.example:443")),
    ).toBeNull();
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("APP_URL", trustedOrigin);
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    expect(rejectUntrustedRequest(request)).toBeNull();
  });
});

describe("rejecting a request from an untrusted origin", () => {
  it("rejects a foreign origin", async () => {
    const request = mutationRequest({ origin: "https://attacker.example" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects a foreign origin that sends a valid JSON content type", async () => {
    const request = mutationRequest({
      origin: "https://attacker.example",
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects an origin differing only by scheme", async () => {
    const request = mutationRequest({ origin: "http://overflow.example" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects an origin differing only by port", async () => {
    const request = mutationRequest({ origin: "https://overflow.example:8443" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects an origin differing only by a subdomain prefix", async () => {
    const request = mutationRequest({ origin: "https://evil.overflow.example" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects an origin differing only by letter case", async () => {
    const request = mutationRequest({ origin: "https://OVERFLOW.example" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects the opaque origin", async () => {
    const request = mutationRequest({ origin: "null" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("rejects a request carrying no origin header", async () => {
    const request = mutationRequest({ "content-type": "application/json" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });

  it("prefers the origin verdict over the content type verdict", async () => {
    const request = mutationRequest({
      origin: "https://attacker.example",
      "content-type": "text/plain",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      403,
      "FORBIDDEN",
      "The request origin is not allowed.",
    );
  });
});

describe("rejecting an unsupported media type", () => {
  it("rejects text/plain", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "text/plain",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });

  it("rejects application/x-www-form-urlencoded", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/x-www-form-urlencoded",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });

  it("rejects multipart/form-data", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "multipart/form-data; boundary=overflow",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });

  // Absent and empty are deliberately different: no header at all is allowed,
  // a header that claims an empty media type is not.
  it("rejects a present but empty content type", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });

  it("rejects a media type that merely ends in json", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json-patch+json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, trustedEnv),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });
});

/**
 * The content-type half on its own is what a token-authenticated route applies:
 * a programmatic client sends no `Origin`, so the origin check cannot run for
 * it, but the media type still must be JSON.
 */
describe("rejecting an unsupported media type without an origin check", () => {
  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=overflow",
    "application/json-patch+json",
    "",
  ])("rejects the %j content type whatever the origin says", async (contentType) => {
    await expectErrorResponse(
      rejectUnsupportedMediaType(mutationRequest({ "content-type": contentType })),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  });

  it.each<{ label: string; headers: Record<string, string> }>([
    { label: "no origin at all", headers: {} },
    { label: "a foreign origin", headers: { origin: "https://attacker.example" } },
    { label: "the trusted origin", headers: { origin: trustedOrigin } },
  ])("accepts application/json sent with $label", ({ headers }) => {
    const request = mutationRequest({ "content-type": "application/json", ...headers });

    expect(rejectUnsupportedMediaType(request)).toBeNull();
  });

  it("accepts a request that names no content type", () => {
    expect(rejectUnsupportedMediaType(mutationRequest({}))).toBeNull();
  });

  it("accepts a charset parameter on the JSON media type", () => {
    const request = mutationRequest({ "content-type": "application/json; charset=utf-8" });

    expect(rejectUnsupportedMediaType(request)).toBeNull();
  });

  // The origin half is the only half that reads APP_URL, so an unconfigured
  // deployment cannot turn a token client's valid request into a refusal.
  it("does not consult APP_URL", () => {
    vi.stubEnv("APP_URL", "");

    expect(
      rejectUnsupportedMediaType(mutationRequest({ "content-type": "application/json" })),
    ).toBeNull();
  });
});

describe("rejecting a request the server is not configured to accept", () => {
  it("rejects every request when APP_URL is unset", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment()),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });

  it("rejects every request when APP_URL is empty", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment("")),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });

  it("rejects every request when APP_URL is whitespace only", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment("   ")),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });

  it("rejects every request when APP_URL is not a parsable absolute URL", async () => {
    const request = mutationRequest({
      origin: trustedOrigin,
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment("not-a-url")),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });

  it("rejects every request when APP_URL parses to the opaque origin", async () => {
    // The opaque origin serializes to "null", which is exactly what a sandboxed
    // browsing context sends, so it must never become a matchable trusted value.
    const request = mutationRequest({
      origin: "null",
      "content-type": "application/json",
    });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment("data:text/plain,overflow")),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });

  it("prefers the misconfiguration verdict over the origin verdict", async () => {
    const request = mutationRequest({ origin: "https://attacker.example" });

    await expectErrorResponse(
      rejectUntrustedRequest(request, environment("not-a-url")),
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  });
});
