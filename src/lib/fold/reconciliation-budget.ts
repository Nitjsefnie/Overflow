import {
  assessGraphqlBudget,
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
  const store = options.store ?? gitHubGraphqlBudget();
  const reserve = options.reserve ?? readGraphqlBudgetReserve(process.env);
  return {
    check(now) {
      const assessment = assessGraphqlBudget(store.read(), { reserve, now });
      // The store outlives a drain, so fresh gates do not repeat hold reports.
      return { ...assessment, changed: store.noteState(assessment.state) };
    },
  };
}
