import { describe, expect, it, vi } from "vitest";
import { findRepositoryGone, measureRepositorySize } from "@/lib/fold/repository-size";
import type { GitHubRepositoryReference } from "@/lib/github/types";

/**
 * The wiring composition of the size measure: which credential a count query
 * rides, per repository provider, and the reference it is aimed by. The forge
 * clients' count reads themselves are pinned in their own suites.
 */

const reference: GitHubRepositoryReference = { owner: "group", name: "project" };

function dependencies(overrides: {
  repository?: Record<string, unknown> | null;
  gitHubToken?: string | null;
  forgeToken?: { token: string; identityId: string } | null;
}) {
  const base = { ownerName: "group/project", githubRepositoryId: 41, provider: "github", instanceUrl: null as string | null, sponsor: { id: "sponsor-1" } };
  return {
    getRepository: vi.fn(async () =>
      overrides.repository === undefined ? base : overrides.repository === null ? null : { ...base, ...overrides.repository }),
    getGitHubAccessToken: vi.fn(async () => overrides.gitHubToken ?? null),
    resolveForgeToken: vi.fn(async () => overrides.forgeToken ?? null),
  };
}

type FactoryInput =
  | { provider: "github"; accessToken: string; ownerId: string }
  | { provider: "gitlab"; instanceUrl: string; token: string };

function fakeGateway(count: number | null, calls: FactoryInput[], references: GitHubRepositoryReference[]) {
  return (input: FactoryInput) => {
    calls.push(input);
    return {
      getRepositoryHistoryCount: async (passed: GitHubRepositoryReference) => {
        references.push(passed);
        return count;
      },
    };
  };
}

