import type { SqlClient } from "@/lib/db/types";
import { readReconciliationEvidence } from "@/lib/fold/evidence-facts";
import type {
  DirtyReconciliationSubject,
  ReconciliationEvidence,
} from "@/lib/fold/reconciliation-evidence";
import {
  assessReconciliationFairness,
  type ReconciliationFairnessAssessment,
} from "@/lib/fold/reconciliation-fairness";
import type { RepositoryCoordinator } from "@/lib/fold/repository-coordination";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";

export class PostgresReconciliationPacingStore {
  public constructor(
    private readonly sql: SqlClient,
    private readonly coordinator: RepositoryCoordinator,
  ) {}

  public async getReconciliationEvidence(repositoryId: string): Promise<ReconciliationEvidence | null> {
    // The document is reassembled from the facts storage by the same module
    // that splits it — same shape, deterministic order, so the fold's merge
    // logic is unchanged.
    return readReconciliationEvidence(this.sql, repositoryId);
  }

  public async getDirtyReconciliationSubjects(repositoryId: string): Promise<DirtyReconciliationSubject[]> {
    const rows = await this.sql<{
      kind: DirtyReconciliationSubject["kind"]; github_subject_id: string; subject_number: number; generation: string;
    }[]>`select kind, github_subject_id, subject_number, generation
      from repository_reconciliation_dirty_subjects where repository_id = ${repositoryId}
      order by kind, github_subject_id`;
    return rows.map((row) => ({ kind: row.kind, id: Number(row.github_subject_id),
      number: row.subject_number, generation: Number(row.generation) }));
  }

  public async discardDirtyReconciliationSubject(input: {
    repositoryId: string;
    kind: DirtyReconciliationSubject["kind"];
    githubSubjectId: number;
    generation: number;
  }): Promise<void> {
    // Keyed with the generation the same way the materialize-time delete is: a
    // webhook that re-enqueued the subject with a fresh generation mid-run must
    // keep its row, so the fresh request still reconciles.
    await this.sql`delete from repository_reconciliation_dirty_subjects
      where repository_id = ${input.repositoryId} and kind = ${input.kind}
        and github_subject_id = ${input.githubSubjectId} and generation = ${input.generation}`;
  }

  public async getReconciliationCooldown(repositoryId: string): Promise<Date | null> {
    const [row] = await this.sql<{ reconciliation_not_before: Date | null }[]>`
      select reconciliation_not_before from registered_repositories where id = ${repositoryId}
    `;
    return row?.reconciliation_not_before ?? null;
  }

  public async setReconciliationCooldown(repositoryId: string, notBefore: Date | null): Promise<void> {
    await this.coordinator.withRepositoryPublication(repositoryId, async (transaction) => {
      await transaction`
        update registered_repositories set reconciliation_not_before = ${notBefore}
        where id = ${repositoryId}
      `;
    });
  }

  public async assessReconciliationFairness(input: {
    repositoryId: string;
    sponsorId: string;
    budget: GitHubGraphqlBudgetAssessment;
    now: Date;
  }): Promise<ReconciliationFairnessAssessment> {
    return this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
      const [active] = await transaction<{ count: number }[]>`
        select count(*)::int as count from registered_repositories
        where sponsor_id = ${input.sponsorId} and active = true
      `;
      const [row] = await transaction<{ debt: number; measured_at: Date; rate_per_second: number }[]>`
        select debt, measured_at, rate_per_second from repository_reconciliation_usage
        where sponsor_id = ${input.sponsorId} and repository_id = ${input.repositoryId} for update
      `;
      const assessment = assessReconciliationFairness({
        usage: row === undefined ? null : { debt: row.debt, measuredAt: row.measured_at, ratePerSecond: row.rate_per_second },
        budget: input.budget, activeRepositoryCount: active.count, now: input.now,
      });
      // The pure invalid-clock verdict may carry an epoch fallback. Neither that
      // synthetic instant nor its unallocated rate belongs in durable state.
      if (!Number.isFinite(input.now.getTime())) return assessment;
      const { usage } = assessment;
      await transaction`
        insert into repository_reconciliation_usage (sponsor_id, repository_id, debt, measured_at, rate_per_second)
        values (${input.sponsorId}, ${input.repositoryId}, ${usage.debt}, ${usage.measuredAt}, ${usage.ratePerSecond})
        on conflict (sponsor_id, repository_id) do update set
          debt = excluded.debt, measured_at = excluded.measured_at, rate_per_second = excluded.rate_per_second
      `;
      return assessment;
    });
  }
}
