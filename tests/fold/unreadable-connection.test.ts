import { describe, expect, it, vi } from "vitest";
import { reconcileRepository, type ReconciliationDependencies } from "@/lib/fold/reconcile";
import { RECONCILIATION_EVIDENCE_FORMAT } from "@/lib/fold/reconciliation-evidence";
import { GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import { walkReconciliation } from "@/lib/fold/reconciliation-walk";
import { fixture, pullRequest, subject } from "./reconciliation-walk-fixture";
import {
  pagedReconciliationGateway,
  reconciliationDependencies,
  reconciliationIssue,
  reconciliationPullRequest,
} from "../support/reconciliation-fixtures";

// One issue the walk could not fully read — the closing-PR connection, or the
// opening evidence (labels/timeline) — is a discarded unresolvable subject:
// journaled, its dirty row dropped, never failing the run, and priced
// fail-closed without deleting its stored row.

describe("reconcileRepository unreadable issue connections", () => {
  it("completes the run when the walk reports one issue's closing connection unreadable, journaling the marked issue", async () => {
    const marked = { ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [], closingPullRequestsUnreadable: true as const };
    const healthy = { ...reconciliationIssue({ id: 102, number: 2 }), closingPullRequests: [reconciliationPullRequest({ id: 202, number: 12 })] };
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockResolvedValue([marked, healthy]) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=1 reason=UNREADABLE_FIELD",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      // The marked issue stays in the fold input: synchronize deletes any issue
      // absent from it, so dropping the issue would erase the stored row.
      expect(materializeInput.synchronization?.issues.map((issue) => issue.id)).toEqual([101, 102]);
      expect(materializeInput.fold.settlements.map((settlement) => settlement.githubIssueId)).toEqual([102]);
      expect(materializeInput.fold.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "CLOSING_EVIDENCE_UNREADABLE",
        githubPullRequestId: null,
        reason: "The closing pull request connection could not be read, so no settlement derives from closing evidence that was never read.",
      }]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("folds the cached shape when the walk marks a cached issue's closing connection unreadable", async () => {
    const cachedReview = { id: 301, state: "APPROVED" as const, submittedAt: "2026-09-01T11:00:00Z", dismissal: null };
    const cachedIssue = { ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [reconciliationPullRequest({ id: 201, number: 11 })] };
    const marked = { ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [], closingPullRequestsUnreadable: true as const };
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockResolvedValue([marked]) },
    });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date("2030-01-02T10:00:00Z"),
      lastFullPassAt: new Date("2030-01-02T10:00:00Z"),
      omittedOversizedFacts: 0,
      issues: [cachedIssue],
      pullRequests: [{ id: 201, reviews: [cachedReview], rawDiff: "cached diff" }],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [{ kind: "ISSUE" as const, id: 101, number: 1, generation: 7 }];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "ISSUE", githubSubjectId: 101, generation: 7,
      });
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=1 reason=UNREADABLE_FIELD",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      // The cached shape folds, not the marked fresh one: the cached closing
      // evidence, and therefore the prior settlement, re-derives unchanged.
      expect(materializeInput.synchronization?.issues).toEqual([cachedIssue]);
      expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 201, reviews: [cachedReview], rawDiff: "cached diff" }]);
      expect(materializeInput.fold.unwritableClosures).toEqual([]);
      expect(materializeInput.fold.settlements.map((settlement) => settlement.githubIssueId)).toEqual([101]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("folds the marked fresh shape when a walked marked issue has no cached copy", async () => {
    // The cached-keep limb keys on a cached copy existing: with none, the
    // marked fresh shape is what folds, and the fold prices nothing from it.
    const marked = { ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [], closingPullRequestsUnreadable: true as const };
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockResolvedValue([marked]) },
    });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date("2030-01-02T10:00:00Z"),
      lastFullPassAt: new Date("2030-01-02T10:00:00Z"),
      omittedOversizedFacts: 0,
      issues: [],
      pullRequests: [],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=1 reason=UNREADABLE_FIELD",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      expect(materializeInput.synchronization?.issues[0]).toMatchObject({ id: 101, closingPullRequestsUnreadable: true, closingPullRequests: [] });
      expect(materializeInput.fold.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "CLOSING_EVIDENCE_UNREADABLE",
        githubPullRequestId: null,
        reason: "The closing pull request connection could not be read, so no settlement derives from closing evidence that was never read.",
      }]);
      expect(materializeInput.fold.settlements).toEqual([]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails the run without discarding when a dirty issue read answers the typed error for another field path", async () => {
    // The walk-reported marker is data, but the per-subject classifier still
    // keys on the exact closing-connections path: any other invalid field is a
    // whole-run defect and keeps whole-run retry semantics.
    const otherField = new GitHubGraphqlInvalidResponseError(
      "GitHub GraphQL response was invalid. assignees.nodes was not a list.",
      "assignees.nodes",
    );
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async () => {
          throw otherField;
        }),
      },
    });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date(),
      lastFullPassAt: new Date(),
      omittedOversizedFacts: 0,
      issues: [],
      pullRequests: [],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "ISSUE" as const, id: 999, number: 42, generation: 7 },
    ];
    dependencies.store.discardDirtyReconciliationSubject = vi.fn().mockResolvedValue(undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
        message: "Unable to reconcile repository.",
      });
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.discardDirtyReconciliationSubject).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("returns a successful getIssue without the unreadable marker through the real gateway", async () => {
    const gateway = pagedReconciliationGateway([], true);

    const read = await gateway.getIssue({ owner: "octo", name: "example" }, { id: 101, number: 1 });

    // Exact equality on the closing fields pins the marker's ABSENCE on the
    // success limb: the tolerant matcher on the client suite's shape pin would
    // pass a mutant that marked here too.
    expect(read?.closingPullRequests).toEqual([reconciliationPullRequest({ id: 201, number: 11 })]);
    expect(read?.closingPullRequestsUnreadable).toBeUndefined();
    expect(read?.openingEvidenceUnreadable).toBeUndefined();
  });

  it("excludes a walked issue whose opening evidence is unreadable from the fold and keeps its stored row", async () => {
    const marked = {
      ...reconciliationIssue({ id: 101, number: 1 }),
      labels: [] as string[],
      history: [],
      comments: [],
      closingPullRequests: [],
      openingEvidenceUnreadable: true as const,
    };
    const healthy = { ...reconciliationIssue({ id: 102, number: 2 }), closingPullRequests: [reconciliationPullRequest({ id: 202, number: 12 })] };
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockResolvedValue([marked, healthy]) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=1 reason=UNREADABLE_FIELD",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      // The observed set still carries the marked issue; the fold does not.
      expect(materializeInput.synchronization?.issues.map((issue) => issue.id)).toEqual([101, 102]);
      expect(materializeInput.synchronization?.keptIssueGitHubIds).toEqual([101]);
      expect(materializeInput.fold.issues.map((issue) => issue.githubIssueId)).toEqual([102]);
      // No fold row means no false OPENING_* violation for an issue whose only
      // defect was an unreadable read.
      expect(materializeInput.fold.policyViolations).toEqual([]);
      expect(materializeInput.fold.settlements.map((settlement) => settlement.githubIssueId)).toEqual([102]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("folds the cached shape when the walk marks a cached issue's opening evidence unreadable", async () => {
    const cachedIssue = { ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [reconciliationPullRequest({ id: 201, number: 11 })] };
    const marked = {
      ...reconciliationIssue({ id: 101, number: 1 }),
      labels: [] as string[],
      history: [],
      comments: [],
      closingPullRequests: [],
      openingEvidenceUnreadable: true as const,
    };
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockResolvedValue([marked]) },
    });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date("2030-01-02T10:00:00Z"),
      lastFullPassAt: new Date("2030-01-02T10:00:00Z"),
      omittedOversizedFacts: 0,
      issues: [cachedIssue],
      pullRequests: [],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=1 reason=UNREADABLE_FIELD",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      expect(materializeInput.synchronization?.issues).toEqual([cachedIssue]);
      expect(materializeInput.synchronization?.keptIssueGitHubIds).toEqual([]);
      expect(materializeInput.fold.settlements.map((settlement) => settlement.githubIssueId)).toEqual([101]);
    } finally {
      errorLog.mockRestore();
    }
  });

});

