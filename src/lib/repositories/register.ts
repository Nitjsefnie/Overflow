import { isParticipationEligible, type EnforcementState, type UserRole } from "@/lib/db/types";
import { GitHubApiError } from "@/lib/github/errors";
import { assessClaimPath, type ClaimPathEvidence, type ClaimPathVerdict } from "@/lib/domain/claim-path";
import { plural } from "@/lib/plural";
import {
  validateDifficultyScheme,
  type ActualDifficultyLabel,
  type DifficultyScheme,
  type OpeningDifficultyLabel,
} from "@/lib/domain/difficulty-scheme";
import type {
  GitHubRepository,
  GitHubRepositoryReference,
  GitHubWebhook,
  GitHubWebhookConfiguration,
} from "@/lib/github/types";

export type RepositoryRegistrationInput = {
  repositoryUrl: string;
  openingName: string;
  actualName: string;
  openingLabels: OpeningDifficultyLabel[];
  actualLabels: ActualDifficultyLabel[];
};

export type RegisteredRepository = {
  id: string;
  githubRepositoryId: number;
  ownerName: string;
  sponsorId: string;
  visibility: "PUBLIC" | "PRIVATE";
  /**
   * Null for a repository registered without a webhook — a GitLab
   * registration (contract items 27/28 PARTIAL; webhook ingestion deferred).
   * Every GitHub-side webhook operation must treat null as "nothing to
   * operate on", never as an id.
   */
  githubWebhookId: number | null;
};

export type NewRegisteredRepository = Omit<RegisteredRepository, "id"> & {
  difficultyScheme: DifficultyScheme;
};

/**
 * A registration row together with the instant its sponsor unregistered it —
 * null while the registration stands. The register path reads the state
 * rather than the row alone so an unregistered row can proceed to
 * reactivation where an active one is a conflict, and the unregister path
 * reads it to resolve the row an owner/name submission names.
 */
export type RepositoryRegistrationState = {
  repository: RegisteredRepository;
  /** ISO-8601 instant of sponsor unregistration; null while registered. */
  unregisteredAt: string | null;
};

export type RepositoryUnregisterOutcome =
  | { kind: "UNREGISTERED"; repository: RegisteredRepository }
  | { kind: "ALREADY_UNREGISTERED"; repository: RegisteredRepository }
  | { kind: "NOT_REGISTERED" }
  | { kind: "FORBIDDEN" };

export type RepositoryRegistrationGateway = {
  getRepository(repository: GitHubRepositoryReference): Promise<GitHubRepository>;
  /**
   * Reads the repository by its immutable GitHub numeric id — the drain's
   * resolution primitive (issue 516). The id survives a rename and an owner
   * transfer (see the parallel note on `GitHubPullRequest.repositoryGitHubId`),
   * while an owner/name path stored earlier does not. Answers null only when
   * GitHub 404s the id — no repository visible to this token; every other
   * failure is rethrown so a transient outage is never read as a deleted
   * repository.
   */
  getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null>;
  listRepositoryLabels(repository: GitHubRepositoryReference): Promise<Set<string>>;
  createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook>;
  deleteWebhook(repository: GitHubRepositoryReference, webhookId: number): Promise<void>;
  listWorkflowFiles(repository: GitHubRepositoryReference): Promise<ClaimPathEvidence[]>;
};

/**
 * One webhook on GitHub that Overflow may have orphaned: a registration created
 * it and then failed to store the registration. The record is written before the
 * compensating deletion is attempted, so the webhook id survives every failure
 * combination, and the drain works from it until the hook is proven gone.
 */
export type AbandonedWebhookCleanup = {
  githubRepositoryId: number;
  /** The owner/name path at record time; kept for humans and diagnostics only — the drain addresses hooks through the id. */
  ownerName: string;
  webhookId: number;
  createdAt: string;
};

