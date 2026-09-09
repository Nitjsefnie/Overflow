import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveRouteCredential, getCurrentUserRole } = vi.hoisted(() => ({
  resolveRouteCredential: vi.fn(),
  getCurrentUserRole: vi.fn(),
}));

vi.mock("@/lib/security/route-credential", () => ({ resolveRouteCredential }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole }));

import { requiredMemberSession } from "@/lib/security/member-route-auth";

type GateResult = Awaited<ReturnType<typeof requiredMemberSession>>;

const memberId = "00000000-0000-4000-8000-000000000001";
const tokenOwnerId = "00000000-0000-4000-8000-000000000007";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct-call harness: the credential resolution is mocked, so each case drives
 * one decision arm of the gate against injected dependencies.
 */
function memberDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getSession: vi.fn(),
    findAccountByTokenHash: vi.fn(),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    ...overrides,
  };
}

async function expectMemberRefusal(
  result: GateResult,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: { code, message } });
}

describe("requiredMemberSession", () => {
  it("answers a null credential with the 401 sign-in refusal, before any role lookup", async () => {
    resolveRouteCredential.mockResolvedValue(null);
    const dependencies = memberDependencies();

    const result = await requiredMemberSession(
      new Request("https://overflow.example/api/overrides"),
      dependencies,
    );

    await expectMemberRefusal(result, 401, "UNAUTHENTICATED", "Sign in is required.");
    expect(dependencies.getCurrentRole).not.toHaveBeenCalled();
  });

  it("answers a credential whose account no longer exists with the 403 member refusal", async () => {
    resolveRouteCredential.mockResolvedValue({ user: { id: memberId } });
    const dependencies = memberDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const result = await requiredMemberSession(
      new Request("https://overflow.example/api/overrides"),
      dependencies,
    );

    await expectMemberRefusal(result, 403, "FORBIDDEN", "A member account is required.");
    expect(dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  it("passes a cookie member session through with the role re-read from the database", async () => {
    resolveRouteCredential.mockResolvedValue({ user: { id: memberId } });
    const dependencies = memberDependencies({
      getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    });

    const result = await requiredMemberSession(
      new Request("https://overflow.example/api/overrides"),
      dependencies,
    );

    expect(result).toEqual({ user: { id: memberId, role: "MEMBER" } });
    expect(dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith(memberId);
  });

  it("passes a bearer credential through as its owner with the role re-read from the database", async () => {
    // The bearer path resolves to the token owner and nothing more, so the
    // credential carries a role only here to pin that the gate does not trust
    // one from the credential: the refusal boundary re-reads it.
    resolveRouteCredential.mockResolvedValue({ user: { id: tokenOwnerId, role: "MODERATOR" } });
    const dependencies = memberDependencies({
      getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    });

    const result = await requiredMemberSession(
      new Request("https://overflow.example/api/overrides", {
        headers: { authorization: "Bearer ovf_bearer-credential" },
      }),
      dependencies,
    );

    expect(result).toEqual({ user: { id: tokenOwnerId, role: "MEMBER" } });
    expect(dependencies.getCurrentRole).toHaveBeenCalledExactlyOnceWith(tokenOwnerId);
  });

  it.each([
    ["credential resolution"],
    ["role lookup"],
  ] as const)(
    "answers a failed %s with the gate's 502",
    async (arm) => {
      const failure = vi.fn().mockRejectedValue(new Error("store outage"));
      resolveRouteCredential.mockImplementation(
        arm === "credential resolution"
          ? failure
          : () => Promise.resolve({ user: { id: memberId } }),
      );
      const dependencies = memberDependencies({
        getCurrentRole: arm === "role lookup" ? failure : vi.fn().mockResolvedValue("MEMBER"),
      });

      const result = await requiredMemberSession(
        new Request("https://overflow.example/api/overrides"),
        dependencies,
      );

      await expectMemberRefusal(
        result,
        502,
        "UPSTREAM_FAILURE",
        "Unable to authorize the settlement correction request.",
      );
      if (arm === "credential resolution") {
        expect(dependencies.getCurrentRole).not.toHaveBeenCalled();
      }
    },
  );
});
