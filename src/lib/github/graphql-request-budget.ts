import { AsyncLocalStorage } from "node:async_hooks";

export class GraphqlBudgetHeld extends Error {
  public constructor(public readonly resetAt: Date) {
    super("Reconciliation GraphQL budget is below reserve.");
  }
}

const requestBudget = new AsyncLocalStorage<{
  check: () => Date | null;
  held: GraphqlBudgetHeld | null;
}>();

/** Only the crawl entered here is guarded; ordinary owned gateways stay usable. */
export function withGraphqlRequestBudget<T>(check: () => Date | null, work: () => Promise<T>): Promise<T> {
  return requestBudget.run({ check, held: null }, work);
}

export function checkGraphqlRequestBudget(): void {
  const scope = requestBudget.getStore();
  if (scope === undefined) return;
  if (scope.held === null) {
    const resetAt = scope.check();
    if (resetAt !== null) scope.held = new GraphqlBudgetHeld(resetAt);
  }
  // Async descendants retain this same latch even if a sibling has rejected
  // and released repository coordination. Expiry never reopens an abandoned crawl.
  if (scope.held !== null) throw scope.held;
}
