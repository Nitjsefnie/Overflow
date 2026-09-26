import type { ServerResponse } from "node:http";
import { isIP } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createForgeIdentitiesPostHandler,
  type ForgeIdentitiesRouteDependencies,
} from "@/app/api/forge-identities/route";
import type { ForgeIdentityStore } from "@/lib/forge/identities";
import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import {
  listen,
  listenOrNull,
  recordConnectAttempts,
  useLoopbackListeners,
  type LoopbackListener,
} from "../support/loopback-listener";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

// The member-supplied instance URL is the destination of every request here,
// and none of these tests inject a transport into the code under test: what
// runs is the production default. The listeners answer like a GitLab that
// accepts the token.
//
// The link route accepts only https instances, so the link cases submit https
// URLs: they pass the scheme gate and reach the destination refusal this file
// is about. The listeners speak plain http, so a request that got through
// would fail its TLS handshake and read as unreachable too; the witness for
// "refused before connecting" is therefore the listener's accepted-connection
// count (a handshake attempt is still a connection) and, for a literal no
// test can listen on, the recorded connect attempts.

useTrustedOrigin();
useLoopbackListeners();

afterEach(() => {
  vi.restoreAllMocks();
});

const { json: linkRequest } = guardedRequests("/api/forge-identities");

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

function answerAsGitLab(request: { url?: string }, response: ServerResponse): void {
  const path = request.url ?? "";
  const payload = path.startsWith("/api/v4/personal_access_tokens/self")
    ? { id: 7, name: "overflow", scopes: ["read_api"] }
    : path.startsWith("/api/v4/user")
      ? { id: 4242, username: "internal-admin" }
      : { id: 1, name: "project" };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function linkFixture(fetch?: typeof globalThis.fetch) {
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
  const claims: unknown[] = [];
  const dependencies: ForgeIdentitiesRouteDependencies = {
    getSession: async () => ({ user: { id: "user-1", role: "MEMBER" } }),
    getCurrentRole: async () => "MEMBER",
    createIdentityStore: () => store,
    tokenEncryptionKey: TEST_KEY,
    ...(fetch === undefined ? {} : { fetch }),
    claimPastWork: async (input) => {
      claims.push(input);
    },
  };
  return { handler: createForgeIdentitiesPostHandler(dependencies), writes, claims };
}

async function link(instanceUrl: string, fetch?: typeof globalThis.fetch) {
  const fixture = linkFixture(fetch);
  const response = await fixture.handler(linkRequest({ instanceUrl, token: "glpat-member-token" }));
  return {
    status: response.status,
    body: await response.text(),
    writes: fixture.writes,
    claims: fixture.claims,
  };
}

/** What the route answers when the instance cannot be reached at all. */
async function unreachableAnswer(): Promise<{ status: number; body: string }> {
  const { status, body, writes } = await link("https://gitlab.example.com", async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:443"), { code: "ECONNREFUSED" });
  });
  expect(writes).toEqual([]);
  return { status, body };
}

type Destination = { instanceUrl: string; host: string; listeners: LoopbackListener[] } | null;

const destinations: Array<[string, () => Promise<Destination>]> = [
  ["the IPv4 loopback literal", async () => {
    const listener = await listen("127.0.0.1", answerAsGitLab);
    return { instanceUrl: `https://127.0.0.1:${listener.port}`, host: "127.0.0.1", listeners: [listener] };
  }],
  ["localhost, on whichever loopback family it resolves to", async () => {
    const ipv4 = await listen("127.0.0.1", answerAsGitLab);
    const ipv6 = await listenOrNull("::1", answerAsGitLab, ipv4.port);
    return {
      instanceUrl: `https://localhost:${ipv4.port}`,
      host: "localhost",
      listeners: ipv6 === null ? [ipv4] : [ipv4, ipv6],
    };
  }],
  ["the IPv6 loopback literal", async () => {
    const listener = await listenOrNull("::1", answerAsGitLab);
    return listener === null
      ? null
      : { instanceUrl: `https://[::1]:${listener.port}`, host: "::1", listeners: [listener] };
  }],
  // Nothing can listen on the metadata address here; the witness is that no
  // socket ever tried to connect to it.
  ["the link-local metadata address", async () => ({
    instanceUrl: "https://169.254.169.254",
    host: "169.254.169.254",
    listeners: [],
  })],
];

describe("linking a forge identity on a non-public instance through the production transport", () => {
  it.for(destinations)(
    "refuses %s without connecting, storing nothing, and answers exactly as for an unreachable host",
    async ([, prepare], context) => {
      const destination = await prepare();
      if (destination === null) {
        // The host has no IPv6 loopback to listen on; the literal is still
        // covered by the transport's own classification tests.
        context.skip();
        return;
      }
      const expected = await unreachableAnswer();
      const attempts = recordConnectAttempts();

      const answer = await link(destination.instanceUrl);

      for (const listener of destination.listeners) {
        expect(listener.connections).toBe(0);
      }
      expect(answer.writes).toEqual([]);
      expect(answer.claims).toEqual([]);
      // A socket asked to connect to a name still resolves it first, and the
      // refusal lands in that lookup; only a literal would go straight to
      // the wire, so the attempt record witnesses literals.
      if (isIP(destination.host) !== 0) {
        expect(attempts).not.toContain(destination.host);
      }
      expect({ status: answer.status, body: answer.body }).toEqual(expected);
    },
  );
});

describe("a GitLab gateway built with no transport, as the worker and the labels route build it", () => {
  it("rejects a loopback instance with a status-0 GitLabApiError and never connects", async () => {
    const listener = await listen("127.0.0.1", answerAsGitLab);
    const gateway = new GitLabGateway({ instanceUrl: `http://127.0.0.1:${listener.port}`, token: "glpat-x" });

    const outcome = await gateway.getRepositoryById(1).then(
      (value) => ({ settled: "resolved" as const, value }),
      (error: unknown) => ({ settled: "rejected" as const, value: error }),
    );

    expect(listener.connections).toBe(0);
    expect(outcome.settled).toBe("rejected");
    expect(outcome.value).toBeInstanceOf(GitLabApiError);
    expect((outcome.value as GitLabApiError).status).toBe(0);
  });

  it("reports a refused destination and a genuine transport failure as the same error", async () => {
    const listener = await listen("127.0.0.1", answerAsGitLab);
    const refused = await rejectionOf(
      new GitLabGateway({ instanceUrl: `http://127.0.0.1:${listener.port}`, token: "glpat-x" }).getRepositoryById(1),
    );
    const failed = await rejectionOf(
      new GitLabGateway({
        instanceUrl: "https://gitlab.example.com",
        token: "glpat-x",
        fetch: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:443"), { code: "ECONNREFUSED" });
        },
      }).getRepositoryById(1),
    );

    expect(listener.connections).toBe(0);
    expect(refused).toBeInstanceOf(GitLabApiError);
    expect(failed).toBeInstanceOf(GitLabApiError);
    // Everything the error carries except its stack, whose frames are code
    // positions: a caller that echoed any of it could not tell the two apart.
    expect(exposedFields(refused as GitLabApiError)).toEqual(exposedFields(failed as GitLabApiError));
    expect(exposedFields(failed as GitLabApiError)).not.toContain("203.0.113.9");
  });
});

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

function exposedFields(error: GitLabApiError): string {
  const properties = Object.getOwnPropertyDescriptors(error);
  Reflect.deleteProperty(properties, "stack");
  return `${JSON.stringify(error)} ${inspect(Object.defineProperties({}, properties), { showHidden: true, depth: null })}`;
}
