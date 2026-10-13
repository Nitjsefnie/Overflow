import type { FoldSettlement } from "@/lib/fold/repository-fold";

export type SettlementRow = {
  id: string;
  fold_revision: number;
  issue_id: string;
  pull_request_id: string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  creditor_id: string | null;
  creditor_github_login: string | null;
  creditor_github_user_id: number | string | null;
  debtor_id: string;
  opening_comparison_points: number;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  proof_sha256: string;
  status: FoldSettlement["status"];
  settled_label: string | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

export function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database record was invalid.");
  }
  return parsed;
}

export function timestampToIso(value: string | Date | null): string {
  const normalized = nullableTimestampToIso(value);
  if (normalized === null) {
    throw new Error("Database timestamp was missing.");
  }
  return normalized;
}

export function nullableTimestampToIso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Timestamp was invalid.");
  }
  return date.toISOString();
}