export type RepositoryRegistrationStore = {
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<RegisteredRepository | null>;
  createRepository(repository: NewRegisteredRepository): Promise<RegisteredRepository | null>;
  /**
   * Appends the submitted catalog as the repository's next version and moves
   * the stored current catalog in the same transaction (issue 180). Answers
   * `changed: false` when the submitted catalog already is the current one,
   * and null when no registration holds the GitHub identity.
   */
  appendDifficultySchemeVersion(input: {
    githubRepositoryId: number;
    sponsorId: string;
    scheme: DifficultyScheme;
    effectiveFrom: Date;
  }): Promise<RepositoryCatalogChange | null>;
  /**
   * The registration holding the GitHub owner/name path, with the instant its
   * sponsor unregistered it, or null when no row holds the path.
   */
  findRepositoryRegistrationStateByOwnerName(ownerName: string): Promise<RepositoryRegistrationState | null>;
  /** The registration holding the GitHub identity, or null when no row holds it. */
  findRepositoryRegistrationState(githubRepositoryId: number): Promise<RepositoryRegistrationState | null>;
  /**
   * Deactivates the registration holding the owner/name path on its sponsor's
   * behalf: active = false with unregistered_at = now() in one statement, so
   * the invariant the check constraint pins — an active row was never
   * unregistered — holds after every path. The row is locked by owner_name
   * for the whole decision, so a concurrent reactivation cannot interleave.
   */
  unregisterRepository(input: { ownerName: string; sponsorId: string }): Promise<RepositoryUnregisterOutcome>;
  /**
   * Durably records a webhook Overflow created and may have orphaned, before the
   * compensating deletion is attempted. Re-saving the same GitHub repository and
   * webhook pair rewrites the earlier record.
   */
  saveAbandonedWebhookCleanup(record: AbandonedWebhookCleanup): Promise<void>;
  /** Every recorded abandoned webhook, oldest first, so a drain works through them in order. */
  listAbandonedWebhookCleanups(): Promise<AbandonedWebhookCleanup[]>;
  /** Removes the record once the webhook is proven gone; clearing an absent record resolves. */
  clearAbandonedWebhookCleanup(githubRepositoryId: number, webhookId: number): Promise<void>;
};

export type RepositoryCatalogChange = {
  changed: boolean;
  /** The appended version's number, null when nothing changed. */
  versionNumber: number | null;
  /** The instant the appended version begins governing, ISO-8601, null when nothing changed. */
  effectiveFrom: string | null;
};

export type RepositoryRegistrationDependencies = {
  actor: { id: string; role: UserRole; enforcementState?: EnforcementState };
  github: RepositoryRegistrationGateway;
  store: RepositoryRegistrationStore;
  webhook: GitHubWebhookConfiguration;
  scheduleInitialImport?: (repositoryId: string) => Promise<unknown>;
};

export type RepositoryRegistrationResult = RegisteredRepository & {
  initialImportScheduled: boolean;
  claimPath: ClaimPathVerdict;
};

export type RepositoryUnregisterApiResult = {
  repository: RegisteredRepository;
  /** True when THIS call deleted the hook on GitHub; false when already absent (HTTP 404). */
  webhookDeleted: boolean;
  /** True when the local row was already sponsor-unregistered (idempotent repeat). */
  alreadyUnregistered: boolean;
};

export class RepositoryRegistrationError extends Error {
  public constructor(
    public readonly code: "CONFLICT" | "FORBIDDEN" | "GITHUB_ACCESS" | "GITHUB_CREDENTIALS" | "GITHUB_RATE_LIMITED" | "INVALID_INPUT" | "NOT_FOUND" | "ROLLBACK_INCOMPLETE" | "UPSTREAM_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryRegistrationError";
  }
}

export class RepositoryOwnerNameConflictError extends Error {
  public constructor(public readonly ownerName: string) {
    super(`The GitHub path ${ownerName} is already claimed by a registration.`);
    this.name = "RepositoryOwnerNameConflictError";
  }
}

export class RepositoryWebhookIdConflictError extends Error {
  public constructor(public readonly githubWebhookId: number) {
    super(`The GitHub webhook id ${githubWebhookId} is already claimed by a registration.`);
    this.name = "RepositoryWebhookIdConflictError";
  }
}

export class RepositoryRegistrationEnforcementError extends Error {
  public constructor() {
    super("The account is not eligible to register repositories.");
    this.name = "RepositoryRegistrationEnforcementError";
  }
}

export class RepositorySchemeChangeForbiddenError extends Error {
  public constructor(public readonly githubRepositoryId: number) {
    super("Only the repository's sponsor can change its difficulty catalog.");
    this.name = "RepositorySchemeChangeForbiddenError";
  }
}

export class RepositorySchemeChangeOrderError extends Error {
  public constructor(public readonly githubRepositoryId: number) {
    super("A difficulty catalog version cannot begin governing before the version before it.");
    this.name = "RepositorySchemeChangeOrderError";
  }
}

