import { describe, expect, it, vi, type Mock } from "vitest";
import {
  expectNoDependencyCall,
  guardedRequests,
  foreignOrigin,
  useTrustedOrigin,
} from "../support/trusted-origin";

const { productionAuth, productionRole } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));

import { createTeamGetHandler, createTeamPostHandler } from "@/app/api/teams/route";
import { createTeamMemberDeleteHandler, createTeamMemberPostHandler } from "@/app/api/teams/members/route";
import { createTeamDistributionPostHandler } from "@/app/api/teams/distributions/route";
import type { TeamRouteDependencies, TeamRouteStore } from "@/lib/teams/route";
import type { TeamRefusal, TeamStoreResult, TeamView } from "@/lib/teams/store";

const leadId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const teamId = "00000000-0000-4000-8000-000000000003";
const at = "2026-10-01T10:00:00.000Z";

const teamView: TeamView = {
  id: teamId, name: "Quay", leadId, createdAt: at,
  members: [{ userId: leadId, githubLogin: "lead", joinedAt: at }],
  balance: 7,
  distributions: [{ id: teamId, teamId, memberId: leadId, memberLogin: "lead", points: 3, createdAt: at }],
};

const teamPath = "/api/teams";
const membersPath = "/api/teams/members";
const distributionsPath = "/api/teams/distributions";

useTrustedOrigin();

type Store = Record<keyof TeamRouteStore, Mock>;
type Dependencies = Record<keyof Omit<TeamRouteDependencies, "createStore">, Mock> & { createStore: Mock; store: Store };

function storeWith(overrides: Partial<Store> = {}): Store {
  return {
    createTeam: vi.fn().mockResolvedValue({ kind: "ok", value: { id: teamId, name: "Quay", leadId, createdAt: at } }),
    addTeamMember: vi.fn().mockResolvedValue({ kind: "ok", value: { userId: memberId } }),
    removeTeamMember: vi.fn().mockResolvedValue({ kind: "ok", value: { userId: memberId } }),
    distributeTeamPoints: vi.fn().mockResolvedValue({
      kind: "ok",
      value: { id: teamId, teamId, memberId, points: 3, createdAt: at },
    }),
    getTeamForAccount: vi.fn().mockResolvedValue(teamView),
    ...overrides,
  } as Store;
}

function dependencies(store = storeWith(), overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: leadId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    createStore: vi.fn().mockReturnValue(store),
    store,
    ...overrides,
  } as Dependencies;
}

type Case = {
  label: string;
  path: string;
  method: string;
  valid: unknown;
  call: (deps: Dependencies) => (request: Request) => Promise<Response>;
  act: keyof TeamRouteStore;
  success: { status: number; body: unknown };
  invalid: unknown[];
};

const cases: Case[] = [
  {
    label: "POST /api/teams", path: teamPath, method: "POST", valid: { name: "Quay" },
    call: (deps) => createTeamPostHandler(deps), act: "createTeam",
    success: { status: 201, body: { team: { id: teamId, name: "Quay", leadId, createdAt: at } } },
    invalid: ["not json", {}, { name: "   " }, { name: "x".repeat(81) }, { name: "Quay", extra: 1 }, { name: 4 }],
  },
  {
    label: "POST /api/teams/members", path: membersPath, method: "POST", valid: { githubLogin: "Mira" },
    call: (deps) => createTeamMemberPostHandler(deps), act: "addTeamMember",
    success: { status: 201, body: { member: { userId: memberId } } },
    invalid: ["not json", {}, { githubLogin: " " }, { githubLogin: "x".repeat(40) }, { githubLogin: "mira", extra: 1 }],
  },
  {
    label: "DELETE /api/teams/members", path: membersPath, method: "DELETE", valid: { memberId },
    call: (deps) => createTeamMemberDeleteHandler(deps), act: "removeTeamMember",
    success: { status: 200, body: { removed: true } },
    invalid: ["not json", {}, { memberId: "nope" }, { memberId, extra: 1 }],
  },
  {
    label: "POST /api/teams/distributions", path: distributionsPath, method: "POST", valid: { memberId, points: 3 },
    call: (deps) => createTeamDistributionPostHandler(deps), act: "distributeTeamPoints",
    success: { status: 201, body: { distribution: { id: teamId, teamId, memberId, points: 3, createdAt: at } } },
    invalid: ["not json", {}, { memberId }, { points: 3 }, { memberId, points: 0 }, { memberId, points: -1 },
      { memberId, points: 1.5 }, { memberId, points: "3" }, { memberId: "nope", points: 3 }, { memberId, points: 3, extra: 1 }],
  },
];

const refusals: [TeamRefusal["kind"], number, string][] = [
  ["invalid_name", 422, "INVALID_INPUT"],
  ["name_taken", 409, "CONFLICT"],
  ["already_in_team", 409, "CONFLICT"],
  ["not_found", 404, "NOT_FOUND"],
  ["not_lead", 403, "FORBIDDEN"],
  ["not_member", 404, "NOT_FOUND"],
  ["lead_cannot_leave", 409, "CONFLICT"],
  ["invalid_points", 422, "INVALID_INPUT"],
  ["insufficient_balance", 409, "CONFLICT"],
];

