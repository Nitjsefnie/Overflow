import { callGuarded } from "@/lib/fold/guarded-callback";
import {
  assessGraphqlBudget,
  DEFAULT_GRAPHQL_BUDGET_RESERVE,
  gitHubGraphqlBudget,
  readGraphqlBudgetReserve,
  type GitHubGraphqlBudgetAssessment,
  type GitHubGraphqlBudgetStore,
} from "@/lib/github/rate-limit-budget";

export type ReconciliationBudgetCheck = GitHubGraphqlBudgetAssessment & { readonly changed: boolean; readonly owner: string };

export type ReconciliationBudgetGate = {
  /** The verdict now, plus whether it differs from the verdict last checked. */
  check(owner: string, now: Date): ReconciliationBudgetCheck;
};

export function createReconciliationBudgetGate(options: {
  store?: GitHubGraphqlBudgetStore;
  reserve?: number;
} = {}): ReconciliationBudgetGate {
  return {
    check(owner, now) {
      let store: GitHubGraphqlBudgetStore | undefined;
      let reserve = DEFAULT_GRAPHQL_BUDGET_RESERVE;
      let assessment: GitHubGraphqlBudgetAssessment;
      try {
        // Acquire inside each check: a broken default or accessor must neither
        // fail factory construction nor prevent a later pass from recovering.
        store = options.store ?? gitHubGraphqlBudget();
        reserve = options.reserve ?? readGraphqlBudgetReserve(process.env);
        assessment = assessGraphqlBudget(store.read(owner), { reserve, now });
      } catch {
        // An unavailable observer is not evidence of exhaustion.
        assessment = { state: "UNKNOWN", reading: null, reserve };
      }
      let changed = false;
      try {
        // The store outlives a drain, so fresh gates do not repeat hold reports.
        changed = store?.noteState(owner, assessment.state) ?? false;
      } catch {
        // Reporting transitions cannot revoke an already-established hold.
      }
      return { ...assessment, changed, owner };
    },
  };
}

export type ReconciliationBudgetDependencies = {
  budget?: ReconciliationBudgetGate;
  onBudgetChange?(check: ReconciliationBudgetCheck): void;
};

/** Capture admission before touching diagnostics; even a broken reporter cannot revoke a hold. */
export function reconciliationBudgetHoldUntil(
  dependencies: ReconciliationBudgetDependencies,
  owner: string,
  now: () => Date,
  onAssessment?: (assessment: GitHubGraphqlBudgetAssessment) => void,
): Date | null {
  let check: ReconciliationBudgetCheck | undefined;
  let holdUntil: Date | null = null;
  try {
    const admissionTime = now().getTime();
    const admission = new Date(admissionTime);
    if (!Number.isFinite(admission.getTime())) return null;
    check = (dependencies.budget ?? createReconciliationBudgetGate()).check(owner, admission);
    if (check.state === "BELOW_RESERVE" && check.reading !== null) {
      const reset = new Date(check.reading.resetAt.getTime());
      // A discriminator cannot make an expired window current, and a finite
      // source number may still exceed Date's representable range.
      if (Number.isFinite(reset.getTime()) && reset.getTime() > admissionTime) holdUntil = reset;
      else check = { ...check, state: "UNKNOWN", reading: null };
    }
  } catch {
    // Missing or unreadable observation means UNKNOWN and admits the pass.
    check = undefined;
  }
  try {
    onAssessment?.(check ?? { state: "UNKNOWN", reading: null, reserve: DEFAULT_GRAPHQL_BUDGET_RESERVE });
  } catch {
    // Capturing the assessment cannot revoke the reserve verdict or diagnostics.
  }
  try {
    if (check?.changed) {
      callGuarded(dependencies, () => dependencies.onBudgetChange ?? reportBudgetChange, [check], reportBudgetHookFailure);
    }
  } catch {
    // Transition metadata can be an accessor too; it cannot change admission.
  }
  return holdUntil;
}

function reportBudgetChange(check: ReconciliationBudgetCheck): void {
  const payload = { owner: check.owner, state: check.state, remaining: check.reading?.remaining,
    reserve: check.reserve, resetAt: check.reading?.resetAt };
  if (check.state === "BELOW_RESERVE") console.warn("Reconciliation GraphQL budget state changed", payload);
  else console.info("Reconciliation GraphQL budget state changed", payload);
}

function reportBudgetHookFailure(error: unknown): void {
  const message = "Reconciliation budget transition hook failed";
  try {
    console.error(message, error);
  } catch {
    try {
      console.error(message);
    } catch {
      // Budget diagnostics cannot reject a pass or a detached hook handler.
    }
  }
}