export async function registerRepository(
  dependencies: RepositoryRegistrationDependencies,
  input: RepositoryRegistrationInput,
): Promise<RepositoryRegistrationResult> {
  if (
    dependencies.actor.enforcementState !== undefined &&
    !isParticipationEligible(dependencies.actor.enforcementState)
  ) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "The account is not eligible to register repositories.",
    );
  }

  const difficultyScheme = toDifficultyScheme(input);
  const validation = validateDifficultyScheme(difficultyScheme);
  if (!validation.ok) {
    throw new RepositoryRegistrationError("INVALID_INPUT", validation.reason);
  }

  let submittedRepository: GitHubRepositoryReference;
  try {
    submittedRepository = parseGitHubRepository(input.repositoryUrl);
  } catch {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
    );
  }

  const repository = await getSubmittedRepository(dependencies.github, submittedRepository);
  if (repository.visibility !== "PUBLIC") {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "Only public GitHub repositories can be registered.",
    );
  }

  if (!repository.canAdminister) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "GitHub administrator permission is required for the submitted repository.",
    );
  }

  // An unregistered row is not a conflict: the resubmission reactivates it (the
  // store's conditional on-conflict update), so only a row still holding the
  // registration stands in the way.
  const existing = await findExistingRepository(dependencies.store, repository.id);
  if (existing !== null && existing.unregisteredAt === null) {
    throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is already registered.");
  }

  await verifySchemeLabelsExist(dependencies.github, submittedRepository, repository, difficultyScheme, "register again");

  let webhook: GitHubWebhook;
  try {
    webhook = await dependencies.github.createWebhook(submittedRepository, dependencies.webhook);
  } catch (error) {
    throw githubSetupError(error, repository, "create the repository webhook");
  }

  let created: RegisteredRepository | null;
  try {
    created = await dependencies.store.createRepository({
      githubRepositoryId: repository.id,
      ownerName: repository.fullName,
      sponsorId: dependencies.actor.id,
      visibility: repository.visibility,
      githubWebhookId: webhook.id,
      difficultyScheme,
    });
  } catch (error) {
    // Every route out of this catch abandons the registration, so the webhook this call
    // created has no repository to deliver to. The try holds only the store call, so
    // compensating for the webhook once here covers every failure the store can raise,
    // including one raised as a RepositoryRegistrationError by a store, decorator or retry
    // wrapper the interface does not constrain. The cleanup record is written before the
    // deletion is attempted (issue 451), so even a webhook whose deletion never completes
    // stays known to Overflow and reachable by the drain.
    const abandonment = await abandonCreatedWebhook(
      dependencies,
      submittedRepository,
      repository.id,
      repository.fullName,
      webhook.id,
      describeErrorCause(error),
    );
    if (!abandonment.proven) {
      throw new RepositoryRegistrationError("ROLLBACK_INCOMPLETE", rollbackIncompleteMessage);
    }

    // The submitted repository is genuinely absent from the table: another registration holds
    // the owner/name path, so the insert failed on that unique constraint rather than on the
    // numeric GitHub id. Saying "already registered" here would name the wrong row, and
    // answering an upstream failure would invite a retry that can only fail the same way,
    // because the path is read off the submission and is the same on every attempt.
    if (error instanceof RepositoryOwnerNameConflictError) {
      throw new RepositoryRegistrationError(
        "CONFLICT",
        `The GitHub path ${error.ownerName} is claimed by a different registration. `
          + "The submitted repository is not registered, and it cannot be registered while another "
          + "registration holds that path.",
      );
    }

    // The same collision on a different constraint, and the opposite advice: the colliding
    // value is the id GitHub returned for the hook this call created, that hook was abandoned
    // above, and the next attempt asks GitHub for another one. What GitHub will return for that
    // one is not this module's to know, so a retry is worth making before the collision is
    // treated as durable, rather than being the one action ruled out.
    if (error instanceof RepositoryWebhookIdConflictError) {
      throw new RepositoryRegistrationError(
        "CONFLICT",
        "The GitHub webhook created for the submitted repository collided with one a different "
          + "registration already records. The submitted repository is not registered. Registering "
          + "again requests a new webhook from GitHub, so retry once before treating this as stored "
          + "state that has to be resolved.",
      );
    }

    if (error instanceof RepositoryRegistrationEnforcementError) {
      throw new RepositoryRegistrationError(
        "FORBIDDEN",
        "The account is not eligible to register repositories.",
      );
    }

    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the repository registration.");
  }

  // An absent row has two causes, and both leave a registration the resubmission cannot
  // reopen. Either the numeric GitHub id the on-conflict arbiter watches was already
  // taken by a row still registered — active, so the where clause skipped it — and the
  // registration the sponsor submitted belongs to the row that holds it; or the held row
  // is moderation-deactivated (unregistered_at is null there too), which only a
  // moderation reactivation may bring back, never a resubmission. Both are the same
  // answer to the sponsor: this GitHub repository is already registered.
  if (created === null) {
    // The registration did not complete, so the webhook just created has no repository to
    // deliver to; the same durable-before-delete compensation applies as in the catch above.
    // No exception exists here — the store answered null — so the arbiter-decline phrase
    // stands in for a rendered error: the operator must not read this diagnostic as
    // "save error unknown".
    const abandonment = await abandonCreatedWebhook(
      dependencies,
      submittedRepository,
      repository.id,
      repository.fullName,
      webhook.id,
      arbiterDeclinedSaveCause,
    );
    if (!abandonment.proven) {
      throw new RepositoryRegistrationError("ROLLBACK_INCOMPLETE", rollbackIncompleteMessage);
    }
    throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is already registered.");
  }

  // The registration is committed by this point. Work that already exists in the
  // repository only enters the ledger through a reconciliation, and a webhook can
  // never deliver it because it was created after that work. So schedule that import
  // durably here rather than holding the response open for a full crawl, and report a
  // failure to schedule it to the sponsor rather than undoing a registration that stands.
  const initialImportScheduled = await scheduleInitialImport(dependencies, created.id);

  // Report the claim-path verdict after registration rather than enforce it: workflow
  // text supplies evidence, not proof, and may carry a claim path this check cannot
  // recognise. Refusing registration on that basis would block a legitimate one.
  // A failed check likewise cannot undo or fail the registration that already stands.
  let claimPath: RepositoryRegistrationResult["claimPath"];
  try {
    claimPath = assessClaimPath(await dependencies.github.listWorkflowFiles(submittedRepository));
  } catch {
    claimPath = "NOT_CHECKED";
  }

  // The registration stands, so this is the moment a webhook recorded for cleanup by an
  // earlier failed registration can be retired: drain the cleanup table best-effort before
  // answering, so a retry the sponsor makes after a ROLLBACK_INCOMPLETE also cleans up.
  await drainAbandonedWebhooks(dependencies);

  return { ...created, initialImportScheduled, claimPath };
}

