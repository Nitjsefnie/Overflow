import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, currentRole } = vi.hoisted(() => ({
  auth: vi.fn(),
  currentRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: currentRole }));

import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

describe("dashboard session authorization", () => {
  beforeEach(() => {
    auth.mockReset();
    currentRole.mockReset();
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
  });
});
