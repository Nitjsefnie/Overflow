import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import type { ForgeIdentityStore } from "@/lib/forge/identities";
import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import { listen, useLoopbackListeners } from "../support/loopback-listener";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

// The body caps and the redirect refusal, proved at the seams that apply them:
// the identity link route and a GitLab gateway built with no transport, each
// running on its production default. The mock wraps the factory, so every
// transport a module builds by calling it treats the IPv4 loopback as public,
// and a loopback listener can stand in for a public GitLab. The mock passes
// each caller's options through untouched and builds no transport of its own,
// so each cap is the one the production module asked for — every option but
// the deny list, which it drops because its own permission seam may not stand
// beside one.
//
// The link route accepts only an https instance, and the listeners here have
// no certificate, so the wrapped transport carries a request for an
// `https://127.0.0.1` URL to that address over plain http. That is the mock's
// one other change, and it is below everything under test: the route, the
// scheme gate and the service see the https URL, and the caps and the
// redirect refusal are the real transport's, applied to the response.

// Release modules evaluated with this file's permissive transport.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

vi.mock("@/lib/security/public-destination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/public-destination")>();
  const loopbackPermitted = (address: string): boolean =>
    address === "127.0.0.1" || actual.isPublicAddress(address);
  const overLoopbackHttp = (input: string | URL | Request): string | URL | Request => {
    if (input instanceof Request) return input;
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "127.0.0.1") return input;
    url.protocol = "http:";
    return url;
  };
  const createPublicFetch: typeof actual.createPublicFetch = (options) => {
    // The deployment deny list rides in on the transports this mock replaces,
    // and it may not stand beside the mock's own permission seam, so it is
    // dropped rather than passed through.
    const guarded = actual.createPublicFetch({
      ...options,
      denyCidrs: undefined,
      isPermittedAddress: loopbackPermitted,
    });
    return ((input: string | URL | Request, init?: RequestInit) =>
      guarded(overLoopbackHttp(input), init)) as typeof fetch;
  };
  return { ...actual, createPublicFetch };
});

useTrustedOrigin();
useLoopbackListeners();

afterEach(() => {
  vi.restoreAllMocks();
});

const mebibyte = 1024 * 1024;

const { json: linkRequest } = guardedRequests("/api/forge-identities");

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

/** A GitLab that accepts the token; `user` may replace the /api/v4/user answer. */
function gitlab(user?: (response: ServerResponse) => void) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = request.url ?? "";
    if (path.startsWith("/api/v4/user") && user !== undefined) {
      user(response);
      return;
    }
    const payload = path.startsWith("/api/v4/personal_access_tokens/self")
      ? { id: 7, name: "overflow", scopes: ["read_api"] }
      : { id: 4242, username: "tester" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
}

async function link(instanceUrl: string, fetch?: typeof globalThis.fetch) {
  const writes: string[] = [];
  const store: ForgeIdentityStore = {
    async listForUser() {
      return [];
    },
    async markTokenRejected() {
      writes.push("markTokenRejected");
    },
    async upsertIdentity(input) {
      writes.push("upsertIdentity");
      return {
        id: "identity-1",
        provider: input.provider,
        instanceUrl: input.instanceUrl,
        forgeLogin: input.forgeLogin,
        verifiedAt: "2026-09-26T00:00:00.000Z",
        tokenFailedAt: null,
      };
    },
    async deleteForUser() {
      writes.push("deleteForUser");
      return true;
    },
  };
  const dependencies: ForgeIdentitiesRouteDependencies = {
    getSession: async () => ({ user: { id: "user-1", role: "MEMBER" } }),
    getCurrentRole: async () => "MEMBER",
    createIdentityStore: () => store,
    tokenEncryptionKey: TEST_KEY,
    ...(fetch === undefined ? {} : { fetch }),
  };
  const response = await createForgeIdentitiesPostHandler(dependencies)(
    linkRequest({ instanceUrl, token: "glpat-member-token" }),
  );
  return { status: response.status, body: await response.text(), writes };
}

async function unreachableAnswer(): Promise<{ status: number; body: string }> {
  const { status, body } = await link("https://gitlab.example.com", async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:443"), { code: "ECONNREFUSED" });
  });
  return { status, body };
}

/** A JSON object of at least `bytes` bytes that still carries a valid GitLab user. */
function paddedUser(bytes: number): string {
  const skeleton = JSON.stringify({ id: 4242, username: "tester", bio: "" });
  return JSON.stringify({ id: 4242, username: "tester", bio: "a".repeat(Math.max(0, bytes - skeleton.length)) });
}

