import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type {
  RepositoryFoldRevisionCounts,
  RepositoryRederivationRequest,
} from "@/lib/fold/postgres-store";
import {
  ModerationServiceError,
  requireModerator,
  type ModerationActor,
} from "@/lib/moderation/service";

/**
 * The moderator-facing view of issue 197's third obligation: which derived rows
 * a repository holds that the current fold logic produced, and which are still
 * the output of an older revision of it.
 */
export type RepositoryRederivationStatus = {
  repositoryId: string;
  ownerName: string;
  rowsAtCurrentRevision: number;
  rowsBelowCurrentRevision: number;
  /**
   * When the outstanding re-derivation request was made, or null when none is.
   * The queue's generation counter is deliberately absent: it is bookkeeping the
   * worker compares against and says nothing a moderator can act on.
   */
  rederivationRequestedAt: string | null;
};

/**
 * The counts are only interpretable against the revision they were taken at, so
 * the revision travels with them rather than being looked up separately.
 */
export type RederivationOverview = {
  foldRevision: number;
  repositories: RepositoryRederivationStatus[];
};

export type OutstandingRederivationRequest = {
  repositoryId: string;
  ownerName: string;
  rederivationRequestedAt: string | null;
};

export type RederivationStore = {
  listRepositoryFoldRevisionCounts(revision: number): Promise<RepositoryFoldRevisionCounts[]>;
  findRepositoryRederivationRequest(repositoryId: string): Promise<RepositoryRederivationRequest | null>;
  requestRepositoryRederivation(repositoryId: string, at: Date): Promise<void>;
};

export class RepositoryRederivationService {
  public constructor(
    private readonly store: RederivationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listRederivationStatus(actor: ModerationActor): Promise<RederivationOverview> {
    requireModerator(actor);
    const counts = await this.store.listRepositoryFoldRevisionCounts(FOLD_REVISION);
    return {
      foldRevision: FOLD_REVISION,
      repositories: counts.map((repository) => ({
        repositoryId: repository.repositoryId,
        ownerName: repository.ownerName,
        rowsAtCurrentRevision: repository.rowsAtRevision,
        rowsBelowCurrentRevision: repository.rowsBelowRevision,
        rederivationRequestedAt: repository.rederivationRequestedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Asks for one repository's derived rows to be recomputed — issue 197's second
   * obligation.
   *
   * The repository is resolved before the request is written rather than letting
   * the queue's foreign key refuse it, so an unknown target answers NOT_FOUND
   * like every other moderation target that does not exist instead of surfacing
   * a database error. A deactivated repository answers the same way: it is not
   * on this route's surface, and a pass over it does no fold work.
   *
   * The stored timestamp is read back rather than assumed, because the store
   * keeps the later of the existing request and this one: a moderator whose
   * clock is behind an outstanding request must be shown the request that
   * actually stands.
   */
  public async requestRederivation(
    actor: ModerationActor,
    repositoryId: string,
  ): Promise<OutstandingRederivationRequest> {
    requireModerator(actor);
    const target = await this.store.findRepositoryRederivationRequest(repositoryId);
    if (target === null) {
      throw new ModerationServiceError("NOT_FOUND", "Repository was not found.");
    }

    await this.store.requestRepositoryRederivation(repositoryId, this.now());

    const outstanding = await this.store.findRepositoryRederivationRequest(repositoryId);
    if (outstanding === null) {
      throw new ModerationServiceError("NOT_FOUND", "Repository was not found.");
    }
    return {
      repositoryId: outstanding.repositoryId,
      ownerName: outstanding.ownerName,
      rederivationRequestedAt: outstanding.rederivationRequestedAt?.toISOString() ?? null,
    };
  }
}
