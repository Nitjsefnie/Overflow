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
  githubWebhookId: number;
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
  listRepositoryLabels(repository: GitHubRepositoryReference): Promise<Set<string>>;
  createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook>;
  deleteWebhook(repository: GitHubRepositoryReference, webhookId: number): Promise<void>;
  listWorkflowFiles(repository: GitHubRepositoryReference): Promise<ClaimPathEvidence[]>;
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
    public readonly code: "CONFLICT" | "FORBIDDEN" | "GITHUB_ACCESS" | "GITHUB_CREDENTIALS" | "GITHUB_RATE_LIMITED" | "INVALID_INPUT" | "NOT_FOUND" | "UPSTREAM_FAILURE",
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
    // created has no repository to deliver to. The try holds only the store call, so deleting
    // the webhook once here covers every failure it can raise, including one raised as a
    // RepositoryRegistrationError by a store, decorator or retry wrapper the interface does
    // not constrain.
    await deleteWebhookBestEffort(dependencies.github, submittedRepository, webhook.id);

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
    await deleteWebhookBestEffort(dependencies.github, submittedRepository, webhook.id);
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

  return { ...created, initialImportScheduled, claimPath };
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

  let webhookDeleted = true;
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

async function deleteWebhookBestEffort(
  github: RepositoryRegistrationGateway,
  repository: GitHubRepositoryReference,
  webhookId: number,
): Promise<void> {
  try {
    await github.deleteWebhook(repository, webhookId);
  } catch {
    // The database error remains the safe response; a later reconciliation can retry deletion.
  }
}
