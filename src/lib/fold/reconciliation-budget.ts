import {
  assessGraphqlBudget,
  DEFAULT_GRAPHQL_BUDGET_RESERVE,
  gitHubGraphqlBudget,
  readGraphqlBudgetReserve,
  type GitHubGraphqlBudgetAssessment,
  type GitHubGraphqlBudgetStore,
} from "@/lib/github/rate-limit-budget";

export type ReconciliationBudgetCheck = GitHubGraphqlBudgetAssessment & { readonly changed: boolean };

export type ReconciliationBudgetGate = {
  /** The verdict now, plus whether it differs from the verdict last checked. */
  check(now: Date): ReconciliationBudgetCheck;
};

export function createReconciliationBudgetGate(options: {
  store?: GitHubGraphqlBudgetStore;
  reserve?: number;
} = {}): ReconciliationBudgetGate {
  return {
    check(now) {
      let store: GitHubGraphqlBudgetStore | undefined;
      let reserve = DEFAULT_GRAPHQL_BUDGET_RESERVE;
      let assessment: GitHubGraphqlBudgetAssessment;
      try {
        // Acquire inside each check: a broken default or accessor must neither
        // fail factory construction nor prevent a later poll from recovering.
        store = options.store ?? gitHubGraphqlBudget();
        reserve = options.reserve ?? readGraphqlBudgetReserve(process.env);
        assessment = assessGraphqlBudget(store.read(), { reserve, now });
      } catch {
        // An unavailable observer is not evidence of exhaustion.
        assessment = { state: "UNKNOWN", reading: null, reserve };
      }
      let changed = false;
      try {
        // The store outlives a drain, so fresh gates do not repeat hold reports.
        changed = store?.noteState(assessment.state) ?? false;
      } catch {
        // Reporting transitions cannot revoke an already-established hold.
      }
      return { ...assessment, changed };
    },
  };
}
