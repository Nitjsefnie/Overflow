import { describe, expect, it } from "vitest";
import {
  AccountModerationService,
  ModerationServiceError,
  type ModerationStore,
  type ModeratorRoleChange,
} from "@/lib/moderation/service";
import { normalizeModeratorGitHubUserIds, resolveSignInRole } from "@/lib/moderation/roles";

describe("the configured moderator list names GitHub account ids", () => {
  it("parses comma-separated positive integers and ignores whitespace", () => {
    expect(normalizeModeratorGitHubUserIds(" 583231, 1024 ,7")).toEqual(new Set([583231, 1024, 7]));
  });

  it("accepts the positive safe-integer boundaries and deduplicates ids", () => {
    expect(normalizeModeratorGitHubUserIds("1,9007199254740991,1")).toEqual(new Set([1, 9007199254740991]));
  });

  it("never matches a login, a zero, a negative, a fraction, or an empty entry", () => {
    expect(normalizeModeratorGitHubUserIds("octocat,0,-5,1.5,,  ,9007199254740993")).toEqual(new Set());
  });

  it("ignores non-decimal forms without discarding valid entries", () => {
    expect(normalizeModeratorGitHubUserIds("octocat,1,1e3,0x10,+7,Infinity,NaN,9007199254740992,1024"))
      .toEqual(new Set([1, 1024]));
  });

  it.each(["0042", "42abc", "1e3"])("ignores malformed id %s without a valid prefix masking it", (entry) => {
    expect(normalizeModeratorGitHubUserIds(entry)).toEqual(new Set());
  });

  it("treats an unset variable as no configured moderators", () => {
    expect(normalizeModeratorGitHubUserIds(undefined)).toEqual(new Set());
    expect(normalizeModeratorGitHubUserIds("")).toEqual(new Set());
  });
});

describe("granting and revoking moderator status", () => {
  it("promotes a member and records who did it", async () => {
    const harness = createHarness();

    await expect(
      harness.service.setModeratorRole({ id: "moderator-id", role: "MODERATOR" }, "member-id", true),
    ).resolves.toMatchObject({ targetAccountId: "member-id", role: "MODERATOR", actorId: "moderator-id" });

    expect(harness.calls).toEqual([{ actorId: "moderator-id", targetAccountId: "member-id", moderator: true }]);
  });

  it("revokes a moderator and records who did it", async () => {
    const harness = createHarness();

    await expect(
      harness.service.setModeratorRole({ id: "moderator-id", role: "MODERATOR" }, "other-id", false),
    ).resolves.toMatchObject({ targetAccountId: "other-id", role: "MEMBER" });

    expect(harness.calls).toEqual([{ actorId: "moderator-id", targetAccountId: "other-id", moderator: false }]);
  });

  it("refuses a member who is not a moderator", async () => {
    const harness = createHarness();

    await expect(
      harness.service.setModeratorRole({ id: "member-id", role: "MEMBER" }, "other-id", true),
    ).rejects.toBeInstanceOf(ModerationServiceError);
    expect(harness.calls).toEqual([]);
  });

  it("refuses to revoke your own moderator status", async () => {
    const harness = createHarness();

    await expect(
      harness.service.setModeratorRole({ id: "moderator-id", role: "MODERATOR" }, "moderator-id", false),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.calls).toEqual([]);
  });

  it("refuses to revoke the last remaining moderator", async () => {
    const harness = createHarness({ result: { kind: "invalid_state" } });

    await expect(
      harness.service.setModeratorRole({ id: "moderator-id", role: "MODERATOR" }, "other-id", false),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reports an unknown target account", async () => {
    const harness = createHarness({ result: { kind: "not_found" } });

    await expect(
      harness.service.setModeratorRole({ id: "moderator-id", role: "MODERATOR" }, "ghost-id", true),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the configured moderator list is a floor, not an override", () => {
  it("promotes a configured account that is stored as a member", () => {
    expect(resolveSignInRole("MEMBER", true)).toBe("MODERATOR");
  });

  it("keeps a moderator granted in the product when the account is not configured", () => {
    expect(resolveSignInRole("MODERATOR", false)).toBe("MODERATOR");
  });

  it("leaves an unconfigured member a member", () => {
    expect(resolveSignInRole("MEMBER", false)).toBe("MEMBER");
  });

  it("treats an account that does not exist yet as a member", () => {
    expect(resolveSignInRole(null, false)).toBe("MEMBER");
    expect(resolveSignInRole(null, true)).toBe("MODERATOR");
  });
});

type HarnessOptions = {
  result?: { kind: "not_found" } | { kind: "invalid_state" };
};

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<{ actorId: string; targetAccountId: string; moderator: boolean }> = [];
  const store: ModerationStore = {
    loadCalibrationCohort: async () => null,
    openAccountAudit: async () => ({ kind: "not_found" }),
    dismissAccountAudit: async () => ({ kind: "not_found" }),
    substantiateAccountAudit: async () => ({ kind: "not_found" }),
    closeRecalibration: async () => ({ kind: "not_found" }),
    listModerators: async () => [],
    setModeratorRole: async (input) => {
      calls.push(input);
      if (options.result !== undefined) {
        return options.result;
      }
      const change: ModeratorRoleChange = {
        targetAccountId: input.targetAccountId,
        targetGitHubLogin: "target",
        role: input.moderator ? "MODERATOR" : "MEMBER",
        actorId: input.actorId,
        changedAt: "2026-09-05T00:00:00.000Z",
      };
      return { kind: "ok", value: change };
    },
  };

  return { service: new AccountModerationService(store), calls };
}