/**
 * Streams a JSON array of labels of at least `bytes` bytes, honouring
 * backpressure, so a body larger than any cap never has to sit in memory.
 */
function streamLabels(bytes: number, response: ServerResponse): void {
  const description = "d".repeat(4096);
  response.writeHead(200, { "content-type": "application/json" });
  Readable.from((function* () {
    let written = 1;
    yield "[";
    for (let index = 0; written < bytes; index += 1) {
      const entry = `${index === 0 ? "" : ","}${JSON.stringify({ name: `label-${index}`, description })}`;
      written += entry.length;
      yield entry;
    }
    yield "]";
  })()).pipe(response);
}

async function settle<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ settled: "resolved" as const, value }),
    (error: unknown) => ({ settled: "rejected" as const, value: error }),
  );
}

describe("the identity link route's default transport", () => {
  it("links through a permitted instance, so the refusals below are not destination refusals", async () => {
    const listener = await listen("127.0.0.1", gitlab());

    const answer = await link(`https://127.0.0.1:${listener.port}`);

    expect(listener.paths).toEqual(["/api/v4/user", "/api/v4/personal_access_tokens/self"]);
    expect(answer.status).toBe(201);
    expect(answer.writes).toEqual(["upsertIdentity"]);
  });

  it("refuses a /user answer one byte over 1 MiB, answering as for an unreachable host", async () => {
    const listener = await listen("127.0.0.1", gitlab((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(paddedUser(mebibyte + 1));
    }));
    const expected = await unreachableAnswer();

    const answer = await link(`https://127.0.0.1:${listener.port}`);

    expect(listener.paths).toEqual(["/api/v4/user"]);
    expect(answer.writes).toEqual([]);
    expect({ status: answer.status, body: answer.body }).toEqual(expected);
  });

  it("refuses a redirect without following it, answering as for an unreachable host", async () => {
    const target = await listen("127.0.0.1", gitlab());
    const origin = await listen("127.0.0.1", gitlab((response) => {
      response.writeHead(302, { location: `https://127.0.0.1:${target.port}/api/v4/user` });
      response.end();
    }));
    const expected = await unreachableAnswer();

    const answer = await link(`https://127.0.0.1:${origin.port}`);

    expect(origin.paths).toEqual(["/api/v4/user"]);
    expect(target.connections).toBe(0);
    expect(answer.writes).toEqual([]);
    expect({ status: answer.status, body: answer.body }).toEqual(expected);
  });
});

describe("a GitLab gateway's default transport", () => {
  const repository = { owner: "group", name: "project" };

  it("reads a list page larger than 1 MiB", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => streamLabels(2 * mebibyte, response));
    const gateway = new GitLabGateway({ instanceUrl: `http://127.0.0.1:${listener.port}`, token: "glpat-x" });

    const labels = await gateway.listRepositoryLabels(repository);

    expect(labels.size).toBeGreaterThan(256);
    expect(labels.has("label-0")).toBe(true);
  });

  it("refuses a body over 64 MiB as a status-0 GitLabApiError", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => streamLabels(64 * mebibyte + 1, response));
    const gateway = new GitLabGateway({ instanceUrl: `http://127.0.0.1:${listener.port}`, token: "glpat-x" });

    const outcome = await settle(gateway.listRepositoryLabels(repository));

    expect(listener.paths).toHaveLength(1);
    expect(outcome.settled).toBe("rejected");
    expect(outcome.value).toBeInstanceOf(GitLabApiError);
    expect((outcome.value as GitLabApiError).status).toBe(0);
  });

  it("refuses a redirect as a status-0 GitLabApiError without following it", async () => {
    const target = await listen("127.0.0.1", (_request, response) => streamLabels(16, response));
    const origin = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(301, { location: `http://127.0.0.1:${target.port}/api/v4/projects/1/labels` });
      response.end();
    });
    const gateway = new GitLabGateway({ instanceUrl: `http://127.0.0.1:${origin.port}`, token: "glpat-x" });

    const outcome = await settle(gateway.listRepositoryLabels(repository));

    expect(origin.paths).toHaveLength(1);
    expect(target.connections).toBe(0);
    expect(outcome.settled).toBe("rejected");
    expect(outcome.value).toBeInstanceOf(GitLabApiError);
    expect((outcome.value as GitLabApiError).status).toBe(0);
  });
});