// A pull request's own connection the read could not parse — its closing
// references, or its reviews or dismissals evidence — discards that one read
// and that subject's dirty row; the journal names the field, never upstream text.
describe("reconcileRepository unreadable pull request connections", () => {
  const cachedReview = { id: 301, state: "APPROVED" as const, submittedAt: "2026-09-01T11:00:00Z", dismissal: null };
  const closingIssue = () => ({ ...reconciliationIssue({ id: 101, number: 1 }), closingPullRequests: [reconciliationPullRequest({ id: 201, number: 11 })] });
  function incremental(github: Partial<ReconciliationDependencies["github"]>) {
    const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockResolvedValue([]), getIssue: vi.fn().mockResolvedValue(closingIssue()), ...github } });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1, formatVersion: RECONCILIATION_EVIDENCE_FORMAT, checkpoint: new Date(), lastFullPassAt: new Date(), omittedOversizedFacts: 0,
      issues: [closingIssue()], pullRequests: [{ id: 201, reviews: [cachedReview], rawDiff: "cached diff" }],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [{ kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 9 }];
    return dependencies;
  }

  it.each(["closingIssuesReferences.nodes", "closingIssuesReferences.nodes.repository"])(
    "discards a dirty pull request whose closing read's %s is unreadable and still reads its evidence", async (fieldPath) => {
      const dependencies = incremental({
        getPullRequestClosingIssues: vi.fn().mockRejectedValue(new GitHubGraphqlInvalidResponseError("Unreadable closing read", fieldPath)),
        getPullRequestReviews: vi.fn().mockResolvedValue([]),
      });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(dependencies.store.discardDirtyReconciliationSubject).toHaveBeenCalledExactlyOnceWith({
          repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 9,
        });
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(
          `Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=UNREADABLE_FIELD field=${fieldPath}`,
        );
        // The issue already naming the pull request is still reread, and the pull request's evidence still read fresh.
        expect(vi.mocked(dependencies.github.getIssue).mock.calls.map(([, issue]) => issue.id)).toEqual([101]);
        expect(dependencies.github.getPullRequestReviews).toHaveBeenCalledWith(expect.anything(), 11);
        const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
        expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 201, reviews: [], rawDiff: "diff" }]);
      } finally {
        errorLog.mockRestore();
      }
    });

  it.each(["reviews.nodes", "timelineItems.nodes"])(
    "discards a dirty pull request whose evidence read's %s is unreadable, keeping its cached evidence", async (fieldPath) => {
      const dependencies = incremental({
        getPullRequestReviews: vi.fn().mockRejectedValue(new GitHubGraphqlInvalidResponseError("Unreadable evidence read", fieldPath)),
      });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(dependencies.store.discardDirtyReconciliationSubject).toHaveBeenCalledExactlyOnceWith({
          repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 9,
        });
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(
          `Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=UNREADABLE_FIELD field=${fieldPath}`,
        );
        const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
        expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 201, reviews: [cachedReview], rawDiff: "cached diff" }]);
      } finally {
        errorLog.mockRestore();
      }
    });

  // Classification keys on the read: a field path another read owns (or no
  // pull request read owns) keeps whole-run retry semantics.
  it.each([
    ["closing", "assignees.nodes"], ["closing", "reviews.nodes"], ["closing", "timelineItems.nodes"],
    ["evidence", "assignees.nodes"], ["evidence", "closingIssuesReferences.nodes"], ["evidence", "closingIssuesReferences.nodes.repository"],
  ] as const)("fails the run without discarding when a %s read answers the typed error for %s", async (read, fieldPath) => {
    const failure = new GitHubGraphqlInvalidResponseError("Unrelated field", fieldPath);
    const dependencies = incremental(read === "closing"
      ? { getPullRequestClosingIssues: vi.fn().mockRejectedValue(failure) }
      : { getPullRequestReviews: vi.fn().mockRejectedValue(failure) });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({ message: "Unable to reconcile repository." });
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.discardDirtyReconciliationSubject).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("journals the field when the sweep walk discards a pull request's unreadable closing read", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(2)];
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => {
      throw new GitHubGraphqlInvalidResponseError("Unreadable closing read", "closingIssuesReferences.nodes");
    });
    f.pass.dirtySubjects = [{ kind: "PULL_REQUEST", id: 2, number: 2, generation: 3 }];
    const dependencies = reconciliationDependencies({
      github: { walkReconciliation: (_reference, input) => walkReconciliation({ ...input, listing: f.listing, gateway: f.gateway }) },
    });
    dependencies.sweep = { spend: async () => null, discardPass: async () => {}, openPass: async () => f.pass };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).resolves.toMatchObject({ skipped: false });
      expect(dependencies.store.discardDirtyReconciliationSubject).toHaveBeenCalledExactlyOnceWith({
        repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 2, generation: 3,
      });
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=2 reason=UNREADABLE_FIELD field=closingIssuesReferences.nodes",
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
