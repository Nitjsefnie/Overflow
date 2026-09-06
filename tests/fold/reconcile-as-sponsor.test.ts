import { describe, expect, it, vi } from "vitest";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import type { ReconciliationGateway, ReconciliationRepository, ReconciliationStore } from "@/lib/fold/reconcile";

describe("reconciling a repository as its sponsor", () => {
  it("folds a deactivated repository whose sponsor has no token left", async () => {
    // The path the worker used to burn every attempt on. A repository deactivated
    // while it held a job needs no GitHub read at all — the fold short-circuits to
    // a clean no-delta run — so resolving the sponsor's token before that decision
    // turned a job that completes instantly into five failures and a FAILED row
    // the sweep will not revive, because the sweep only enqueues active ones.
    const harness = createHarness({ active: false, accessToken: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).resolves.toMatchObject({ repositoryId: "repo-1", skipped: false, adds: 0, changes: 0, removals: 0 });

    expect(harness.calls).toEqual(["getRepository", "beginRun", "completeRun", "setReconciliationCooldown"]);
    // No token was resolved and no gateway was built, because nothing needed one.
    expect(harness.gatewaysBuilt).toEqual([]);
  });

  it("builds the gateway from the sponsor's token for an active repository", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).resolves.toMatchObject({ repositoryId: "repo-1" });

    expect(harness.gatewaysBuilt).toEqual(["sponsor-token"]);
    expect(harness.calls).toContain("getGitHubAccessToken");
  });

  it("passes the repository catalogs through the sponsor gateway", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });
    const listIssues = vi.fn().mockResolvedValue([]);
    harness.store.findUsersByGitHubUserIds = async () => [];
    harness.store.materialize = async () => ({ adds: 0, changes: 0, removals: 0 });
    await reconcileRepositoryAsSponsor(harness.store, "repo-1", () => ({
      getRepositoryById: async () => ({
        id: 4242, owner: "example", ownerType: "USER", name: "repository", fullName: "example/repository",
        visibility: "PUBLIC", url: "https://github.com/example/repository", canAdminister: true,
      }),
      listIssues, getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
    }));
    expect(listIssues).toHaveBeenCalledWith({ owner: "example", name: "repository" }, {
      timelineCriticalLabels: new Set([
        "delivered/1", "delivered/2", "delivered/3", "delivered/4", "delivered/5",
        "delivered/6", "delivered/7", "delivered/8", "delivered/9", "delivered/10",
      ]),
      timelineWatchedLabels: new Set(["S", "M", "L"]),
    });
  });

  it("refuses an active repository whose sponsor has no token", async () => {
    const harness = createHarness({ active: true, accessToken: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).rejects.toThrow(/Unable to reconcile repository/i);

    expect(harness.gatewaysBuilt).toEqual([]);
  });

  it("refuses a repository that is not registered at all", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token", repository: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).rejects.toThrow(/not found/i);
  });
});

function createHarness(options: {
  active: boolean;
  accessToken: string | null;
  repository?: ReconciliationRepository | null;
}) {
  const calls: string[] = [];
  const gatewaysBuilt: string[] = [];
  const repository: ReconciliationRepository | null =
    options.repository === undefined
      ? {
          id: "repo-1",
          githubRepositoryId: 4_242,
          ownerName: "example/repository",
          registeredAt: "2030-01-02T03:04:05.678Z",
          active: options.active,
          sponsor: {
            id: "sponsor-1",
            githubUserId: 9_001,
            githubLogin: "sponsor",
            enforcementState: "ACTIVE",
          },
          difficultyScheme: validDifficultyScheme(),
        }
      : options.repository;

  const store = {
    withRepositoryReconciliation: async <T>(_repositoryId: string, work: () => Promise<T>) => work(),
    getRepository: async () => {
      calls.push("getRepository");
      return repository;
    },
    getReconciliationCooldown: async () => null,
    setReconciliationCooldown: async () => {
      calls.push("setReconciliationCooldown");
    },
    getGitHubAccessToken: async () => {
      calls.push("getGitHubAccessToken");
      return options.accessToken;
    },
    beginRun: async () => {
      calls.push("beginRun");
      return "run-1";
    },
    completeRun: async () => {
      calls.push("completeRun");
    },
    failRun: async () => {
      calls.push("failRun");
    },
    materializeRepositoryFold: async () => ({ adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 }),
    markRepositoryUnavailable: async () => {
      calls.push("markRepositoryUnavailable");
    },
    recordVerifiedRepositoryIdentity: async () => {
      calls.push("recordVerifiedRepositoryIdentity");
    },
  } as unknown as ReconciliationStore;

  const createGateway = (accessToken: string): ReconciliationGateway => {
    gatewaysBuilt.push(accessToken);
    return {
      getRepositoryById: async () => null,
      listIssues: async () => [],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
    };
  };

  return { store, createGateway, calls, gatewaysBuilt };
}
