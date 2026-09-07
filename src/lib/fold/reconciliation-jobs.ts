export type ReconciliationJobReason = "WEBHOOK" | "REGISTRATION" | "SWEEP" | "REDERIVATION";
export type ReconciliationJobState = "PENDING" | "RUNNING" | "FAILED";

export type ClaimedReconciliationJob = {
  id: string;
  repositoryId: string;
  reason: ReconciliationJobReason;
  /** Includes the attempt this claim just started. */
  attemptCount: number;
  leaseToken: string;
  rederivationRequestedAt: Date | null;
  rederivationGeneration: number;
};
