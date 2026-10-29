import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RECONCILIATION_COOLDOWN_SECONDS,
  FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE,
  reconcileRepository,
  type ReconciliationDeltas,
  type ReconciliationDependencies,
  type ReconciliationGateway,
} from "@/lib/fold/reconcile";
import { ForgeCredentialRejectedError } from "@/lib/forge/gateway";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { RECONCILIATION_EVIDENCE_FORMAT } from "@/lib/fold/reconciliation-evidence";
import { GitHubGateway } from "@/lib/github/client";
import { CLOSING_PULL_REQUESTS_FIELD_PATH } from "@/lib/github/drain-issue-reads";
import type { GitHubRepository, GitHubRepositoryReference, GitHubSubject } from "@/lib/github/types";
import { createHash } from "node:crypto";
import { GitHubApiError, GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import { GitHubResponseTooLargeError, MAX_SUCCESS_BODY_BYTES } from "@/lib/github/response-text";
import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import { errorLogToken, logField } from "@/lib/webhooks/log-field";
import { runReconciliationCli } from "../../scripts/reconcile";
import { reconciliationDependencies, reconciliationIssue, reconciliationPullRequest, pagedReconciliationGateway, verifiedRepository } from "../support/reconciliation-fixtures";
import { assertClosingPullRequestQuery } from "../support/closing-pull-request-query";
import { verifiedRepositoryPayload } from "../support/verified-repository";
import { inspect, format } from "node:util";
import { walkReconciliation } from "@/lib/fold/reconciliation-walk";
import { fixture, instant, issue, pullRequest, subject } from "./reconciliation-walk-fixture";
import { RECORD_MARKER, withRecordBearingPostgresWrite } from "../support/record-bearing-postgres-error";

describe("reconcileRepository", () => {
  it.each(["WEBHOOK", "REGISTRATION", "REDERIVATION", "OVERRIDE"] as const)("leaves a missing cache for the sweep on %s", async (reason) => {
    const dependencies = reconciliationDependencies();
    dependencies.store.getGitHubAccessToken = async () => null;
    const result = await reconcileRepository(dependencies, "repository", { reason, rederive: true });
    expect(result.skipped).toBe(true);
    expect(dependencies.github.getRepositoryById).not.toHaveBeenCalled();
    expect(dependencies.store.materialize).not.toHaveBeenCalled();
  });

  it.each(["old-format", "omitted", "stale", "rederive"] as const)("gates the %s full-pass trigger on a webhook", async (trigger) => {
    const dependencies = reconciliationDependencies();
    const at = new Date("2030-01-02T10:00:00Z");
    dependencies.now = () => at;
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1, formatVersion: trigger === "old-format" ? 0 : RECONCILIATION_EVIDENCE_FORMAT,
      omittedOversizedFacts: trigger === "omitted" ? 1 : 0,
      checkpoint: at, lastFullPassAt: trigger === "stale" ? new Date("2030-01-01T00:00:00Z") : at, issues: [], pullRequests: [],
    });
    const result = await reconcileRepository(dependencies, "repository", { reason: "WEBHOOK", rederive: trigger === "rederive" });
    if (trigger === "old-format" || trigger === "omitted") {
      expect(result.skipped).toBe(true);
      expect(dependencies.github.listIssues).not.toHaveBeenCalled();
    } else {
      expect(result.skipped).toBe(false);
      expect(dependencies.github.listIssues).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ since: "2030-01-02T09:59:00.000Z" }));
      expect(dependencies.store.materialize).toHaveBeenCalledWith(expect.objectContaining({ synchronization: expect.objectContaining({ full: false }) }));
      expect(dependencies.store.beginRun).toHaveBeenCalledWith("repository", { rederivation: false });
    }
  });

  describe("sweep pass lifecycle", () => {
    const sweepRun = () => {
      const f = fixture([...[1, 2, 3, 9].map((id) => subject(id)), subject(19, "pull_request")]);
      const walk = vi.fn<NonNullable<ReconciliationGateway["walkReconciliation"]>>(
        async (_reference, input) => walkReconciliation({ ...input, listing: f.listing, gateway: f.gateway }));
      const dependencies = reconciliationDependencies({ github: { walkReconciliation: walk } });
      const discardPass = vi.fn(async () => { await f.pass.complete(); });
      const discardIfInactive = vi.fn<(repositoryId: string) => Promise<void>>(async () => {});
      dependencies.sweep = { spend: async () => null, openPass: async () => f.pass, discardPass, discardIfInactive };
      return { f, dependencies, discardPass, discardIfInactive, walk };
    };
    type Run = ReturnType<typeof sweepRun>["f"];
    const failGathering = (f: Run, id: number, failure: Error) => {
      const gather = f.gateway.gatherIssue;
      let failing = true;
      f.gateway.gatherIssue = async (target) => {
        if (failing && target.id === id) throw failure;
        return gather(target);
      };
      return () => { failing = false; };
    };
    const failStaging = (f: Run, id: number, failure: Error) => {
      const stage = f.pass.stage;
      let failing = true;
      f.pass.stage = vi.fn(async (input) => {
        if (failing && input.subjectKey === id) throw failure;
        return stage(input);
      });
      return () => { failing = false; };
    };

    it.each<[string, (f: Run) => () => void, number]>([
      ["a forge request", (f) => failGathering(f, 3, new GitHubApiError(500)), 3],
      ["a database write", (f) => failStaging(f, 3, new Error("connection terminated unexpectedly")), 1],
    ])("keeps the sweep pass when a budget-bound run fails on %s and resumes it with its staged subjects", async (_label, fail, attempts) => {
      const { f, dependencies, walk } = sweepRun();
      const recover = fail(f);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).rejects.toThrow();
      } finally { logged.mockRestore(); }
      expect(walk).toHaveBeenCalledTimes(attempts);
      expect(f.pass.complete).not.toHaveBeenCalled();
      expect((await f.pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([1, 2]);
      expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(2), key: 2 });
      expect(dependencies.store.failRun).toHaveBeenCalledOnce();

      recover();
      await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).resolves.toMatchObject({ skipped: false });
      expect([f.counts.get(1), f.counts.get(2)]).toEqual([1, 1]);
      expect(f.counts.has(3)).toBe(true);
      expect(f.listed[1]).toEqual({ since: instant(2).toISOString(), cursor: null });
      expect(dependencies.store.materialize).toHaveBeenCalledOnce();
    });

    const identity = { id: 19, number: 19 };
    const stub = (id: number) => ({ subject: { id, number: id } });
    const withoutField = (record: object, field: string) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== field));
    const closing = (bad: unknown) => ({ ...issue(9), closingPullRequests: [pullRequest(5), bad, pullRequest(6)] });
    const wrongType: Record<string, unknown> = { id: "5", number: "5", state: 1, mergedAt: 1, repositoryGitHubId: "1" };
    const unreadableRows: Array<[string, "issue" | "pull_request", unknown]> = [
      ["an unavailable subject identity", "issue", null],
      ["a string id", "issue", { ...issue(9), id: "9" }],
      ["a fractional number", "issue", { ...issue(9), number: 9.5 }],
      ["an unsafe id", "issue", { ...issue(9), id: 2 ** 53 }],
      ["an unsafe number", "issue", { ...issue(9), number: 2 ** 53 }],
      ...["labels", "history", "comments", "closingPullRequests"].flatMap((field): Array<[string, "issue", unknown]> => [
        [`no ${field}`, "issue", withoutField(issue(9), field)],
        [`${field} that is a string`, "issue", { ...issue(9), [field]: "x" }]]),
      ["a null closing pull request", "issue", closing(null)],
      ["a closing pull request with an unsafe id", "issue", closing({ ...pullRequest(7), id: 2 ** 53 })],
      ["a closing pull request with an unsafe number", "issue", closing({ ...pullRequest(7), number: 2 ** 53 })],
      ...Object.keys(wrongType).flatMap((field): Array<[string, "issue", unknown]> => [
        [`a closing pull request without ${field}`, "issue", closing(withoutField(pullRequest(7), field))],
        [`a closing pull request with a wrong-typed ${field}`, "issue", closing({ ...pullRequest(7), [field]: wrongType[field] })]]),
      ["a pull request row without a subject", "pull_request", { evidence: null }],
      ["a pull request row without evidence", "pull_request", { subject: identity }],
      ["a pull request row with non-object evidence", "pull_request", { subject: identity, evidence: "unavailable" }],
      ["a pull request row without reviews", "pull_request", { subject: identity, evidence: { rawDiff: "diff" } }],
      ["a pull request row with object reviews", "pull_request", { subject: identity, evidence: { reviews: {}, rawDiff: "diff" } }],
      ["a pull request row without a diff", "pull_request", { subject: identity, evidence: { reviews: [] } }],
      ["a pull request row with a numeric diff", "pull_request", { subject: identity, evidence: { reviews: [], rawDiff: 1 } }],
      ["a refreshed pull request row without missing", "pull_request", { subject: identity, evidence: null, refreshed: true, listed: true }],
      ["a refreshed pull request row with a string missing", "pull_request", { subject: identity, evidence: null, refreshed: true, missing: "no", listed: true }],
      ["a refreshed pull request row without listed", "pull_request", { subject: identity, evidence: null, refreshed: true, missing: false }],
      ["a refreshed pull request row with a string listed", "pull_request", { subject: identity, evidence: null, refreshed: true, missing: false, listed: "yes" }],
    ];

    it.each(unreadableRows)("discards the sweep pass, without retrying, when a staged row holds %s", async (_label, kind, payload) => {
      const { f, dependencies, walk } = sweepRun();
      await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: 8, updatedAt: instant(8), payload: stub(8) });
      const key = kind === "issue" ? 9 : 19;
      await f.pass.stage({ anchor: "subjects", kind, subjectKey: key, updatedAt: instant(key), payload });
      await f.pass.stage({ anchor: "subjects", kind: "pull_request", subjectKey: 10, updatedAt: instant(10), payload: { ...stub(10), evidence: null } });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).rejects
          .toHaveProperty("cause.message", "Staged sweep pass data is unreadable.");
      } finally { logged.mockRestore(); }
      expect(walk).toHaveBeenCalledOnce();
      expect(f.pass.complete).toHaveBeenCalledOnce();
      expect(await f.pass.readStaged()).toEqual([]);
      expect(dependencies.store.failRun).toHaveBeenCalledOnce();

      await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).resolves.toMatchObject({ skipped: false });
    });

    it("resumes a pass whose staged rows are all readable", async () => {
      const { f, dependencies } = sweepRun();
      const open = { ...pullRequest(5), state: "OPEN" as const, mergedAt: null };
      const rows = [
        { kind: "issue" as const, subjectKey: 9, payload: { ...issue(9), closingPullRequests: [open] } },
        { kind: "issue" as const, subjectKey: 10, payload: { subject: { id: 10, number: 10 } } },
        { kind: "pull_request" as const, subjectKey: 11, payload: { subject: { id: 11, number: 11 }, evidence: null } },
        { kind: "pull_request" as const, subjectKey: 12, payload: { subject: { id: 12, number: 12 }, evidence: { reviews: [], rawDiff: "diff" } } },
        { kind: "pull_request" as const, subjectKey: 14, payload: { subject: { id: 14, number: 14 }, evidence: null, refreshed: false } },
        { kind: "pull_request" as const, subjectKey: 13, payload: { subject: { id: 13, number: 13 }, evidence: null, refreshed: true, missing: true, listed: false } },
      ];
      for (const row of rows) await f.pass.stage({ anchor: "subjects", updatedAt: instant(row.subjectKey), ...row });
      await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).resolves.toMatchObject({ skipped: false });
    });

    it("settles an unregistered repository's pass only after the failed run released coordination", async () => {
      const { f, dependencies, discardIfInactive } = sweepRun();
      failGathering(f, 3, new GitHubApiError(500));
      let released = false;
      const coordinate = dependencies.store.withRepositoryReconciliation.bind(dependencies.store);
      dependencies.store.withRepositoryReconciliation = async (id, work) => {
        try { return await coordinate(id, work); } finally { released = true; }
      };
      discardIfInactive.mockImplementation(async () => { expect(released).toBe(true); });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).rejects.toThrow("Unable to reconcile repository.");
      } finally { logged.mockRestore(); }
      expect(discardIfInactive).toHaveBeenCalledExactlyOnceWith("repository");
      expect(f.pass.complete).not.toHaveBeenCalled();
    });

    it("does not settle the pass of a run that succeeded and keeps the failure when settling fails", async () => {
      const { f, dependencies, discardIfInactive } = sweepRun();
      await reconcileRepository(dependencies, "repository", { reason: "SWEEP" });
      expect(discardIfInactive).not.toHaveBeenCalled();

      failGathering(f, 2, new GitHubApiError(500));
      discardIfInactive.mockRejectedValue(new Error("database unavailable"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).rejects.toThrow("Unable to reconcile repository.");
        expect(logged.mock.calls).toContainEqual(["Could not discard reconciliation sweep checkpoints."]);
        expect(logged.mock.calls.flat().map(String).join("\n")).not.toContain("database unavailable");
      } finally { logged.mockRestore(); }
      expect(discardIfInactive).toHaveBeenCalledOnce();
    });

    it("ends the sweep pass when the fold completes", async () => {
      const { f, dependencies } = sweepRun();
      await expect(reconcileRepository(dependencies, "repository", { reason: "SWEEP" })).resolves.toMatchObject({ skipped: false });
      expect(f.pass.complete).toHaveBeenCalledOnce();
      expect(await f.pass.readStaged()).toEqual([]);
    });

    it.each<[string, () => GitHubRepository | null]>([
      ["NOT_FOUND", () => null],
      ["IDENTITY_MISMATCH", () => verifiedRepository({ id: 1 })],
      ["NOT_PUBLIC", () => verifiedRepository({ visibility: "PRIVATE" })],
    ])("ends the sweep pass when the crawl is declined as %s", async (reason, answer) => {
      const { f, dependencies } = sweepRun();
      await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: 1, updatedAt: instant(1), payload: { subject: { id: 1, number: 1 } } });
      vi.mocked(dependencies.github.getRepositoryById).mockResolvedValue(answer());
      await reconcileRepository(dependencies, "repository", { reason: "SWEEP" });
      expect(dependencies.store.markRepositoryUnavailable).toHaveBeenCalledWith(expect.objectContaining({ reason }));
      expect(f.pass.complete).toHaveBeenCalledOnce();
      expect(await f.pass.readStaged()).toEqual([]);
    });

    it("ends the sweep pass of an inactive repository", async () => {
      const { f, dependencies, discardPass } = sweepRun();
      await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: 1, updatedAt: instant(1), payload: { subject: { id: 1, number: 1 } } });
      (await dependencies.store.getRepository("repository"))!.active = false;
      await reconcileRepository(dependencies, "repository", { reason: "SWEEP" });
      expect(discardPass).toHaveBeenCalledExactlyOnceWith("repository");
      expect(await f.pass.readStaged()).toEqual([]);
    });
  });

  it("turns a sweep request hold into a skipped run rather than a repository failure", async () => {
    const { SweepBudgetSpent } = await import("@/lib/fold/sweep-request-budget");
    const resetAt = new Date("2030-01-02T12:00:00Z");
    const dependencies = reconciliationDependencies({ github: { listIssues: async () => { throw new SweepBudgetSpent(resetAt); } } });
    const result = await reconcileRepository(dependencies, "repository", { reason: "SWEEP" });
    expect(result).toMatchObject({ skipped: true, sweepHeldUntil: resetAt });
    expect(dependencies.store.holdRun).toHaveBeenCalledExactlyOnceWith("run-1", "Reconciliation held for the sweep request budget.", "SWEEP_REQUEST_BUDGET", null);
    expect(dependencies.store.failRun).not.toHaveBeenCalled();
    expect(dependencies.store.materialize).not.toHaveBeenCalled();
    expect(dependencies.store.markRepositoryUnavailable).not.toHaveBeenCalled();
  });

  it("completes with evidence after a transient review read recovers", async () => {
    const reviews = [{ id: 301, state: "APPROVED" as const, submittedAt: "2026-09-01T11:00:00Z", dismissal: null }];
    const dependencies = reconciliationDependencies({
      github: { getPullRequestReviews: vi.fn().mockRejectedValueOnce(new GitHubApiError(503)).mockResolvedValue(reviews) },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({
        runId: "run-1", skipped: false, adds: 1,
      });
      expect(dependencies.github.getPullRequestReviews).toHaveBeenCalledTimes(2);
      expect(dependencies.store.materialize).toHaveBeenCalledWith(expect.objectContaining({
        synchronization: expect.objectContaining({ pullRequests: [{ id: 201, reviews, rawDiff: "diff" }] }),
      }));
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it("fails the run immediately when a review read rejects the credential", async () => {
    const failure = new GitHubApiError(401);
    const dependencies = reconciliationDependencies({
      github: { getPullRequestReviews: vi.fn().mockRejectedValue(failure) },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({ cause: failure });
      expect(dependencies.github.getPullRequestReviews).toHaveBeenCalledOnce();
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.materialize).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it.each(["cause", "deadline", "headers"] as const)("records an ordinary failure when %s guidance is unreadable", async (field) => {
    const upstream = field === "cause" ? new Error("Upstream failure") : new GitHubApiError(403, true, 120);
    Object.defineProperty(upstream, field === "deadline" ? "notBefore" : field, {
      get: () => { throw new Error("error field refused"); },
    });
    const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockRejectedValue(upstream) } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const failure = await reconcileRepository(dependencies, "repository").catch((error: unknown) => error);
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect((failure as Error).cause === upstream).toBe(true);
      expect(dependencies.store.setReconciliationCooldown).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); info.mockRestore(); }
  });

  it.each([false, true])("shares the exact repository and job deadline across advancing clocks, wrapped=%s", async (wrapped) => {
    const { runNextReconciliationJob } = await import("@/lib/fold/reconciliation-worker");
    let clock = new Date("2030-01-02T03:04:05.678Z");
    const now = () => new Date(clock);
    const upstream = new GitHubApiError(403, true, 120, null, { "retry-after": "120" });
    const thrown = wrapped ? new Error("Gateway wrapper", { cause: upstream }) : upstream;
    const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockRejectedValue(thrown) } });
    let cooldown: Date | null = null;
    vi.mocked(dependencies.store.setReconciliationCooldown).mockImplementation(async (_id, at) => {
      cooldown = at;
      clock = new Date(clock.getTime() + 5000);
    });
    const deferred: Date[] = [];
    const failures: unknown[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await runNextReconciliationJob({
        now, scheduleLeaseRenewal: () => () => {},
        onFailure: (_id, error) => { failures.push(error); clock = new Date(clock.getTime() + 7000); },
        store: {
          claimNextReconciliationJob: async () => ({ id: "job-deadline", repositoryId: "repository", reason: "SWEEP", attemptCount: 5, leaseToken: "lease-deadline", rederivationRequestedAt: null, rederivationGeneration: 0 }),
          renewReconciliationJobLease: async () => true,
          completeReconciliationJob: async () => { throw new Error("unexpected completion"); },
          retryReconciliationJob: async () => { throw new Error("unexpected retry"); },
          failReconciliationJob: async () => { throw new Error("unexpected failure"); },
          deferReconciliationJob: async (_id, _lease, at) => { deferred.push(at); return true; },
          getReconciliationCooldown: async () => cooldown,
        },
        reconcile: () => reconcileRepository({ ...dependencies, now }, "repository"),
      })).toBe("DEFERRED");
      expect(cooldown).toEqual(new Date("2030-01-02T03:06:05.678Z"));
      expect(deferred).toEqual([new Date("2030-01-02T03:06:05.678Z")]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ cause: thrown });
      expect(JSON.stringify(failures[0])).toBe("{}");
    } finally {
      logged.mockRestore();
      info.mockRestore();
    }
  });

  it("journals the GitHub refusal without the reflected access token", async () => {
    const token = createHash("sha256").update("reconciliation diagnostic fixture").digest("hex");
    const upstream = new GitHubApiError(403, true, 60, `Secondary rate limit: ${token}`, {
      "retry-after": "60", "x-github-request-id": "request-reconcile",
    }, token);
    const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockRejectedValue(upstream) } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const budgetLog = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({ cause: upstream });
      const line = logged.mock.calls.find(([message]) => message === "Reconciliation of repository repository failed.")!.join(" ");
      expect(line).toContain('status=403 body="Secondary rate limit: [REDACTED]"');
      expect(line).toContain('retry-after="60" x-github-request-id="request-reconcile"');
      expect(line).not.toContain(token);
    } finally {
      logged.mockRestore();
      budgetLog.mockRestore();
    }
  });

  it("enables bounded timeline verification from the repository catalogs", async () => {
    const dependencies = reconciliationDependencies();
    await reconcileRepository(dependencies, "repository");
    expect(dependencies.github.listIssues).toHaveBeenCalledWith(
      { owner: "octo", name: "example" },
      {
        timelineCriticalLabels: new Set(Array.from({ length: 10 }, (_, index) => `delivered/${index + 1}`)),
        timelineWatchedLabels: new Set(["M"]),
      },
    );
  });

  it.each([120, 0, null])("records only rate-limit cooldowns with retryAfterSeconds=%s from the injected clock", async (retryAfterSeconds) => {
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const upstream of [new Error("schema failure"), new GitHubApiError(403, false, retryAfterSeconds), new GitHubApiError(403, true, retryAfterSeconds)]) {
        const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockRejectedValue(upstream) } });
        await expect(reconcileRepository({ ...dependencies, now }, "repository")).rejects.toMatchObject({ cause: upstream });
        expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
        const writes = vi.mocked(dependencies.store.setReconciliationCooldown).mock.calls;
        if (upstream instanceof GitHubApiError && upstream.rateLimited) {
          expect(writes).toHaveLength(1);
          expect(writes).toEqual([["repository", new Date(now().getTime() +
            Math.max(60, retryAfterSeconds ?? DEFAULT_RECONCILIATION_COOLDOWN_SECONDS) * 1000)]]);
        } else {
          expect(writes).toEqual([]);
        }
      }
    } finally {
      errorLog.mockRestore();
    }
  });

  it("writes the exhausted primary reset as the repository cooldown", async () => {
    const upstream = new GitHubApiError(403, true, 120, null, {
      "retry-after": "120", "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(new Date("2030-01-02T03:09:05Z").getTime() / 1000),
    });
    const dependencies = reconciliationDependencies({ github: { listIssues: vi.fn().mockRejectedValue(upstream) } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository({ ...dependencies, now: () => new Date("2030-01-02T03:04:05.678Z") }, "repository"))
        .rejects.toMatchObject({ cause: upstream });
      expect(dependencies.store.setReconciliationCooldown).toHaveBeenCalledWith("repository", new Date("2030-01-02T03:09:05Z"));
    } finally {
      logged.mockRestore();
    }
  });

  it.each([true, false])("clears an expired cooldown after success with active=%s", async (active) => {
    const dependencies = reconciliationDependencies();
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    vi.mocked(dependencies.store.getReconciliationCooldown).mockResolvedValue(now());
    const repository = await dependencies.store.getRepository("repository");
    repository!.active = active;
    await reconcileRepository({ ...dependencies, now }, "repository");
    if (active) {
      expect(dependencies.store.materialize).toHaveBeenCalledWith(expect.objectContaining({
        synchronization: expect.objectContaining({ full: true }),
      }));
      expect(dependencies.store.setReconciliationCooldown).not.toHaveBeenCalled();
    } else {
      expect(dependencies.store.setReconciliationCooldown).toHaveBeenCalledWith("repository", null);
    }
    expect(dependencies.store.beginRun).toHaveBeenCalledOnce();
    expect(dependencies.github.listIssues).toHaveBeenCalledTimes(active ? 1 : 0);
  });

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
        getRepositoryById: async () => verifiedRepository(),
        getIssue: async () => null,
        getPullRequestClosingIssues: async () => [],
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
      { operation: "IssueTimelineCounts", variables: { owner: "octo", name: "example", number3: 3, number1: 1, number2: 2 } },
      // Every issue page is collected before any issue is read, so the per-issue
      // timeline reads follow both pages, in the order the nodes arrived.
      ...[3, 1, 2].map((issueNumber) => (
        { operation: "IssueTimeline", variables: { owner: "octo", name: "example", issueNumber, cursor: null } }
      )),
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
    expect(fold.pullRequests.map(({ authorGitHubUserId }) => authorGitHubUserId)).toEqual([2001, 2001, 2001]);
    expect(fold.settlements.map(({ creditorGitHubUserId }) => creditorGitHubUserId)).toEqual([2001, 2001, 2001]);
    expect(fold.settlements.map(({ donationCommentId }) => donationCommentId)).toEqual([null, null, null]);
    expect(fold.issues.map((issue) => issue.updatedAt)).toEqual([
      "2026-09-01T12:05:00.000Z", "2026-09-01T12:05:00.000Z", "2026-09-01T12:05:00.000Z",
    ]);
    // Keep the historical digest comparable without the added provenance fields.
    const legacyFold = JSON.stringify(fold, (key, value) => (
      key === "authorGitHubUserId" || key === "creditorGitHubUserId"
        || key === "claimAssigneeGitHubUserId" || key === "updatedAt" || key === "asksOutsideRepository" || key === "doneWhen"
        || key === "donationCommentId" ? undefined : value
    ));
    // The digest moved when the fold result stopped carrying issue and pull
    // request body text (issue 681); the JSON shape is otherwise unchanged.
    expect(createHash("sha256").update(legacyFold).digest("hex")).toBe("9640faa8a1fd4b0db7d108e447da7c9d6b347d0cfaa9d47e1f38568523ad0224");
    const unstampedFold = JSON.stringify(fold, (key, value) => (
      key === "updatedAt" || key === "asksOutsideRepository" || key === "doneWhen" || key === "donationCommentId" ? undefined : value
    ));
    expect(createHash("sha256").update(unstampedFold).digest("hex")).toBe("cfb680a10c35065663b858d59c86e2688ef85205a594e9e002ac7c08422b2b2d");
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
    // Retained CLOSED evidence changes the rows, while merged pricing stays identical.
    expect(fold.pullRequests.filter((pr) => pr.state === "CLOSED")).toHaveLength(360);
    const unstampedFold = JSON.stringify({ ...fold, pullRequests: fold.pullRequests.filter((pr) => pr.state === "MERGED") }, (key, value) => (
      key === "updatedAt" || key === "asksOutsideRepository" || key === "doneWhen" || key === "donationCommentId" ? undefined : value
    ));
    expect(createHash("sha256").update(unstampedFold).digest("hex")).toBe("cfb680a10c35065663b858d59c86e2688ef85205a594e9e002ac7c08422b2b2d");
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

  it("never reads reviews or a diff for a closing pull request in another repository", async () => {
    const calls: Array<{ operation: string; repository: { owner: string; name: string }; number: number }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [
            {
              ...reconciliationPullRequest({ id: 202, number: 12 }),
              url: "https://github.com/other/fork/pull/12",
              repositoryGitHubId: 5002,
              repositoryNameWithOwner: "other/fork",
              authorGitHubUserId: 4001,
              mergedAt: "2026-09-01T11:45:00.000Z",
            },
            reconciliationPullRequest({ id: 201, number: 11 }),
          ],
        }]),
        getPullRequestReviews: vi.fn(async (repository, number) => {
          calls.push({ operation: "reviews", repository, number });
          return [];
        }),
        getPullRequestDiff: vi.fn(async (repository, number) => {
          calls.push({ operation: "diff", repository, number });
          return `diff ${number}`;
        }),
      },
    });

    await reconcileRepository(dependencies, "repository");

    expect(calls).toEqual([
      { operation: "reviews", repository: { owner: "octo", name: "example" }, number: 11 },
      { operation: "diff", repository: { owner: "octo", name: "example" }, number: 11 },
    ]);
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.settlements.map(({ githubIssueId, githubPullRequestId }) => [githubIssueId, githubPullRequestId]))
      .toEqual([[101, 201]]);
    expect(fold.pullRequests.map(({ githubPullRequestId }) => githubPullRequestId)).toEqual([201]);
    expect(fold.unwritableClosures).toEqual([]);
    // The foreign author is not looked up either: nothing here can credit them.
    expect(dependencies.store.findUsersByGitHubUserIds).toHaveBeenCalledExactlyOnceWith([2001]);
  });

  it("records a cross-repository closure without reading any evidence for a wholly foreign closure", async () => {
    const calls: Array<{ operation: string; number: number }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [{
            ...reconciliationPullRequest({ id: 202, number: 12 }),
            url: "https://github.com/other/fork/pull/12",
            repositoryGitHubId: 5002,
            repositoryNameWithOwner: "other/fork",
          }],
        }]),
        getPullRequestReviews: vi.fn(async (_repository, number) => {
          calls.push({ operation: "reviews", number });
          return [];
        }),
        getPullRequestDiff: vi.fn(async (_repository, number) => {
          calls.push({ operation: "diff", number });
          return `diff ${number}`;
        }),
      },
    });

    await reconcileRepository(dependencies, "repository");

    expect(calls).toEqual([]);
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.settlements).toEqual([]);
    expect(fold.pullRequests).toEqual([]);
    expect(fold.ledgerEntries).toEqual([]);
    expect(fold.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: expect.stringContaining("other/fork"),
    }]);
  });

  it("proves a settlement with the diff it read rather than the empty one it did not", async () => {
    // The registered name is varied only as a lever: it is what makes a
    // reconciliation that decides by name skip the fetch the fold assumes ran.
    const calls: Array<{ operation: string; number: number }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        getPullRequestReviews: vi.fn(async (_repository, number) => {
          calls.push({ operation: "reviews", number });
          return [];
        }),
        getPullRequestDiff: vi.fn(async (_repository, number) => {
          calls.push({ operation: "diff", number });
          return `diff ${number}`;
        }),
      },
    });
    const repository = await dependencies.store.getRepository("repository");
    repository!.ownerName = "OCTO/Example";

    await reconcileRepository(dependencies, "repository");

    // Soft, so a run that skips the fetch still reports what it did to the proof.
    expect.soft(calls).toEqual([
      { operation: "reviews", number: 11 },
      { operation: "diff", number: 11 },
    ]);
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.unwritableClosures).toEqual([]);
    expect(fold.settlements.map(({ githubPullRequestId }) => githubPullRequestId)).toEqual([201]);
    // The harm of reconciliation and the fold disagreeing is not a missing
    // settlement, it is this: a settlement proved by the empty diff nobody read.
    expect(fold.settlements[0]!.proofSha256).toBe(createHash("sha256").update("diff 11").digest("hex"));
    expect(fold.settlements[0]!.proofSha256).not.toBe(createHash("sha256").update("").digest("hex"));
  });

  it("reads evidence when the repository was renamed after registration", async () => {
    const calls: Array<{ operation: string; repository: { owner: string; name: string }; number: number }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        // The identity resolves to the new path while the stored one stays stale,
        // and every closing reference reports the new name with the same id.
        getRepositoryById: vi.fn().mockResolvedValue(
          verifiedRepository({ owner: "octo", name: "renamed-example", fullName: "octo/renamed-example" }),
        ),
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [{
            ...reconciliationPullRequest({ id: 201, number: 11 }),
            url: "https://github.com/octo/renamed-example/pull/11",
            repositoryNameWithOwner: "octo/renamed-example",
          }],
        }]),
        getPullRequestReviews: vi.fn(async (repository, number) => {
          calls.push({ operation: "reviews", repository, number });
          return [];
        }),
        getPullRequestDiff: vi.fn(async (repository, number) => {
          calls.push({ operation: "diff", repository, number });
          return `diff ${number}`;
        }),
      },
    });

    await reconcileRepository(dependencies, "repository");

    expect(calls).toEqual([
      { operation: "reviews", repository: { owner: "octo", name: "renamed-example" }, number: 11 },
      { operation: "diff", repository: { owner: "octo", name: "renamed-example" }, number: 11 },
    ]);
    // The snapshot the fold works from still carries the stale stored path, so a
    // rule reading that name rejects the repository's own pull request.
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.unwritableClosures).toEqual([]);
    expect(fold.settlements.map(({ githubPullRequestId }) => githubPullRequestId)).toEqual([201]);
    expect(fold.settlements[0]!.proofSha256).toBe(createHash("sha256").update("diff 11").digest("hex"));
  });

  it("never reads evidence for a different repository under the registered owner", async () => {
    const calls: Array<{ operation: string; number: number }> = [];
    const materialize = vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 });
    const dependencies = reconciliationDependencies({
      materialize,
      github: {
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [{
            ...reconciliationPullRequest({ id: 202, number: 12 }),
            url: "https://github.com/octo/other-example/pull/12",
            repositoryGitHubId: 5002,
            repositoryNameWithOwner: "octo/other-example",
          }],
        }]),
        getPullRequestReviews: vi.fn(async (_repository, number) => {
          calls.push({ operation: "reviews", number });
          return [];
        }),
        getPullRequestDiff: vi.fn(async (_repository, number) => {
          calls.push({ operation: "diff", number });
          return `diff ${number}`;
        }),
      },
    });

    await reconcileRepository(dependencies, "repository");

    expect(calls).toEqual([]);
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.settlements).toEqual([]);
    expect(fold.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: expect.stringContaining("octo/other-example"),
    }]);
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
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      // The log carries the encoded token, not the raw object (issue 1042):
      // one line, so no text the error picked up can forge journal lines.
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", errorLogToken(upstream));
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails the whole run without discarding or materializing when the issue list exceeds the response cap", async () => {
    const overCap = new GitHubResponseTooLargeError(MAX_SUCCESS_BODY_BYTES);
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockRejectedValue(overCap) },
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "ISSUE", id: 999, number: 42, generation: 7 },
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
        message: "Unable to reconcile repository.",
        cause: overCap,
      });
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.discardDirtyReconciliationSubject).not.toHaveBeenCalled();
      expect(dependencies.store.materialize).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", errorLogToken(overCap));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps Postgres record text out of the failure log and rethrown cause", async () => {
    await withRecordBearingPostgresWrite(async (write, originalError) => {
      const dependencies = reconciliationDependencies({ materialize: vi.fn().mockImplementation(write) });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const failure = await reconcileRepository(dependencies, "repository").catch((caught: unknown) => caught);
        const upstream = originalError();
        const logged = inspect(errorLog.mock.calls, { depth: null });
        const thrown = inspect(failure, { depth: null });
        expect(inspect(upstream, { depth: null })).toContain(RECORD_MARKER);
        expect(logged).not.toContain(RECORD_MARKER);
        expect(thrown).not.toContain(RECORD_MARKER);
        expect(logged).toContain("Reconciliation of repository repository failed.");
        // The log line carries the encoded name and message (issue 1042); the
        // code's visibility is superseded there — it still rides the rethrown
        // cause object, which is what `thrown` asserts next.
        expect(logged).toContain(`${logField("PostgresError")}:`);
        expect(logged).toContain("test write failed");
        expect(thrown).toContain(upstream.code);
        const reportedCause = (failure as Error).cause as Error;
        expect(reportedCause.message).toBe("test write failed");
        expect(Object.keys(reportedCause).sort()).toEqual(["code", "name", "routine", "severity"]);
        expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      } finally {
        errorLog.mockRestore();
      }
    });
  });

  it("keeps a GitHub response body on the rethrown cause and out of the stored failure", async () => {
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
      expect(dependencies.store.failRun.mock.calls).toEqual([["run-1", "Reconciliation failed.", null]]);
      // The log carries the encoded token (issue 1042); the body stays on the
      // cause object the rethrow attaches, out of the product-readable row.
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", errorLogToken(upstream));
      expect(upstream.body).toBe(body);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("records the credential as the cause when the fold died on a rejected GitLab credential", async () => {
    const rejection = new ForgeCredentialRejectedError();
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockRejectedValue(rejection) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
        cause: rejection,
      });
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE, null);
      // The cause still reaches the service log as the encoded token, exactly
      // as on the generic path (issue 1042).
      expect(errorLog).toHaveBeenCalledWith("Reconciliation of repository repository failed.", errorLogToken(rejection));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("finds the credential rejection nested in the fold error's cause chain", async () => {
    const rejection = new ForgeCredentialRejectedError();
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockRejectedValue(new Error("aggregate wrapper", { cause: rejection })) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reconcileRepository(dependencies, "repository").catch(() => undefined);
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE, null);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps the generic stored failure when a nested cause chain carries no credential rejection", async () => {
    const dependencies = reconciliationDependencies({
      github: { listIssues: vi.fn().mockRejectedValue(new Error("outer wrapper", { cause: new Error("inner") })) },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reconcileRepository(dependencies, "repository").catch(() => undefined);
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each([
    [new Error("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to an Issue with the number of '42'."), "NOT_FOUND", ""],
    [new GitHubResponseTooLargeError(MAX_SUCCESS_BODY_BYTES), "RESPONSE_TOO_LARGE", ""],
    [new GitHubGraphqlInvalidResponseError("GitHub GraphQL response was invalid. closedByPullRequestsReferences.nodes contained a null entry.", CLOSING_PULL_REQUESTS_FIELD_PATH), "UNREADABLE_FIELD", " field=closedByPullRequestsReferences.nodes"],
    [new GitHubGraphqlInvalidResponseError("GitHub GraphQL response was invalid. labels.nodes was not a list.", "labels.nodes"), "UNREADABLE_FIELD", " field=labels.nodes"],
    [new GitHubGraphqlInvalidResponseError("GitHub GraphQL response was invalid. timelineItems.nodes contained a null entry.", "timelineItems.nodes"), "UNREADABLE_FIELD", " field=timelineItems.nodes"],
  ])("completes the run when a dirty issue read answers %s, discarding only that subject", async (failure, reason, field) => {
    const poison = { kind: "ISSUE" as const, id: 999, number: 42, generation: 7 };
    const good = { kind: "ISSUE" as const, id: 555, number: 43, generation: 8 };
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async (_reference: GitHubRepositoryReference, subject: GitHubSubject) => {
          if (subject.number === poison.number) throw failure;
          return { ...reconciliationIssue({ id: subject.id, number: subject.number }), closingPullRequests: [] };
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
    dependencies.store.getDirtyReconciliationSubjects = async () => [poison, good];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "ISSUE", githubSubjectId: 999, generation: 7,
      });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        `Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=42 reason=${reason}${field}`,
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      const foldedIds = materializeInput.fold.issues.map((issue) => issue.githubIssueId);
      expect(foldedIds).toContain(555);
      expect(foldedIds).not.toContain(999);
      expect(materializeInput.synchronization?.dirtySubjects).toEqual([poison, good]);
      expect(vi.mocked(dependencies.github.getIssue).mock.calls.map(([, subject]) => subject.number)).toEqual([42, 43]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("completes the run when a dirty GitLab issue is gone upstream, discarding only that subject", async () => {
    // A GitLab issue can vanish between the pass that journaled its dirty row
    // and the per-subject read of the next pass; the gateway's per-issue reads
    // then answer GitLab's fixed 404, which the GitHub-shaped classifier never
    // matched. The discard is keyed with the subject's generation, so a
    // genuine re-enqueue (bumped generation) still reconciles.
    const poison = { kind: "ISSUE" as const, id: 999, number: 42, generation: 7 };
    const good = { kind: "ISSUE" as const, id: 555, number: 43, generation: 8 };
    const notFound = new GitLabApiError(404);
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async (_reference: GitHubRepositoryReference, subject: GitHubSubject) => {
          if (subject.number === poison.number) throw notFound;
          return { ...reconciliationIssue({ id: subject.id, number: subject.number }), closingPullRequests: [] };
        }),
      },
    });
    const repository = await dependencies.store.getRepository("repository");
    repository!.provider = "gitlab";
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date(),
      lastFullPassAt: new Date(),
      omittedOversizedFacts: 0,
      issues: [],
      pullRequests: [],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [poison, good];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "ISSUE", githubSubjectId: 999, generation: 7,
      });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=ISSUE number=42 reason=NOT_FOUND",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      const foldedIds = materializeInput.fold.issues.map((issue) => issue.githubIssueId);
      expect(foldedIds).toContain(555);
      expect(foldedIds).not.toContain(999);
      expect(materializeInput.synchronization?.dirtySubjects).toEqual([poison, good]);
      expect(vi.mocked(dependencies.github.getIssue).mock.calls.map(([, subject]) => subject.number)).toEqual([42, 43]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails the run without discarding when a dirty GitLab issue read fails with a server error", async () => {
    // The GitLab arm is 404 and nothing else: a server error is transient or
    // run-invalidating, so it keeps whole-run retry semantics and must never
    // discard the subject. This is the negative control against a widened
    // classifier accepting any GitLabApiError status.
    const serverError = new GitLabApiError(500);
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async () => {
          throw serverError;
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
      { kind: "ISSUE" as const, id: 555, number: 43, generation: 8 },
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

  it.each([
    [new Error("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a PullRequest with the number of '44'."), "NOT_FOUND"],
    [new GitHubResponseTooLargeError(MAX_SUCCESS_BODY_BYTES), "RESPONSE_TOO_LARGE"],
  ])("completes the run when dirty pull request closing references answer %s, discarding only that subject", async (failure, reason) => {
    const subject = { kind: "PULL_REQUEST" as const, id: 777, number: 44, generation: 9 };
    const dependencies = reconciliationDependencies({
      github: {
        getPullRequestClosingIssues: vi.fn(async () => {
          throw failure;
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
    dependencies.store.getDirtyReconciliationSubjects = async () => [subject];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 777, generation: 9,
      });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        `Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=44 reason=${reason}`,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each(["reviews", "diff"] as const)(
    "completes the run when a merged closing pull request's %s is gone upstream, discarding and omitting only that subject",
    async (failingFetch) => {
      // Production-true shapes: the reviews read is GraphQL and answers a
      // deleted pull request with the flattened NOT_FOUND message; the diff
      // read is REST and answers GitHub's fixed 404 error.
      const notFound = failingFetch === "diff"
        ? new GitHubApiError(404)
        : new Error(
          "GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a PullRequest with the number of '11'.",
        );
      const dependencies = reconciliationDependencies({
        github: {
          listIssues: vi.fn().mockResolvedValue([{
            ...reconciliationIssue({ id: 101, number: 1 }),
            closingPullRequests: [
              reconciliationPullRequest({ id: 201, number: 11 }),
              reconciliationPullRequest({ id: 202, number: 12 }),
            ],
          }]),
          getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "reviews" && number === 11) throw notFound;
            return [];
          }),
          getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "diff" && number === 11) throw notFound;
            return `diff ${number}`;
          }),
        },
      });
      dependencies.store.getDirtyReconciliationSubjects = async () => [
        { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
      ];
      const discard = vi.fn().mockResolvedValue(undefined);
      dependencies.store.discardDirtyReconciliationSubject = discard;
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith({
          repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 7,
        });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
          "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=NOT_FOUND",
        );
        const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
        expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 202, reviews: [], rawDiff: "diff 12" }]);
        expect(
          vi.mocked(dependencies.github.getPullRequestReviews).mock.calls.map(([, number]) => number).sort((a, b) => a - b),
        ).toEqual([11, 12]);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it.each(["reviews", "diff"] as const)(
    "completes the run when a merged closing pull request's %s read answers the diff-cap 406, discarding and omitting only that subject",
    async (failingFetch) => {
      // GitHub durably refuses a diff over its 20000-line cap with a fixed 406
      // ("Sorry, the diff exceeded the maximum number of lines"), so no retry
      // can ever succeed and the failure joins the discard arm: the dirty row
      // goes, the subject is omitted, and the run completes.
      const diffCap = new GitHubApiError(406);
      const dependencies = reconciliationDependencies({
        github: {
          listIssues: vi.fn().mockResolvedValue([{
            ...reconciliationIssue({ id: 101, number: 1 }),
            closingPullRequests: [
              reconciliationPullRequest({ id: 201, number: 11 }),
              reconciliationPullRequest({ id: 202, number: 12 }),
            ],
          }]),
          getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "reviews" && number === 11) throw diffCap;
            return [];
          }),
          getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "diff" && number === 11) throw diffCap;
            return `diff ${number}`;
          }),
        },
      });
      dependencies.store.getDirtyReconciliationSubjects = vi.fn(async () => [
        { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
      ]);
      const discard = vi.fn().mockResolvedValue(undefined);
      dependencies.store.discardDirtyReconciliationSubject = discard;
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith({
          repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 7,
        });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
          "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=DIFF_TOO_LARGE",
        );
        const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
        expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 202, reviews: [], rawDiff: "diff 12" }]);

        // The discard is what empties the subject's dirty row, so a subsequent
        // reconciliation no longer carries it as dirty work and still completes
        // instead of failing the run again; the journal keeps naming the
        // subject so the durable skip stays operator-visible.
        dependencies.store.getDirtyReconciliationSubjects = vi.fn(async () => []);
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenNthCalledWith(
          2,
          "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=DIFF_TOO_LARGE",
        );
        const secondInput = vi.mocked(dependencies.store.materialize).mock.calls[1]![0];
        expect(secondInput.synchronization?.dirtySubjects).toEqual([]);
        expect(secondInput.synchronization?.pullRequests).toEqual([{ id: 202, reviews: [], rawDiff: "diff 12" }]);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it.each(["reviews", "diff"] as const)(
    "completes the run when a merged closing pull request's %s read answers a body over the success-path byte cap, discarding and omitting only that subject",
    async (failingFetch) => {
      // A body past the client's success-path cap is as fixed as the diff-cap
      // 406: the pull request's own bytes are what tripped it, so every retry
      // re-reads the same over-cap body and fails the same way. The failure
      // joins the discard arm — dirty row gone, subject omitted, run completes.
      // Both the REST diff and GraphQL reviews reads preserve this error class.
      const overCap = new GitHubResponseTooLargeError(MAX_SUCCESS_BODY_BYTES);
      const dependencies = reconciliationDependencies({
        github: {
          listIssues: vi.fn().mockResolvedValue([{
            ...reconciliationIssue({ id: 101, number: 1 }),
            closingPullRequests: [
              reconciliationPullRequest({ id: 201, number: 11 }),
              reconciliationPullRequest({ id: 202, number: 12 }),
            ],
          }]),
          getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "reviews" && number === 11) throw overCap;
            return [];
          }),
          getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "diff" && number === 11) throw overCap;
            return `diff ${number}`;
          }),
        },
      });
      dependencies.store.getDirtyReconciliationSubjects = vi.fn(async () => [
        { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
      ]);
      const discard = vi.fn().mockResolvedValue(undefined);
      dependencies.store.discardDirtyReconciliationSubject = discard;
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith({
          repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 7,
        });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
          "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=RESPONSE_TOO_LARGE",
        );
        const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
        expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 202, reviews: [], rawDiff: "diff 12" }]);

        // The discard is what empties the subject's dirty row, so a subsequent
        // reconciliation no longer carries it as dirty work and still completes
        // instead of failing the run again.
        dependencies.store.getDirtyReconciliationSubjects = vi.fn(async () => []);
        await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
        expect(dependencies.store.failRun).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenNthCalledWith(
          2,
          "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=RESPONSE_TOO_LARGE",
        );
        const secondInput = vi.mocked(dependencies.store.materialize).mock.calls[1]![0];
        expect(secondInput.synchronization?.dirtySubjects).toEqual([]);
        expect(secondInput.synchronization?.pullRequests).toEqual([{ id: 202, reviews: [], rawDiff: "diff 12" }]);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it.each(["reviews", "diff"] as const)(
    "fails the run without discarding when a merged closing pull request's %s read fails with a server error",
    async (failingFetch) => {
      // A 5xx is transient: whole-run retry semantics hold and the discard arm
      // must never swallow it, on either pull-request evidence leg.
      const serverError = new GitHubApiError(502);
      const dependencies = reconciliationDependencies({
        github: {
          listIssues: vi.fn().mockResolvedValue([{
            ...reconciliationIssue({ id: 101, number: 1 }),
            closingPullRequests: [
              reconciliationPullRequest({ id: 201, number: 11 }),
              reconciliationPullRequest({ id: 202, number: 12 }),
            ],
          }]),
          getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "reviews" && number === 11) throw serverError;
            return [];
          }),
          getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
            if (failingFetch === "diff" && number === 11) throw serverError;
            return `diff ${number}`;
          }),
        },
      });
      dependencies.store.getDirtyReconciliationSubjects = async () => [
        { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
      ];
      const discard = vi.fn().mockResolvedValue(undefined);
      dependencies.store.discardDirtyReconciliationSubject = discard;
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
          message: "Unable to reconcile repository.",
        });
        expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
        expect(discard).not.toHaveBeenCalled();
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("fails the run without discarding when a dirty GitHub issue read answers the diff-cap 406", async () => {
    // The issue arm is the deleted-subject class and nothing else: an issue
    // read has no diff to cap, so a 406 there is not expected and keeps
    // whole-run retry semantics. This pins the boundary against the pull
    // request classifier's 406 branch leaking into the issue arm.
    const diffCap = new GitHubApiError(406);
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async () => {
          throw diffCap;
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

  it("completes the run when an untracked merged closing pull request's evidence is gone upstream, journaling and omitting without a discard", async () => {
    const notFound = new Error(
      "GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a PullRequest with the number of '12'.",
    );
    const dependencies = reconciliationDependencies({
      github: {
        listIssues: vi.fn().mockResolvedValue([{
          ...reconciliationIssue({ id: 101, number: 1 }),
          closingPullRequests: [
            reconciliationPullRequest({ id: 201, number: 11 }),
            reconciliationPullRequest({ id: 202, number: 12 }),
          ],
        }]),
        getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
          if (number === 12) throw notFound;
          return [];
        }),
        getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => `diff ${number}`),
      },
    });
    // Pull request 12 fails while carrying no dirty row at all: nothing is
    // discarded, and pull request 11's healthy row is not touched either.
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
    ];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=12 reason=NOT_FOUND",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      expect(materializeInput.synchronization?.pullRequests).toEqual([{ id: 201, reviews: [], rawDiff: "diff 11" }]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a discarded pull request's last-known evidence flowing until the next full pass", async () => {
    // Incremental pass: the pull request is dirty and cached, the refresh
    // fails with the production-true REST shape for the diff leg, and the
    // cached entry keeps flowing instead of being blanked. The final
    // assertion also pins the refresh filter's selection: a dirty cached
    // pull request is in the refresh set.
    const cachedReview = {
      id: 3001,
      state: "CHANGES_REQUESTED" as const,
      submittedAt: "2026-09-01T09:30:00.000Z",
      dismissal: null,
    };
    const dependencies = reconciliationDependencies({
      github: {
        getPullRequestReviews: vi.fn().mockResolvedValue([]),
        getPullRequestDiff: vi.fn(async () => {
          throw new GitHubApiError(404);
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
      pullRequests: [{ id: 201, reviews: [cachedReview], rawDiff: "cached diff" }],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
    ];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 7,
      });
      expect(dependencies.store.failRun).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=NOT_FOUND",
      );
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      expect(materializeInput.synchronization?.pullRequests).toEqual([
        { id: 201, reviews: [cachedReview], rawDiff: "cached diff" },
      ]);
      expect(vi.mocked(dependencies.github.getPullRequestDiff).mock.calls.map(([, number]) => number)).toEqual([11]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("re-fetches the dirty cached pull request's evidence and keeps a referenced healthy one cached on an incremental pass", async () => {
    // The referencing issue is RETAINED (absent from the incremental scan,
    // and its getIssue probe answers unchanged), so the refresh filter alone
    // decides which closing pull requests are re-read: the dirty cached one
    // is fetched again, the healthy cached one is not, and both keep their
    // cached evidence flowing.
    const cachedReview = {
      id: 3001,
      state: "CHANGES_REQUESTED" as const,
      submittedAt: "2026-09-01T09:30:00.000Z",
      dismissal: null,
    };
    const referencedIssue = {
      ...reconciliationIssue({ id: 101, number: 1 }),
      closingPullRequests: [
        reconciliationPullRequest({ id: 201, number: 11 }),
        reconciliationPullRequest({ id: 210, number: 21 }),
      ],
    };
    const dependencies = reconciliationDependencies({
      github: {
        listIssues: vi.fn().mockResolvedValue([]),
        getPullRequestReviews: vi.fn(async () => []),
        getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
          if (number === 11) throw new GitHubApiError(404);
          return `diff ${number}`;
        }),
      },
    });
    dependencies.store.getReconciliationEvidence = async () => ({
      version: 1,
      formatVersion: RECONCILIATION_EVIDENCE_FORMAT,
      checkpoint: new Date(),
      lastFullPassAt: new Date(),
      omittedOversizedFacts: 0,
      issues: [referencedIssue],
      pullRequests: [
        { id: 201, reviews: [cachedReview], rawDiff: "cached diff 201" },
        { id: 210, reviews: [], rawDiff: "cached diff 210" },
      ],
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
    ];
    const discard = vi.fn().mockResolvedValue(undefined);
    dependencies.store.discardDirtyReconciliationSubject = discard;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({ skipped: false });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith({
        repositoryId: "repository", kind: "PULL_REQUEST", githubSubjectId: 201, generation: 7,
      });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "Reconciliation of repository repository discarded unresolvable subject kind=PULL_REQUEST number=11 reason=NOT_FOUND",
      );
      expect(
        vi.mocked(dependencies.github.getPullRequestDiff).mock.calls.map(([, number]) => number).sort((a, b) => a - b),
      ).toEqual([11]);
      const materializeInput = vi.mocked(dependencies.store.materialize).mock.calls[0]![0];
      expect(materializeInput.synchronization?.pullRequests).toEqual([
        { id: 201, reviews: [cachedReview], rawDiff: "cached diff 201" },
        { id: 210, reviews: [], rawDiff: "cached diff 210" },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails the run without discarding when a merged closing pull request's evidence fetch fails transiently", async () => {
    const transient = new GitHubApiError(403, true, 60);
    const dependencies = reconciliationDependencies({
      github: {
        getPullRequestReviews: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
          if (number === 11) throw transient;
          return [];
        }),
      },
    });
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

  it("fails the run without discarding when a merged closing pull request's evidence fetch fails with a server error", async () => {
    // Negative control above the gone-subject status: a 5xx is transient or
    // run-invalidating, so no subject arm may fire for it even when the
    // subject carries a dirty row.
    const serverError = new GitHubApiError(500, false, null);
    const dependencies = reconciliationDependencies({
      github: {
        getPullRequestDiff: vi.fn(async (_reference: GitHubRepositoryReference, number: number) => {
          if (number === 11) throw serverError;
          return `diff ${number}`;
        }),
      },
    });
    dependencies.store.getDirtyReconciliationSubjects = async () => [
      { kind: "PULL_REQUEST" as const, id: 201, number: 11, generation: 7 },
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(reconcileRepository(dependencies, "repository")).rejects.toMatchObject({
        message: "Unable to reconcile repository.",
      });
      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.discardDirtyReconciliationSubject).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining("discarded unresolvable subject"));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails the run without discarding when a dirty subject fails transiently", async () => {
    const transient = new GitHubApiError(403, true, 60);
    const dependencies = reconciliationDependencies({
      github: {
        getIssue: vi.fn(async () => {
          throw transient;
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
      { kind: "ISSUE" as const, id: 555, number: 43, generation: 8 },
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
      expect(dependencies.github.listIssues).toHaveBeenCalledWith({ owner: "octo", name: "example" }, expect.objectContaining({ timelineWatchedLabels: new Set(["M"]) }));
      expect(materialize).toHaveBeenCalledOnce();
    },
  );

  it("crawls the path the registered numeric identity resolves to, not the stored one", async () => {
    const dependencies = reconciliationDependencies({
      github: {
        getRepositoryById: vi.fn().mockResolvedValue(
          verifiedRepository({ owner: "new-owner", name: "repo", fullName: "new-owner/repo" }),
        ),
      },
    });
    const repository = await dependencies.store.getRepository("repository");
    repository!.ownerName = "old-owner/repo";
    (dependencies.store.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

    await reconcileRepository(dependencies, "repository");

    const reference = { owner: "new-owner", name: "repo" };
    expect(dependencies.github.listIssues).toHaveBeenCalledWith(reference, expect.objectContaining({ timelineWatchedLabels: new Set(["M"]) }));
    expect(dependencies.github.getPullRequestReviews).toHaveBeenCalledWith(reference, 11);
    expect(dependencies.github.getPullRequestDiff).toHaveBeenCalledWith(reference, 11);
    expect(dependencies.github.getRepositoryById).toHaveBeenCalledWith(5001);
    expect(dependencies.store.recordVerifiedRepositoryIdentity).toHaveBeenCalledWith({
      repositoryId: "repository",
      ownerName: "new-owner/repo",
      visibility: "PUBLIC",
    });
  });

  it.each([
    { reason: "NOT_FOUND", verified: null },
    { reason: "IDENTITY_MISMATCH", verified: verifiedRepository({ id: 6002 }) },
    { reason: "NOT_PUBLIC", verified: verifiedRepository({ visibility: "PRIVATE" }) },
  ] as const)("declines the crawl and records $reason instead of materializing another repository", async ({ reason, verified }) => {
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    const dependencies = reconciliationDependencies({
      github: { getRepositoryById: vi.fn().mockResolvedValue(verified) },
    });

    const summary = await reconcileRepository({ ...dependencies, now }, "repository");

    expect(summary).toEqual({
      repositoryId: "repository",
      runId: "run-1",
      skipped: false,
      adds: 0,
      changes: 0,
      removals: 0,
      added: 0,
      changed: 0,
      removed: 0,
    });
    expect(dependencies.store.markRepositoryUnavailable).toHaveBeenCalledExactlyOnceWith({
      repositoryId: "repository",
      reason,
      at: now(),
    });
    expect(dependencies.store.completeRun).toHaveBeenCalledWith("run-1");
    expect(dependencies.store.setReconciliationCooldown).toHaveBeenCalledWith("repository", null);
    expect(dependencies.store.failRun).not.toHaveBeenCalled();
    expect(dependencies.store.materialize).not.toHaveBeenCalled();
    expect(dependencies.store.findUsersByGitHubUserIds).not.toHaveBeenCalled();
    expect(dependencies.store.recordVerifiedRepositoryIdentity).not.toHaveBeenCalled();
    expect(dependencies.github.listIssues).not.toHaveBeenCalled();
  });

  it("records the verified identity of an unrenamed repository and reconciles it", async () => {
    const dependencies = reconciliationDependencies();

    await expect(reconcileRepository(dependencies, "repository")).resolves.toMatchObject({
      runId: "run-1",
      adds: 1,
      changes: 0,
      removals: 0,
    });

    expect(dependencies.store.recordVerifiedRepositoryIdentity).toHaveBeenCalledExactlyOnceWith({
      repositoryId: "repository",
      ownerName: "octo/example",
      visibility: "PUBLIC",
    });
    expect(dependencies.store.markRepositoryUnavailable).not.toHaveBeenCalled();
    expect(dependencies.github.listIssues).toHaveBeenCalledWith({ owner: "octo", name: "example" }, expect.objectContaining({ timelineWatchedLabels: new Set(["M"]) }));
    expect(dependencies.store.materialize).toHaveBeenCalledOnce();
  });

  it.each([false, true])("fails the run when identity verification itself fails, rateLimited=%s", async (rateLimited) => {
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    const upstream = new GitHubApiError(403, rateLimited, 120);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dependencies = reconciliationDependencies({
        github: { getRepositoryById: vi.fn().mockRejectedValue(upstream) },
      });

      await expect(reconcileRepository({ ...dependencies, now }, "repository")).rejects.toMatchObject({ cause: upstream });

      expect(dependencies.store.failRun).toHaveBeenCalledWith("run-1", "Reconciliation failed.", null);
      expect(dependencies.store.markRepositoryUnavailable).not.toHaveBeenCalled();
      expect(dependencies.github.listIssues).not.toHaveBeenCalled();
      expect(vi.mocked(dependencies.store.setReconciliationCooldown).mock.calls).toEqual(
        rateLimited ? [["repository", new Date(now().getTime() + 120 * 1000)]] : [],
      );
    } finally {
      errorLog.mockRestore();
    }
  });

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
    // Moderation is not unavailability: a repository GitHub still serves must not be
    // stamped unavailable, nor spend a request, because a moderator switched it off.
    expect(dependencies.github.getRepositoryById).not.toHaveBeenCalled();
    expect(dependencies.store.markRepositoryUnavailable).not.toHaveBeenCalled();
  });

  it("spends nothing on a repository still inside its cooldown", async () => {
    const dependencies = reconciliationDependencies();
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    vi.mocked(dependencies.store.getReconciliationCooldown)
      .mockResolvedValue(new Date(now().getTime() + 1));

    const summary = await reconcileRepository({ ...dependencies, now }, "repository");

    expect(summary).toMatchObject({ skipped: true, runId: null, adds: 0, changes: 0, removals: 0 });
    expect(dependencies.store.beginRun).not.toHaveBeenCalled();
    expect(dependencies.github.getRepositoryById).not.toHaveBeenCalled();
    expect(dependencies.store.markRepositoryUnavailable).not.toHaveBeenCalled();
  });

  it("does not read the gateway dependency for a repository still inside its cooldown", async () => {
    const dependencies = reconciliationDependencies();
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    vi.mocked(dependencies.store.getReconciliationCooldown)
      .mockResolvedValue(new Date(now().getTime() + 1));
    const githubReads = vi.fn(() => dependencies.github);
    const lazyDependencies = Object.defineProperty({ ...dependencies, now }, "github", {
      get: githubReads, enumerable: true,
    });

    const summary = await reconcileRepository(lazyDependencies, "repository");

    expect(summary).toMatchObject({ skipped: true, runId: null });
    expect(githubReads).not.toHaveBeenCalled();
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

  it("encodes forge text at the failure log when the GitLab read fails", async () => {
    // The member chooses the GitLab instance, so every string it returns is
    // member-supplied: this `updated_at` splits into a forged journal line
    // shaped like a privileged-action report and carries raw terminal escapes.
    const hostile = "2026-01-01\nPrivileged action {\n  action: 'moderator-role.grant'\n}\n\u001b[2J\u001b[31mspoofed";
    const gitlabProject = {
      id: 5001,
      name: "example",
      path: "example",
      path_with_namespace: "octo/example",
      visibility: "public",
      web_url: "https://gitlab.test/octo/example",
      namespace: { id: 1, name: "Octo", path: "octo", kind: "group" },
      permissions: { project_access: { access_level: 40 } },
    };
    const hostileIssue = {
      id: 6600001,
      iid: 12,
      project_id: 5001,
      title: "Broken ledger",
      description: "It broke.",
      state: "opened",
      web_url: "https://gitlab.test/octo/example/-/issues/12",
      author: { id: 901, username: "sponsor" },
      labels: [],
      created_at: "2026-09-10T06:00:00.000Z",
      updated_at: hostile,
      closed_at: null,
      assignees: [{ id: 902, username: "claimer" }],
    };
    const gateway = new GitLabGateway({
      instanceUrl: "https://gitlab.test",
      token: "synthetic-pat",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/projects/5001")) return Response.json(gitlabProject);
        if (url.includes("/issues?")) return Response.json([hostileIssue]);
        // Per-issue evidence collections (label events, notes, closed_by).
        return Response.json([]);
      },
    });
    const calls: unknown[][] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      // The harness spreads the github override over its own mocks, and a
      // class instance's methods live on its prototype — bind the real
      // gateway's methods explicitly so the real gateway serves the fold.
      const gatewayBindings: ReconciliationDependencies["github"] = {
        getRepositoryById: (githubRepositoryId) => gateway.getRepositoryById(githubRepositoryId),
        listIssues: (repository, options) => gateway.listIssues(repository, options),
        getIssue: (repository, subject) => gateway.getIssue(repository, subject),
        getPullRequestClosingIssues: (repository, subject) => gateway.getPullRequestClosingIssues(repository, subject),
        getPullRequestReviews: (repository, pullRequestNumber) => gateway.getPullRequestReviews(repository, pullRequestNumber),
        getPullRequestDiff: (repository, pullRequestNumber) => gateway.getPullRequestDiff(repository, pullRequestNumber),
      };
      const dependencies = reconciliationDependencies({ github: gatewayBindings });
      await expect(reconcileRepository(dependencies, "repository")).rejects.toThrow("Unable to reconcile repository.");

      expect(calls).toHaveLength(1);
      const rendered = format(...calls[0]!);
      // The log line is exactly one line: the fixed message plus the error as
      // one encoded token — the raw object (whose stack carries the forge text
      // raw) is never passed.
      expect(rendered).not.toContain("\n");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).toBe(`Reconciliation of repository repository failed. ${
        errorLogToken(new Error(`GitLab returned an unparsable timestamp: ${logField(hostile)}`))
      }`);
    } finally {
      errorLog.mockRestore();
    }
  });
});

function deferredCall() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