/**
 * Best-effort cleanup of webhooks Overflow created and may have orphaned — a
 * registration created the hook and then failed to store the registration.
 * Every record the cleanup table holds is worked through: one whose active
 * registration came back holding the same webhook id only has its record
 * cleared (the hook is wanted again), every other one is resolved through its
 * repository's immutable id to the owner/name GitHub serves now — the id
 * survives renames and owner transfers while a stored path does not (issue
 * 516) — and the hook is deleted through that current path, where a GitHub 404
 * counts as proven. A null resolution — the repository deleted, or hidden
 * from this credential since registration — clears the record without a
 * deletion call. A webhook that cannot be proven deleted keeps its record for
 * the next drain. Never throws: the drain must never disturb the registration
 * or unregistration that just succeeded.
 */
export async function drainAbandonedWebhooks(
  dependencies: Pick<RepositoryRegistrationDependencies, "github" | "store">,
): Promise<void> {
  let records: AbandonedWebhookCleanup[];
  try {
    records = await dependencies.store.listAbandonedWebhookCleanups();
  } catch {
    return;
  }

  for (const record of records) {
    try {
      const state = await dependencies.store.findRepositoryRegistrationState(record.githubRepositoryId);
      if (
        state !== null &&
        state.unregisteredAt === null &&
        state.repository.githubWebhookId === record.webhookId
      ) {
        // unregistered_at is null both while the sponsor holds the registration and
        // after a moderation deactivation (which owns `active` alone), so any row
        // still holding this exact webhook id spares the deletion: the hook is wanted.
        await dependencies.store.clearAbandonedWebhookCleanup(record.githubRepositoryId, record.webhookId);
        continue;
      }

      // The hook is addressed through the repository's immutable id, never the
      // stored owner/name: the id survives a rename and an owner transfer, so
      // the resolution carries the path GitHub serves NOW.
      let repository: GitHubRepository | null;
      try {
        repository = await dependencies.github.getRepositoryById(record.githubRepositoryId);
      } catch {
        // A failed resolution proves nothing about the hook: keep the record
        // and attempt no deletion this pass.
        continue;
      }

      // Null answers no repository visible to this token — deleted, or hidden
      // from this credential since registration (a public repository can go
      // private). Either way the hook can no longer be addressed, so the
      // record clears below; a hook that somehow still lives is cleared
      // unrecorded, the same decision the stored-name drain made in this case.
      if (repository !== null) {
        const reference: GitHubRepositoryReference = { owner: repository.owner, name: repository.name };
        try {
          await dependencies.github.deleteWebhook(reference, record.webhookId);
        } catch (error) {
          if (!(error instanceof GitHubApiError && error.status === 404)) {
            // Not proven — keep the record and let a later drain retry the deletion.
            continue;
          }
        }
      }

      try {
        await dependencies.store.clearAbandonedWebhookCleanup(record.githubRepositoryId, record.webhookId);
      } catch {
        // The record staying is safe: the next drain re-checks the registration state first.
      }
    } catch {
      // One record's failure must not stop the drain from working through the rest.
    }
  }
}

/**
 * Unregisters a repository on its sponsor's behalf (issue 48).
 *
 * The flow is GitHub-first: the webhook Overflow created at registration is
 * deleted before the local row is touched, so a GitHub refusal leaves the
 * registration exactly as it stood. A GitHub 404 reads as the hook — or its
 * repository — already gone, the desired end state, so the flow continues
 * with `webhookDeleted: false`. Any other GitHub failure maps through the
 * same error catalog registration uses, with the local store untouched, and
 * a retry converges: the dashboard control persists because the row remains.
 *
 * Unregistration runs no participation gate and no public/admin pre-checks:
 * it removes ledger activity rather than creating it (gating would trap a
 * moderated sponsor's repositories), and GitHub enforces administration at
 * the deleteWebhook call itself, so a repository that went private or was
 * deleted on GitHub can still be unregistered.
 */
