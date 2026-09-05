import { describe, expect, it, vi } from "vitest";
import {
  reconcileRepository,
  type ReconciliationDeltas,
  type ReconciliationDependencies,
} from "@/lib/fold/reconcile";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { GitHubGateway } from "@/lib/github/client";
import { createHash } from "node:crypto";
import { GitHubApiError } from "@/lib/github/errors";
import { runReconciliationCli } from "../../scripts/reconcile";
import { assertClosingPullRequestQuery } from "../support/closing-pull-request-query";

describe("reconcileRepository", () => {
  it("bounds in-flight gateway calls for many merged closing pull requests", async () => {
    const pullRequestCount = 24;
    const issues = Array.from({ length: pullRequestCount }, (_, index) => ({
      ...reconciliationIssue({ id: 101 + index, number: 1 + index }),
      closingPullRequests: [reconciliationPullRequest({ id: 201 + index, number: 101 + index })],
    }));
    const gates = Array.from({ length: 1 + pullRequestCount * 2 }, () => deferredCall());
    const started = gates.map(() => deferredCall());
    const calls: Array<{ operation: string; number?: number }> = [];
    let active = 0;
    let highWaterMark = 0;
    const record = async <T>(operation: string, value: T, number?: number): Promise<T> => {
      const index = calls.length;
      calls.push({ operation, number });
      active += 1;
      highWaterMark = Math.max(highWaterMark, active);
      started[index].resolve();
      await gates[index].promise;
      active -= 1;
      return value;
    };
    const materialize = vi.fn().mockResolvedValue({ adds: pullRequestCount, changes: 0, removals: 0 });
    const { store } = reconciliationDependencies({ materialize });
    const result = reconcileRepository({
      store,
      github: {
        listIssues: () => record("issues", issues),
        getPullRequestReviews: (_repository, number) => record("reviews", [], number),
        getPullRequestDiff: (_repository, number) => record("diff", `diff ${number}`, number),
      },
    }, "repository");

    for (let index = 0; index < gates.length; index += 1) {
      await started[index].promise;
      gates[index].resolve();
    }
    await result;

    expect(highWaterMark).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(calls.filter(({ operation }) => operation === "issues")).toHaveLength(1);
    for (const operation of ["reviews", "diff"]) {
      expect(calls.filter((call) => call.operation === operation).map(({ number }) => number).sort((a, b) => a! - b!))
        .toEqual(issues.map((issue) => issue.closingPullRequests[0].number));
    }
    expect(materialize.mock.calls[0]![0].fold.settlements).toHaveLength(pullRequestCount);
  });

  it("reconciles closing references with exactly one GraphQL request per issue page", async () => {
    const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 3, changes: 0, removals: 0 });
    const github = pagedReconciliationGateway(requests, false);
    const { store } = reconciliationDependencies({ materialize });

    await reconcileRepository({ store, github }, "repository");

    expect(materialize.mock.calls[0]![0].fold.issues.map((issue: { githubIssueId: number }) => issue.githubIssueId))
      .toEqual([101, 102, 103]);
    expect(requests).toEqual([
      { operation: "RepositoryIssues", variables: { owner: "octo", name: "example", cursor: null } },
      { operation: "RepositoryIssues", variables: { owner: "octo", name: "example", cursor: "issues-next" } },
    ]);
  });

  it("preserves the complete fold and ordering for a fixed paged fixture with merged closing references", async () => {
    const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 3, changes: 0, removals: 0 });
    const { store } = reconciliationDependencies({ materialize });
    await reconcileRepository({ store, github: pagedReconciliationGateway(requests, true) }, "repository");
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.issues.map((issue) => issue.githubIssueId)).toEqual([101, 102, 103]);
    expect(fold.pullRequests.map((pullRequest) => pullRequest.githubPullRequestId)).toEqual([201, 202, 203]);
    expect(fold.settlements.map((settlement) => [settlement.githubIssueId, settlement.githubPullRequestId]))
      .toEqual([[101, 201], [102, 202], [103, 203]]);
    // Captured from the pre-batching implementation at commit 136449c.
    expect(createHash("sha256").update(JSON.stringify(fold)).digest("hex")).toBe("0ac5072d7c8aeb9d42841698ee8b121f5425ad718a26bd8a9cb587f430ba2796");
  });

  it("settles from the only merged closing reference on the second continuation", async () => {
    const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 3, changes: 0, removals: 0 });
    const { store } = reconciliationDependencies({ materialize });
    await reconcileRepository({ store, github: pagedReconciliationGateway(requests, true, 121) }, "repository");

    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.settlements.map(({ githubIssueId, githubPullRequestId, status, credits }) => (
      [githubIssueId, githubPullRequestId, status, credits]
    ))).toEqual([[101, 201, "SETTLED", 6], [102, 202, "SETTLED", 6], [103, 203, "SETTLED", 6]]);
    expect(fold.ledgerEntries.map(({ accountId, amount }) => [accountId, amount])).toEqual([
      ["contributor", 6], ["sponsor", -6],
      ["contributor", 6], ["sponsor", -6],
      ["contributor", 6], ["sponsor", -6],
    ]);
    // The 120 unmerged references per issue must not alter any part of the baseline fold.
    expect(createHash("sha256").update(JSON.stringify(fold)).digest("hex")).toBe("0ac5072d7c8aeb9d42841698ee8b121f5425ad718a26bd8a9cb587f430ba2796");
    expect(requests.filter(({ operation }) => operation === "ClosingPullRequests")).toEqual([
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 3, cursor: "closing-3-next" } },
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 3, cursor: "closing-3-last" } },
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 1, cursor: "closing-1-next" } },
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 1, cursor: "closing-1-last" } },
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 2, cursor: "closing-2-next" } },
      { operation: "ClosingPullRequests", variables: { owner: "octo", name: "example", issueNumber: 2, cursor: "closing-2-last" } },
    ]);
  });

  it("builds a complete authoritative snapshot from GraphQL closing PR references and reports deltas", async () => {
    const materialize = vi.fn().mockResolvedValue({ adds: 2, changes: 1, removals: 3 });
    const dependencies = reconciliationDependencies({ materialize });

    const summary = await reconcileRepository(dependencies, "repository");

    expect(dependencies.store.findUsersByGitHubUserIds).toHaveBeenCalledWith([2001]);
    expect(summary).toMatchObject({
      repositoryId: "repository",
      adds: 2,
      changes: 1,
      removals: 3,
    });
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
          settlements: [expect.objectContaining({ creditorId: "contributor", creditorGitHubUserId: 2001, proofSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })],
          pullRequests: [expect.objectContaining({ authorId: "contributor", authorGitHubUserId: 2001 })],
        }),
      }),
    );
  });

  it("looks up distinct author ids once and excludes authors without an id", async () => {
    const dependencies = reconciliationDependencies({
      github: {
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [
            reconciliationPullRequest({ id: 201, number: 11 }),
            { ...reconciliationPullRequest({ id: 202, number: 12 }), authorGitHubUserId: 3001 },
            reconciliationPullRequest({ id: 203, number: 13 }),
            { ...reconciliationPullRequest({ id: 204, number: 14 }), authorGitHubUserId: null },
          ],
        }]),
      },
    });

    await reconcileRepository(dependencies, "repository");

    expect(dependencies.store.findUsersByGitHubUserIds).toHaveBeenCalledExactlyOnceWith([2001, 3001]);
  });

  it.each([false, true])("preserves every author's identity across reconciliation (reverse order: %s)", async (reverse) => {
    const issues = [
      reconciliationIssue({ id: 101, number: 1 }),
      reconciliationIssue({ id: 102, number: 2 }),
      reconciliationIssue({ id: 103, number: 3 }),
    ];
    const pullRequests = new Map([
      [1, [{ ...reconciliationPullRequest({ id: 201, number: 11 }), authorLogin: "alice" }]],
      [2, [{ ...reconciliationPullRequest({ id: 202, number: 12 }), authorLogin: "bob", authorGitHubUserId: 3001 }]],
      [3, [{ ...reconciliationPullRequest({ id: 203, number: 13 }), authorLogin: "release-bot[bot]", authorGitHubUserId: null }]],
    ]);
    const materialize = vi.fn().mockResolvedValue({ adds: 3, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        listIssues: vi.fn().mockResolvedValue((reverse ? [...issues].reverse() : issues).map((issue) => ({
          ...issue, closingPullRequests: pullRequests.get(issue.number) ?? [],
        }))),
      },
    });
    dependencies.store.findUsersByGitHubUserIds = vi.fn().mockResolvedValue([
      { id: "alice-member", githubUserId: 2001, githubLogin: "alice", enforcementState: "ACTIVE" },
      { id: "bob-member", githubUserId: 3001, githubLogin: "bob", enforcementState: "ACTIVE" },
    ]);

    await reconcileRepository(dependencies, "repository");

    expect(materialize.mock.calls[0]?.[0].fold.ledgerEntries).toHaveLength(4);
    expect(materialize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      fold: expect.objectContaining({
        settlements: [
          expect.objectContaining({ githubIssueId: 101, creditorId: "alice-member", creditorGitHubUserId: 2001, status: "SETTLED", credits: 6 }),
          expect.objectContaining({ githubIssueId: 102, creditorId: "bob-member", creditorGitHubUserId: 3001, status: "SETTLED", credits: 6 }),
          expect.objectContaining({ githubIssueId: 103, creditorId: null, creditorGitHubUserId: null, status: "UNCLAIMED", credits: 6 }),
        ],
        pullRequests: [
          expect.objectContaining({ githubPullRequestId: 201, authorId: "alice-member", authorGitHubUserId: 2001 }),
          expect.objectContaining({ githubPullRequestId: 202, authorId: "bob-member", authorGitHubUserId: 3001 }),
          expect.objectContaining({ githubPullRequestId: 203, authorId: null, authorGitHubUserId: null }),
        ],
        ledgerEntries: expect.arrayContaining([
          { accountId: "alice-member", counterpartyId: "sponsor", amount: 6 },
          { accountId: "sponsor", counterpartyId: "alice-member", amount: -6 },
          { accountId: "bob-member", counterpartyId: "sponsor", amount: 6 },
          { accountId: "sponsor", counterpartyId: "bob-member", amount: -6 },
        ]),
      }),
    }));
  });

  it("converges when a full reconciliation is repeated after missed or reordered webhook deliveries", async () => {
    const materializer = new StatefulSettlementMaterializer(new Map([
      [101, "stale settlement for the first authoritative issue"],
      [999, "obsolete settlement from a missed webhook delivery"],
    ]));
    const snapshots = [
      {
        issues: [
          reconciliationIssue({ id: 101, number: 1 }),
          reconciliationIssue({ id: 102, number: 2 }),
        ],
        closingPullRequests: new Map([
          [1, [reconciliationPullRequest({ id: 201, number: 11 })]],
          [2, [reconciliationPullRequest({ id: 202, number: 12 })]],
        ]),
      },
      {
        issues: [
          reconciliationIssue({ id: 102, number: 2 }),
          reconciliationIssue({ id: 101, number: 1 }),
        ],
        closingPullRequests: new Map([
          [2, [reconciliationPullRequest({ id: 202, number: 12 })]],
          [1, [reconciliationPullRequest({ id: 201, number: 11 })]],
        ]),
      },
    ];
    let snapshotIndex = 0;
    const materialize = vi.fn((input: { repositoryId: string; runId: string; fold: FoldResult }) => (
      materializer.materialize(input)
    ));
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        listIssues: vi.fn(async () => {
          const snapshot = snapshots[snapshotIndex];
          snapshotIndex += 1;
          if (snapshot === undefined) {
            throw new Error("No authoritative reconciliation snapshot remained.");
          }
          return snapshot.issues.map((issue) => ({
            ...issue, closingPullRequests: snapshot.closingPullRequests.get(issue.number) ?? [],
          }));
        }),
      },
    });

    const first = await reconcileRepository(dependencies, "repository");
    const canonicalStateAfterFirstRun = materializer.snapshot();
    const second = await reconcileRepository(dependencies, "repository");

    expect(first).toMatchObject({ adds: 1, changes: 1, removals: 1 });
    expect(canonicalStateAfterFirstRun.map(([githubIssueId]) => githubIssueId)).toEqual([101, 102]);
    expect(second).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    expect(materialize.mock.calls[0]?.[0].fold).toEqual(materialize.mock.calls[1]?.[0].fold);
    expect(materializer.snapshot()).toEqual(canonicalStateAfterFirstRun);
  });

  it("records a sanitized failed run while logging and propagating the cause", async () => {
    const upstream = new Error("token=secret should not be persisted");
    const dependencies = reconciliationDependencies({
      github: {
        listIssues: vi.fn().mockRejectedValue(upstream),
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failure = await reconcileRepository(dependencies, "repository").then(
        () => {
          throw new Error("Reconciliation was expected to fail.");
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Unable to reconcile repository.");
      expect((failure as Error).cause).toBe(upstream);
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.");
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", upstream);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a GitHub response body in the logged cause and out of the stored failure", async () => {
    const body = "secondary rate limit at https://github.com/?token=sponsor-secret";
    const upstream = new GitHubApiError(403, true, null, body);
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockRejectedValue(upstream) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
        message: "Unable to reconcile repository.",
        cause: upstream,
      });
      expect(dependencies.store.failRun.mock.calls).toEqual([["run-1", "Reconciliation failed."]]);
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", upstream);
      expect(upstream.body).toBe(body);
    } finally {
      errorLog.mockRestore();
    }
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

  it("records a no-op run for an inactive repository without deleting historical settlements", async () => {
    const dependencies = reconciliationDependencies();
    const repository = await dependencies.store.getRepository("repository");
    repository!.active = false;
    (dependencies.store.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

    const summary = await reconcileRepository(dependencies, "repository");

    expect(summary).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    expect(dependencies.github.listIssues).not.toHaveBeenCalled();
    expect(dependencies.store.materialize).not.toHaveBeenCalled();
    expect(dependencies.store.completeRun).toHaveBeenCalledWith("run-1");
  });

  it.each(["BANNED", "RECALIBRATING"] as const)(
    "rebuilds work that was eligible when merged after the sponsor becomes %s",
    async (enforcementState) => {
      const dependencies = reconciliationDependencies();
      const repository = await dependencies.store.getRepository("repository");
      repository!.sponsor.enforcementState = enforcementState;
      repository!.sponsor.moderationEvents = [{
        id: `event-${enforcementState}`,
        priorState: "ACTIVE",
        newState: enforcementState,
        occurredAt: "2026-09-02T00:00:00.000Z",
      }];
      (dependencies.store.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({
        adds: 1,
        changes: 0,
        removals: 0,
      });
      expect(dependencies.store.materialize).toHaveBeenCalledWith(expect.objectContaining({
        fold: expect.objectContaining({ settlements: [expect.objectContaining({ credits: 6 })] }),
      }));
    },
  );

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

function deferredCall() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            body: "Pull request body",
            url: "https://github.com/octo/example/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: "contributor",
            authorGitHubUserId: 2001,
          },
        ],
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        createdAt: "2026-09-01T08:00:00.000Z",
        authorLogin: "sponsor",
        labels: ["M", "delivered/6"],
        claimAssigneeGitHubLogin: "contributor",
        history: [
          { kind: "LABELED", id: "opening-101", actorLogin: "sponsor", createdAt: "2026-09-01T08:01:00.000Z", label: "M" },
          { kind: "ASSIGNED", id: "assigned-101", actorLogin: "sponsor", createdAt: "2026-09-01T09:00:00.000Z", assigneeLogin: "contributor" },
          { kind: "LABELED", id: "actual-101", actorLogin: "sponsor", createdAt: "2026-09-01T11:00:00.000Z", label: "delivered/6" },
        ],
        comments: [{
          id: "comment-101",
          databaseId: 301,
          authorLogin: "sponsor",
          body: "Settled as delivered/6.",
          createdAt: "2026-09-01T11:30:00.000Z",
          lastEditedAt: null,
        }],
      },
    ]),
    getPullRequestReviews: vi.fn().mockResolvedValue([]),
    getPullRequestDiff: vi.fn().mockResolvedValue("diff"),
    ...overrides.github,
  };
  const failRun = vi.fn().mockResolvedValue(undefined);
  const store = {
    withRepositoryReconciliation: vi.fn(async <T>(_repositoryId: string, work: () => Promise<T>) => work()),
    getRepository: vi.fn().mockResolvedValue({
      id: "repository",
      ownerName: "octo/example",
      active: true,
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    }),
    getGitHubAccessToken: vi.fn().mockResolvedValue("token"),
    findUsersByGitHubUserIds: vi.fn().mockResolvedValue([
      { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE" },
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

class StatefulSettlementMaterializer {
  public constructor(private state: Map<number, string>) {}

  public async materialize(input: { fold: FoldResult }): Promise<ReconciliationDeltas> {
    const desired = new Map(
      input.fold.settlements.map((settlement) => [settlement.githubIssueId, JSON.stringify(settlement)]),
    );
    let adds = 0;
    let changes = 0;
    let removals = 0;

    for (const [githubIssueId, desiredState] of desired) {
      const existingState = this.state.get(githubIssueId);
      if (existingState === undefined) {
        adds += 1;
      } else if (existingState !== desiredState) {
        changes += 1;
      }
    }
    for (const githubIssueId of this.state.keys()) {
      if (!desired.has(githubIssueId)) {
        removals += 1;
      }
    }
    this.state = desired;
    return { adds, changes, removals };
  }

  public snapshot(): Array<[number, string]> {
    return [...this.state.entries()].sort(([left], [right]) => left - right);
  }
}

function reconciliationIssue(input: { id: number; number: number }) {
  return {
    id: input.id,
    number: input.number,
    title: `Issue ${input.number}`,
    body: `Issue ${input.number} body`,
    url: `https://github.com/octo/example/issues/${input.number}`,
    state: "CLOSED" as const,
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: "sponsor",
    labels: ["M", "delivered/6"],
    claimAssigneeGitHubLogin: "contributor",
    history: [
      { kind: "LABELED" as const, id: `opening-${input.id}`, actorLogin: "sponsor", createdAt: "2026-09-01T08:01:00.000Z", label: "M" },
      { kind: "ASSIGNED" as const, id: `assigned-${input.id}`, actorLogin: "sponsor", createdAt: "2026-09-01T09:00:00.000Z", assigneeLogin: "contributor" },
      { kind: "LABELED" as const, id: `actual-${input.id}`, actorLogin: "sponsor", createdAt: "2026-09-01T11:00:00.000Z", label: "delivered/6" },
    ],
    comments: [{
      id: `comment-${input.id}`,
      databaseId: input.id + 10_000,
      authorLogin: "sponsor",
      body: "Settled as delivered/6.",
      createdAt: "2026-09-01T11:30:00.000Z",
      lastEditedAt: null,
    }],
  };
}

function reconciliationPullRequest(input: { id: number; number: number }) {
  return {
    id: input.id,
    number: input.number,
    title: `Pull request ${input.number}`,
    body: `Pull request ${input.number} body`,
    url: `https://github.com/octo/example/pull/${input.number}`,
    state: "MERGED" as const,
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: `${input.id.toString(16).padStart(40, "0")}`,
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: "contributor",
    authorGitHubUserId: 2001,
  };
}

function pagedReconciliationGateway(
  requests: Array<{ operation: string; variables: Record<string, unknown> }>,
  merged: boolean,
  closingReferenceCount: 1 | 121 = 1,
): GitHubGateway {
  const pageInfo = { hasNextPage: false, endCursor: null };
  const pullRequestNode = (number: number) => {
    const pullRequest = reconciliationPullRequest({ id: 200 + number, number: 10 + number });
    return {
      ...pullRequest,
      databaseId: pullRequest.id,
      state: merged ? "MERGED" : "OPEN",
      mergedAt: merged ? pullRequest.mergedAt : null,
      mergeCommit: merged ? { oid: pullRequest.mergeCommitOid } : null,
      commits: { nodes: [{ commit: { committedDate: pullRequest.finalCommitAt } }] },
      author: { __typename: "User", login: pullRequest.authorLogin, databaseId: pullRequest.authorGitHubUserId },
    };
  };
  const closingReferences = (number: number) => [
    ...Array.from({ length: closingReferenceCount - 1 }, (_, index) => ({
      ...pullRequestNode(number),
      databaseId: 10_000 + number * 1000 + index,
      number: 1000 + number * 1000 + index,
      url: `https://github.com/octo/example/pull/${1000 + number * 1000 + index}`,
      state: "CLOSED",
      mergedAt: null,
      mergeCommit: null,
    })),
    pullRequestNode(number),
  ];
  return new GitHubGateway({
    accessToken: "test-token",
    fetch: async (input, init) => {
      if (String(input).endsWith("/graphql")) {
        const { query, variables } = JSON.parse(String(init?.body));
        const operation = /query (\w+)/.exec(query)![1]!;
        requests.push({ operation, variables });
        if (operation === "RepositoryIssues") {
          assertClosingPullRequestQuery(query, operation);
          if (variables.cursor !== null && variables.cursor !== "issues-next") {
            throw new Error(`Unmodeled issue cursor: ${variables.cursor}`);
          }
          const numbers = variables.cursor === null ? [3, 1] : [2];
          const nodes = numbers.map((number) => {
            const issue = reconciliationIssue({ id: 100 + number, number });
            return {
              ...issue,
              databaseId: issue.id,
              author: { login: issue.authorLogin },
              labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo },
              assignees: { nodes: [{ login: "contributor" }] },
              timelineItems: {
                nodes: [
                  ...issue.history.map((event) => ({
                    ...event,
                    __typename: event.kind === "ASSIGNED" ? "AssignedEvent" : "LabeledEvent",
                    actor: { login: event.actorLogin },
                    label: { name: event.label },
                    assignee: { login: event.assigneeLogin },
                  })),
                  ...issue.comments.map((comment) => ({
                    ...comment, __typename: "IssueComment", author: { login: comment.authorLogin },
                  })),
                ],
                pageInfo,
              },
              closedByPullRequestsReferences: {
                nodes: closingReferences(number).slice(0, 20),
                pageInfo: closingReferenceCount === 121
                  ? { hasNextPage: true, endCursor: `closing-${number}-next` }
                  : pageInfo,
              },
            };
          });
          return Response.json({ data: { repository: { issues: {
            nodes,
            pageInfo: variables.cursor === null ? { hasNextPage: true, endCursor: "issues-next" } : pageInfo,
          } } } });
        }
        if (operation === "ClosingPullRequests") {
          assertClosingPullRequestQuery(query, operation);
          const { issueNumber, cursor } = variables;
          const modeledCursors: Array<string | null> = closingReferenceCount === 1
            ? [null]
            : [`closing-${issueNumber}-next`, `closing-${issueNumber}-last`];
          if (![1, 2, 3].includes(issueNumber) ||
              !modeledCursors.includes(cursor)) {
            throw new Error(`Unmodeled closing-reference request: ${JSON.stringify(variables)}`);
          }
          const start = cursor === null ? 0 : cursor === `closing-${issueNumber}-next` ? 20 : 120;
          return Response.json({ data: { repository: { issue: {
            closedByPullRequestsReferences: {
              nodes: closingReferences(issueNumber).slice(start, start + 100),
              pageInfo: start + 100 < closingReferenceCount
                ? { hasNextPage: true, endCursor: `closing-${issueNumber}-last` }
                : pageInfo,
            },
          } } } });
        }
        if (operation === "PullRequestReviews") {
          return Response.json({ data: { repository: { pullRequest: { reviews: { nodes: [], pageInfo } } } } });
        }
        throw new Error(`Unexpected operation ${operation}`);
      }
      return new Response("diff");
    },
  });
}