describe("measuring a repository's size as its sponsor", () => {
  it("measures a GitHub repository with the sponsor's token, aimed by the registered owner/name", async () => {
    const calls: FactoryInput[] = [];
    const references: GitHubRepositoryReference[] = [];
    const measure = measureRepositorySize(dependencies({ gitHubToken: "token-a" }), fakeGateway(1356, calls, references));
    await expect(measure("repository-1")).resolves.toBe(1356);
    expect(references).toEqual([reference]);
    expect(calls).toEqual([{ provider: "github", accessToken: "token-a", ownerId: "sponsor-1" }]);
  });

  it("measures a GitLab repository with the linked identity's token on its instance", async () => {
    const calls: FactoryInput[] = [];
    const references: GitHubRepositoryReference[] = [];
    const measure = measureRepositorySize(
      dependencies({ repository: { provider: "gitlab", instanceUrl: "https://gitlab.test" }, forgeToken: { token: "pat", identityId: "identity-1" } }),
      fakeGateway(50, calls, references),
    );
    await expect(measure("repository-1")).resolves.toBe(50);
    expect(references).toEqual([reference]);
    expect(calls).toEqual([{ provider: "gitlab", instanceUrl: "https://gitlab.test", token: "pat" }]);
  });

  it("returns null, not a wrong-credential read, for a GitLab repository without a linked identity", async () => {
    const calls: FactoryInput[] = [];
    const references: GitHubRepositoryReference[] = [];
    const measure = measureRepositorySize(
      dependencies({ repository: { provider: "gitlab", instanceUrl: "https://gitlab.test" }, forgeToken: null }),
      fakeGateway(50, calls, references),
    );
    await expect(measure("repository-1")).resolves.toBeNull();
    expect(calls).toEqual([]);
    expect(references).toEqual([]);
  });

  it("returns null when the GitLab repository carries no instance URL", async () => {
    const calls: FactoryInput[] = [];
    const measure = measureRepositorySize(
      dependencies({ repository: { provider: "gitlab", instanceUrl: null }, forgeToken: { token: "pat", identityId: "identity-1" } }),
      fakeGateway(50, calls, []),
    );
    await expect(measure("repository-1")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null when the sponsor's GitHub token is gone", async () => {
    const calls: FactoryInput[] = [];
    const measure = measureRepositorySize(dependencies({ gitHubToken: null }), fakeGateway(1356, calls, []));
    await expect(measure("repository-1")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null for a repository the store no longer knows", async () => {
    const calls: FactoryInput[] = [];
    const measure = measureRepositorySize(dependencies({ repository: null }), fakeGateway(1356, calls, []));
    await expect(measure("repository-1")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null, with no gateway built, for a malformed ownerName without a separating owner", async () => {
    // The GitHub token is supplied so the separator guard is what stops the
    // read — a null token would mask either malformed shape with its own null.
    for (const ownerName of ["project", "/project", "group/"]) {
      const calls: FactoryInput[] = [];
      const measure = measureRepositorySize(
        dependencies({ repository: { ownerName }, gitHubToken: "token-a" }), fakeGateway(1356, calls, []));
      await expect(measure("repository-1")).resolves.toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("propagates a forge failure: the measure failed and the caller keeps the previous size", async () => {
    const measure = measureRepositorySize(dependencies({ gitHubToken: "token-a" }), () => {
      throw new Error("forge unreachable");
    });
    await expect(measure("repository-1")).rejects.toThrow("forge unreachable");
  });
});

describe("finding a repository gone as its sponsor", () => {
  function lookupGateway(answer: () => Promise<object | null>, calls: FactoryInput[], ids: number[]) {
    return (input: FactoryInput) => {
      calls.push(input);
      return {
        getRepositoryById: async (id: number) => {
          ids.push(id);
          return answer();
        },
      };
    };
  }

  it("looks a GitHub repository up by its registered id with the sponsor's token, gone only on null", async () => {
    for (const [answer, gone] of [[null, true], [{ id: 41 }, false]] as const) {
      const calls: FactoryInput[] = [];
      const ids: number[] = [];
      const isGone = findRepositoryGone(dependencies({ gitHubToken: "token-a" }), lookupGateway(async () => answer, calls, ids));
      await expect(isGone("repository-1")).resolves.toBe(gone);
      expect(calls).toEqual([{ provider: "github", accessToken: "token-a", ownerId: "sponsor-1" }]);
      expect(ids).toEqual([41]);
    }
  });

  it("looks a GitLab project up by its registered id with the linked identity's token on its instance", async () => {
    const calls: FactoryInput[] = [];
    const ids: number[] = [];
    const isGone = findRepositoryGone(
      dependencies({
        repository: { provider: "gitlab", instanceUrl: "https://gitlab.test", githubRepositoryId: 77 },
        forgeToken: { token: "pat", identityId: "identity-1" },
      }),
      lookupGateway(async () => null, calls, ids),
    );
    await expect(isGone("repository-1")).resolves.toBe(true);
    expect(calls).toEqual([{ provider: "gitlab", instanceUrl: "https://gitlab.test", token: "pat" }]);
    expect(ids).toEqual([77]);
  });

  it("looks up a GitLab project under a nested namespace", async () => {
    const calls: FactoryInput[] = [];
    const isGone = findRepositoryGone(
      dependencies({
        repository: { ownerName: "group/subgroup/project", provider: "gitlab", instanceUrl: "https://gitlab.test" },
        forgeToken: { token: "pat", identityId: "identity-1" },
      }),
      lookupGateway(async () => null, calls, []),
    );
    await expect(isGone("repository-1")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["github", "group/..", "group/.github"],
    ["github", "group/.", "group/-renamed"],
    ["github", "bad owner/project", "good_owner/project"],
    ["github", "group/bad name", "group/_renamed"],
    ["github", "-owner/project", "owner/project"],
    ["github", "group/%2e%2e", "group/project"],
    ["github", "group/project\n", "a/x"],
    ["gitlab", "group/..", "group/project"],
    ["gitlab", "group/../project", "group/sub.group/project"],
    ["gitlab", "bad group/sub/project", "group/sub-group/project"],
    ["gitlab", "-group/project", "_group/subgroup/project"],
    ["gitlab", "group/-project", ".group/_sub/project"],
    ["gitlab", "group/bad+name", "group/my_project"],
    ["gitlab", "group/project\n", "a/x"],
    ["gitlab", "group./project", "group/project."],
    ["gitlab", "group/project.git", "group/project.gitlab"],
    ["gitlab", "group/project.atom", "group/project.atomic"],
    ["gitlab", "group/sub.git/project", "group/sub.gitlab/project"],
    ["gitlab", "group/sub.atom/project", "group/sub.atomic/project"],
  ])("rejects malformed %s path %s while accepting %s", async (provider, malformed, valid) => {
    const repository = { provider, instanceUrl: "https://gitlab.test" };
    const credentials = { gitHubToken: "token-a", forgeToken: { token: "pat", identityId: "identity-1" } };
    const controlCalls: FactoryInput[] = [];
    const control = findRepositoryGone(
      dependencies({ ...credentials, repository: { ...repository, ownerName: valid } }),
      lookupGateway(async () => null, controlCalls, []),
    );
    await expect(control("repository-1")).resolves.toBe(true);
    expect(controlCalls).toHaveLength(1);

    const calls: FactoryInput[] = [];
    const isGone = findRepositoryGone(
      dependencies({ ...credentials, repository: { ...repository, ownerName: malformed } }),
      lookupGateway(async () => null, calls, []),
    );
    await expect(isGone("repository-1")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ["github", { gitHubToken: "" }],
    ["gitlab", { repository: { provider: "gitlab", instanceUrl: "https://gitlab.test" }, forgeToken: { token: "", identityId: "identity-1" } }],
  ])("does not look up a %s repository with an empty credential", async (_provider, overrides) => {
    const calls: FactoryInput[] = [];
    const isGone = findRepositoryGone(dependencies(overrides), lookupGateway(async () => null, calls, []));
    await expect(isGone("repository-1")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("is not gone, with no lookup, without a repository, a credential, an instance or a well-formed path", async () => {
    for (const overrides of [
      { repository: null, gitHubToken: "token-a" },
      { gitHubToken: null },
      { repository: { ownerName: "project" }, gitHubToken: "token-a" },
      { repository: { ownerName: "group//project" }, gitHubToken: "token-a" },
      { repository: { ownerName: "group/project/extra" }, gitHubToken: "token-a" },
      { repository: { ownerName: "group//project", provider: "gitlab", instanceUrl: "https://gitlab.test" }, forgeToken: { token: "pat", identityId: "identity-1" } },
      { repository: { provider: "gitlab", instanceUrl: null }, forgeToken: { token: "pat", identityId: "identity-1" } },
      { repository: { provider: "gitlab", instanceUrl: "https://gitlab.test" }, forgeToken: null },
    ]) {
      const calls: FactoryInput[] = [];
      const isGone = findRepositoryGone(dependencies(overrides), lookupGateway(async () => null, calls, []));
      await expect(isGone("repository-1")).resolves.toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("propagates a lookup failure rather than reading it as gone", async () => {
    const isGone = findRepositoryGone(dependencies({ gitHubToken: "token-a" }), lookupGateway(async () => {
      throw new Error("GitHub API request failed with status 401.");
    }, [], []));
    await expect(isGone("repository-1")).rejects.toThrow("status 401");
  });
});