export async function unregisterRepository(
  dependencies: RepositoryRegistrationDependencies,
  input: { repositoryUrl: string },
): Promise<RepositoryUnregisterApiResult> {
  let submittedRepository: GitHubRepositoryReference;
  try {
    submittedRepository = parseGitHubRepository(input.repositoryUrl);
  } catch {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
    );
  }

  const ownerName = `${submittedRepository.owner}/${submittedRepository.name}`;
  const state = await findUnregisterTarget(dependencies.store, ownerName);
  if (state === null) {
    throw new RepositoryRegistrationError(
      "NOT_FOUND",
      `No registration holds the GitHub path ${ownerName}, so there is nothing to unregister.`,
    );
  }

  // The sponsor check precedes every GitHub request: an outsider asking for
  // an unregistration must not move anything on GitHub, and the stored
  // sponsor is already in hand from the lookup above. The store re-checks
  // inside its transaction; this check keeps the common refusal free of
  // side effects.
  if (state.repository.sponsorId !== dependencies.actor.id) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "Only the repository's sponsor can unregister it.",
    );
  }

  // A null webhook id — a GitLab registration — has no hook to delete, so
  // nothing is called and the result honestly reports no deletion happened.
  let webhookDeleted = false;
  if (state.repository.githubWebhookId !== null) {
    webhookDeleted = true;
    try {
      await dependencies.github.deleteWebhook(submittedRepository, state.repository.githubWebhookId);
    } catch (error) {
      // A 404 says the hook, or its repository, is already gone: the desired
      // end state holds, so the flow continues rather than failing. Any other
      // failure leaves the local row untouched and maps through the catalog.
      if (error instanceof GitHubApiError && error.status === 404) {
        webhookDeleted = false;
      } else {
        throw githubSetupError(error, null, "delete the repository webhook");
      }
    }
  }

  const outcome = await unregisterThroughStore(dependencies.store, { ownerName, sponsorId: dependencies.actor.id });
  if (outcome.kind === "NOT_REGISTERED") {
    // The row vanished between the lookup and the write. The registration is
    // gone either way, so NOT_FOUND is the honest answer.
    throw new RepositoryRegistrationError(
      "NOT_FOUND",
      `No registration holds the GitHub path ${ownerName}, so there is nothing to unregister.`,
    );
  }
  if (outcome.kind === "FORBIDDEN") {
    throw new RepositoryRegistrationError("FORBIDDEN", "Only the repository's sponsor can unregister it.");
  }

  // The unregistration stands, so this is the other moment the cleanup table can be
  // drained best-effort (issue 451): any webhook an earlier failed registration recorded
  // is retired here, and the drain never disturbs the answer that unregistration gave.
  await drainAbandonedWebhooks(dependencies);

  return {
    repository: outcome.repository,
    webhookDeleted,
    alreadyUnregistered: outcome.kind === "ALREADY_UNREGISTERED",
  };
}

async function findUnregisterTarget(
  store: RepositoryRegistrationStore,
  ownerName: string,
): Promise<RepositoryRegistrationState | null> {
  try {
    return await store.findRepositoryRegistrationStateByOwnerName(ownerName);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to unregister the repository.");
  }
}

async function unregisterThroughStore(
  store: RepositoryRegistrationStore,
  input: { ownerName: string; sponsorId: string },
): Promise<RepositoryUnregisterOutcome> {
  try {
    return await store.unregisterRepository(input);
  } catch (error) {
    if (error instanceof RepositoryRegistrationError) {
      throw error;
    }
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to unregister the repository.");
  }
}

/**
 * Changes a registered repository's difficulty catalog (issue 180).
 *
 * The submission is validated exactly like a registration and resolved through
 * GitHub to the same numeric identity, so the catalog change lands on the
 * repository the sponsor actually administers. The change itself is an append:
 * the submitted catalog becomes the repository's next catalog version and the
 * stored current catalog moves with it in one transaction, so closures already
 * settled keep the catalog their evidence window closed under.
 *
 * The registration-time claim-path verdict is deliberately not revisited: it
 * advises the sponsor's workflow setup and never gated the registration
 * either, and a catalog change alters no workflow, so re-reading the
 * repository's workflows would add a GitHub read whose answer changes nothing
 * about this change.
 */
