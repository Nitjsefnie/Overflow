import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubApiError, GitHubGraphqlRequestError } from "@/lib/github/errors";
import { GitHubGraphqlClient } from "@/lib/github/graphql";
import { createAppInstallationLookup } from "@/lib/github/app-installation-auth";
import { errorLogToken } from "@/lib/webhooks/log-field";

const repository = { owner: "octo", name: "overflow" };
const accessToken = randomBytes(24).toString("base64url");

async function httpFailure(transport: "REST" | "GraphQL", body: string, headers: HeadersInit): Promise<GitHubApiError> {
  const fetch = async () => new Response(body, { status: 403, headers });
  const result = transport === "REST"
    ? new GitHubGateway({ accessToken, fetch }).getRepository(repository)
    : new GitHubGraphqlClient({ accessToken, fetch }).query("query {}", {});
  const error: unknown = await result.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

describe("GitHub failure diagnostics", () => {
  it.each(["REST", "GraphQL"] as const)("captures and renders secondary-limit evidence over %s", async (transport) => {
    const error = await httpFailure(transport, "You have exceeded a secondary rate limit.", {
      "retry-after": "60", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4100",
      "x-ratelimit-used": "900", "x-ratelimit-reset": "1900000000", "x-ratelimit-resource": "core",
      "x-github-request-id": "request-secondary", authorization: accessToken, "x-private": "private-header",
    });
    const line = errorLogToken(new Error("Unable to reconcile repository.", { cause: error }));
    expect(line).toContain('status=403 body="You have exceeded a secondary rate limit."');
    for (const [name, value] of Object.entries({
      "retry-after": "60", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4100",
      "x-ratelimit-used": "900", "x-ratelimit-reset": "1900000000", "x-ratelimit-resource": "core",
      "x-github-request-id": "request-secondary",
    })) expect(line).toContain(`${name}="${value}"`);
    expect(error).toMatchObject({ rateLimited: true, retryAfterSeconds: 60 });
    expect(line).not.toMatch(/authorization|private-header/);
    expect(error.toJSON()).toEqual({ name: "GitHubApiError", status: 403, rateLimited: true, retryAfterSeconds: 60 });
  });

  it("retains GitHub diagnostics beyond the generic cause preview", async () => {
    let error: Error = await httpFailure("REST", "Secondary rate limit", { "retry-after": "60" });
    for (let index = 9; index >= 0; index--) error = new Error(`wrapper-${index}`, { cause: error });
    const line = errorLogToken(error);
    expect(line).toContain('status=403 body="Secondary rate limit" retry-after="60"');
    expect(line).not.toContain("wrapper-6");
    expect(line).not.toContain("wrapper-9");
    expect(line.length).toBeLessThan(500);
  });

  it("captures primary-limit reset evidence", async () => {
    const error = await httpFailure("REST", "API rate limit exceeded", {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000",
    });
    expect(errorLogToken(error)).toContain('x-ratelimit-remaining="0" x-ratelimit-reset="1900000000"');
    expect(error).toMatchObject({ rateLimited: true, retryAfterSeconds: null });
  });

  it("records an access refusal without inventing rate-limit headers", async () => {
    const error = await httpFailure("GraphQL", "Resource not accessible by integration", {});
    expect(errorLogToken(error)).toContain('status=403 body="Resource not accessible by integration"');
    expect(error).toMatchObject({ rateLimited: false, retryAfterSeconds: null, headers: {} });
    expect(errorLogToken(error)).not.toMatch(/retry-after|x-ratelimit/);
  });

  it.each(["REST", "GraphQL"] as const)("redacts reflected tokens before storing and logging %s bodies", async (transport) => {
    const error = await httpFailure(transport, `Denied ${accessToken} ${accessToken}`, {});
    expect(error.body).toBe("Denied [REDACTED] [REDACTED]");
    const line = `Reconciliation of repository example failed. ${errorLogToken(error)}`;
    expect(line).not.toContain(accessToken);
    expect(line).toContain('body="Denied [REDACTED] [REDACTED]"');
  });

  it("bounds captured bodies and headers and encodes control characters", async () => {
    const error = await httpFailure("REST", `Denied\n\u001b${"b".repeat(900)}`, {
      "x-github-request-id": `request\u001b${"r".repeat(900)}`,
    });
    expect(error.headers).toEqual({ "x-github-request-id": `request\u001b${"r".repeat(248)}` });
    expect(error.body).toHaveLength(500);
    const line = errorLogToken(error);
    expect(line).toContain('body="Denied\\u000a\\u001b');
    expect(line).toContain('x-github-request-id="request\\u001b');
    expect(line).not.toMatch(/[\n\r\u001b]/u);
    expect(line).not.toContain("r".repeat(257));
  });

  it.each(["REST", "GraphQL"] as const)("redacts a known token in an allowed header over %s", async (transport) => {
    const error = await httpFailure(transport, "Denied", { "x-github-request-id": `request ${accessToken}` });
    expect(error.headers["x-github-request-id"]).toBe("request [REDACTED]");
    const line = errorLogToken(error);
    expect(line).toContain('x-github-request-id="request [REDACTED]"');
    expect(line).not.toContain(accessToken);
  });

  it.each(["configure", "ensure"])("preserves diagnostics when %s re-wraps an HTTP error", async (operation) => {
    const secret = randomBytes(20).toString("base64url");
    const gateway = new GitHubGateway({ accessToken, fetch: async () => new Response(`Denied ${secret}`, {
      status: 403, headers: { "x-github-request-id": "request-webhook" },
    }) });
    const result = operation === "configure"
      ? gateway.configureWebhook(repository, 81, { callbackUrl: "https://example.test", secret })
      : gateway.ensureWebhookEvents(repository, 81, secret);
    const error = await result.catch((error: unknown) => error);
    const line = errorLogToken(error);
    expect(line).toContain('body="Denied [REDACTED]"');
    expect(line).toContain('x-github-request-id="request-webhook"');
    expect(line).not.toContain(secret);
  });

  it.each([
    ["configure", "GET"], ["configure", "PATCH"],
    ["ensure", "GET"], ["ensure", "PATCH"], ["create", "POST"],
  ])("redacts crossing-boundary credentials during %s %s", async (operation, method) => {
    const secret = randomBytes(24).toString("base64url");
    const configuration = { callbackUrl: "https://example.test", secret };
    const gateway = new GitHubGateway({ accessToken, fetch: async (_input, init) => {
      if ((init?.method ?? "GET") !== method) return Response.json({
        type: "Repository", id: 81, name: "web", active: true, events: ["issues"],
        config: { url: configuration.callbackUrl, secret: "********", content_type: "json", insecure_ssl: "0" },
      });
      return new Response(`${"b".repeat(490)}${secret}`, {
        status: 403, headers: { "x-github-request-id": `${"r".repeat(240)}${secret}`, "x-ratelimit-resource": accessToken },
      });
    } });
    const result = operation === "configure" ? gateway.configureWebhook(repository, 81, configuration)
      : operation === "ensure" ? gateway.ensureWebhookEvents(repository, 81, secret)
        : gateway.createWebhook(repository, configuration);
    const error = await result.catch((error: unknown) => error);
    expect(errorLogToken(error)).not.toContain(secret.slice(0, 16));
    expect(errorLogToken(error)).not.toContain(accessToken);
    expect(error).toMatchObject({
      body: `${"b".repeat(490)}[REDACTED]`,
      headers: { "x-github-request-id": `${"r".repeat(240)}[REDACTED]`, "x-ratelimit-resource": "[REDACTED]" },
    });
  });

  it("redacts the union of partially overlapping credentials in body and allowed headers", async () => {
    const prefix = randomBytes(18).toString("base64url");
    const shared = randomBytes(18).toString("base64url");
    const suffix = randomBytes(12).toString("base64url");
    const token = prefix + shared;
    const secret = shared + suffix;
    const reflected = prefix + shared + suffix;
    const gateway = new GitHubGateway({ accessToken: token, fetch: async () => new Response(reflected, {
      status: 403, headers: { "x-github-request-id": reflected },
    }) });
    const error = await gateway.configureWebhook(repository, 81, { callbackUrl: "https://example.test", secret })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ body: "[REDACTED]", headers: { "x-github-request-id": "[REDACTED]" } });
    const line = errorLogToken(error);
    expect(line).toContain('body="[REDACTED]" x-github-request-id="[REDACTED]"');
    for (const part of [prefix, shared, suffix]) expect(line).not.toContain(part);
  });

  it("redacts overlapping occurrences of the same credential", async () => {
    const part = randomBytes(6).toString("base64url");
    const token = part.repeat(3);
    const secret = randomBytes(24).toString("base64url");
    const reflected = part.repeat(4);
    const gateway = new GitHubGateway({ accessToken: token, fetch: async () => new Response(reflected, {
      status: 403, headers: { "x-github-request-id": reflected },
    }) });
    const error = await gateway.configureWebhook(repository, 81, { callbackUrl: "https://example.test", secret })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ body: "[REDACTED]", headers: { "x-github-request-id": "[REDACTED]" } });
    expect(errorLogToken(error)).not.toContain(part);
  });

  it("captures workflow-read HTTP diagnostics", async () => {
    const gateway = new GitHubGateway({ accessToken, fetch: async () => new Response(`Denied ${accessToken}`, {
      status: 403, headers: { "retry-after": "60" },
    }) });
    const error = await gateway.listWorkflowFiles(repository).catch((error: unknown) => error);
    expect(errorLogToken(error)).toContain('body="Denied [REDACTED]" retry-after="60"');
  });

  it("captures App lookup diagnostics and redacts the signed JWT", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let jwt = "";
    const lookup = createAppInstallationLookup({
      config: { appId: "42", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
      now: () => new Date("2030-01-02T03:04:05Z"),
      fetch: async (_input, init) => {
        jwt = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
        return new Response(`Denied ${jwt}`, { status: 403, headers: { "retry-after": "60" } });
      },
    });
    const error = await lookup("octo/overflow").catch((error: unknown) => error);
    expect((error as GitHubApiError).body).toBe("Denied [REDACTED]");
    expect(errorLogToken(error)).toContain('body="Denied [REDACTED]" retry-after="60"');
    expect(errorLogToken(error)).not.toContain(jwt);
  });

  it.each(["structured", "malformed"] as const)("captures only bounded redacted response headers for %s GraphQL errors", async (shape) => {
    const headers = {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(new Date("2030-01-02T03:09:05Z").getTime() / 1000),
      "x-github-request-id": `request ${accessToken}`,
      "x-ratelimit-resource": "r".repeat(400),
      authorization: accessToken, "x-private": "private-header",
    };
    const client = new GitHubGraphqlClient({
      accessToken,
      fetch: async () => shape === "structured"
        ? Response.json({ errors: [{ type: "RATE_LIMITED" }] }, { headers })
        : new Response("not-json", { headers }),
    });
    const error: unknown = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect((error as GitHubGraphqlRequestError).headers).toEqual({
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": headers["x-ratelimit-reset"],
      "x-github-request-id": "request [REDACTED]", "x-ratelimit-resource": "r".repeat(256),
    });
    expect(Object.isFrozen((error as GitHubGraphqlRequestError).headers)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("headers");
    expect(JSON.stringify(error)).not.toContain(accessToken);
  });

  it("keeps parse-failure diagnostics and request-id without a payload status for a non-JSON 200", async () => {
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => new Response(`not-json ${accessToken}`, {
      headers: { "x-github-request-id": "request-parse" },
    }) });
    const error = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubGraphqlRequestError);
    expect(error).toMatchObject({ status: null, requestId: "request-parse" });
    const line = errorLogToken(new Error("Unable to reconcile repository.", { cause: error }));
    expect(line).toContain("SyntaxError:");
    expect(line).toContain('x-github-request-id="request-parse"');
    expect(line).not.toContain("status=");
    expect(line).not.toContain(accessToken);
  });

  it("omits credential prefixes from engine-shortened JSON parse diagnostics", async () => {
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => new Response(`!${accessToken}`, {
      headers: { "x-github-request-id": "request-prefix" },
    }) });
    const failure = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: null });
    const line = errorLogToken(failure);
    expect(line).toContain("SyntaxError:");
    expect(line).toContain('x-github-request-id="request-prefix"');
    expect(line).not.toContain("status=");
    expect(line).not.toContain(accessToken.slice(0, 8));
  });

  it("renders captured primary GraphQL limit evidence with one request-id", async () => {
    const reset = String(new Date("2030-01-02T03:09:05Z").getTime() / 1000);
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => Response.json({
      errors: [{ type: "RATE_LIMITED" }],
    }, { headers: {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset,
      "x-github-request-id": "request-primary", authorization: accessToken,
    } }) });
    const failure = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    const line = errorLogToken(failure);
    expect(line).toContain('status=200');
    expect(line).toContain('x-ratelimit-remaining="0"');
    expect(line).toContain(`x-ratelimit-reset="${reset}"`);
    expect(line.match(/x-github-request-id=/g)).toHaveLength(1);
    expect(line).not.toContain("authorization");
    expect(line).not.toContain(accessToken);
  });

  it("retains a bounded redacted network failure description without inventing HTTP context", async () => {
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => {
      throw new TypeError(`Connection failed ${accessToken}\n${"x".repeat(2000)}`);
    } });
    const error = await client.query("query {}", {}).catch((error: unknown) => error) as Error;
    expect(error.message).toContain("TypeError: Connection failed [REDACTED]");
    expect(error.message.length).toBeLessThan(600);
    expect(errorLogToken(error)).not.toContain(accessToken);
    expect(errorLogToken(error)).not.toMatch(/status=|x-github-request-id=/);
  });

  it("identifies a GraphQL payload missing data with HTTP context", async () => {
    const client = new GitHubGraphqlClient({ accessToken, fetch: async () => Response.json({}, {
      headers: { "x-github-request-id": "request-missing" },
    }) });
    const error = await client.query("query {}", {}).catch((error: unknown) => error);
    expect(errorLogToken(error)).toContain("missing data");
    expect(errorLogToken(error)).toContain('status=200 x-github-request-id="request-missing"');
  });
});
