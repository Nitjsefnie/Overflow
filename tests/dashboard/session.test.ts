import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, currentRole, redirect } = vi.hoisted(() => ({
  auth: vi.fn(),
  currentRole: vi.fn(),
  // The real redirect() throws to abort rendering. A mock that returns would let
  // control fall through the exit it is meant to close, so every assertion after
  // it would be about code the server never reaches.
  redirect: vi.fn((target: string) => {
    throw new Error(`redirected to ${target}`);
  }),
}));

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));
vi.mock("next/navigation", () => ({ redirect }));

import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

describe("dashboard session authorization", () => {
  beforeEach(() => {
    auth.mockReset();
    currentRole.mockReset();
    redirect.mockClear();
  });

  it("uses the current PostgreSQL role instead of an already-issued JWT role", async () => {
    auth.mockResolvedValue({
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Demoted moderator",
        role: "MODERATOR",
      },
    });
    currentRole.mockResolvedValue("MEMBER");

    const session = await requireMemberPageSession();

    expect(currentRole).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(session.user.role).toBe("MEMBER");
    expect(isModeratorSession(session)).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends a visitor with no signed-in identity to the landing page", async () => {
    auth.mockResolvedValue(null);

    await expect(requireMemberPageSession()).rejects.toThrow("redirected to /");

    expect(redirect).toHaveBeenCalledExactlyOnceWith("/");
    expect(currentRole).not.toHaveBeenCalled();
  });

  it("sends a visitor to the recovery route when the role lookup fails", async () => {
    auth.mockResolvedValue({ user: { id: "00000000-0000-4000-8000-000000000002", name: "Member" } });
    currentRole.mockRejectedValue(new Error("the ledger is unreachable"));

    await expect(requireMemberPageSession()).rejects.toThrow("redirected to /session?reason=unavailable");

    expect(redirect).toHaveBeenCalledExactlyOnceWith("/session?reason=unavailable");
  });

  it("sends a visitor to the recovery route when the member record is gone", async () => {
    auth.mockResolvedValue({ user: { id: "00000000-0000-4000-8000-000000000003", name: "Member" } });
    currentRole.mockResolvedValue(null);

    await expect(requireMemberPageSession()).rejects.toThrow("redirected to /session?reason=stale");

    expect(redirect).toHaveBeenCalledExactlyOnceWith("/session?reason=stale");
  });
});