export async function changeRepositoryCatalog(
  dependencies: RepositoryRegistrationDependencies,
  input: RepositoryRegistrationInput,
): Promise<RepositoryCatalogChangeResult> {
  if (
    dependencies.actor.enforcementState !== undefined &&
    !isParticipationEligible(dependencies.actor.enforcementState)
  ) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "The account is not eligible to change repository catalogs.",
    );
  }

  const difficultyScheme = toDifficultyScheme(input);
  const validation = validateDifficultyScheme(difficultyScheme);
  if (!validation.ok) {
    throw new RepositoryRegistrationError("INVALID_INPUT", validation.reason);
  }

  let submittedRepository: GitHubRepositoryReference;
  try {
    submittedRepository = parseGitHubRepository(input.repositoryUrl);
  } catch {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
    );
  }

  const repository = await getSubmittedRepository(dependencies.github, submittedRepository);
  if (repository.visibility !== "PUBLIC") {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "Only public GitHub repositories can keep a registered difficulty catalog.",
    );
  }

  if (!repository.canAdminister) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "GitHub administrator permission is required for the submitted repository.",
    );
  }

  const registered = await findRegisteredRepository(dependencies.store, repository.id);
  if (registered === null) {
    throw new RepositoryRegistrationError(
      "CONFLICT",
      "This GitHub repository is not registered, so there is no catalog to change.",
    );
  }

  // The sponsor check precedes every GitHub request: an outsider asking for a
  // catalog change must not move anything on the repository, and the stored
  // sponsor is already in hand from the lookup above. The store re-checks
  // inside its transaction; this check keeps the common refusal free of side
  // effects.
  if (registered.sponsorId !== dependencies.actor.id) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "Only the repository's sponsor can change its difficulty catalog.",
    );
  }

  await verifySchemeLabelsExist(dependencies.github, submittedRepository, repository, difficultyScheme, "retry the catalog change");

  try {
    const change = await dependencies.store.appendDifficultySchemeVersion({
      githubRepositoryId: repository.id,
      sponsorId: dependencies.actor.id,
      scheme: difficultyScheme,
      effectiveFrom: new Date(),
    });
    // Unreachable through the flow above — the registration was just found —
    // but a null here must not spread into a result that claims a change.
    if (change === null) {
      throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is not registered, so there is no catalog to change.");
    }
    return { ...change, repository: registered };
  } catch (error) {
    if (error instanceof RepositorySchemeChangeForbiddenError) {
      throw new RepositoryRegistrationError("FORBIDDEN", error.message);
    }
    if (error instanceof RepositorySchemeChangeOrderError) {
      // Reachable through the API only when the account's clock moves
      // backwards between changes: the route supplies now(), and a version
      // recording at the same instant is allowed. A retry is the remedy.
      throw new RepositoryRegistrationError(
        "CONFLICT",
        "The catalog change could not be recorded: its effective instant precedes the version before it. Retry the change.",
      );
    }
    if (error instanceof RepositoryRegistrationError) {
      throw error;
    }
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the difficulty catalog change.");
  }
}

export type RepositoryCatalogChangeResult = RepositoryCatalogChange & {
  /** The registered repository whose catalog changed. */
  repository: RegisteredRepository;
};

async function findRegisteredRepository(
  store: RepositoryRegistrationStore,
  githubRepositoryId: number,
): Promise<RegisteredRepository | null> {
  try {
    return await store.findRepositoryByGitHubId(githubRepositoryId);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the difficulty catalog change.");
  }
}

/**
 * Label verification replaces label creation: the repository must already
 * carry every label the submitted scheme names, and registration refuses to
 * name what is missing rather than creating it. Removing the label write is
 * what makes the narrow `admin:repo_hook` OAuth scope sufficient — the only
 * user-token writes left are webhook create/patch/delete.
 */
