import { describe, expect, it, vi } from "vitest";
import {
  reconcileRepository,
  type ReconciliationDependencies,
} from "@/lib/fold/reconcile";
import { runReconciliationCli } from "../../scripts/reconcile";

describe("reconcileRepository", () => {
  it("builds a complete authoritative snapshot from GraphQL closing PR references and reports deltas", async () => {
    const materialize = vi.fn().mockResolvedValue({ adds: 2, changes: 1, removals: 3 });
    const dependencies = reconciliationDependencies({ materialize });

    const summary = await reconcileRepository(dependencies, "repository");

    expect(summary).toMatchObject({
      repositoryId: "repository",
      adds: 2,
      changes: 1,
      removals: 3,
    });
    expect(dependencies.github.getIssueClosingPullRequests).toHaveBeenCalledWith(
      { owner: "octo", name: "example" },
      1,
    );
    expect(dependencies.github.getPullRequestReviews).toHaveBeenCalledWith(
      { owner: "octo", name: "example" },
      11,
    );
    expect(dependencies.github.getPullRequestDiff).toHaveBeenCalledWith(
      { owner: "octo", name: "example" },
      11,
    );
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repository",
        fold: expect.objectContaining({
          settlements: [expect.objectContaining({ proofSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })],
        }),
      }),
    );
  });

  it("converges when a full reconciliation is repeated after missed or reordered webhook deliveries", async () => {
    const materialize = vi.fn().mockResolvedValue({ adds: 0, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({ materialize });

    const first = await reconcileRepository(dependencies, "repository");
    const second = await reconcileRepository(dependencies, "repository");

    expect(first).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    expect(second).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    expect(materialize.mock.calls[0]?.[0].fold).toEqual(materialize.mock.calls[1]?.[0].fold);
  });

  it("records a sanitized failed reconciliation run instead of an upstream error message", async () => {
    const dependencies = reconciliationDependencies({
      github: {
        listIssues: vi.fn().mockRejectedValue(new Error("token=secret should not be persisted")),
      },
    });

    await expect(reconcileRepository(dependencies, "repository")).rejects.toThrow(
      "Unable to reconcile repository.",
    );

    expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.");
  });

  it.each(["WARNED", "UNDER_AUDIT"] as const)(
    "reconciles a repository sponsored by a %s account",
    async (enforcementState) => {
      const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
      const dependencies = reconciliationDependencies({ materialize });
      const repository = await dependencies.store.getRepository("repository");
      repository!.sponsor.enforcementState = enforcementState;
      (dependencies.store.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({
        adds: 1,
        changes: 0,
        removals: 0,
      });
      expect(dependencies.github.listIssues).toHaveBeenCalledWith({ owner: "octo", name: "example" });
      expect(materialize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["an inactive repository", (repository: { active: boolean; sponsor: { enforcementState: string } }) => { repository.active = false; }],
    ["a banned sponsor", (repository: { active: boolean; sponsor: { enforcementState: string } }) => { repository.sponsor.enforcementState = "BANNED"; }],
    ["a recalibrating sponsor", (repository: { active: boolean; sponsor: { enforcementState: string } }) => { repository.sponsor.enforcementState = "RECALIBRATING"; }],
  ])("records a no-op run for %s without deleting historical settlements", async (_name, change) => {
    const dependencies = reconciliationDependencies();
    const repository = await dependencies.store.getRepository("repository");
    change(repository!);
    (dependencies.store.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

    const summary = await reconcileRepository(dependencies, "repository");

    expect(summary).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    expect(dependencies.github.listIssues).not.toHaveBeenCalled();
    expect(dependencies.store.materialize).not.toHaveBeenCalled();
    expect(dependencies.store.completeRun).toHaveBeenCalledWith("run-1");
  });

  it("reconciles exactly one owner/name repository or every active repository through the same path", async () => {
    const reconcile = vi.fn().mockResolvedValue({ repositoryId: "repository", adds: 0, changes: 0, removals: 0 });
    const store = {
      findRepositoryByOwnerName: vi.fn().mockResolvedValue({ id: "repository" }),
      listActiveRepositoryIds: vi.fn().mockResolvedValue(["repository", "repository-2"]),
    };
    const write = vi.fn();

    await runReconciliationCli(["--repository", "octo/example"], { store, reconcile, write });
    await runReconciliationCli([], { store, reconcile, write });

    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(reconcile).toHaveBeenNthCalledWith(1, "repository");
    expect(reconcile).toHaveBeenNthCalledWith(2, "repository");
    expect(reconcile).toHaveBeenNthCalledWith(3, "repository-2");
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"repositoryId":"repository"'));
  });

  it("rejects malformed CLI arguments instead of broadening a scoped reconciliation", async () => {
    const dependencies = {
      store: {
        findRepositoryByOwnerName: vi.fn(),
        listActiveRepositoryIds: vi.fn(),
      },
      reconcile: vi.fn(),
      write: vi.fn(),
    };

    await expect(runReconciliationCli(["--repository", "octo/example", "unexpected"], dependencies)).rejects.toThrow(
      "Usage: pnpm reconcile [--repository owner/name]",
    );
    await expect(runReconciliationCli(["--repository", "not/a/repository/path"], dependencies)).rejects.toThrow(
      "Usage: pnpm reconcile [--repository owner/name]",
    );
  });
});

function reconciliationDependencies(
  overrides: Partial<{
    materialize: ReturnType<typeof vi.fn>;
    github: Partial<ReconciliationDependencies["github"]>;
  }> = {},
): ReconciliationDependencies & {
  github: Required<ReconciliationDependencies["github"]>;
  store: ReconciliationDependencies["store"] & {
    failRun: ReturnType<typeof vi.fn>;
    completeRun: ReturnType<typeof vi.fn>;
  };
} {
  const github = {
    listIssues: vi.fn().mockResolvedValue([
      {
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        labels: ["M"],
      },
    ]),
    getIssueClosingPullRequests: vi.fn().mockResolvedValue([
      {
        id: 201,
        number: 11,
        title: "Pull request",
        body: "Pull request body",
        url: "https://github.com/octo/example/pull/11",
        state: "MERGED",
        mergedAt: "2026-09-01T12:00:00.000Z",
        authorLogin: "contributor",
        labels: ["delivered/6"],
      },
    ]),
    getPullRequestReviews: vi.fn().mockResolvedValue([]),
    getPullRequestDiff: vi.fn().mockResolvedValue("diff"),
    ...overrides.github,
  };
  const failRun = vi.fn().mockResolvedValue(undefined);
  const store = {
    getRepository: vi.fn().mockResolvedValue({
      id: "repository",
      ownerName: "octo/example",
      active: true,
      sponsor: { id: "sponsor", githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    }),
    getGitHubAccessToken: vi.fn().mockResolvedValue("token"),
    listExistingIssues: vi.fn().mockResolvedValue([]),
    findUsersByGitHubLogins: vi.fn().mockResolvedValue([
      { id: "sponsor", githubLogin: "sponsor", enforcementState: "ACTIVE" },
      { id: "contributor", githubLogin: "contributor", enforcementState: "ACTIVE" },
    ]),
    beginRun: vi.fn().mockResolvedValue("run-1"),
    completeRun: vi.fn().mockResolvedValue(undefined),
    materialize: overrides.materialize ?? vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 }),
    failRun,
  };

  return { store, github } as ReconciliationDependencies & {
    github: Required<ReconciliationDependencies["github"]>;
    store: ReconciliationDependencies["store"] & {
      failRun: ReturnType<typeof vi.fn>;
      completeRun: ReturnType<typeof vi.fn>;
    };
  };
}
