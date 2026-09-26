import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { auth, currentRole, redirect } = vi.hoisted(() => ({
  auth: vi.fn(),
  currentRole: vi.fn(),
  // The real redirect() throws to abort rendering; a returning mock would let
  // control fall through the exit under test.
  redirect: vi.fn((target: string) => {
    throw new Error(`redirected to ${target}`);
  }),
}));

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));
vi.mock("next/navigation", () => ({ redirect }));

import { requireMemberPageSession } from "@/lib/dashboard/session";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import { requiredMemberSession } from "@/lib/security/member-route-auth";

// Rebind cached consumers to this file's mocks when workers are shared.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const sessionTokenId = "00000000-0000-4000-8000-00000000e1d5";

// Distinctive values that must never reach a log line. The route gates resolve
// the credential for real, so the bearer token has the minted token's shape.
const bearerToken = `ovf_${"S".repeat(20)}ecretBearerValue${"x".repeat(7)}`;
const cookieValue = "cookie-secret-value-7f3a91";
const sessionUserId = "00000000-0000-4000-8000-00000000d15c";
const sessionUserName = "Distinctive Member Name";
const sessionUserEmail = "distinctive.member@example.test";
const secrets = [bearerToken, cookieValue, sessionUserId, sessionUserName, sessionUserEmail];

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

type Phase = "credential resolution" | "role lookup";

const routeGates = [
  {
    gate: "member route gate",
    run: requiredMemberSession,
    message: "Unable to authorize the member request.",
    authorized: { user: { id: sessionUserId, role: "MODERATOR" } },
  },
  {
    gate: "moderator route gate",
    run: requiredModeratorSession,
    message: "Unable to authorize the moderator request.",
    // The moderator gate also names the credential behind the action (issue 682).
    authorized: {
      user: { id: sessionUserId, role: "MODERATOR" },
      credential: { kind: "token", tokenId: sessionTokenId },
    },
  },
] as const;

const phases: Phase[] = ["credential resolution", "role lookup"];
const credentials = ["bearer token", "session cookie"] as const;

function gatedRequest(credential: (typeof credentials)[number]): Request {
  const headers: Record<string, string> = { cookie: `authjs.session-token=${cookieValue}` };
  if (credential === "bearer token") {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  return new Request("https://overflow.example/api/overrides", { headers });
}

/**
 * Dependencies whose lookup for the named phase throws `failure`; the other
 * lookups resolve the distinctive session user as a moderator.
 */
function failingDependencies(phase: Phase, failure: Error) {
  const credentialLookup = phase === "credential resolution"
    ? vi.fn().mockRejectedValue(failure)
    : vi.fn().mockResolvedValue({ id: sessionUserId });
  return {
    getSession: phase === "credential resolution"
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue({ user: { id: sessionUserId, role: "MODERATOR" } }),
    findAccountByTokenHash: credentialLookup,
    getCurrentRole: phase === "role lookup"
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue("MODERATOR"),
  };
}

function otherPhase(phase: Phase): Phase {
  return phase === "credential resolution" ? "role lookup" : "credential resolution";
}

function expectOneFailureLine(gate: string, phase: Phase, failure: Error): void {
  expect(consoleError).toHaveBeenCalledTimes(1);
  const [message, logged, ...rest] = consoleError.mock.calls[0] ?? [];
  expect(typeof message).toBe("string");
  const text = (message as string).toLowerCase();
  expect(text).toContain(gate);
  expect(text).toContain(phase);
  expect(text).not.toContain(otherPhase(phase));
  expect(logged).toBe(failure);
  expect(rest).toEqual([]);
}

function expectNoSecretLogged(): void {
  for (const call of consoleError.mock.calls) {
    for (const argument of call) {
      const rendered = typeof argument === "string" ? argument : inspect(argument, { depth: null });
      for (const secret of secrets) {
        expect(rendered).not.toContain(secret);
      }
    }
  }
}

describe.each(routeGates)("$gate lookup failures", ({ gate, run, message, authorized }) => {
  it.each(phases.flatMap((phase) => credentials.map((credential) => ({ phase, credential }))))(
    "answers 502 and logs one line naming the gate and $phase for a $credential",
    async ({ phase, credential }) => {
      const failure = new Error("the ledger is unreachable");

      const result = await run(gatedRequest(credential), failingDependencies(phase, failure));

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: { code: "UPSTREAM_FAILURE", message },
      });
      expectOneFailureLine(gate, phase, failure);
      expectNoSecretLogged();
    },
  );

  it("logs nothing when the gate authorizes the request", async () => {
    const result = await run(gatedRequest("bearer token"), {
      getSession: vi.fn(),
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: sessionUserId, tokenId: sessionTokenId }),
      getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    });

    expect(result).toEqual(authorized);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("member page gate lookup failures", () => {
  const sessionUser = { id: sessionUserId, name: sessionUserName, email: sessionUserEmail };

  it("redirects to recovery and logs one line naming the gate and role lookup", async () => {
    auth.mockResolvedValue({ user: sessionUser });
    const failure = new Error("the ledger is unreachable");
    currentRole.mockRejectedValue(failure);

    await expect(requireMemberPageSession()).rejects.toThrow(
      "redirected to /session?reason=unavailable",
    );

    expect(redirect).toHaveBeenCalledExactlyOnceWith("/session?reason=unavailable");
    expectOneFailureLine("member page gate", "role lookup", failure);
    expectNoSecretLogged();
  });

  it("logs nothing when the gate admits the member", async () => {
    auth.mockResolvedValue({ user: sessionUser });
    currentRole.mockResolvedValue("MEMBER");

    const session = await requireMemberPageSession();

    expect(session.user.id).toBe(sessionUserId);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no signed-in identity", session: null, role: "MEMBER", target: "/" },
    { label: "a member record that is gone", session: { user: sessionUser }, role: null, target: "/session?reason=stale" },
  ])("logs nothing for the redirect on $label", async ({ session, role, target }) => {
    auth.mockResolvedValue(session);
    currentRole.mockResolvedValue(role);

    await expect(requireMemberPageSession()).rejects.toThrow(`redirected to ${target}`);

    expect(redirect).toHaveBeenCalledExactlyOnceWith(target);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