async function verifySchemeLabelsExist(
  github: RepositoryRegistrationGateway,
  submittedRepository: GitHubRepositoryReference,
  repository: GitHubRepository | null,
  scheme: DifficultyScheme,
  remedy: string,
): Promise<void> {
  let existingLabels: Set<string>;
  try {
    existingLabels = await github.listRepositoryLabels(submittedRepository);
  } catch (error) {
    throw githubSetupError(error, repository, "read the repository difficulty labels");
  }

  const schemeLabels = [...new Set([...scheme.openingLabels, ...scheme.actualLabels].map((label) => label.label))];
  const missing = schemeLabels.filter((label) => !existingLabels.has(label));
  if (missing.length > 0) {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      `The repository is missing the difficulty labels ${missing.map((label) => `\`${label}\``).join(", ")}. `
        + `Create them on GitHub, then ${remedy}.`,
    );
  }
}

function githubSetupError(
  error: unknown,
  repository: GitHubRepository | null,
  step: "retrieve the submitted GitHub repository" | "read the repository difficulty labels" | "create the repository webhook" | "delete the repository webhook",
): RepositoryRegistrationError {
  // Issue 93: a 401 says GitHub rejected the authorization Overflow itself holds — the token
  // expired or was revoked, unlike a 403/404, which is about the repository or the
  // application's approval. Retrying cannot fix the token, so the message carries the one
  // remedy that refreshes it.
  if (error instanceof GitHubApiError && error.status === 401) {
    return new RepositoryRegistrationError(
      "GITHUB_CREDENTIALS",
      `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to ${step}. `
        + "To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.",
    );
  }

  if (error instanceof GitHubApiError && !error.rateLimited && (error.status === 403 || error.status === 404)) {
    let cause = repository?.ownerType === "ORGANIZATION"
      ? `This can happen when the Overflow OAuth application is not approved for that organization. Ask an organization owner to approve it at https://github.com/organizations/${repository.owner}/settings/oauth_application_policy.`
      : "This may be caused by missing authorization for the Overflow OAuth application.";
    if (repository === null) {
      cause += " For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy.";
    }
    const authorizationRemedies = ` ${cause} Review Overflow's authorization at https://github.com/settings/applications, then retry registration.`;
    if (error.status === 404) {
      const observation = `GitHub answered 404 for the request to ${step}. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted${repository === null ? "" : " since it was looked up"}.`;
      return new RepositoryRegistrationError("GITHUB_ACCESS", `${observation}${authorizationRemedies}`);
    }
    // Issue 97: a 403 that carries no rate-limit evidence cannot separate a missing
    // authorization from a secondary rate limit — GitHub answers 403 both ways. State the
    // ambiguity and lead with the transient remedy; the settings remedies follow.
    return new RepositoryRegistrationError(
      "GITHUB_ACCESS",
      `GitHub refused to ${step} (HTTP 403). `
        + "GitHub answers 403 both when the Overflow OAuth application is not yet authorized "
        + "and when it is temporarily limiting requests, and this response carries nothing that "
        + "separates the two causes. Wait a minute and retry registration before changing anything."
        + authorizationRemedies,
    );
  }

  if (error instanceof GitHubApiError && (error.rateLimited || error.status === 429)) {
    const delay = error.retryAfterSeconds === null ? "" : ` Retry after ${error.retryAfterSeconds} ${plural(error.retryAfterSeconds, "second")}.`;
    return new RepositoryRegistrationError(
      "GITHUB_RATE_LIMITED",
      `GitHub rate-limited the request to ${step} (HTTP ${error.status}).${delay} Please retry registration later.`,
    );
  }

  return new RepositoryRegistrationError(
    "UPSTREAM_FAILURE",
    step === "retrieve the submitted GitHub repository"
      ? "Unable to retrieve the submitted GitHub repository."
      : `Unable to ${step} on GitHub.`,
  );
}

async function scheduleInitialImport(
  dependencies: RepositoryRegistrationDependencies,
  repositoryId: string,
): Promise<boolean> {
  if (dependencies.scheduleInitialImport === undefined) {
    return false;
  }

  try {
    await dependencies.scheduleInitialImport(repositoryId);
    return true;
  } catch {
    return false;
  }
}

export function parseGitHubRepository(value: string): GitHubRepositoryReference {
  const submitted = value.trim();
  const shorthand = submitted.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand !== null) {
    return toRepositoryReference(shorthand[1], shorthand[2]);
  }

  let url: URL;
  try {
    url = new URL(submitted);
  } catch {
    throw new Error("Invalid GitHub repository URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Invalid GitHub repository URL.");
  }

  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length !== 2) {
    throw new Error("Invalid GitHub repository URL.");
  }

  return toRepositoryReference(pathSegments[0], pathSegments[1]);
}

function toDifficultyScheme(input: RepositoryRegistrationInput): DifficultyScheme {
  return {
    openingName: input.openingName,
    actualName: input.actualName,
    openingLabels: input.openingLabels,
    actualLabels: input.actualLabels,
  };
}