describe.each(cases)("$label", (route) => {
  const { json, foreignJson, trustedText } = guardedRequests(route.path);
  const send = (deps: Dependencies, body: unknown = route.valid) =>
    route.call(deps)(json(body, route.method));

  it("acts for the credential's account and answers its success shape", async () => {
    const deps = dependencies();
    const response = await send(deps);

    expect(response.status).toBe(route.success.status);
    await expect(response.json()).resolves.toEqual(route.success.body);
    const act = deps.store[route.act];
    expect(act).toHaveBeenCalledTimes(1);
    expect(act.mock.calls[0]![0]).toBe(leadId);
  });

  it("acts for the bearer token's account rather than the browser account", async () => {
    const tokenAccount = "00000000-0000-4000-8000-000000000099";
    const deps = dependencies(undefined, {
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: tokenAccount, tokenId: "token-1" }),
    });
    const response = await route.call(deps)(json(route.valid, route.method, { authorization: `Bearer ovf_${"r".repeat(43)}` }));

    expect(response.status).toBe(route.success.status);
    expect(deps.store[route.act].mock.calls[0]![0]).toBe(tokenAccount);
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it("lets a bearer token skip the origin check, which only a cookie request owes", async () => {
    const deps = dependencies(undefined, {
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: leadId, tokenId: "token-1" }),
    });
    const response = await route.call(deps)(
      json(route.valid, route.method, { origin: foreignOrigin, authorization: `Bearer ovf_${"r".repeat(43)}` }),
    );

    expect(response.status).toBe(route.success.status);
  });

  it("holds a request with a non-bearer authorization header to the origin check", async () => {
    const deps = dependencies();
    const response = await route.call(deps)(
      json(route.valid, route.method, { origin: foreignOrigin, authorization: "Basic abc" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall({ getSession: deps.getSession, createStore: deps.createStore });
  });

  it("refuses an anonymous request before the store is built", async () => {
    const deps = dependencies(undefined, { getSession: vi.fn().mockResolvedValue(null) });
    const response = await send(deps);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it("refuses an account that no longer exists", async () => {
    const deps = dependencies(undefined, { getCurrentRole: vi.fn().mockResolvedValue(null) });
    const response = await send(deps);

    expect(response.status).toBe(403);
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it("refuses a foreign origin before any dependency is reached", async () => {
    const deps = dependencies();
    const response = await route.call(deps)(foreignJson(route.valid, route.method));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall({ getSession: deps.getSession, createStore: deps.createStore });
  });

  it("refuses a non-JSON media type", async () => {
    const deps = dependencies();
    const response = await route.call(deps)(trustedText(route.valid, route.method));

    expect(response.status).toBe(415);
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it("answers 413 when the body crosses the 4 KiB read limit", async () => {
    const deps = dependencies();
    const response = await send(deps, { ...(route.valid as object), padding: "x".repeat(4 * 1024 + 1) });

    expect(response.status).toBe(413);
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it.each(route.invalid.map((body, index) => [index, body] as const))("answers 422 for invalid body %i", async (_index, body) => {
    const deps = dependencies();
    const request = typeof body === "string"
      ? new Request(json({}, route.method).url, {
        method: route.method, headers: { origin: "https://overflow.example", "content-type": "application/json" }, body,
      })
      : json(body, route.method);
    const response = await route.call(deps)(request);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid team request." },
    });
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it.each(refusals)("maps the store refusal %s to %i %s", async (kind, status, code) => {
    const store = storeWith({ [route.act]: vi.fn().mockResolvedValue({ kind } satisfies TeamStoreResult<never>) });
    const response = await send(dependencies(store));

    expect(response.status).toBe(status);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("answers 502 when the store fails", async () => {
    const store = storeWith({ [route.act]: vi.fn().mockRejectedValue(new Error("db down: secret detail")) });
    const response = await send(dependencies(store));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("UPSTREAM_FAILURE");
    expect(text).not.toContain("secret detail");
  });
});

describe("GET /api/teams", () => {
  const request = () => new Request(new URL(teamPath, "https://overflow.internal"));

  it("answers the account's team", async () => {
    const deps = dependencies();
    const response = await createTeamGetHandler(deps)(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ team: teamView });
    expect(deps.store.getTeamForAccount).toHaveBeenCalledWith(leadId);
  });

  it("answers null for an account in no team", async () => {
    const store = storeWith({ getTeamForAccount: vi.fn().mockResolvedValue(null) });
    const response = await createTeamGetHandler(dependencies(store))(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ team: null });
  });

  it("refuses an anonymous request", async () => {
    const deps = dependencies(undefined, { getSession: vi.fn().mockResolvedValue(null) });
    const response = await createTeamGetHandler(deps)(request());

    expect(response.status).toBe(401);
    expectNoDependencyCall({ createStore: deps.createStore });
  });

  it("answers 502 when the read fails", async () => {
    const store = storeWith({ getTeamForAccount: vi.fn().mockRejectedValue(new Error("db down")) });
    const response = await createTeamGetHandler(dependencies(store))(request());

    expect(response.status).toBe(502);
  });
});
