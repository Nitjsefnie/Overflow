import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryPostHandler } from "@/app/api/repositories/route";
import * as labelsRoute from "@/app/api/repositories/labels/route";
import type { RepositoryRegistrationDependencies } from "@/lib/repositories/register";
import { listen, useLoopbackListeners } from "../support/loopback-listener";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

// Every route that surfaces a GitLab gateway error must answer a refused
// destination exactly as it answers a genuine transport failure. Both sides
// run through the production transport, which none of these tests replace:
// the refused side is a loopback listener that must never be reached, the
// failing side a name under `.invalid`, which never resolves.
//
// Both sides use https URLs, the only scheme the routes accept, so each
// request passes the scheme gate and reaches the gateway. The listener speaks
// plain http: a request that got through would fail its TLS handshake rather
// than read the listener's answer, so the witness that it was never reached is
// its accepted-connection count, which a handshake attempt still increments.

// Release modules evaluated with this file's mocked session and stores.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const { readSession, getForgeToken } = vi.hoisted(() => ({
  readSession: vi.fn(),
  getForgeToken: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));
vi.mock("@/lib/forge/postgres-identities-store", () => ({
  PostgresForgeIdentityStore: class {
    public getForgeToken = getForgeToken;
  },
}));

useTrustedOrigin();
useLoopbackListeners();

const unresolvableInstance = "https://gitlab.invalid";

beforeEach(() => {
  readSession.mockReset().mockResolvedValue({ user: { id: "sponsor-id", role: "MEMBER" } });
  getForgeToken.mockReset().mockResolvedValue({ token: "glpat-sponsor", identityId: "identity-1" });
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "token-encryption-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Answers like a GitLab that hides every project. */
function answerNotFound(_request: unknown, response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: "404 Project Not Found" }));
}

async function answerOf(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

/** Any use of a registration dependency before the gateway call is a test failure. */
function untouchable<T>(name: string): T {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`the ${name} dependency was used (${String(property)})`);
    },
  }) as T;
}

const { json: registrationRequest } = guardedRequests("/api/repositories");

function registrationInput(instanceUrl: string) {
  return {
    repositoryUrl: `${instanceUrl}/group/project`,
    provider: "gitlab",
    instanceUrl,
    project: "group/project",
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "size/S", comparisonPoints: 2, reservePoints: 2 },
      { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
      { label: "size/L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

async function register(instanceUrl: string): Promise<{ status: number; body: string }> {
  const handler = createRepositoryPostHandler({
    findAccountByTokenHash: async () => null,
    getSession: async () => ({ user: { id: "sponsor-id", role: "MEMBER" } }),
    async createRegistrationDependencies(): Promise<RepositoryRegistrationDependencies> {
      // No forgeFetch: the gateway runs on its production default.
      return {
        actor: { id: "sponsor-id", role: "MEMBER" },
        github: untouchable("github"),
        store: untouchable("store"),
        webhook: { callbackUrl: "https://overflow.example/api/gitlab/webhooks" },
        forgeIdentity: { instanceUrl, token: "glpat-sponsor" },
      };
    },
  });
  return answerOf(await handler(registrationRequest(registrationInput(instanceUrl))));
}

describe("a gateway error at the repository registration route", () => {
  it("answers a loopback instance exactly as an unresolvable one, and never reaches it", async () => {
    const listener = await listen("127.0.0.1", answerNotFound);
    const unreachable = await register(unresolvableInstance);

    const refused = await register(`https://127.0.0.1:${listener.port}`);

    expect(listener.connections).toBe(0);
    expect(refused).toEqual(unreachable);
    expect(refused.status).toBe(502);
  });
});

async function readLabels(instanceUrl: string): Promise<{ status: number; body: string }> {
  const query = new URLSearchParams({ provider: "gitlab", instance: instanceUrl, project: "group/project" });
  return answerOf(await labelsRoute.GET(new Request(`https://overflow.internal/api/repositories/labels?${query}`)));
}

describe("a gateway error at the repository labels route", () => {
  it("answers a loopback instance exactly as an unresolvable one, and never reaches it", async () => {
    const listener = await listen("127.0.0.1", answerNotFound);
    const unreachable = await readLabels(unresolvableInstance);

    const refused = await readLabels(`https://127.0.0.1:${listener.port}`);

    expect(listener.connections).toBe(0);
    expect(refused).toEqual(unreachable);
    expect(refused.status).toBe(502);
  });
});
