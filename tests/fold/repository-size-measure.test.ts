import { describe, expect, it, vi } from "vitest";
import { measureRepositorySize } from "@/lib/fold/repository-size";
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
  const base = { ownerName: "group/project", provider: "github", instanceUrl: null as string | null, sponsor: { id: "sponsor-1" } };
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

  it("propagates a forge failure: the measure failed and the caller keeps the previous size", async () => {
    const measure = measureRepositorySize(dependencies({ gitHubToken: "token-a" }), () => {
      throw new Error("forge unreachable");
    });
    await expect(measure("repository-1")).rejects.toThrow("forge unreachable");
  });
});
