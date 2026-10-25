import { withSweepPass, type ReconciliationSweepControl, type SweepPass } from "@/lib/fold/sweep-pass";
import type { ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import { SweepBudgetSpent, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { reconciliationBudgetHoldUntil, type ReconciliationBudgetDependencies } from "@/lib/fold/reconciliation-budget";
import type { GitHubIssueListOptions } from "@/lib/github/client";
import { DEFAULT_GRAPHQL_BUDGET_RESERVE, type GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";
import { mapWithConcurrency } from "@/lib/async/map-with-concurrency";
import { withTransientRequestRetry } from "@/lib/fold/reconciliation-retry";
import { GitHubApiError, GitHubGraphqlRequestError, findGitHubRateLimitError, githubRateLimitNotBefore, isGitHubSubjectNotFoundError, MAX_ERROR_CAUSE_READS } from "@/lib/github/errors";
import { GitHubResponseTooLargeError } from "@/lib/github/response-text";
import { GitLabApiError } from "@/lib/gitlab/client";
import { GraphqlBudgetHeld, withGraphqlRequestBudget } from "@/lib/github/graphql-request-budget";
import { withGraphqlFoldCost } from "@/lib/github/graphql-cost";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
import { errorLogToken } from "@/lib/webhooks/log-field";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { ForgeCredentialRejectedError } from "@/lib/forge/gateway";
import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { redactPostgresError } from "@/lib/db/redact-postgres-error";
import type { ReconciliationCostCharge, ReconciliationFairnessAssessment } from "@/lib/fold/reconciliation-fairness";
import {
  RECONCILIATION_EVIDENCE_FORMAT,
  type DirtyReconciliationSubject,
  type ReconciliationEvidence,
  type ReconciliationSynchronization,
} from "@/lib/fold/reconciliation-evidence";
import { foldRepository, type FoldForgeIdentity, type FoldResult, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type {
  GitHubIssue,
  GitHubIssueReference,
  GitHubSubject,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
} from "@/lib/github/types";

// Cap this reconciliation at four HTTP requests: each PR worker paginates
// reviews, then dismissals, then fetches its diff, one request at a time.
const reconciliationConcurrency = 4;
const reconciliationOverlapMs = 60_000;
const reconciliationFullRepairMs = 6 * 60 * 60_000;

export { DEFAULT_RECONCILIATION_COOLDOWN_SECONDS } from "@/lib/github/errors";

// The stored failure for a fold that died on a rejected linked credential — a
// code constant for the same reason the generic message below is one (the runs
// table is read by the product), and the sentence names the repair: re-link.
export const FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE =
  "Reconciliation failed: the linked GitLab credential was rejected. Re-link the identity to restore folding.";

// Reconciliation resolves the registered repository by the identity GitHub cannot
// reassign, and so does the fold: the snapshot repository carries it, so there is
// one declaration of where the registered identity lives rather than two.
export type ReconciliationRepository = RepositoryFoldSnapshot["repository"] & {
  disputePullRequests: GitHubSubject[];
};

export type RepositoryUnavailableReason = "NOT_FOUND" | "NOT_PUBLIC" | "IDENTITY_MISMATCH";

export type ReconciliationGateway = {
  getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null>;
  listIssues(repository: GitHubRepositoryReference, options?: GitHubIssueListOptions): Promise<GitHubIssue[]>;
  getIssue(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssue | null>;
  getPullRequestClosingIssues(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssueReference[]>;
  getPullRequestReviews(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]>;
  getPullRequestDiff(repository: GitHubRepositoryReference, pullRequestNumber: number): Promise<string>;
};

export type ReconciliationDeltas = {
  adds: number;
  changes: number;
  removals: number;
};

export type ReconciliationHeldBy = "SWEEP_REQUEST_BUDGET" | "GRAPHQL_BUDGET";

export type ReconciliationStore = {
  withRepositoryReconciliation<T>(repositoryId: string, work: () => Promise<T>): Promise<T>;
  getRepository(repositoryId: string): Promise<ReconciliationRepository | null>;
  /**
   * The linked identities matching THIS repository's provider and instance,
   * for the given forge user ids — the fold's GitLab author candidates. The
   * store scopes the match to the exact triple's repository-side columns, so
   * the fold's match is the triple by construction. Optional: only the GitLab
   * path consults it, and production's fold store always implements it —
   * absent, GitLab authors resolve as unlinked (the UNCLAIMED posture), so
   * GitHub-only test fakes never need to stub it.
   */
  findForgeIdentitiesByForgeUserIds?(
    repositoryId: string,
    forgeUserIds: number[],
  ): Promise<FoldForgeIdentity[]>;
  assessReconciliationFairness(input: {
    repositoryId: string;
    sponsorId: string;
    budget: GitHubGraphqlBudgetAssessment;
    now: Date;
  }): Promise<ReconciliationFairnessAssessment>;
  getReconciliationEvidence(repositoryId: string): Promise<ReconciliationEvidence | null>;
  getDirtyReconciliationSubjects(repositoryId: string): Promise<DirtyReconciliationSubject[]>;
  // Required: an undiscarded dirty row would re-journal the unresolvable
  // subject on every run. Production stores discard eagerly for that reason.
  discardDirtyReconciliationSubject(input: {
    repositoryId: string;
    kind: DirtyReconciliationSubject["kind"];
    githubSubjectId: number;
    generation: number;
  }): Promise<void>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
  setReconciliationCooldown(repositoryId: string, notBefore: Date | null): Promise<void>;
  getGitHubAccessToken(userId: string): Promise<string | null>;
  findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]>;
  hasDerivedRowsBelowFoldRevision(repositoryId: string, revision: number): Promise<boolean>;
  beginRun(repositoryId: string, options?: { rederivation: boolean }): Promise<string>;
  completeRun(runId: string): Promise<void>;
  materialize(input: { repositoryId: string; runId: string; fold: FoldResult; synchronization?: ReconciliationSynchronization; cost?: ReconciliationCostCharge }): Promise<ReconciliationDeltas>;
  failRun(runId: string, errorMessage: string, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void>;
  holdRun(runId: string, message: string, heldBy: ReconciliationHeldBy, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void>;
  recordVerifiedRepositoryIdentity(input: {
    repositoryId: string;
    ownerName: string;
    visibility: "PUBLIC";
  }): Promise<void>;
  markRepositoryUnavailable(input: {
    repositoryId: string;
    reason: RepositoryUnavailableReason;
    at: Date;
  }): Promise<void>;
};

export type ReconciliationDependencies = ReconciliationBudgetDependencies & {
  store: ReconciliationStore;
  github: ReconciliationGateway;
  sweep?: ReconciliationSweepControl;
  now?: () => Date;
};

export type ReconciliationSummary = ReconciliationDeltas & {
  repositoryId: string;
  added: number;
  changed: number;
  removed: number;
} & ({ skipped: false; runId: string } | { skipped: true; runId: null; budgetHeldUntil?: Date; fairnessHeldUntil?: Date; sweepHeldUntil?: Date; sweepPending?: boolean });

export async function reconcileRepository(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  options?: { rederive?: boolean; reason?: ReconciliationJobReason },
): Promise<ReconciliationSummary> {
  // Forward every dependency lazily: a spread would read each property (the
  // budget getter included) before the coordinated run reads it, and a getter
  // that throws there escapes the admission path that tolerates it.
  const sanitizedGateway = sanitizeReconciliationGateway(() => withTransientRequestRetry(dependencies.github));
  const sanitizedDependencies = new Proxy(dependencies, {
    get: (target, property, receiver) => property === "github"
      ? sanitizedGateway
      : Reflect.get(target, property, receiver),
  });
  return dependencies.store.withRepositoryReconciliation(
    repositoryId,
    () => reconcileRepositoryWhileCoordinated(sanitizedDependencies, repositoryId, options),
  );
}

function sanitizeReconciliationGateway(current: () => ReconciliationGateway): ReconciliationGateway {
  return {
    getRepositoryById: async (...args) => sanitizeForgeStrings(await current().getRepositoryById(...args)),
    listIssues: async (...args) => sanitizeForgeStrings(await current().listIssues(...args)),
    getIssue: async (...args) => sanitizeForgeStrings(await current().getIssue(...args)),
    getPullRequestClosingIssues: async (...args) => sanitizeForgeStrings(await current().getPullRequestClosingIssues(...args)),
    getPullRequestReviews: async (...args) => sanitizeForgeStrings(await current().getPullRequestReviews(...args)),
    getPullRequestDiff: async (...args) => sanitizeForgeStrings(await current().getPullRequestDiff(...args)),
  };
}

async function reconcileRepositoryWhileCoordinated(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  options?: { rederive?: boolean; reason?: ReconciliationJobReason },
): Promise<ReconciliationSummary> {
  const repository = await dependencies.store.getRepository(repositoryId);
  if (repository === null) {
    throw new Error("Repository was not found.");
  }

  return dependencies.sweep === undefined
    ? reconcileRepositoryAfterRepositoryRead(dependencies, repository, repositoryId, options)
    : withSweepRequestBudget(() => dependencies.sweep!.spend(repository.sponsor.id),
      () => reconcileRepositoryAfterRepositoryRead(dependencies, repository, repositoryId, options));
}

async function reconcileRepositoryAfterRepositoryRead(
  dependencies: ReconciliationDependencies,
  repository: ReconciliationRepository,
  repositoryId: string,
  options?: { rederive?: boolean; reason?: ReconciliationJobReason },
): Promise<ReconciliationSummary> {
  // One unresolvable subject must not stall the repository's fold: a deleted
  // issue or pull request can never resolve, and the retry machinery (the sweep
  // revives FAILED jobs with attempts reset) would retry it forever. The
  // classifier names the durable failure class the failure belongs to — a
  // NOT_FOUND is definitive, a pull request whose diff GitHub refuses under
  // its 20000-line cap (a fixed 406) can never read, and a body past the
  // client's success-path byte cap can never be read any smaller — so its dirty
  // row is discarded and the remaining subjects keep the run alive; any other
  // per-subject failure keeps whole-run retry semantics. The journal line names
  // the subject's identity and the failure class only, matching the
  // reconciliation queue's rule against storing upstream error text.
  const discardUnresolvableSubject = async (
    failure: unknown,
    kind: DirtyReconciliationSubject["kind"],
    subject: GitHubSubject,
    dirty: DirtyReconciliationSubject | undefined,
    classifyDiscard: (error: unknown) => SubjectDiscardReason | null = defaultSubjectDiscardReason,
  ): Promise<boolean> => {
    const reason = classifyDiscard(failure);
    if (reason === null) return false;
    if (dirty !== undefined) {
      await dependencies.store.discardDirtyReconciliationSubject({
        repositoryId,
        kind: dirty.kind,
        githubSubjectId: dirty.id,
        generation: dirty.generation,
      });
    }
    console.error(`Reconciliation of repository ${repositoryId} discarded unresolvable subject kind=${kind} number=${subject.number} reason=${reason}`);
    return true;
  };

  const now = dependencies.now ?? (() => new Date());
  const notBefore = await dependencies.store.getReconciliationCooldown(repositoryId);
  // Read under the repository lock so a queued webhook sees the previous run's cooldown.
  if (notBefore !== null && notBefore.getTime() > now().getTime()) {
    return { repositoryId, runId: null, skipped: true, adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
  }

  // The repository lock and sponsor identity scope admission for every fold caller.
  const admissionAt = now();
  const captured: { assessment: GitHubGraphqlBudgetAssessment } = {
    assessment: { state: "UNKNOWN", reading: null, reserve: DEFAULT_GRAPHQL_BUDGET_RESERVE },
  };
  const budgetHeldUntil = repository.active
    ? reconciliationBudgetHoldUntil(dependencies, repository.sponsor.id, () => admissionAt,
      (assessment) => { captured.assessment = assessment; }) : null;
  if (budgetHeldUntil !== null) {
    return { repositoryId, runId: null, skipped: true, budgetHeldUntil,
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
  }

  let fairnessAvailable = false;
  try {
    const { state, reading, reserve } = captured.assessment;
    fairnessAvailable = repository.active && state === "AVAILABLE" && reading !== null
      && Number.isFinite(reading.remaining) && reading.remaining >= 0
      && Number.isFinite(reserve) && reserve >= 0
      && Number.isFinite(new Date(reading.observedAt.getTime()).getTime())
      && Number.isFinite(new Date(reading.resetAt.getTime()).getTime())
      && reading.resetAt.getTime() > admissionAt.getTime();
  } catch {
    // An unreadable observation cannot turn fail-open admission into a retry.
  }
  if (fairnessAvailable) {
    const assessment = await dependencies.store.assessReconciliationFairness({
      repositoryId, sponsorId: repository.sponsor.id, budget: captured.assessment, now: admissionAt,
    });
    if (assessment.state === "HELD" && assessment.holdUntil instanceof Date
      && Number.isFinite(assessment.holdUntil.getTime()) && assessment.holdUntil.getTime() > admissionAt.getTime()) {
      return { repositoryId, runId: null, skipped: true, fairnessHeldUntil: assessment.holdUntil,
        adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
    }
  }

  const allowsFull = options?.reason === undefined || options.reason === "SWEEP";
  const rederive = allowsFull && (options?.rederive === true
    || await dependencies.store.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION));
  const runId = await dependencies.store.beginRun(repositoryId, { rederivation: rederive });
  let failedCost: Omit<ReconciliationCostCharge, "completedAt"> | null = null;
  let pass: SweepPass | undefined;
  const discardPass = async () => {
    try { await pass?.complete(); } catch { console.error("Could not discard reconciliation sweep checkpoints."); }
  };
  try {
    if (!repository.active) {
      await dependencies.sweep?.discardPass(repositoryId);
      await dependencies.store.completeRun(runId);
      await dependencies.store.setReconciliationCooldown(repositoryId, null);
      return noDeltaSummary(repositoryId, runId);
    }

    const collected = await withGraphqlFoldCost<ReconciliationSummary>(async (readCost) => {
      try {
        // Advance to scan start only after successful materialization. Completion
        // time could skip changes made while these upstream reads were in flight.
        let scanStartedAt = now();
        const [cached, observedDirtySubjects] = await Promise.all([
          dependencies.store.getReconciliationEvidence(repositoryId),
          dependencies.store.getDirtyReconciliationSubjects(repositoryId),
        ]);
        let dirtySubjects = observedDirtySubjects;
        // While the most recent write omitted oversized facts the cache has
        // holes; reading a hole as upstream absence would destroy the subject's
        // materialized rows on a quiet partial pass. Fold full passes until a
        // pass re-observes everything within the limit and clears the flag.
        const unsafeCache = cached === null || cached.formatVersion !== RECONCILIATION_EVIDENCE_FORMAT
          || cached.omittedOversizedFacts > 0;
        if (!allowsFull && unsafeCache) {
          await dependencies.store.completeRun(runId);
          return { repositoryId, runId: null, skipped: true, sweepPending: true,
            adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
        }
        const accessToken = await dependencies.store.getGitHubAccessToken(repository.sponsor.id);
        if (accessToken === null) {
          throw new Error("GitHub access token was not available.");
        }

        const full = allowsFull && (options?.reason === "SWEEP" || unsafeCache || rederive
          || scanStartedAt.getTime() - cached!.lastFullPassAt.getTime() >= reconciliationFullRepairMs);

        pass = full && dependencies.sweep !== undefined
          ? await dependencies.sweep.openPass({ repositoryId,
            evidenceVersion: JSON.stringify([cached?.version ?? null, FOLD_REVISION, repository.difficultyScheme]),
            scanStartedAt, dirtySubjects }) : undefined;
        if (pass !== undefined) {
          scanStartedAt = pass.scanStartedAt;
          dirtySubjects = pass.dirtySubjects;
        }
        // The stored path is a display name GitHub reassigns to whoever takes it after a
        // rename or transfer, so every read below is aimed by the numeric identity instead.
        const verified = await dependencies.github.getRepositoryById(repository.githubRepositoryId);
        if (verified === null) {
          await discardPass();
          return declineCrawl(dependencies, repositoryId, runId, "NOT_FOUND", now());
        }
        // GitHub answering for an id other than the one asked for should be impossible;
        // decline rather than materialize whatever it did answer with.
        if (verified.id !== repository.githubRepositoryId) {
          await discardPass();
          return declineCrawl(dependencies, repositoryId, runId, "IDENTITY_MISMATCH", now());
        }
        // Only public repositories can be registered, and one that stopped being public
        // stops being crawled. This is nearly unobservable in production: the sponsor's
        // token carries only `admin:repo_hook`, so a repository that went private answers 404
        // and lands in NOT_FOUND above. The branch is kept for a broader-scoped token,
        // where materializing a private repository would be worse than declining.
        if (verified.visibility !== "PUBLIC") {
          await discardPass();
          return declineCrawl(dependencies, repositoryId, runId, "NOT_PUBLIC", now());
        }

        await dependencies.store.recordVerifiedRepositoryIdentity({
          repositoryId,
          ownerName: verified.fullName,
          visibility: verified.visibility,
        });
        return await withSweepPass(pass, async () => {
          const reference: GitHubRepositoryReference = { owner: verified.owner, name: verified.name };
          const { githubIssues, pullRequestEvidence } = await withGraphqlRequestBudget(
            () => reconciliationBudgetHoldUntil(dependencies, repository.sponsor.id, now),
            async () => {
              const changed = new Map((await dependencies.github.listIssues(reference, {
                ...(full ? {} : { since: new Date(cached!.checkpoint.getTime() - reconciliationOverlapMs).toISOString() }),
                timelineCriticalLabels: new Set(repository.difficultyScheme.actualLabels.map(({ label }) => label)),
                timelineWatchedLabels: new Set(repository.difficultyScheme.openingLabels.map(({ label }) => label)),
              })).map((issue) => [issue.id, issue]));
              const retained = new Map((full ? [] : cached!.issues).map((issue) => [issue.id, issue]));
              if (!full) {
                const affected = new Map<number, GitHubSubject>();
                for (const subject of dirtySubjects) {
                  if (subject.kind === "ISSUE") {
                    affected.set(subject.id, subject);
                  } else {
                    // Both sides matter when a PR edits away an old closing reference.
                    for (const issue of [...retained.values(), ...changed.values()]) {
                      if (issue.closingPullRequests.some((pr) => pr.id === subject.id && belongsToRegisteredRepository(repository, pr))) {
                        affected.set(issue.id, issue);
                      }
                    }
                    try {
                      const references = await dependencies.github.getPullRequestClosingIssues(reference, subject);
                      for (const issue of references) {
                        if (belongsToRegisteredRepository(repository, issue)) affected.set(issue.id, issue);
                      }
                    } catch (error) {
                      if (!(await discardUnresolvableSubject(error, subject.kind, subject, subject))) throw error;
                    }
                  }
                }
                const dirtyIssueSubjects = new Map(dirtySubjects
                  .filter(({ kind }) => kind === "ISSUE")
                  .map((subject) => [subject.id, subject]));
                for (const subject of affected.values()) {
                  if (changed.has(subject.id)) continue;
                  let issue: GitHubIssue | null;
                  try {
                    issue = await dependencies.github.getIssue(reference, subject);
                  } catch (error) {
                    if (!(await discardUnresolvableSubject(error, "ISSUE", subject, dirtyIssueSubjects.get(subject.id), issueDiscardReason))) {
                      throw error;
                    }
                    continue;
                  }
                  if (issue !== null) changed.set(issue.id, issue);
                }
              }
              for (const issue of changed.values()) retained.set(issue.id, issue);
              const githubIssues = [...retained.values()];
              const pullRequestEvidence = new Map((full ? [] : cached!.pullRequests)
                .map(({ id, reviews, rawDiff }) => [id, { reviews, rawDiff }]));
              // Closing references must meet the fold's repository and state checks.
              const referencedPullRequests = githubIssues.flatMap(({ closingPullRequests }) => closingPullRequests)
                .filter(pr => (pr.state === "CLOSED" || (pr.state === "MERGED" && pr.mergedAt !== null))
                  && belongsToRegisteredRepository(repository, pr));
              const disputePullRequests = repository.disputePullRequests;
              const changedPullRequestIds = new Set([...changed.values()].flatMap(({ closingPullRequests }) => closingPullRequests.map(pr => pr.id)));
              const dirtyPullRequestSubjects = new Map(dirtySubjects
                .filter(({ kind }) => kind === "PULL_REQUEST")
                .map((subject) => [subject.id, subject]));
              const refreshedEvidence = await collectPullRequestEvidence(
                dependencies.github,
                reference,
                [
                  ...referencedPullRequests.filter(({ id }) => full || changedPullRequestIds.has(id)
                    || dirtyPullRequestSubjects.has(id) || !pullRequestEvidence.has(id)),
                  ...disputePullRequests,
                ],
                discardUnresolvableSubject,
                dirtyPullRequestSubjects,
                new Set(disputePullRequests.map(pr => pr.id)),
              );
              for (const [id, evidence] of refreshedEvidence.evidence) pullRequestEvidence.set(id, evidence);
              const retainedPrIds = new Set([...referencedPullRequests, ...disputePullRequests]
                .filter(pr => !refreshedEvidence.missingDisputePrIds.has(pr.id)).map(({ id }) => id));
              for (const id of pullRequestEvidence.keys()) if (!retainedPrIds.has(id)) pullRequestEvidence.delete(id);
              return { githubIssues, pullRequestEvidence };
            },
          );
          // The same boundary the evidence fetch draws: an author is looked up
          // because their pull request might be credited here, and a pull request in
          // another repository never can be.
          const authorGitHubUserIds = [...new Set(
            githubIssues
              .flatMap(({ closingPullRequests }) => closingPullRequests)
              .filter((pullRequest) => belongsToRegisteredRepository(repository, pullRequest))
              .map((pullRequest) => pullRequest.authorGitHubUserId)
              .filter((githubUserId): githubUserId is number => githubUserId !== null),
          )];
          // GitLab authors resolve through linked identities on this repository's
          // provider and instance, not through the users table's GitHub ids.
          const forgeIdentities = repository.provider === "gitlab"
            ? await dependencies.store.findForgeIdentitiesByForgeUserIds?.(
                repositoryId,
                authorGitHubUserIds,
              )
            : undefined;
          const users = repository.provider === "gitlab"
            ? []
            : await dependencies.store.findUsersByGitHubUserIds(authorGitHubUserIds);
          const snapshot: RepositoryFoldSnapshot = {
            // The stored path can still carry the pre-rename name on the run that
            // first observes the rename — recordVerifiedRepositoryIdentity above
            // refreshes the database, not this in-memory value — so the fresh
            // verify rides along and the fold can name the current path beside the
            // stale one in a cross-repository reason.
            repository: {
              ...repository,
              observedOwnerName: verified.fullName,
            },
            users,
            forgeIdentities,
            issues: githubIssues.map((issue) => ({
              ...issue,
              claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin,
              claimAssigneeGitHubUserId: issue.claimAssigneeGitHubUserId,
              closingPullRequests: issue.closingPullRequests.map((pullRequest) => ({
                ...pullRequest,
                reviews: pullRequestEvidence.get(pullRequest.id)?.reviews ?? [],
                rawDiff: pullRequestEvidence.get(pullRequest.id)?.rawDiff ?? "",
              })),
            })),
          };
          const fold = foldRepository(snapshot);
          const cost: ReconciliationCostCharge = { ...readCost(), sponsorId: repository.sponsor.id, completedAt: now() };
          const deltas = await dependencies.store.materialize({ repositoryId, runId, fold, cost, synchronization: {
            expectedVersion: cached?.version ?? null, scanStartedAt, full, issues: githubIssues,
            pullRequests: [...pullRequestEvidence].map(([id, evidence]) => ({ id, ...evidence })), dirtySubjects,
          } });

          await discardPass();
          return {
            repositoryId,
            runId,
            skipped: false,
            ...deltas,
            added: deltas.adds,
            changed: deltas.changes,
            removed: deltas.removals,
          };
        });
      } catch (error) {
        // Capture before the scope rejects; the outer handlers persist only the run outcome.
        const observation = readCost();
        failedCost = observation.observedResponses > 0 || observation.unmeasuredResponses > 0
          ? { ...observation, sponsorId: repository.sponsor.id } : null;
        throw error;
      }
    });
    return collected.value;
  } catch (error) {
    if (error instanceof SweepBudgetSpent) {
      await dependencies.store.holdRun(runId, "Reconciliation held for the sweep request budget.", "SWEEP_REQUEST_BUDGET", failedCost);
      return { repositoryId, runId: null, skipped: true, sweepHeldUntil: error.resetAt,
        adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
    }
    if (error instanceof GraphqlBudgetHeld) {
      await dependencies.store.holdRun(runId, "Reconciliation held for GraphQL budget.", "GRAPHQL_BUDGET", failedCost);
      return { repositoryId, runId: null, skipped: true, budgetHeldUntil: error.resetAt,
        adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
    }
    await discardPass();
    // The stored message stays fixed: an upstream error can carry the sponsor's
    // GitHub token in a URL, and reconciliation_runs is read by the product.
    // PostgreSQL diagnostic fields can quote the forge record. Keep them out
    // of this log and every logger that prints the rethrown cause chain.
    const reportedError = redactPostgresError(error);
    // The console sink renders an error object through its stack, whose first
    // line carries the message raw — and a member-chosen GitLab instance
    // supplied text that rode into that message. The token is one bounded
    // single line instead, so no instance can forge a journal line or drive
    // the operator's terminal (issue 1042). redactPostgresError stays ahead:
    // its redaction is about stored product data, orthogonal to the encoding.
    console.error(`Reconciliation of repository ${repositoryId} failed.`, errorLogToken(reportedError));
    await dependencies.store.failRun(
      runId,
      carriesCredentialRejection(error) ? FORGE_CREDENTIAL_REJECTED_RUN_MESSAGE : "Reconciliation failed.",
      failedCost,
    );
    const failure = new Error("Unable to reconcile repository.", { cause: reportedError });
    const rateLimit = findGitHubRateLimitError(error);
    let notBefore: Date | undefined;
    let retryAfterSeconds: number | null = null;
    try {
      if (rateLimit) {
        const deadline = rateLimit.notBefore ?? githubRateLimitNotBefore(rateLimit, now());
        retryAfterSeconds = rateLimit.retryAfterSeconds;
        notBefore = deadline;
      }
    } catch {
      // Keep the recorded failure and its original cause when guidance is unreadable.
    }
    if (notBefore) {
      // Carry the decision across awaited persistence/reporting without adding API JSON fields.
      Object.defineProperties(failure, {
        rateLimited: { value: true },
        retryAfterSeconds: { value: retryAfterSeconds },
        notBefore: { value: notBefore },
      });
      await dependencies.store.setReconciliationCooldown(repositoryId, notBefore);
    }
    throw failure;
  }
}

// A credential rejection reaches this module nested — the sponsor gateway's
// guard raises it from inside a read, and intermediate layers may wrap it — so
// the finite, guarded walk follows the cause chain as with rate-limit detection.
// Unreadable evidence leaves the generic failure.
function carriesCredentialRejection(error: unknown): boolean {
  const visited = new Set<unknown>();
  try {
    for (let cause = error, depth = 0; depth < MAX_ERROR_CAUSE_READS && cause !== null && cause !== undefined && !visited.has(cause); depth += 1) {
      visited.add(cause);
      if (cause instanceof ForgeCredentialRejectedError) return true;
      cause = (cause as { cause?: unknown }).cause;
    }
  } catch {
    // Diagnostic getters cannot cost the persisted failure outcome.
  }
  return false;
}

// The journal reason a durable per-subject failure class names when its subject
// joins the discard arm; null means the failure keeps whole-run retry semantics.
type SubjectDiscardReason = "NOT_FOUND" | "DIFF_TOO_LARGE" | "RESPONSE_TOO_LARGE";

// The reviews read is GraphQL, so a pull request deleted upstream answers
// the flattened NOT_FOUND message the subject classifier matches; the diff
// read is REST and answers GitHub's fixed 404 error, which that classifier
// never sees. The diff read also answers GitHub's fixed 406 when the diff
// exceeds the 20000-line cap — retrying the same read answers 406 again —
// so it joins the same subject-alone arm under its own reason. That read can
// also answer a body past the client's success-path byte cap, which is fixed
// for the pull request the same way: its own bytes are what tripped the cap,
// so every retry re-reads them and trips it again. Both the REST diff and
// GraphQL reviews legs share this cap. Either shape is
// definitive for that pull request, not a property of the run.
function pullRequestDiscardReason(error: unknown): SubjectDiscardReason | null {
  if (error instanceof GitHubApiError && error.status === 406) return "DIFF_TOO_LARGE";
  if (error instanceof GitHubResponseTooLargeError) return "RESPONSE_TOO_LARGE";
  if (isGitHubSubjectNotFoundError(error) || (error instanceof GitHubApiError && error.status === 404)) return "NOT_FOUND";
  return null;
}

function disputePullRequestDiscardReason(error: unknown): SubjectDiscardReason | null {
  if (error instanceof GitLabApiError && error.status === 404) return "NOT_FOUND";
  if (error instanceof GitHubGraphqlRequestError && error.status === 200 && !error.rateLimited
    && /^GitHub GraphQL request failed\. NOT_FOUND: Could not resolve to a Repository\b[^;]*$/.test(error.message)) return "NOT_FOUND";
  return pullRequestDiscardReason(error);
}

// The ISSUE per-subject read draws the same definitive arm on either forge:
// the GraphQL shape answers the flattened NOT_FOUND message the default
// classifier matches, GitHub's REST read answers its fixed 404 error, and a
// GitLab read that loses the issue between endpoints throws GitLabApiError
// 404. Any of the three is gone for good — a deleted issue can never
// resolve. A capped issue read also cannot resolve: its own issue body,
// labels, timeline or closing references exceeded the shared byte cap.
// Anything else keeps whole-run retry semantics.
function issueDiscardReason(error: unknown): SubjectDiscardReason | null {
  if (error instanceof GitHubResponseTooLargeError) return "RESPONSE_TOO_LARGE";
  return isGitHubSubjectNotFoundError(error)
    || (error instanceof GitHubApiError && error.status === 404)
    || (error instanceof GitLabApiError && error.status === 404)
    ? "NOT_FOUND"
    : null;
}

// The default per-subject classifier also covers a pull request's closing-issue
// references: those bytes belong to that subject, so retry cannot shrink them.
// Repository-wide list reads never enter a per-subject classifier.
function defaultSubjectDiscardReason(error: unknown): SubjectDiscardReason | null {
  if (error instanceof GitHubResponseTooLargeError) return "RESPONSE_TOO_LARGE";
  return isGitHubSubjectNotFoundError(error) ? "NOT_FOUND" : null;
}

// A pull request's evidence read draws the same subject-alone arm the
// per-subject reads draw: a gone pull request is definitive for the
// subject, not a property of the run — the sweep revives FAILED jobs and
// would retry the run forever — so the subject's dirty row, when one
// exists, is discarded (keyed with its generation, so a genuine re-enqueue
// still reconciles) and the subject is omitted from the returned evidence
// map. An ordinary closing reference the cache already holds keeps its last-known
// evidence until the next full pass (at most six hours); a definitively missing
// dispute PR also leaves retention, so stale facts cannot authorize a grant.
// Blank an ordinary reference instead and a probably-transient read failure
// blanks a settlement's proof to the empty diff. A diff over GitHub's
// 20000-line cap (a fixed 406 on either evidence leg) and a body past the
// client's success-path byte cap both deliberately join this arm beside
// NOT_FOUND: the pull request's own size is what failed, so no retry can
// succeed and the sweep would fail the run forever. Every other class —
// a rate limit with its cooldown path, auth, 5xx, network, the GraphQL
// budget held — is transient or run-invalidating and rethrows, keeping
// whole-run retry; nothing further joins this arm.
async function collectPullRequestEvidence(
  github: ReconciliationGateway,
  reference: GitHubRepositoryReference,
  pullRequests: readonly GitHubSubject[],
  discardUnresolvableSubject: (
    failure: unknown,
    kind: DirtyReconciliationSubject["kind"],
    subject: GitHubSubject,
    dirty: DirtyReconciliationSubject | undefined,
    classifyDiscard?: (error: unknown) => SubjectDiscardReason | null,
  ) => Promise<boolean>,
  dirtyPullRequestSubjects: ReadonlyMap<number, DirtyReconciliationSubject>,
  disputePullRequestIds: ReadonlySet<number>,
): Promise<{ evidence: Map<number, { reviews: GitHubPullRequestReview[]; rawDiff: string }>; missingDisputePrIds: Set<number> }> {
  const uniqueEvidencePullRequests = new Map(pullRequests.map(pr => [pr.id, pr]));
  const missingDisputePrIds = new Set<number>();
  const evidence = await mapWithConcurrency(
    [...uniqueEvidencePullRequests.values()],
    reconciliationConcurrency,
    async (pullRequest) => {
      try {
        return [
          pullRequest.id,
          {
            reviews: await github.getPullRequestReviews(reference, pullRequest.number),
            rawDiff: await github.getPullRequestDiff(reference, pullRequest.number),
          },
        ] as const;
      } catch (error) {
        const disputed = disputePullRequestIds.has(pullRequest.id);
        const reason = disputed ? disputePullRequestDiscardReason(error) : pullRequestDiscardReason(error);
        if (!(await discardUnresolvableSubject(
          error,
          "PULL_REQUEST",
          pullRequest,
          dirtyPullRequestSubjects.get(pullRequest.id),
          () => reason,
        ))) {
          throw error;
        }
        if (disputed && reason === "NOT_FOUND") missingDisputePrIds.add(pullRequest.id);
        return null;
      }
    },
  );
  return { evidence: new Map(evidence.filter((entry) => entry !== null)), missingDisputePrIds };
}

async function declineCrawl(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  runId: string,
  reason: RepositoryUnavailableReason,
  at: Date,
): Promise<ReconciliationSummary> {
  await dependencies.store.markRepositoryUnavailable({ repositoryId, reason, at });
  // Nothing upstream failed: the crawl was declined, so the run completes.
  await dependencies.store.completeRun(runId);
  await dependencies.store.setReconciliationCooldown(repositoryId, null);
  return noDeltaSummary(repositoryId, runId);
}

function noDeltaSummary(repositoryId: string, runId: string): ReconciliationSummary {
  return {
    repositoryId,
    runId,
    skipped: false,
    adds: 0,
    changes: 0,
    removals: 0,
    added: 0,
    changed: 0,
    removed: 0,
  };
}
