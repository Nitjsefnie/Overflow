import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { findGitHubRateLimitError } from "@/lib/github/errors";
import { GraphqlBudgetHeld } from "@/lib/github/graphql-request-budget";

/** Caps a pass's absence-listing records; past it, a later run lists those subjects again. */
export const DEFAULT_SWEEP_PASS_PAGE_CEILING = 1000;
export function readSweepPassPageCeiling(environment: Partial<Record<string, string>>): number {
  const raw = environment.RECONCILIATION_SWEEP_PAGE_CEILING ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SWEEP_PASS_PAGE_CEILING;
}
/** One job's whole retry ladder: RECONCILIATION_RETRY_DELAYS_MS plus the first attempt. */
export const SWEEP_PASS_FAILED_RUN_BOUND = 5;
/** Held passes span windows; the age bound retires a pass that cannot complete. */
export const SWEEP_PASS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export class StagedPassDataUnreadable extends Error {
  public constructor() {
    super("Staged sweep pass data is unreadable.");
  }
}

export type SweepPass = {
  id: string;
  scanStartedAt: Date;
  dirtySubjects: DirtyReconciliationSubject[];
  read(key: string): Promise<unknown | undefined>;
  write(key: string, payload: unknown): Promise<void>;
  walkAnchors(): Readonly<Record<string, { updatedAt: Date; key: number } | undefined>>;
  stage(input: { anchor: string; kind: "issue" | "pull_request"; subjectKey: number; updatedAt: Date; payload: unknown }): Promise<void>;
  readStaged(): Promise<Array<{ kind: "issue" | "pull_request"; subjectKey: number; updatedAt: Date; payload: unknown }>>;
  deleteStaged(keys: ReadonlyArray<{ kind: "issue" | "pull_request"; subjectKey: number }>): Promise<void>;
  hold(): Promise<void>;
  complete(): Promise<void>;
};
export type SweepPassInput = {
  repositoryId: string;
  evidenceVersion: string;
  scanStartedAt: Date;
  dirtySubjects: DirtyReconciliationSubject[];
};
export type ReconciliationSweepControl = {
  /** Charges the fold to its sponsor and its repository's share; null admits, a date holds. */
  spend(sponsorId: string, repositoryId: string): Promise<Date | null>;
  openPass(input: SweepPassInput): Promise<SweepPass>;
  discardPass(repositoryId: string): Promise<void>;
  discardIfInactive?(repositoryId: string): Promise<void>;
};
/** Runs after coordination is released: an unregistration that committed during the run left no other disposal. */
export async function discardInactivePassAfterRun<T>(
  sweep: ReconciliationSweepControl | undefined, repositoryId: string, coordinatedRun: () => Promise<T>,
): Promise<T> {
  try {
    return await coordinatedRun();
  } finally {
    try { await sweep?.discardIfInactive?.(repositoryId); } catch { console.error("Could not discard reconciliation sweep checkpoints."); }
  }
}
export async function discardSweepPass(pass: SweepPass | undefined): Promise<void> {
  try { await pass?.complete(); } catch { console.error("Could not discard reconciliation sweep checkpoints."); }
}
/** A budget or forge rate-limit stop is a hold, not a failed run. */
export async function holdSweepPass(pass: SweepPass | undefined, error: unknown): Promise<void> {
  if (!(error instanceof SweepBudgetSpent || error instanceof GraphqlBudgetHeld || findGitHubRateLimitError(error) !== null)) return;
  try { await pass?.hold(); } catch { console.error("Could not record a hold on reconciliation sweep checkpoints."); }
}
