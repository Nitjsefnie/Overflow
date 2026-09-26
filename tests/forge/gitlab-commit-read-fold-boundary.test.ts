import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ForgeCredentialRejectedError } from "@/lib/forge/gateway";
import {
  FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE,
  reconcileRepository,
  type ReconciliationRepository,
  type ReconciliationStore,
} from "@/lib/fold/reconcile";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";

// Release modules evaluated with this file's transport double.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

// The sponsor gateway builds its GitLabGateway on the default transport, which
// refuses a non-public instance and has no injection seam here; route it to
// the global fetch each test stubs.
vi.mock("@/lib/security/gitlab-api-fetch", () => ({
  gitlabApiFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * The fold boundary for the MR commit read: `withFinalCommitAt` supplies the
 * `finalCommitAt` the settlement-evidence window reads, so a credential
 * failure on that read must reach the fold/reconcile caller as the credential
 * failure it is — never as a completed run whose fold was computed with
 * `finalCommitAt = null`, the shape the swallowed error used to produce (the
 * selector then silently refused the merge request). The inner gateway is the
 * real GitLabGateway over a stubbed transport, so the statuses are the ones
 * the wire produces, and the whole reconciliation runs end-to-end through
 * `reconcileRepositoryAsSponsor` over a planted store.
 */
describe("a credential failure on the GitLab MR commits read never folds a settlement", () => {
  const INSTANCE = "https://gitlab.example.com";
  const REPOSITORY_ID = "repo-1";

  function repositoryRow(): ReconciliationRepository {
    return {
      id: REPOSITORY_ID,
      githubRepositoryId: 278964,
      ownerName: "gitlab-org/gitlab",
      active: true,
      registeredAt: "2026-09-01T00:00:00.000Z",
      sponsor: { id: "sponsor-1", githubUserId: 901, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
      difficultySchemeVersions: [],
      provider: "gitlab",
      instanceUrl: INSTANCE,
    };
  }

  function plantedStore() {
    const materialize = vi.fn(async (_input: Parameters<ReconciliationStore["materialize"]>[0]) => {
      void _input;
      return { adds: 0, changes: 0, removals: 0 };
    });
    const failRun = vi.fn(async () => {});
    const completeRun = vi.fn(async () => {});
    const store: ReconciliationStore = {
      withRepositoryReconciliation: async (_repositoryId, work) => work(),
      getRepository: async () => repositoryRow(),
      findForgeIdentitiesByForgeUserIds: async () => [],
      assessReconciliationFairness: async () => ({
        state: "ADMITTED",
        holdUntil: null,
        usage: { debt: 0, measuredAt: new Date(), ratePerSecond: 0 },
      }),
      getReconciliationEvidence: async () => null,
      getDirtyReconciliationSubjects: async () => [],
      discardDirtyReconciliationSubject: async () => {},
      getReconciliationCooldown: async () => null,
      setReconciliationCooldown: async () => {},
      // Read on every fold before the first forge read, GitLab included.
      getGitHubAccessToken: async () => "unused-github-token",
      findUsersByGitHubUserIds: async () => [],
      hasDerivedRowsBelowFoldRevision: async () => false,
      beginRun: async () => "run-1",
      completeRun,
      materialize,
      failRun,
      recordVerifiedRepositoryIdentity: async () => {},
      markRepositoryUnavailable: async () => {},
    };
    return { store, materialize, failRun, completeRun };
  }

  /**
   * The transport the real GitLabGateway is built over. The merge-request read
   * succeeds everywhere it is read — the closed_by listing carries one merged
   * merge request — while the `/merge_requests/17/commits` read answers what
   * the test plants. The raw_diffs route serves only the healthy control:
   * evidence is collected only once the commits read has answered.
   */
  function forgeTransport(commits: { status: 200 | 401 | 403; body?: unknown }): typeof fetch {
    const json = (body: unknown) => Response.json(body);
    return async (input) => {
      const url = String(input);
      if (url.includes("/merge_requests/17/commits")) {
        return commits.status < 300
          ? json(commits.body ?? [])
          : new Response(String(commits.body), { status: commits.status });
      }
      if (url.includes("/merge_requests/17/raw_diffs")) {
        return new Response("diff --git a/f b/f\n", { status: 200 });
      }
      if (url.includes("/resource_label_events")) {
        return json([
          { id: 142, user: { id: 901, username: "sponsor" }, created_at: "2026-09-11T08:10:00.000Z", label: { id: 73, name: "S", color: "#34495E", description: "" }, action: "add" },
          { id: 143, user: { id: 901, username: "sponsor" }, created_at: "2026-09-11T11:30:00.000Z", label: { id: 74, name: "delivered/6", color: "#0033CC", description: "" }, action: "add" },
        ]);
      }
      if (url.includes("/notes")) {
        return json([{
          id: 305,
          body: "delivered/6 — landed within the window.",
          author: { id: 901, username: "sponsor" },
          created_at: "2026-09-11T11:45:00.000Z",
          updated_at: "2026-09-11T11:45:00.000Z",
          system: false,
        }]);
      }
      if (url.includes("/closed_by")) {
        return json([{
          id: 5_500_001,
          iid: 17,
          project_id: 278964,
          title: "Fix the ledger",
          description: "Closes #12",
          state: "merged",
          web_url: `${INSTANCE}/gitlab-org/gitlab/-/merge_requests/17`,
          author: { id: 900, username: "contributor" },
          created_at: "2026-09-11T09:00:00.000Z",
          updated_at: "2026-09-11T12:00:00.000Z",
          merged_at: "2026-09-11T12:00:00.000Z",
          merge_commit_sha: "a".repeat(40),
          sha: "b".repeat(40),
          squash_commit_sha: "c".repeat(40),
        }]);
      }
      if (url.includes("/issues?")) {
        return json([{
          id: 6_600_001,
          iid: 12,
          project_id: 278964,
          title: "Broken ledger",
          description: "It broke.",
          state: "closed",
          web_url: `${INSTANCE}/gitlab-org/gitlab/-/issues/12`,
          author: { id: 901, username: "sponsor" },
          labels: ["S", "delivered/6"],
          created_at: "2026-09-11T08:00:00.000Z",
          updated_at: "2026-09-11T12:05:00.000Z",
          closed_at: "2026-09-11T12:00:00.000Z",
          assignees: [{ id: 901, username: "sponsor" }],
        }]);
      }
      if (url.includes("/projects/278964")) {
        return json({
          id: 278964,
          name: "gitlab",
          path: "gitlab",
          path_with_namespace: "gitlab-org/gitlab",
          visibility: "public",
          web_url: `${INSTANCE}/gitlab-org/gitlab`,
          namespace: { id: 1, name: "GitLab.org", path: "gitlab-org", kind: "group" },
          permissions: { project_access: { access_level: 40 } },
        });
      }
      return new Response(`no route: ${url}`, { status: 404 });
    };
  }

  it.each([401, 403] as const)(
    "surfaces a %d commits read to the caller and records the credential failure, folding nothing",
    async (status) => {
      // The planted body stands in for upstream error text; it must reach no
      // caller surface and no stored failure.
      vi.stubGlobal("fetch", forgeTransport({ status, body: `${status}_denied glpat-sponsor-secret` }));
      const mark = vi.fn(async () => {});
      const { store, materialize, failRun, completeRun } = plantedStore();
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const reconcileAsSponsor = (gitLabStore: ReconciliationStore) => reconcileRepositoryAsSponsor(
        gitLabStore,
        REPOSITORY_ID,
        () => {
          throw new Error("the GitHub factory must not run for a GitLab fold");
        },
        {
          resolveForgeToken: async () => ({ token: "glpat-linked-identity-token", identityId: "identity-1" }),
          markCredentialRejected: mark,
        },
      );
      try {
        const failure = await reconcileAsSponsor(store).then(() => null, (caught: unknown) => caught);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("Unable to reconcile repository.");
        expect((failure as Error).cause).toBeInstanceOf(ForgeCredentialRejectedError);
        expect(inspect(failure)).not.toContain("glpat-sponsor-secret");
        expect(mark).toHaveBeenCalledExactlyOnceWith("identity-1");
        expect(failRun).toHaveBeenCalledExactlyOnceWith("run-1", FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE);
        expect(inspect(failRun.mock.calls)).not.toContain("glpat-sponsor-secret");
        // The old behavior's signature: a completed run whose fold was computed
        // with finalCommitAt = null (the selector then silently refused the
        // merge request). The credential failure must leave nothing behind.
        expect(materialize).not.toHaveBeenCalled();
        expect(completeRun).not.toHaveBeenCalled();
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("folds the same merged merge request into a settlement once the commits read answers", async () => {
    // The control that makes the two failures above mean something: the only
    // difference is the commits read's answer, and with a valid finalCommitAt
    // the very same merge request is selected and settled.
    vi.stubGlobal("fetch", forgeTransport({ status: 200, body: [{ committed_date: "2026-09-11T11:45:00.000Z" }] }));
    const { store, materialize, failRun } = plantedStore();

    const summary = await reconcileRepositoryAsSponsor(
      store,
      REPOSITORY_ID,
      () => {
        throw new Error("the GitHub factory must not run for a GitLab fold");
      },
      { resolveForgeToken: async () => ({ token: "glpat-linked-identity-token", identityId: "identity-1" }) },
    );

    expect(summary).toMatchObject({ repositoryId: REPOSITORY_ID, runId: "run-1", skipped: false });
    expect(failRun).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledTimes(1);
    const fold = materialize.mock.calls[0]![0].fold;
    expect(fold.settlements).toHaveLength(1);
    // The author's forge identity is unlinked in this store, so the settlement
    // is UNCLAIMED — selected and folded regardless of crediting.
    expect(fold.settlements[0]).toMatchObject({
      status: "UNCLAIMED",
      githubIssueId: 6_600_001,
      githubPullRequestId: 5_500_001,
      provider: "gitlab",
    });
  });

  it("propagates a plain GitLabApiError 401 on the commits read through the non-sponsor reconcile path", async () => {
    // The plain path has no credential guard, so the same wire failure keeps
    // its original shape: the run fails, the stored message is the generic
    // one, and again no fold is ever computed. The gateway is injected
    // directly, so this test needs no transport mock — the real client reads
    // through its own fetch seam.
    const { store, materialize, failRun, completeRun } = plantedStore();
    const gateway = new GitLabGateway({
      instanceUrl: INSTANCE,
      token: "glpat-linked-identity-token",
      fetch: forgeTransport({ status: 401, body: "401_denied" }),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failure = await reconcileRepository({ store, github: gateway }, REPOSITORY_ID)
        .then(() => null, (caught: unknown) => caught);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Unable to reconcile repository.");
      expect((failure as Error).cause).toBeInstanceOf(GitLabApiError);
      expect(((failure as Error).cause as GitLabApiError).status).toBe(401);
      expect(failRun).toHaveBeenCalledExactlyOnceWith("run-1", "Reconciliation failed.");
      expect(materialize).not.toHaveBeenCalled();
      expect(completeRun).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