function toRepositoryReference(owner: string, repositoryName: string): GitHubRepositoryReference {
  const name = repositoryName.replace(/\.git$/i, "");
  if (!isGitHubRepositorySegment(owner) || !isGitHubRepositorySegment(name)) {
    throw new Error("Invalid GitHub repository URL.");
  }

  return { owner, name };
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

async function getSubmittedRepository(
  github: RepositoryRegistrationGateway,
  repository: GitHubRepositoryReference,
): Promise<GitHubRepository> {
  try {
    return await github.getRepository(repository);
  } catch (error) {
    throw githubSetupError(error, null, "retrieve the submitted GitHub repository");
  }
}

async function findExistingRepository(
  store: RepositoryRegistrationStore,
  githubRepositoryId: number,
): Promise<RepositoryRegistrationState | null> {
  try {
    return await store.findRepositoryRegistrationState(githubRepositoryId);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the repository registration.");
  }
}

const rollbackIncompleteMessage =
  "The repository registration could not be saved, and the webhook Overflow created for it "
  + "could not be deleted on GitHub. Nothing was registered; retry the registration, and a later "
  + "successful registration or unregistration removes the abandoned webhook.";

/**
 * The bounded cause rendered into the abandonment diagnostic when the store's
 * on-conflict arbiter answers null without raising (issue 515). No exception
 * exists to describe there, and a diagnostic left without a cause would read
 * as "save error unknown" — the save was declined because another registration
 * holds the GitHub path.
 */
const arbiterDeclinedSaveCause =
  "the store's on-conflict arbiter declined the save (another registration holds the GitHub path)";

/** Hard cap for a rendered save-failure cause, so a diagnostic stays one bounded log line. */
const describeErrorCauseLimit = 200;

/**
 * Renders a thrown save failure for an operator diagnostic (issue 515):
 * deterministic, single-line, and secret-safe — the rendering may name
 * credentials the error message carried, so they are redacted before the
 * string is capped. This is a log-side rendering only: the thrown
 * ROLLBACK_INCOMPLETE error's public message never carries it.
 */
export function describeErrorCause(error: unknown): string {
  const rendered = error instanceof Error && error.message.length > 0
    ? `${error.name}: ${error.message}`
    : String(error);
  return capRenderedCause(redactCredentials(rendered.replace(/[\r\n]+/g, " ")));
}

/**
 * Replaces `scheme://user:password@host…` with `scheme://***@host…` and any
 * `password=<value>` / `password: <value>` fragment with `password=***`.
 */
function redactCredentials(value: string): string {
  return value
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s@/]+:[^\s@/]+@/g, "$1***@")
    .replace(/password(\s*[=:]\s*)[^\s]+/gi, "password=***");
}

function capRenderedCause(value: string): string {
  return value.length > describeErrorCauseLimit ? value.slice(0, describeErrorCauseLimit) : value;
}

/**
 * The abandonment sequence for a webhook a failed registration created (issue 451).
 *
 * The cleanup record is written FIRST — durably, before anything can forget the id. Only
 * then is the deletion attempted; a GitHub 404 counts as proven, the hook is already gone.
 * When the deletion is proven, the record is cleared (a clear failure is tolerable: the
 * record stays and the drain re-checks before deleting). When the deletion is not proven,
 * or the record itself could not be saved, a bounded diagnostic names the owner, the hook
 * id, and whether the cleanup record is retained — and the caller answers
 * ROLLBACK_INCOMPLETE instead of the original save failure, because the orphaned webhook
 * is the actionable state. `saveCause` (issue 515) rides into that diagnostic as a
 * bounded, secret-safe rendering of the original save failure, so an operator can
 * separate a database outage from a constraint conflict; the thrown error's public
 * message never carries it.
 */
async function abandonCreatedWebhook(
  dependencies: RepositoryRegistrationDependencies,
  repository: GitHubRepositoryReference,
  githubRepositoryId: number,
  ownerName: string,
  webhookId: number,
  saveCause?: string,
): Promise<{ proven: boolean; recordSaved: boolean }> {
  const record: AbandonedWebhookCleanup = {
    githubRepositoryId,
    ownerName,
    webhookId,
    createdAt: new Date().toISOString(),
  };
  let recordSaved = true;
  try {
    await dependencies.store.saveAbandonedWebhookCleanup(record);
  } catch {
    recordSaved = false;
  }

  let proven = false;
  try {
    await dependencies.github.deleteWebhook(repository, webhookId);
    proven = true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      proven = true;
    }
  }

  if (!proven || !recordSaved) {
    // `; cause: <saveCause>` integrates before the final period; with no cause the
    // rendered text is byte-identical to the pre-515 diagnostic.
    const causeSuffix = saveCause !== undefined && saveCause.length > 0
      ? `; cause: ${saveCause}.`
      : ".";
    if (recordSaved) {
      console.error(
        `The webhook ${webhookId} created for ${ownerName} could not be proven deleted; `
          + "the cleanup record is retained for a later drain" + causeSuffix,
      );
    } else if (proven) {
      console.error(
        `The cleanup record for the webhook ${webhookId} created for ${ownerName} could not be saved; `
          + "the webhook was deleted, but nothing records it for a later drain" + causeSuffix,
      );
    } else {
      console.error(
        `The cleanup record for the webhook ${webhookId} created for ${ownerName} could not be saved, `
          + "and the webhook could not be proven deleted; nothing records it for a later drain" + causeSuffix,
      );
    }
  }

  if (proven) {
    try {
      await dependencies.store.clearAbandonedWebhookCleanup(githubRepositoryId, webhookId);
    } catch {
      // The record staying is safe: the drain re-checks the registration state before deleting.
    }
  }

  return { proven, recordSaved };
}
