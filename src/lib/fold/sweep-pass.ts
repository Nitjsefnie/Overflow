import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { findGitHubRateLimitError } from "@/lib/github/errors";
import { GraphqlBudgetHeld } from "@/lib/github/graphql-request-budget";

/** Forge re-fetches cost budget, never correctness. */
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
  write(key: string, payload: unknown, cursor?: string | null): Promise<void>;
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
export async function discardInactivePassAfterFailure<T>(
  sweep: ReconciliationSweepControl | undefined, repositoryId: string, coordinatedRun: () => Promise<T>,
): Promise<T> {
  try {
    return await coordinatedRun();
  } catch (error) {
    try { await sweep?.discardIfInactive?.(repositoryId); } catch { console.error("Could not discard reconciliation sweep checkpoints."); }
    throw error;
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
const passes = new AsyncLocalStorage<SweepPass>();
const freshReads = new AsyncLocalStorage<boolean>();
export function withSweepPass<T>(pass: SweepPass | undefined, work: () => Promise<T>): Promise<T> {
  return pass === undefined ? work() : passes.run(pass, work);
}
/** A verification witness must describe the state it verifies; a replayed page describes an earlier one. */
export function withFreshSweepReads<T>(work: () => Promise<T>): Promise<T> {
  return freshReads.run(true, work);
}

/** Replay retained pages locally to save upstream requests.
 * Keys hash paths/query variables, never authentication headers or credentials.
 * Only parsed successful responses are saved; error payloads are never retained.
 */
export async function checkpointSweepRequest<T>(identity: unknown, read: () => Promise<T>): Promise<T> {
  if (freshReads.getStore()) return read();
  const pass = passes.getStore();
  if (pass === undefined) return read();
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const cached = await pass.read(key);
  if (cached !== undefined) return cached as T;
  const payload = sanitizeForgeStrings(await read());
  const issues = (payload as { repository?: { issues?: { pageInfo?: { endCursor?: string | null } } } } | null)?.repository?.issues;
  await pass.write(key, payload, issues?.pageInfo?.endCursor);
  return payload;
}

export async function checkpointSweepRestRequest<T extends { status: number; headers: Headers; body: string }>(
  identity: unknown, read: () => Promise<T>,
): Promise<{ status: number; headers: Headers; body: string }> {
  const payload = await checkpointSweepRequest(identity, async () => {
    const result = await read();
    return { ...result, headers: Object.fromEntries(result.headers) };
  });
  return { ...payload, headers: new Headers(payload.headers) };
}
